import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, computePatch, type TextEdit } from '../../../src/core/patch.ts';
import {
  bodyIndentUnit,
  cardEditText,
  decodeBodyLine,
  encodeBodyLine,
  indentUnitFor,
} from '../../../src/features/kanban/card-text.ts';
import { cardIdentity } from '../../../src/features/kanban/model.ts';
import { planBoardRequest, type PlanOptions } from '../../../src/features/kanban/operations.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';

function open(source: string) {
  const doc = parseLines(source);
  const texts = lineTexts(doc);
  return { doc, texts, board: parseBoard(texts) };
}

function cardOf(source: string, lane = 0, index = 0) {
  const { texts, board } = open(source);
  const card = board.lanes[lane]?.cards[index];
  assert.ok(card);
  return { texts, card };
}

function edit(source: string, text: string, options: PlanOptions = {}, lane = 0, index = 0) {
  const { doc, texts, board } = open(source);
  const card = board.lanes[lane]!.cards[index]!;
  const plan = planBoardRequest(texts, board, { kind: 'editCardText', card: cardIdentity(texts, card), text }, options);
  if (!plan.ok) return { reason: plan.reason, output: source, edits: [] as TextEdit[], operations: [] };
  const result = computePatch(doc, 1, { expectedVersion: 1, ...plan });
  assert.ok(result.ok);
  return { reason: undefined, output: applyEdits(doc, result.edits), edits: [...result.edits], operations: plan.operations };
}

// --- edit text (card-text.ts) ---

test('edit text: title, then body lines without one indentation step', () => {
  const { texts, card } = cardOf('## A\n- [ ] title \n\t- one\n\t\tdeeper\n\n\tafter blank\n');
  assert.equal(cardEditText(texts, card), 'title \n- one\n\tdeeper\n\nafter blank');
  assert.equal(bodyIndentUnit(texts, card), '\t');
});

test('four spaces are one step; two spaces are kept as written', () => {
  assert.equal(decodeBodyLine('    x'), 'x');
  assert.equal(decodeBodyLine('      x'), '  x');
  assert.equal(decodeBodyLine('  x'), '  x');
  assert.equal(decodeBodyLine('\t\tx'), '\tx');
  assert.equal(decodeBodyLine(' \t '), '');
  assert.equal(encodeBodyLine('x', '\t'), '\tx');
  assert.equal(encodeBodyLine('', '    '), '    ');
});

test('fixture 12: tab card, mixed-space card and tab card with a blank body line', () => {
  const source = readFileSync(new URL('../../fixtures/kanban/12-multiline-cards.md', import.meta.url), 'utf8');
  const { texts, board } = open(source);
  const [tabCard, spaceCard, blankCard] = board.lanes[0]!.cards;
  assert.ok(tabCard && spaceCard && blankCard);
  assert.equal(bodyIndentUnit(texts, tabCard), '\t');
  assert.equal(bodyIndentUnit(texts, spaceCard), '    ');
  // "  이어지는 설명 줄" keeps its two spaces; "    네 칸 ..." loses four.
  assert.deepEqual(cardEditText(texts, spaceCard).split('\n').slice(1), ['  이어지는 설명 줄', '네 칸 들여쓰기 줄']);
  assert.deepEqual(cardEditText(texts, blankCard).split('\n').slice(1), ['본문', '', '빈 줄 뒤에도 이어지는 본문']);
});

test('indentation for new lines: body first, then useTab, then tab', () => {
  const tab = cardOf('## A\n- [ ] a\n\tbody\n');
  const spaces = cardOf('## A\n- [ ] a\n  two\n');
  const none = cardOf('## A\n- [ ] a\n');
  assert.equal(indentUnitFor(tab.texts, tab.card, false), '\t');
  assert.equal(indentUnitFor(spaces.texts, spaces.card, true), '    ');
  assert.equal(indentUnitFor(none.texts, none.card), '\t');
  assert.equal(indentUnitFor(none.texts, none.card, false), '    ');
});

// --- editCardText (operations.ts) ---

test('saving the edit text unchanged changes nothing', () => {
  const source = '## A\n- [x]tight \n\t- one\n  two\n\n\tthree\n- [ ] next\n';
  const { texts, card } = cardOf(source);
  const result = edit(source, cardEditText(texts, card));
  assert.deepEqual(result.operations, []);
  assert.equal(result.output, source);
});

test('a title change touches only the text after the check mark', () => {
  const { output, edits } = edit('## A\n- [ ] old\n\tbody\n', 'new\nbody');
  assert.equal(output, '## A\n- [ ] new\n\tbody\n');
  assert.deepEqual(edits, [{ range: { start: { line: 1, character: 6 }, end: { line: 1, character: 9 } }, newText: 'new' }]);
  // Without a space after it, `[x]` is title text (kanban.md 2.5).
  assert.equal(edit('## A\n- [x]tight\n', 'changed').output, '## A\n- changed\n');
});

test('new body lines use the card indentation; unchanged lines keep their bytes', () => {
  const src = '## A\n- [ ] a\n\tone\n  two\n\tthree\n- [ ] b\n';
  // Edit the middle tab line, keep the two-space line, add a line at the end.
  const { output, operations } = edit(src, 'a\none!\n  two\nthree\nfour');
  assert.equal(output, '## A\n- [ ] a\n\tone!\n  two\n\tthree\n\tfour\n- [ ] b\n');
  assert.deepEqual(
    operations.map((op) => op.kind),
    ['replace', 'insert'],
  );
  const spaced = edit('## A\n- [ ] a\n    one\n', 'a\none\ntwo');
  assert.equal(spaced.output, '## A\n- [ ] a\n    one\n    two\n');
});

