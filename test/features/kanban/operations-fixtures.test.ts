// kanban.md 7 tests 2~4 over every fixture: non-target lines preserved, repeat stability,
// and compatibility with a normalizing script (test/support/normalizer.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, computePatch, type LineOperation } from '../../../src/core/patch.ts';
import { findFences } from '../../../src/core/fences.ts';
import { dateLineOf, endsWithTableRow, leavesCommentOpen, firstDateToken, hasLinkDate } from '../../../src/features/kanban/card-dates.ts';
import { cardEditText } from '../../../src/features/kanban/card-text.ts';
import { formatDate } from '../../../src/features/kanban/dates.ts';
import { boardSegments, cardIdentity, type KanbanBoard } from '../../../src/features/kanban/model.ts';
import { planBoardRequest, type BoardRequest, type LaneIdentity } from '../../../src/features/kanban/operations.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { readNormalized, writeNormalized } from '../../support/normalizer.ts';

const fixtureDir = new URL('../../fixtures/kanban/', import.meta.url);
const fixtureNames = readdirSync(fixtureDir).filter((name) => /^\d\d-.*\.md$/.test(name));

interface Opened {
  source: string;
  texts: string[];
  board: KanbanBoard;
}

function open(source: string): Opened {
  const texts = lineTexts(parseLines(source));
  return { source, texts, board: parseBoard(texts) };
}

function laneId(o: Opened, index: number): LaneIdentity {
  return { laneIndex: index, heading: o.texts[o.board.lanes[index].headingLine] };
}

/**
 * The only requests a fixture may refuse as unsafe (kanban.md 4); every other request must apply.
 * - 13: anything that would land after its unclosed code fence.
 * - 20, 27: deleting or moving away the only card of a lane whose later list would then become
 *   the lane's first list, turning hidden lines into cards (2.5).
 * - 31: moving a card whose body is indented for `- ` into an ordered list, where `1. ` needs
 *   one more column, so the body would leave the card (4.1 marker matching).
 */
function unsafeAllowed(name: string, o: Opened, request: BoardRequest): boolean {
  if (name === '13-code-fences.md') return true;
  if (name === '20-not-cards.md' || name === '27-format-variants.md') {
    return (request.kind === 'deleteCard' || request.kind === 'moveCard') && o.board.lanes[request.card.laneIndex].cards.length === 1;
  }
  if (name === '31-list-markers.md') return request.kind === 'moveCard' && request.card.firstLine === '- plain item two';
  return false;
}

/** Applies a request; returns null if it is refused as unsafe, which must be allowed for the fixture. */
function tryApply(name: string, o: Opened, request: BoardRequest): { operations: LineOperation[]; after: Opened } | null {
  const plan = planBoardRequest(o.texts, o.board, request);
  if (!plan.ok && plan.reason === 'unsafe') {
    assert.ok(unsafeAllowed(name, o, request), `unsafe: ${name} ${JSON.stringify(request)}: ${plan.message}`);
    return null;
  }
  return apply(o, request);
}

/** Applies a request that must succeed. */
function apply(o: Opened, request: BoardRequest): { operations: LineOperation[]; after: Opened } {
  const plan = planBoardRequest(o.texts, o.board, request);
  assert.ok(plan.ok, plan.ok ? '' : `${plan.reason}: ${plan.message}`);
  const doc = parseLines(o.source);
  const result = computePatch(doc, 3, { expectedVersion: 3, expectedLines: plan.expectedLines, operations: plan.operations });
  assert.ok(result.ok, result.ok ? '' : `${result.reason}: ${result.message}`);
  return { operations: [...plan.operations], after: open(applyEdits(doc, result.edits)) };
}

