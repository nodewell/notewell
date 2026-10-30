// Random operation sequences on every fixture (kanban.md 4, 7): after each applied request the
// board still parses with its invariants, the parts no request may touch keep their bytes, and
// requests built from the current board are never refused as stale. Seeded, so failures repeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, computePatch } from '../../../src/core/patch.ts';
import { firstDateToken } from '../../../src/features/kanban/card-dates.ts';
import { cardEditText } from '../../../src/features/kanban/card-text.ts';
import { formatDate } from '../../../src/features/kanban/dates.ts';
import { boardSegments, cardIdentity, type KanbanBoard } from '../../../src/features/kanban/model.ts';
import { planBoardRequest, type BoardRequest } from '../../../src/features/kanban/operations.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';

const fixtureDir = new URL('../../fixtures/kanban/', import.meta.url);
const fixtureNames = readdirSync(fixtureDir).filter((name) => /^\d\d-.*\.md$/.test(name));

/** mulberry32: small seeded generator. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces typed text is made of: plain words, Markdown and board syntax, Unicode, whitespace.
const PIECES = ['a', 'word', '한글', ' ', '  ', '\t', '#tag', '[[link]]', '[t](x.md)', '`code`', '**b**', '==h==', '@{2026-01-02}', '- [ ] ', '## ', '***', '---', '```', '~~~', '%%', '%% x %%', '<!-- c -->', '<b>', '\\', '|', '$x$', '😀', 'é', '>', '1. ', '* ', '+ '];

function text(rand: () => number, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    let line = '';
    const n = 1 + Math.floor(rand() * 6);
    for (let j = 0; j < n; j++) line += PIECES[Math.floor(rand() * PIECES.length)];
    out.push(line);
  }
  return out.join('\n');
}

function randomRequest(rand: () => number, texts: readonly string[], board: KanbanBoard): BoardRequest | undefined {
  const lanes = board.lanes;
  if (lanes.length === 0) return undefined;
  const lane = lanes[Math.floor(rand() * lanes.length)]!;
  const laneId = { laneIndex: lane.index, heading: texts[lane.headingLine]! };
  const card = lane.cards.length === 0 ? undefined : lane.cards[Math.floor(rand() * lane.cards.length)]!;
  const kinds = card === undefined ? ['addCard', 'moveLane', 'renameLane'] : ['toggleCard', 'editCardText', 'deleteCard', 'duplicateCard', 'moveCard', 'addCard', 'moveLane', 'renameLane', 'setCardDate', 'removeCardDate'];
  const kind = kinds[Math.floor(rand() * kinds.length)];
  const to = lanes[Math.floor(rand() * lanes.length)]!;
  switch (kind) {
    case 'toggleCard':
      return { kind, card: cardIdentity(texts, card!) };
    case 'editCardText': {
      // Often keep the current text and change a part, sometimes replace it.
      const current = cardEditText(texts, card!);
      const next = rand() < 0.5 ? `${current}\n${text(rand, 1)}` : text(rand, 1 + Math.floor(rand() * 4));
      return { kind, card: cardIdentity(texts, card!), text: next };
    }
    case 'deleteCard':
    case 'duplicateCard':
      return { kind, card: cardIdentity(texts, card!) };
    case 'moveCard': {
      const remaining = to.cards.filter((c) => c !== card).length;
      return { kind, card: cardIdentity(texts, card!), toLane: { laneIndex: to.index, heading: texts[to.headingLine]! }, toIndex: Math.floor(rand() * (remaining + 1)) };
    }
    case 'addCard':
      return { kind, lane: laneId, title: text(rand, 1), index: Math.floor(rand() * (lane.cards.length + 1)) };
    case 'moveLane':
      return { kind, lane: laneId, toIndex: Math.floor(rand() * lanes.length) };
    case 'renameLane':
      return { kind, lane: laneId, name: text(rand, 1) };
    case 'setCardDate':
    case 'removeCardDate': {
      // The date picker (kanban.md 4.8): change or remove the first token, or add one.
      const token = firstDateToken(texts, card!)?.text;
      const id = cardIdentity(texts, card!);
      if (kind === 'removeCardDate' && token !== undefined) return { kind, card: id, token };
      const date = `${2000 + Math.floor(rand() * 40)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 10)}`;
      return { kind: 'setCardDate', card: id, date, ...(token === undefined ? {} : { token }) };
    }
  }
  return undefined;
}

/** Board invariants (kanban.md 2): segments tile the file, cards ordered and inside their lane. */
function checkInvariants(texts: readonly string[], board: KanbanBoard, label: string): void {
  let next = 0;
  for (const { range } of boardSegments(board)) {
    assert.equal(range.start, next, `segments tile: ${label}`);
    next = range.end;
  }
  assert.equal(next, texts.length, `segments cover the file: ${label}`);
  for (const lane of board.lanes) {
    let after = lane.range.start + 1;
    for (const card of lane.cards) {
      assert.ok(card.range.start >= after && card.range.end <= lane.range.end, `card inside its lane: ${label}`);
      assert.ok(/^ {0,3}([-*+]|\d{1,9}[.)])([ \t]|$)/.test(texts[card.range.start]!), `a card starts with a list marker: ${label}`);
      after = card.range.end;
    }
  }
}