test('cards without a body follow useTab', () => {
  assert.equal(edit('## A\n- [ ] a\n', 'a\nnew').output, '## A\n- [ ] a\n\tnew\n');
  assert.equal(edit('## A\n- [ ] a\n', 'a\nnew', { useTab: false }).output, '## A\n- [ ] a\n    new\n');
  assert.equal(edit('## A\n- [ ] a\n\tb\n', 'a\nb\nnew', { useTab: false }).output, '## A\n- [ ] a\n\tb\n\tnew\n');
});

test('blank lines become one indentation step; trailing blank lines are dropped', () => {
  assert.equal(edit('## A\n- [ ] a\n', 'a\none\n\ntwo\n\n\n').output, '## A\n- [ ] a\n\tone\n\t\n\ttwo\n');
});

test('deleting body lines removes only those lines', () => {
  assert.equal(edit('## A\n- [ ] a\n\tone\n\ttwo\n\tthree\n- [ ] b\n', 'a\none\nthree').output, '## A\n- [ ] a\n\tone\n\tthree\n- [ ] b\n');
  assert.equal(edit('## A\n- [ ] a\n\tone\n\n\ttwo\n', 'a').output, '## A\n- [ ] a\n');
});

test('CRLF documents keep CRLF on new lines', () => {
  assert.equal(edit('## A\r\n- [ ] a\r\n\tone\r\n', 'a\none\ntwo').output, '## A\r\n- [ ] a\r\n\tone\r\n\ttwo\r\n');
});

test('empty first line or CR is invalid', () => {
  assert.equal(edit('## A\n- [ ] a\n', '\nbody').reason, 'invalid');
  assert.equal(edit('## A\n- [ ] a\n', '   \nbody').reason, 'invalid');
  assert.equal(edit('## A\n- [ ] a\n', 'a\r\nbody').reason, 'invalid');
});

test('an edit that would not read back as the same card is unsafe', () => {
  // An unclosed fence would swallow the following card.
  assert.equal(edit('## A\n- [ ] a\n- [ ] b\n', 'a\n```').reason, 'unsafe');
  // A closed fence is fine.
  assert.equal(edit('## A\n- [ ] a\n- [ ] b\n', 'a\n```\n## not a lane\n```').output, '## A\n- [ ] a\n\t```\n\t## not a lane\n\t```\n- [ ] b\n');
});

test('old <br> text is kept as written', () => {
  assert.equal(edit('## A\n- [ ] a<br>b\n', 'a<br>b\nc').output, '## A\n- [ ] a<br>b\n\tc\n');
});

// --- fixture 25: cards written by Obsidian Kanban 2.x ---

const OBSIDIAN = readFileSync(new URL('../../fixtures/kanban/25-obsidian-multiline.md', import.meta.url), 'utf8');

/** How Obsidian Kanban 2.x writes a card: check mark + first line, then each further line with one tab. */
function obsidianLines(check: string | null, text: string): string[] {
  const [title, ...rest] = text.split('\n');
  return [`- [${check}] ${title}`, ...rest.map((line) => `\t${line}`)];
}

test('fixture 25: edit text is the Obsidian dedent of each card', () => {
  const { texts, board } = open(OBSIDIAN);
  const [first, second] = board.lanes[0]!.cards;
  assert.ok(first && second);
  assert.equal(
    cardEditText(texts, first),
    'TASK-001\n- TASK-001.01: 세부 작업\n\t- TA\n\t- TB\n\t- TC\n- TASK-002.01: 두 번째 세부 작업\n\t- `마크다운 표기법`',
  );
  assert.equal(cardEditText(texts, second), 'TASK-002\n==**이 태스크는 매우 중요하다**==');
  // Re-serializing like Obsidian gives back the exact original lines: an Obsidian save does not change them.
  for (const card of [first, second]) {
    assert.deepEqual(obsidianLines(card.check, cardEditText(texts, card)), texts.slice(card.range.start, card.range.end));
  }
});

test('fixture 25: unchanged save is a no-op; one sub-item edit patches only that line', () => {
  const { texts, board } = open(OBSIDIAN);
  const first = board.lanes[0]!.cards[0]!;
  assert.deepEqual(edit(OBSIDIAN, cardEditText(texts, first)).operations, []);
  const changed = cardEditText(texts, first).replace('\t- TB', '\t- TB (완료)');
  const { output, edits } = edit(OBSIDIAN, changed);
  assert.deepEqual(edits, [{ range: { start: { line: 11, character: 6 }, end: { line: 11, character: 6 } }, newText: ' (완료)' }]);
  assert.equal(output, OBSIDIAN.replace('\t\t- TB\n', '\t\t- TB (완료)\n'));
});

test('fixture 25: new lines use a tab; highlight and inline code stay as written', () => {
  const { texts, board } = open(OBSIDIAN);
  const second = board.lanes[0]!.cards[1]!;
  const { output } = edit(OBSIDIAN, `${cardEditText(texts, second)}\n- 새 하위 항목\n\t- 더 깊은 \`코드\``, {}, 0, 1);
  assert.ok(output.includes('\t==**이 태스크는 매우 중요하다**==\n\t- 새 하위 항목\n\t\t- 더 깊은 `코드`\n'));
  // The result still round-trips through the Obsidian serialization.
  const after = open(output);
  const card = after.board.lanes[0]!.cards[1]!;
  assert.deepEqual(obsidianLines(card.check, cardEditText(after.texts, card)), after.texts.slice(card.range.start, card.range.end));
  // Everything outside the card, including the blank lines between lanes and the settings block, is unchanged.
  assert.deepEqual(after.texts.slice(card.range.end), open(OBSIDIAN).texts.slice(second.range.end));
});