/** Every request kind against every card / lane, with a few target indices each. */
function allRequests(o: Opened): BoardRequest[] {
  const out: BoardRequest[] = [];
  const lanes = o.board.lanes;
  const picks = (n: number): number[] => [...new Set([0, Math.floor(n / 2), n])];
  for (const lane of lanes) {
    for (const card of lane.cards) {
      const id = cardIdentity(o.texts, card);
      out.push({ kind: 'toggleCard', card: id });
      out.push({ kind: 'deleteCard', card: id });
      out.push({ kind: 'duplicateCard', card: id });
      // A title edit: the card's edit text with a new first line (body unchanged).
      const body = cardEditText(o.texts, card).split('\n').slice(1);
      out.push({ kind: 'editCardText', card: id, text: ['바뀐 제목 [[링크]]', ...body].join('\n') });
      for (const to of lanes) {
        const remaining = to.cards.length - (to === lane ? 1 : 0);
        for (const toIndex of picks(remaining)) out.push({ kind: 'moveCard', card: id, toLane: laneId(o, to.index), toIndex });
      }
    }
    for (const index of picks(lane.cards.length)) out.push({ kind: 'addCard', lane: laneId(o, lane.index), index, title: '새 카드' });
    for (const toIndex of picks(lanes.length - 1)) out.push({ kind: 'moveLane', lane: laneId(o, lane.index), toIndex });
    out.push({ kind: 'renameLane', lane: laneId(o, lane.index), name: '새 이름' });
  }
  return out;
}

/** Original lines a request may delete or replace. */
function targetLines(o: Opened, request: BoardRequest): Set<number> {
  const lines = new Set<number>();
  const addRange = (start: number, end: number): void => {
    for (let i = start; i < end; i++) lines.add(i);
  };
  switch (request.kind) {
    case 'toggleCard':
    case 'editCardText':
      lines.add(o.board.lanes[request.card.laneIndex].cards[request.card.cardIndex].range.start);
      break;
    case 'moveCard':
    case 'deleteCard': {
      const card = o.board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
      addRange(card.range.start, card.range.end);
      break;
    }
    case 'duplicateCard':
      // Only inserts: no original line is deleted or replaced.
      break;
    case 'moveLane': {
      const lane = o.board.lanes[request.lane.laneIndex];
      addRange(lane.range.start, lane.range.end);
      break;
    }
    case 'renameLane':
      lines.add(o.board.lanes[request.lane.laneIndex].headingLine);
      break;
    case 'addCard':
      break;
  }
  return lines;
}

/** Texts after applying line operations naively (a model independent of the patch engine). */
function naive(texts: readonly string[], operations: readonly LineOperation[]): string[] {
  const spans = operations
    .map((op) =>
      op.kind === 'insert'
        ? { start: op.at, end: op.at, lines: op.lines }
        : { start: op.start, end: op.end, lines: op.kind === 'replace' ? op.lines : [] },
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let next = 0;
  for (const span of spans) {
    out.push(...texts.slice(next, span.start), ...span.lines);
    next = Math.max(next, span.end);
  }
  out.push(...texts.slice(next));
  return out;
}

/** Non-lane segments (frontmatter, preamble, archive, settings, tail) as text. */
function fixedParts(o: Opened): string[][] {
  return boardSegments(o.board)
    .filter((s) => s.kind !== 'lane')
    .map((s) => [s.kind, ...o.texts.slice(s.range.start, s.range.end)]);
}

/** Lines of each lane that are not part of a card, in order. */
function otherLines(o: Opened): string[][] {
  return o.board.lanes.map((lane) => {
    const inCard = new Set<number>();
    for (const card of lane.cards) for (let i = card.range.start; i < card.range.end; i++) inCard.add(i);
    const lines: string[] = [];
    for (let i = lane.range.start + 1; i < lane.range.end; i++) if (!inCard.has(i)) lines.push(o.texts[i]);
    return lines;
  });
}

function cardLines(o: Opened, lane: number, index: number): string[] {
  const card = o.board.lanes[lane].cards[index];
  return o.texts.slice(card.range.start, card.range.end);
}

/**
 * A card's first line without its marker and check box: a move may change the check state
 * (2.7), add a check box (`[x] `), or change the marker to the target list's (4.1).
 */
const uncheck = (line: string): string => line.replace(/^( {0,3})(?:[-*+]|\d{1,9}[.)])([ \t]+)(?:\[[^\]]\][ \t]+(?=[^ \t]))?/, '$1$2');

