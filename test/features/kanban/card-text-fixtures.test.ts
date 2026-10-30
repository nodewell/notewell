// kanban.md 4.4 over every card of every fixture: unchanged save is a no-op, only the
// card's changed lines are rewritten, the card reads back as the edited text, repeat
// saves are stable, and the normalizing script still sees the same structure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, computePatch } from '../../../src/core/patch.ts';
import { cardEditText, decodeBodyLine } from '../../../src/features/kanban/card-text.ts';
import { cardIdentity, type KanbanBoard } from '../../../src/features/kanban/model.ts';
import { planBoardRequest } from '../../../src/features/kanban/operations.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { readNormalized } from '../../support/normalizer.ts';

const fixtureDir = new URL('../../fixtures/kanban/', import.meta.url);
const fixtureNames = readdirSync(fixtureDir).filter((name) => /^\d\d-.*\.md$/.test(name));
// Only the unclosed-fence fixture may refuse edits as unsafe.
const UNSAFE_ALLOWED = new Set(['13-code-fences.md']);

interface Opened {
  source: string;
  texts: string[];
  board: KanbanBoard;
}

function open(source: string): Opened {
  const texts = lineTexts(parseLines(source));
  return { source, texts, board: parseBoard(texts) };
}

/** Applies editCardText; null when refused as unsafe. */
function save(o: Opened, lane: number, index: number, text: string, useTab = true) {
  const card = o.board.lanes[lane]!.cards[index]!;
  const plan = planBoardRequest(o.texts, o.board, { kind: 'editCardText', card: cardIdentity(o.texts, card), text }, { useTab });
  if (!plan.ok && plan.reason === 'unsafe') return null;
  assert.ok(plan.ok, plan.ok ? '' : `${plan.reason}: ${plan.message}`);
  const doc = parseLines(o.source);
  const result = computePatch(doc, 1, { expectedVersion: 1, ...plan });
  assert.ok(result.ok);
  return { operations: plan.operations, after: open(applyEdits(doc, result.edits)) };
}

/** Variations of a card's edit text that exercise title and body changes. */
function variations(text: string): { name: string; text: string }[] {
  const [title, ...body] = text.split('\n');
  const out = [
    { name: 'title', text: [`${title} (수정)`, ...body].join('\n') },
    { name: 'append', text: [title, ...body, '추가 줄 #태그'].join('\n') },
    { name: 'prepend', text: [title, '맨 앞 줄', ...body].join('\n') },
    { name: 'blank', text: [title, ...body, '', '빈 줄 뒤 줄'].join('\n') },
  ];
  if (body.length > 0) {
    out.push({ name: 'delete-first', text: [title, ...body.slice(1)].join('\n') });
    out.push({ name: 'modify-last', text: [title, ...body.slice(0, -1), `${body[body.length - 1]} 고침`].join('\n') });
    out.push({ name: 'clear-body', text: title! });
  }
  return out;
}

/** Edit text as it reads back: trailing blank lines are dropped on save. */
function normalized(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const [title, ...body] = lines;
  return [title!.trim() === title ? title : title!.trim(), ...body].join('\n');
}

test('editCardText on every card of every fixture', () => {
  let edits = 0;
  let unsafe = 0;
  for (const name of fixtureNames) {
    const before = open(readFileSync(new URL(name, fixtureDir), 'utf8'));
    for (const lane of before.board.lanes) {
      for (const card of lane.cards) {
        const label = `${name} ${lane.index}/${card.index}`;
        const text = cardEditText(before.texts, card);
        // Unchanged save: no operations at all.
        assert.deepEqual(save(before, lane.index, card.index, text)?.operations, [], `unchanged: ${label}`);

        for (const variation of variations(text)) {
          const what = `${label} ${variation.name}`;
          const saved = save(before, lane.index, card.index, variation.text);
          if (saved === null) {
            assert.ok(UNSAFE_ALLOWED.has(name), `unsafe: ${what}`);
            unsafe++;
            continue;
          }
          const { after, operations } = saved;
          const edited = after.board.lanes[lane.index]!.cards[card.index]!;
          // Lines outside the card are unchanged and in place.
          assert.deepEqual(after.texts.slice(0, card.range.start), before.texts.slice(0, card.range.start), what);
          assert.deepEqual(after.texts.slice(edited.range.end), before.texts.slice(card.range.end), what);
          // Only the card's own lines are touched.
          for (const op of operations) {
            const start = op.kind === 'insert' ? op.at : op.start;
            const end = op.kind === 'insert' ? op.at : op.end;
            assert.ok(start >= card.range.start && end <= card.range.end, `op outside card: ${what}`);
          }
          // The card reads back as exactly the saved text.
          assert.equal(cardEditText(after.texts, edited), normalized(variation.text), what);
          // Body lines whose decoded text survived keep their original bytes.
          const kept = new Set(after.texts.slice(edited.body.start, edited.body.end));
          for (let i = card.body.start; i < card.body.end; i++) {
            const original = before.texts[i]!;
            if (normalized(variation.text).split('\n').slice(1).includes(decodeBodyLine(original)) && decodeBodyLine(original) !== '') {
              assert.ok(kept.has(original), `bytes changed for kept line: ${what}`);
            }
          }
          // Saving the same text again is a no-op.
          assert.deepEqual(save(after, lane.index, card.index, variation.text)?.operations, [], `repeat: ${what}`);
          // The normalizing script sees the same cards and bodies (bodies compared without
          // trailing blank lines, which only an unclosed fence produces; see operations-fixtures.test.ts).
          const trimTail = (lines: readonly string[]): string[] => {
            const out = [...lines];
            while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
            return out;
          };
          const normal = readNormalized(after.source);
          assert.deepEqual(
            normal.lanes.map((l) => l.cards.map((c) => [c.line, ...trimTail(c.body)])),
            after.board.lanes.map((l) =>
              l.cards.map((c) => [after.texts[c.range.start], ...trimTail(after.texts.slice(c.body.start, c.body.end))]),
            ),
            `normalizer: ${what}`,
          );
          edits++;
        }
      }
    }
  }
  assert.ok(edits > 200, `only ${edits} edits`);
  assert.ok(unsafe < 20, `${unsafe} unsafe refusals`);
});

test('useTab decides only for cards without a body', () => {
  const source = readFileSync(new URL('12-multiline-cards.md', fixtureDir), 'utf8');
  const o = open(source);
  const last = o.board.lanes[0]!.cards.length - 1;
  const bare = o.board.lanes[0]!.cards[last]!;
  assert.equal(bare.body.end - bare.body.start, 0);
  const title = cardEditText(o.texts, bare);
  const withTab = save(o, 0, last, `${title}\n새 줄`, true)!.after;
  const withSpaces = save(o, 0, last, `${title}\n새 줄`, false)!.after;
  assert.equal(withTab.texts[bare.range.start + 1], '\t새 줄');
  assert.equal(withSpaces.texts[bare.range.start + 1], '    새 줄');
  // A card with a two-space body still uses its own (space) step, regardless of useTab.
  const spaceCard = o.board.lanes[0]!.cards[1]!;
  const spaced = save(o, 0, 1, `${cardEditText(o.texts, spaceCard)}\n새 줄`, true)!.after;
  assert.equal(spaced.texts[spaceCard.range.end], '    새 줄');
});