/** The parts of a board no request may change. */
function fixedParts(texts: readonly string[], board: KanbanBoard) {
  const slice = (r: { start: number; end: number } | null) => (r === null ? null : texts.slice(r.start, r.end).join('\n'));
  return { frontmatter: slice(board.frontmatter), archive: slice(board.archive), settings: slice(board.settingsBlock?.range ?? null), tail: slice(board.tail) };
}

const STEPS = 1000;

for (const name of fixtureNames) {
  test(`fuzz: ${STEPS} random requests on ${name} keep the board valid`, () => {
    const rand = random(name.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
    let source = readFileSync(new URL(name, fixtureDir), 'utf8');
    const original = (() => {
      const texts = lineTexts(parseLines(source));
      return fixedParts(texts, parseBoard(texts));
    })();
    let applied = 0;
    for (let step = 0; step < STEPS; step++) {
      const doc = parseLines(source);
      const texts = lineTexts(doc);
      const board = parseBoard(texts);
      const request = randomRequest(rand, texts, board);
      if (request === undefined) break;
      const label = `${name} step ${step} ${JSON.stringify(request).slice(0, 200)}`;
      const plan = planBoardRequest(texts, board, request, { eols: doc.lines.map((l) => l.eol) });
      if (!plan.ok) {
        assert.notEqual(plan.reason, 'stale', `built from the current board, never stale: ${label}`);
        continue;
      }
      const patch = computePatch(doc, 1, { expectedVersion: 1, ...plan });
      assert.ok(patch.ok, `patch: ${label}`);
      const next = applyEdits(doc, patch.edits);
      const nextTexts = lineTexts(parseLines(next));
      const nextBoard = parseBoard(nextTexts);
      checkInvariants(nextTexts, nextBoard, label);
      assert.deepEqual(fixedParts(nextTexts, nextBoard), original, `untouched parts: ${label}`);
      assert.equal(nextBoard.lanes.length, board.lanes.length, `lane count: ${label}`);
      assert.equal(next.startsWith('\ufeff'), source.startsWith('\ufeff'), `BOM kept: ${label}`);
      if (request.kind === 'editCardText') {
        const card = nextBoard.lanes[request.card.laneIndex]!.cards[request.card.cardIndex]!;
        const expected = request.text.split('\n');
        while (expected.length > 1 && expected[expected.length - 1]!.trim() === '') expected.pop();
        expected[0] = expected[0]!.trim();
        // A body line of only spaces or tabs is a blank line of the card (card-text.ts).
        for (let i = 1; i < expected.length; i++) if (expected[i]!.trim() === '') expected[i] = '';
        assert.equal(cardEditText(nextTexts, card), expected.join('\n'), `edited card reads back: ${label}`);
      }
      if (request.kind === 'setCardDate') {
        const card = nextBoard.lanes[request.card.laneIndex]!.cards[request.card.cardIndex]!;
        assert.equal(firstDateToken(nextTexts, card)?.text, `@{${formatDate(request.date, board.settings.dateFormat)}}`, `date reads back: ${label}`);
      }
      source = next;
      applied++;
    }
    assert.ok(applied > STEPS / 10, `${applied} requests applied`);
  });
}