/**
 * Bodies are compared without trailing blank lines: only an unclosed code fence can end a
 * body with blank lines (it runs to the lane end, fixture 13), and the normalizer, which
 * does not know fences, stops at the last indented line.
 */
function comparable(lanes: readonly { title: string; complete: boolean; cards: readonly { line: string; body: readonly string[] }[] }[]) {
  return lanes.map((lane) => ({
    ...lane,
    cards: lane.cards.map((card) => {
      const body = [...card.body];
      while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
      return { line: card.line, body };
    }),
  }));
}

/** Board structure as the parser sees it, in the normalizer's shape. */
function parserView(o: Opened) {
  return o.board.lanes.map((lane) => ({
    title: lane.name,
    complete: lane.completeMarkerLines.length > 0,
    cards: lane.cards.map((card) => ({
      line: o.texts[card.range.start],
      body: o.texts.slice(card.body.start, card.body.end),
    })),
  }));
}

test('7.2 every request keeps non-target lines on every fixture', () => {
  let count = 0;
  const unsafe: string[] = [];
  for (const name of fixtureNames) {
    const before = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    for (const request of allRequests(before)) {
      const label = `${name} ${JSON.stringify(request)}`;
      const applied = tryApply(name, before, request);
      if (applied === null) {
        unsafe.push(label);
        continue;
      }
      const { operations, after } = applied;
      const targets = targetLines(before, request);
      for (const op of operations) {
        if (op.kind === 'insert') continue;
        for (let i = op.start; i < op.end; i++) assert.ok(targets.has(i), `line ${i} outside target: ${label}`);
      }
      assert.deepEqual(after.texts, naive(before.texts, operations), label);
      assert.deepEqual(fixedParts(after), fixedParts(before), label);
      assert.equal(after.board.lanes.length, before.board.lanes.length, label);

      switch (request.kind) {
        case 'toggleCard':
        case 'editCardText':
        case 'renameLane': {
          const [line] = [...targets];
          const changed = after.texts.flatMap((t, i) => (t === before.texts[i] ? [] : [i]));
          assert.ok(changed.length <= 1 && (changed.length === 0 || changed[0] === line), label);
          if (request.kind === 'toggleCard') {
            const card = after.board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
            const old = before.board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
            assert.equal(card.checked, !old.checked, label);
          }
          if (request.kind === 'renameLane') assert.equal(after.board.lanes[request.lane.laneIndex].name, '새 이름', label);
          break;
        }
        case 'moveCard': {
          const from = request.card.laneIndex;
          const to = request.toLane.laneIndex;
          const moved = cardLines(before, from, request.card.cardIndex);
          if (after.board.lanes[to].cards[request.toIndex] === undefined) assert.fail(`no card at target: ${label}
${after.source}`);
          const landed = cardLines(after, to, request.toIndex);
          assert.deepEqual(landed.map((l, i) => (i === 0 ? uncheck(l) : l)), moved.map((l, i) => (i === 0 ? uncheck(l) : l)), label);
          // Other lines of every lane stay; the target lane may gain a blank line before the card
          // (an empty lane) and one after it (so a following paragraph stays out of it, 4.1).
          const expected = otherLines(before);
          const actual = otherLines(after);
          const nonBlank = (lines: string[]): string[] => lines.filter((line) => line !== '');
          assert.ok(actual[to].length - expected[to].length <= 2, label);
          assert.deepEqual(nonBlank(actual[to]), nonBlank(expected[to]), label);
          actual[to] = expected[to];
          assert.deepEqual(actual, expected, label);
          // Card counts: one fewer in the source lane, one more in the target lane.
          const counts = before.board.lanes.map((l) => l.cards.length);
          counts[from]--;
          counts[to]++;
          assert.deepEqual(after.board.lanes.map((l) => l.cards.length), counts, label);
          break;
        }
        case 'deleteCard': {
          // The card is gone; every other line of every lane stays in place.
          const counts = before.board.lanes.map((l) => l.cards.length);
          counts[request.card.laneIndex]--;
          assert.deepEqual(after.board.lanes.map((l) => l.cards.length), counts, label);
          assert.deepEqual(otherLines(after), otherLines(before), label);
          break;
        }
        case 'duplicateCard': {
          // An exact copy right after the original; other lines in place.
          const { laneIndex, cardIndex } = request.card;
          assert.deepEqual(cardLines(after, laneIndex, cardIndex + 1), cardLines(before, laneIndex, cardIndex), label);
          assert.deepEqual(cardLines(after, laneIndex, cardIndex), cardLines(before, laneIndex, cardIndex), label);
          assert.deepEqual(otherLines(after), otherLines(before), label);
          break;
        }
        case 'addCard': {
          const lane = request.lane.laneIndex;
          const index = request.index ?? before.board.lanes[lane].cards.length;
          const check = before.board.lanes[lane].done ? 'x' : ' ';
          // The marker of the lane's list (4.1), `-` in a lane without cards.
          const [line, ...body] = cardLines(after, lane, index);
          assert.match(line, /^ {0,3}(?:[-*+]|\d{1,9}[.)]) \[[ x]\] 새 카드$/, label);
          assert.equal(line.includes(`[${check}]`), true, label);
          assert.deepEqual(body, [], label);
          if (before.board.lanes[lane].cards.length === 0) assert.ok(line.startsWith('- '), label);
          assert.equal(after.texts.length - before.texts.length <= 3, true, label);
          break;
        }
        case 'moveLane': {
          const order = before.board.lanes.map((l) => l.index).filter((i) => i !== request.lane.laneIndex);
          order.splice(request.toIndex, 0, request.lane.laneIndex);
          const block = (o: Opened, i: number): string[] => o.texts.slice(o.board.lanes[i].range.start, o.board.lanes[i].range.end);
          // Each lane moves as a whole block of lines.
          assert.deepEqual(
            after.board.lanes.map((l) => block(after, l.index)),
            order.map((i) => block(before, i)),
            label,
          );
          break;
        }
      }
      count++;
    }
  }
  assert.ok(count > 500, `only ${count} requests`);
  // Fixture 13 does refuse some requests (anything that would land after its unclosed fence).
  assert.ok(unsafe.length > 0);
});

test('7.3 ten toggles and ten round-trip moves do not grow indentation or blank lines', () => {
  for (const name of fixtureNames) {
    let o = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    const laneIndex = o.board.lanes.findIndex((l) => l.cards.length > 0);
    if (laneIndex === -1) continue;
    const blanks = (x: Opened): number => x.texts.filter((t) => t.trim() === '').length;
    const indents = (x: Opened): string => x.texts.map((t) => /^[ \t]*/.exec(t)?.[0] ?? '').join('|');

    const start = o;
    for (let i = 0; i < 10; i++) {
      const card = o.board.lanes[laneIndex].cards[0];
      o = apply(o, { kind: 'toggleCard', card: cardIdentity(o.texts, card) }).after;
      assert.equal(blanks(o), blanks(start), name);
      assert.equal(indents(o), indents(start), name);
    }
    // `[X]` comes back as `[x]`, and a card without a check box keeps the `[ ] ` it gained (2.7).
    const first = start.board.lanes[laneIndex].cards[0];
    if (first.check === ' ' || first.check === 'x') {
      assert.equal(o.source, start.source, `even toggles restore the file: ${name}`);
    }

    if (o.board.lanes.length < 2) continue;
    const other = laneIndex === 0 ? 1 : 0;
    let afterFirst: string | undefined;
    for (let round = 0; round < 10; round++) {
      const card = o.board.lanes[laneIndex].cards[0];
      // Index 0 on both sides: never lands after an unclosed fence (fixture 13).
      const out: BoardRequest = { kind: 'moveCard', card: cardIdentity(o.texts, card), toLane: laneId(o, other), toIndex: 0 };
      // The only card of a lane with a later list stays (fixture 27).
      const moved = tryApply(name, o, out);
      if (moved === null) break;
      o = moved.after;
      const back = o.board.lanes[other].cards[0];
      o = apply(o, { kind: 'moveCard', card: cardIdentity(o.texts, back), toLane: laneId(o, laneIndex), toIndex: 0 }).after;
      // At most one blank line is ever added (into an empty lane), and only in the first round.
      assert.ok(blanks(o) <= blanks(start) + 1, `${name} round ${round}`);
      afterFirst ??= o.source;
      assert.equal(o.source, afterFirst, `${name} round ${round} is stable`);
      assert.equal(indents(o).replace(/\|/g, ''), indents(start).replace(/\|/g, ''), name);
    }
  }
});

test('7.4 normalizer reads the same structure after every request, and its output parses back', () => {
  let compared = 0;
  for (const name of fixtureNames) {
    const before = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    for (const request of allRequests(before)) {
      const label = `${name} ${JSON.stringify(request)}`;
      const applied = tryApply(name, before, request);
      if (applied === null) continue;
      const { after } = applied;
      const normalized = readNormalized(after.source);
      assert.deepEqual(comparable(normalized.lanes), comparable(parserView(after)), label);
      const rewritten = open(writeNormalized(normalized));
      assert.deepEqual(comparable(parserView(rewritten)), comparable(normalized.lanes), `normalizer output: ${label}`);
      compared++;
    }
  }
  assert.ok(compared > 500);
});

test('duplicate then delete the copy restores the file byte for byte, on every card', () => {
  let count = 0;
  for (const name of fixtureNames) {
    const before = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    for (const lane of before.board.lanes) {
      for (const card of lane.cards) {
        const label = `${name} ${lane.index}/${card.index}`;
        const applied = tryApply(name, before, { kind: 'duplicateCard', card: cardIdentity(before.texts, card) });
        if (applied === null) continue;
        const copy = applied.after.board.lanes[lane.index]!.cards[card.index + 1]!;
        const back = apply(applied.after, { kind: 'deleteCard', card: cardIdentity(applied.after.texts, copy) }).after;
        assert.equal(back.source, before.source, label);
        count++;
      }
    }
  }
  assert.ok(count > 50, `only ${count} round trips`);
});

test('4.8 date add / change / remove change one line only, on every card of every fixture', () => {
  const DATE = '2031-01-02';
  let applied = 0;
  let roundTrips = 0;
  const refused: string[] = [];
  for (const name of fixtureNames) {
    const before = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    for (const lane of before.board.lanes) {
      for (const card of lane.cards) {
        const id = cardIdentity(before.texts, card);
        const token = firstDateToken(before.texts, card);
        const requests: BoardRequest[] = token
          ? [{ kind: 'setCardDate', card: id, date: DATE, token: token.text }, { kind: 'removeCardDate', card: id, token: token.text }]
          : [{ kind: 'setCardDate', card: id, date: DATE }];
        for (const request of requests) {
          const label = `${name} ${JSON.stringify(request)}`;
          const target = token?.line ?? dateLineOf(before.texts, card);
          const plan = planBoardRequest(before.texts, before.board, request);
          if (!plan.ok) {
            // Only "add" may be refused: after a comment, inside a code fence, or on a card
            // dated by a daily note link.
            assert.equal(plan.reason, 'unsafe', label);
            assert.equal(token, undefined, label);
            const fenced = findFences(before.texts, card.body.start, card.body.end).some((b) => target >= b.open && target <= b.last);
            assert.ok(fenced || leavesCommentOpen(before.texts[target]) || hasLinkDate(before.texts, card), label);
            refused.push(label);
            continue;
          }
          const { operations, after } = apply(before, request);
          if (request.kind === 'setCardDate' && token === undefined && endsWithTableRow(before.texts, card)) {
            // After a table: the row kept, then a blank body line and the date line (4.8).
            assert.equal(operations.length, 1, label);
            const [op] = operations;
            assert.ok(op.kind === 'replace' && op.start === target && op.end === target + 1 && op.lines.length === 3 && op.lines[0] === before.texts[target], label);
            const kept = [...before.texts.slice(0, target + 1), ...before.texts.slice(target + 1)];
            assert.deepEqual([...after.texts.slice(0, target + 1), ...after.texts.slice(target + 3)], kept, label);
            assert.deepEqual(after.board.lanes.map((l) => [l.name, l.cards.length]), before.board.lanes.map((l) => [l.name, l.cards.length]), label);
            const next = after.board.lanes[lane.index]!.cards[card.index]!;
            assert.equal(firstDateToken(after.texts, next)?.text, `@{${formatDate(DATE, before.board.settings.dateFormat)}}`, label);
            assert.equal(next.body.end - next.body.start, card.body.end - card.body.start + 2, label);
            applied++;
            continue;
          }
          // One line replaced in place (the token's line, or the card's last line with content),
          // or, removing a body line that held only the token, that line deleted.
          assert.equal(operations.length, 1, label);
          const [op] = operations;
          const deleted = op.kind === 'delete';
          if (deleted) {
            assert.ok(request.kind === 'removeCardDate' && target !== card.range.start && op.start === target && op.end === target + 1, label);
            assert.equal(before.texts[target].trim(), token!.text, label);
          } else {
            assert.ok(op.kind === 'replace' && op.start === target && op.end === target + 1 && op.lines.length === 1, label);
          }
          const kept = deleted ? before.texts.filter((_, i) => i !== target) : before.texts;
          assert.equal(after.texts.length, kept.length, label);
          for (let i = 0; i < kept.length; i++) if (deleted || i !== target) assert.equal(after.texts[i], kept[i], `${label} line ${i}`);
          assert.equal(after.source.startsWith('\uFEFF'), before.source.startsWith('\uFEFF'), label);
          assert.deepEqual(fixedParts(after), fixedParts(before), label);
          assert.deepEqual(after.board.lanes.map((l) => [l.name, l.cards.length]), before.board.lanes.map((l) => [l.name, l.cards.length]), label);
          // The normalizing script reads the same structure.
          assert.deepEqual(comparable(readNormalized(after.source).lanes), comparable(parserView(after)), label);
          const next = after.board.lanes[lane.index]!.cards[card.index]!;
          const written = `@{${formatDate(DATE, before.board.settings.dateFormat)}}`;
          if (request.kind === 'setCardDate') {
            assert.equal(firstDateToken(after.texts, next)?.text, written, label);
            assert.equal(next.body.end - next.body.start, card.body.end - card.body.start, label);
            if (token === undefined) {
              // Changing the added date touches the same line only, between the braces.
              const other = `@{${formatDate('2032-03-04', before.board.settings.dateFormat)}}`;
              const changed = apply(after, { kind: 'setCardDate', card: cardIdentity(after.texts, next), date: '2032-03-04', token: written }).after;
              assert.deepEqual(changed.texts, after.texts.map((t, i) => (i === target ? t.slice(0, -written.length) + other : t)), `change: ${label}`);
              // Removing it gives the file back, unless the line ended in whitespace.
              const again = changed.board.lanes[lane.index]!.cards[card.index]!;
              const back = apply(changed, { kind: 'removeCardDate', card: cardIdentity(changed.texts, again), token: other }).after;
              if (before.texts[target] === before.texts[target].trimEnd()) {
                assert.equal(back.source, before.source, `round trip: ${label}`);
                roundTrips++;
              } else {
                assert.deepEqual(back.texts, before.texts.map((t, i) => (i === target ? t.trimEnd() : t)), `round trip: ${label}`);
              }
            }
          } else if (!deleted) {
            // The token (and at most one whitespace next to it, plus trailing whitespace) is gone.
            assert.ok(after.texts[target].length <= before.texts[target].length - token!.text.length, label);
            assert.equal(after.texts[target], after.texts[target].trimEnd(), label);
          }
          applied++;
        }
      }
    }
  }
  assert.ok(applied > 80, `only ${applied} date edits`);
  assert.ok(roundTrips > 40, `only ${roundTrips} round trips`);
  assert.ok(refused.length < 10, refused.join('\n'));
});

test('4.9 the check box switch changes only the settings JSON, on every fixture', () => {
  let switched = 0;
  for (const name of fixtureNames) {
    const o = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    for (const value of [true, false]) {
      const plan = planBoardRequest(o.texts, o.board, { kind: 'setShowCheckboxes', value });
      const block = o.board.settingsBlock;
      if (block === null || !block.valid) {
        assert.ok(!plan.ok && plan.reason === 'unsafe', `${name}: no readable settings block, nothing written`);
        continue;
      }
      const { operations, after } = apply(o, { kind: 'setShowCheckboxes', value });
      switched++;
      // Only lines inside the block change; everything before and after is byte for byte the same.
      for (const op of operations) {
        assert.ok(op.kind === 'replace' && op.start > block.range.start && op.end < block.range.end, `${name}: inside the block`);
      }
      const head = o.texts.slice(0, block.range.start + 1);
      const tail = o.texts.slice(block.range.end - 1);
      assert.deepEqual(after.texts.slice(0, head.length), head, `${name}: lines before the block`);
      assert.deepEqual(after.texts.slice(after.texts.length - tail.length), tail, `${name}: lines after the block`);
      // The value reads back; the other settings and the board stay as they were.
      assert.equal(after.board.settings.showCheckboxes, value, name);
      assert.deepEqual({ ...after.board.settings, showCheckboxes: undefined }, { ...o.board.settings, showCheckboxes: undefined }, name);
      assert.deepEqual(parserView(after), parserView(o), `${name}: same cards and lanes`);
      // Writing the same value again changes nothing.
      const again = planBoardRequest(after.texts, after.board, { kind: 'setShowCheckboxes', value });
      assert.ok(again.ok && again.operations.length === 0, `${name}: no-op when already ${value}`);
    }
  }
  assert.ok(switched >= 10, 'most fixtures have a settings block');
});

test('4.10 the width slider changes only the settings JSON, on every fixture', () => {
  let changed = 0;
  for (const name of fixtureNames) {
    const o = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    const block = o.board.settingsBlock;
    for (const value of [200, 432, undefined]) {
      const request = { kind: 'setLaneWidth', ...(value === undefined ? {} : { value }) } as const;
      const plan = planBoardRequest(o.texts, o.board, request);
      if (o.board.settings.laneWidthIn.frontmatter) {
        assert.ok(!plan.ok && plan.reason === 'unsafe', `${name}: Obsidian uses the frontmatter value`);
        continue;
      }
      if (value === undefined && !o.board.settings.laneWidthIn.block) {
        assert.ok(plan.ok && plan.operations.length === 0, `${name}: nothing to reset`);
        continue;
      }
      if (block === null || !block.valid) {
        assert.ok(!plan.ok && plan.reason === 'unsafe', `${name}: no readable settings block, nothing written`);
        continue;
      }
      const { operations, after } = apply(o, request);
      changed++;
      for (const op of operations) {
        assert.ok(op.kind === 'replace' && op.start > block.range.start && op.end < block.range.end, `${name}: inside the block`);
      }
      const head = o.texts.slice(0, block.range.start + 1);
      const tail = o.texts.slice(block.range.end - 1);
      assert.deepEqual(after.texts.slice(0, head.length), head, `${name}: lines before the block`);
      assert.deepEqual(after.texts.slice(after.texts.length - tail.length), tail, `${name}: lines after the block`);
      assert.equal(after.board.settings.laneWidth, value, name);
      assert.equal(after.board.settings.laneWidthIn.block, value !== undefined, name);
      const others = (s: typeof o.board.settings) => ({ ...s, laneWidth: undefined, laneWidthIn: undefined });
      assert.deepEqual(others(after.board.settings), others(o.board.settings), name);
      assert.deepEqual(parserView(after), parserView(o), `${name}: same cards and lanes`);
      const again = planBoardRequest(after.texts, after.board, request);
      assert.ok(again.ok && again.operations.length === 0, `${name}: no-op the second time`);
    }
  }
  assert.ok(changed >= 20, `only ${changed} width changes`);
});
