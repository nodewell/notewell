import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, computePatch, type TextEdit } from '../../../src/core/patch.ts';
import { cardIdentity, type KanbanBoard } from '../../../src/features/kanban/model.ts';
import { planBoardRequest, type BoardRequest, type LaneIdentity } from '../../../src/features/kanban/operations.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/kanban/${name}`, import.meta.url), 'utf8');
}

function open(source: string, doneLanes: string[] = []) {
  const doc = parseLines(source);
  const texts = lineTexts(doc);
  return { doc, texts, board: parseBoard(texts, { doneLanes }) };
}

function card(board: KanbanBoard, texts: string[], lane: number, index: number) {
  const found = board.lanes[lane]?.cards[index];
  assert.ok(found, `card ${lane}/${index}`);
  return cardIdentity(texts, found);
}

function lane(board: KanbanBoard, texts: string[], index: number): LaneIdentity {
  const found = board.lanes[index];
  assert.ok(found, `lane ${index}`);
  return { laneIndex: index, heading: texts[found.headingLine] };
}

/** Plans the request built from the parsed board, patches, and returns the new source. */
function run(source: string, build: (board: KanbanBoard, texts: string[]) => BoardRequest, doneLanes: string[] = []) {
  const { doc, texts, board } = open(source, doneLanes);
  const plan = planBoardRequest(texts, board, build(board, texts));
  assert.ok(plan.ok, plan.ok ? '' : `${plan.reason}: ${plan.message}`);
  const result = computePatch(doc, 1, { expectedVersion: 1, expectedLines: plan.expectedLines, operations: plan.operations });
  assert.ok(result.ok, result.ok ? '' : `${result.reason}: ${result.message}`);
  return { output: applyEdits(doc, result.edits), edits: result.edits as TextEdit[] };
}

function refuse(source: string, build: (board: KanbanBoard, texts: string[]) => BoardRequest) {
  const { texts, board } = open(source);
  const plan = planBoardRequest(texts, board, build(board, texts));
  assert.equal(plan.ok, false);
  return plan.ok ? undefined : plan.reason;
}

const BOARD = ['---', 'kanban-plugin: basic', '---', '', '## Todo', '', '- [ ] one', '\t- body', '- [x] two', '', '## Done', '', '**Complete**', '- [x] three', ''].join('\n');

// --- 7.1 toggle and title ---

test('toggle changes exactly the check character', () => {
  const { output, edits } = run(BOARD, (b, t) => ({ kind: 'toggleCard', card: card(b, t, 0, 0) }));
  assert.equal(output, BOARD.replace('- [ ] one', '- [x] one'));
  assert.deepEqual(edits, [{ range: { start: { line: 6, character: 3 }, end: { line: 6, character: 4 } }, newText: 'x' }]);
  assert.equal(run(BOARD, (b, t) => ({ kind: 'toggleCard', card: card(b, t, 0, 1) })).output, BOARD.replace('- [x] two', '- [ ] two'));
});

test('toggle of [X] or another check character unchecks; a card without a check box gets [x]', () => {
  const src = '## A\n- [X] big\n- [x]tight\n- plain\n- [/] half\n- [ ]\n';
  const toggled = (index: number) => run(src, (b, t) => ({ kind: 'toggleCard', card: card(b, t, 0, index) })).output.split('\n')[index + 1];
  // `[x]tight` has no space after the box, so it is title text (kanban.md 2.5).
  assert.deepEqual([0, 1, 2, 3, 4].map(toggled), ['- [ ] big', '- [x] [x]tight', '- [x] plain', '- [ ] half', '- [x]']);
  assert.equal(run('## A\n1) [ ] one\n', (b, t) => ({ kind: 'toggleCard', card: card(b, t, 0, 0) })).output, '## A\n1) [x] one\n');
  assert.equal(refuse('## A\n-\n', (b, t) => ({ kind: 'toggleCard', card: card(b, t, 0, 0) })), 'invalid', 'an empty card');
});

// Title edits are card text edits whose first line changed (kanban.md 4.4).
test('title edit changes only the text after the check mark', () => {
  const { output, edits } = run(BOARD, (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text: 'uno\n- body' }));
  assert.equal(output, BOARD.replace('- [ ] one', '- [ ] uno'));
  assert.deepEqual(edits, [{ range: { start: { line: 6, character: 6 }, end: { line: 6, character: 9 } }, newText: 'uno' }]);
  // `[x]tight` is the title of a card without a check box.
  const tight = run('## A\n- [x]tight\n', (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text: 'new' }));
  assert.equal(tight.output, '## A\n- new\n');
  assert.equal(run('## A\n- [ ]\n', (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text: 'new' })).output, '## A\n- [ ] new\n');
  assert.equal(run('## A\n* plain\n', (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text: 'new' })).output, '## A\n* new\n');
  // A title that would read back as a check box is refused.
  assert.equal(refuse('## A\n- plain\n', (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text: '[x] new' })), 'unsafe');
});

test('a changed title is trimmed; an empty title or CR is refused', () => {
  assert.equal(
    run(BOARD, (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text: '  spaced  \n- body' })).output,
    BOARD.replace('- [ ] one', '- [ ] spaced'),
  );
  for (const text of ['', '   ', '\n- body', 'a\rb']) {
    assert.equal(refuse(BOARD, (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text })), 'invalid');
  }
});

test('stale card identity is refused', () => {
  assert.equal(
    refuse(BOARD, () => ({ kind: 'toggleCard', card: { laneIndex: 0, cardIndex: 0, firstLine: '- [ ] other' } })),
    'stale',
  );
  assert.equal(refuse(BOARD, () => ({ kind: 'toggleCard', card: { laneIndex: 0, cardIndex: 5, firstLine: '- [ ] one' } })), 'stale');
  assert.equal(refuse(BOARD, () => ({ kind: 'toggleCard', card: { laneIndex: 9, cardIndex: 0, firstLine: '- [ ] one' } })), 'stale');
});

// --- 7.2 move and add ---

test('move a card with its body to another lane', () => {
  const { output } = run(BOARD, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 1 }));
  assert.equal(
    output,
    ['---', 'kanban-plugin: basic', '---', '', '## Todo', '', '- [x] two', '', '## Done', '', '**Complete**', '- [x] three', '- [x] one', '\t- body', ''].join(
      '\n',
    ),
  );
});

test('moving into a done lane checks, out of one unchecks, otherwise unchanged', () => {
  const into = run(BOARD, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 0 })).output;
  assert.ok(into.includes('**Complete**\n- [x] one\n\t- body\n- [x] three'));
  const out = run(BOARD, (b, t) => ({ kind: 'moveCard', card: card(b, t, 1, 0), toLane: lane(b, t, 0), toIndex: 0 })).output;
  assert.ok(out.includes('## Todo\n\n- [ ] three\n- [ ] one'));
  // Between ordinary lanes the check stays as it is.
  const plain = '## A\n- [x] done here\n## B\n- [ ] b\n';
  assert.equal(
    run(plain, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 1 })).output,
    '## A\n## B\n- [ ] b\n- [x] done here\n',
  );
  // Done to done keeps the check, including [X].
  const twoDone = '## D1\n**Complete**\n- [X] big\n## D2\n**Complete**\n';
  assert.ok(
    run(twoDone, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 0 })).output.includes('- [X] big'),
  );
});

test('doneLanes setting makes a lane a done lane by name', () => {
  const src = '## 할 일\n- [ ] a\n## 완료\n- [x] b\n';
  const output = run(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 1 }), ['완료']).output;
  assert.equal(output, '## 할 일\n## 완료\n- [x] b\n- [x] a\n');
});

test('move within a lane keeps interstitial lines in place', () => {
  // Between cards of one list only blank lines can stand (a comment would end the list, 2.5).
  const src = '## A\n- [ ] one\n\n\n- [ ] two\n- [ ] three\n\n<!-- note -->\n';
  const { output } = run(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 0), toIndex: 2 }));
  assert.equal(output, '## A\n\n\n- [ ] two\n- [ ] three\n- [ ] one\n\n<!-- note -->\n');
  const back = run(output, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 2), toLane: lane(b, t, 0), toIndex: 0 })).output;
  assert.equal(back, '## A\n\n\n- [ ] one\n- [ ] two\n- [ ] three\n\n<!-- note -->\n');
});

test('moving to the same position does nothing', () => {
  const { texts, board } = open(BOARD);
  const plan = planBoardRequest(texts, board, { kind: 'moveCard', card: card(board, texts, 0, 1), toLane: lane(board, texts, 0), toIndex: 1 });
  assert.deepEqual(plan, { ok: true, operations: [], expectedLines: [] });
});

test('insert positions follow 4.1', () => {
  // Before the N-th card.
  assert.equal(run(BOARD, (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), index: 1, title: 'new' })).output, BOARD.replace('- [x] two', '- [ ] new\n- [x] two'));
  // End of lane: right after the last card's range (its body included).
  assert.equal(
    run('## A\n- [ ] a\n\t- body\n\n## B\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'new' })).output,
    '## A\n- [ ] a\n\t- body\n- [ ] new\n\n## B\n',
  );
  // Empty lane with a blank line after the heading: after that blank line.
  assert.equal(
    run('## A\n\n\n## B\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'new' })).output,
    '## A\n\n- [ ] new\n\n## B\n',
  );
  // Empty lane without a blank line: right after the heading, with one blank line.
  assert.equal(
    run('## A\n## B\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'new' })).output,
    '## A\n\n- [ ] new\n## B\n',
  );
  // Empty lane at the end of a file without trailing newline.
  assert.equal(run('## A', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'new' })).output, '## A\n\n- [ ] new');
});

test('add card uses [ ] and the dominant EOL; bad index or title refused', () => {
  assert.equal(
    run('## A\r\n- [ ] a\r\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), index: 0, title: 'b' })).output,
    '## A\r\n- [ ] b\r\n- [ ] a\r\n',
  );
  assert.equal(refuse(BOARD, (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), index: 3, title: 'x' })), 'invalid');
  assert.equal(refuse(BOARD, (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), index: -1, title: 'x' })), 'invalid');
  assert.equal(refuse(BOARD, (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: ' ' })), 'invalid');
  assert.equal(refuse(BOARD, () => ({ kind: 'addCard', lane: { laneIndex: 0, heading: '## Other' }, title: 'x' })), 'stale');
});

test('move into an empty lane of fixture 02', () => {
  const src = fixture('02-empty-lanes.md');
  const { texts, board } = open(src);
  assert.ok(board.lanes.length >= 2 && board.lanes.every((l) => l.cards.length === 0));
  const output = run(src, (b, t) => ({ kind: 'addCard', lane: lane(b, t, 1), title: 'first' })).output;
  const after = open(output);
  assert.deepEqual(after.board.lanes.map((l) => l.cards.length), board.lanes.map((_, i) => (i === 1 ? 1 : 0)));
  assert.equal(after.texts.length, texts.length + (texts[board.lanes[1].headingLine + 1]?.trim() === '' ? 1 : 2));
});

test('move card index is a final position and is range-checked', () => {
  assert.equal(
    refuse(BOARD, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 0), toIndex: 2 })),
    'invalid',
  );
  assert.equal(
    refuse(BOARD, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: { laneIndex: 1, heading: '## Todo' }, toIndex: 0 })),
    'stale',
  );
});

// --- 7.3 lanes ---

test('move a lane: whole range', () => {
  const src = '## A\n- [ ] a\n\n## B\n- [ ] b\n\n## C\n- [ ] c\n';
  assert.equal(run(src, (b, t) => ({ kind: 'moveLane', lane: lane(b, t, 2), toIndex: 0 })).output, '## C\n- [ ] c\n## A\n- [ ] a\n\n## B\n- [ ] b\n\n');
  assert.equal(run(src, (b, t) => ({ kind: 'moveLane', lane: lane(b, t, 0), toIndex: 2 })).output, '## B\n- [ ] b\n\n## C\n- [ ] c\n## A\n- [ ] a\n\n');
  assert.equal(run(src, (b, t) => ({ kind: 'moveLane', lane: lane(b, t, 0), toIndex: 1 })).output, '## B\n- [ ] b\n\n## A\n- [ ] a\n\n## C\n- [ ] c\n');
  assert.equal(refuse(src, (b, t) => ({ kind: 'moveLane', lane: lane(b, t, 0), toIndex: 3 })), 'invalid');
});

test('lane move keeps the settings block and archive where they are', () => {
  const src = fixture('14-archive.md');
  const { texts, board } = open(src);
  const output = run(src, (b, t) => ({ kind: 'moveLane', lane: lane(b, t, 1), toIndex: 0 })).output;
  const after = open(output);
  assert.deepEqual(after.board.lanes.map((l) => l.name), [board.lanes[1].name, board.lanes[0].name]);
  const archive = board.archive;
  assert.ok(archive && after.board.archive);
  assert.deepEqual(after.texts.slice(after.board.archive.start), texts.slice(archive.start));
});

test('rename changes only the heading text and keeps its prefix', () => {
  const { output, edits } = run('##   Old  \n- [ ] a\n', (b, t) => ({ kind: 'renameLane', lane: lane(b, t, 0), name: 'New' }));
  assert.equal(output, '##   New\n- [ ] a\n');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].range.start.line, 0);
  assert.equal(edits[0].range.end.line, 0);
  assert.equal(refuse('## A\n', (b, t) => ({ kind: 'renameLane', lane: lane(b, t, 0), name: 'a\nb' })), 'invalid');
  assert.equal(refuse('## A\n', (b, t) => ({ kind: 'renameLane', lane: lane(b, t, 0), name: '' })), 'invalid');
});

// --- other heading and list shapes (kanban.md 2.4, 2.5, 4.1) ---

test('rename keeps the heading level, drops closing #s, and renames a setext heading on its text line', () => {
  const rename = (src: string, index = 0) => run(src, (b, t) => ({ kind: 'renameLane', lane: lane(b, t, index), name: 'New' })).output;
  assert.equal(rename('# One\n- [ ] a\n'), '# New\n- [ ] a\n');
  assert.equal(rename(' ### Three ###\n'), ' ### New\n');
  assert.equal(rename('##\n'), '## New\n');
  assert.equal(rename('Todo\n====\n- [ ] a\n'), 'New\n====\n- [ ] a\n');
  assert.equal(rename('## A\n\n Two\nlines\n---\n', 1), '## A\n\n New\n---\n');
  // A name that would not read back as the lane name is refused.
  assert.equal(refuse('## A\n', (b, t) => ({ kind: 'renameLane', lane: lane(b, t, 0), name: 'B #' })), 'unsafe');
  assert.equal(refuse('A\n===\n', (b, t) => ({ kind: 'renameLane', lane: lane(b, t, 0), name: '- B' })), 'unsafe');
});

test('cards keep their list: an added or moved card takes the marker of the lane list', () => {
  const src = '## Star\n\n* [ ] s1\n* s2\n\n## Ordered\n\n3. [ ] o3\n4. [ ] o4\n\n## Paren\n\n1) [ ] p1\n\n## Empty\n';
  const add = (laneIndex: number, index: number) =>
    run(src, (b, t) => ({ kind: 'addCard', lane: lane(b, t, laneIndex), index, title: 'new' })).output.split('\n');
  assert.equal(add(0, 1)[3], '* [ ] new');
  // Ordered: the card before it plus one, or the number of the card after it at the front.
  assert.equal(add(1, 0)[7], '3. [ ] new');
  assert.equal(add(1, 1)[8], '4. [ ] new');
  assert.equal(add(1, 2)[9], '5. [ ] new');
  assert.equal(add(2, 1)[13], '2) [ ] new');
  assert.equal(add(3, 0)[16], '- [ ] new');

  const move = (toLane: number, toIndex: number) =>
    run(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 1), toLane: lane(b, t, toLane), toIndex })).output;
  // Only the marker changes; a card without a check box stays without one.
  assert.ok(move(1, 1).includes('3. [ ] o3\n4. s2\n4. [ ] o4\n'));
  assert.ok(move(2, 0).includes('1) s2\n1) [ ] p1\n'));
  assert.ok(move(3, 0).endsWith('## Empty\n\n- s2\n'));
  // The same kind keeps its own marker (and number).
  const same = run('## A\n1. [ ] a\n## B\n7. [ ] b\n', (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 1 }));
  assert.equal(same.output, '## A\n## B\n7. [ ] b\n1. [ ] a\n');
});

test('a card without a check box gets [x] in a done lane; moving out only unchecks a box', () => {
  const src = '## Todo\n\n- plain\n- [ ] boxed\n\n## Done\n\n**Complete**\n- [/] half\n- done plain\n';
  const toDone = run(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 0 })).output;
  assert.ok(toDone.includes('**Complete**\n- [x] plain\n- [/] half\n'));
  const outOfDone = (index: number) => run(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 1, index), toLane: lane(b, t, 0), toIndex: 0 })).output;
  assert.ok(outOfDone(0).includes('\n- [ ] half\n- plain\n'));
  assert.ok(outOfDone(1).includes('\n- done plain\n- plain\n'));
});

test('insertion into a lane without cards: after the **Complete** line, and a blank line before a following paragraph', () => {
  // The done mark must stay before the lane's first list (2.7), as Obsidian writes it.
  assert.equal(
    run('## Done\n\n**Complete**\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'new' })).output,
    '## Done\n\n**Complete**\n- [x] new\n',
  );
  // Without the blank line the paragraph would become the card's lazy continuation (2.5).
  assert.equal(
    run('## A\n\nSome text\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'new' })).output,
    '## A\n\n- [ ] new\n\nSome text\n',
  );
  assert.equal(
    run('## A\nSome text\n## B\n- [ ] b\n', (b, t) => ({ kind: 'moveCard', card: card(b, t, 1, 0), toLane: lane(b, t, 0), toIndex: 0 })).output,
    '## A\n\n- [ ] b\n\nSome text\n## B\n',
  );
  // Setext heading: after its underline.
  assert.equal(run('A\n===\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'new' })).output, 'A\n===\n\n- [ ] new\n');
});

test('lazy continuation lines move, duplicate and edit with their card', () => {
  const src = '## A\n- [ ] a\nlazy a\n- [ ] b\n\n## B\n- [ ] c\n';
  assert.equal(
    run(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 1 })).output,
    '## A\n- [ ] b\n\n## B\n- [ ] c\n- [ ] a\nlazy a\n',
  );
  assert.equal(run(src, (b, t) => ({ kind: 'duplicateCard', card: card(b, t, 0, 0) })).output, '## A\n- [ ] a\nlazy a\n- [ ] a\nlazy a\n- [ ] b\n\n## B\n- [ ] c\n');
  // An unchanged lazy line keeps its bytes; one that would follow a blank line gets the indentation step.
  const edit = (text: string) => run(src, (b, t) => ({ kind: 'editCardText', card: card(b, t, 0, 0), text })).output;
  assert.equal(edit('a2\nlazy a'), '## A\n- [ ] a2\nlazy a\n- [ ] b\n\n## B\n- [ ] c\n');
  assert.equal(edit('a\nnew\nlazy a'), '## A\n- [ ] a\n\tnew\nlazy a\n- [ ] b\n\n## B\n- [ ] c\n');
  assert.equal(edit('a\n\nlazy a'), '## A\n- [ ] a\n\t\n\tlazy a\n- [ ] b\n\n## B\n- [ ] c\n');
});

test('a request that would pull a following paragraph into another card is refused', () => {
  // Deleting `b` would make `text` a lazy line of `a` (its fence closes the paragraph of b only).
  const src = '## A\n- [ ] a\n- [ ] b\n\t```\n\t```\ntext\n';
  assert.equal(refuse(src, (b, t) => ({ kind: 'deleteCard', card: card(b, t, 0, 1) })), 'unsafe');
});

test('duplicate lane names are told apart by index (fixture 11)', () => {
  const src = fixture('11-duplicate-lanes.md');
  const { texts, board } = open(src);
  const names = board.lanes.map((l) => l.name);
  const dup = names.findIndex((n, i) => names.indexOf(n) !== i);
  assert.ok(dup > 0);
  const first = names.indexOf(names[dup]);
  const output = run(src, (b, t) => ({ kind: 'renameLane', lane: lane(b, t, dup), name: 'Renamed' })).output;
  const after = open(output);
  assert.equal(after.board.lanes[dup].name, 'Renamed');
  assert.equal(after.board.lanes[first].name, names[dup]);
  // Same name, wrong index: stale only if that lane's heading differs; here it is the same text,
  // so the identity also needs the index to land on the right lane.
  assert.equal(texts[board.lanes[first].headingLine], texts[board.lanes[dup].headingLine]);
  const add = run(src, (b, t) => ({ kind: 'addCard', lane: lane(b, t, dup), title: 'only here' })).output;
  const added = open(add);
  assert.equal(added.board.lanes[dup].cards.length, board.lanes[dup].cards.length + 1);
  assert.equal(added.board.lanes[first].cards.length, board.lanes[first].cards.length);
});

test('requests that would land after an unclosed fence are refused as unsafe', () => {
  const src = '## A\n- [ ] a\n## B\n- [ ] open\n\t```\n\tcode\n';
  // Appending after the open fence would put the card inside it.
  assert.equal(refuse(src, (b, t) => ({ kind: 'addCard', lane: lane(b, t, 1), title: 'x' })), 'unsafe');
  assert.equal(refuse(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 1 })), 'unsafe');
  // Moving the lane with the open fence first would swallow lane A.
  assert.equal(refuse(src, (b, t) => ({ kind: 'moveLane', lane: lane(b, t, 1), toIndex: 0 })), 'unsafe');
  // Safe requests around it still work.
  assert.equal(
    run(src, (b, t) => ({ kind: 'moveCard', card: card(b, t, 0, 0), toLane: lane(b, t, 1), toIndex: 0 })).output,
    '## A\n## B\n- [ ] a\n- [ ] open\n\t```\n\tcode\n',
  );
  assert.equal(run(src, (b, t) => ({ kind: 'toggleCard', card: card(b, t, 1, 0) })).output, src.replace('- [ ] open', '- [x] open'));
});

test('adding to a done lane writes a checked card (marker or doneLanes); other lanes unchecked', () => {
  assert.ok(run(BOARD, (b, t) => ({ kind: 'addCard', lane: lane(b, t, 1), title: 'new' })).output.endsWith('- [x] three\n- [x] new\n'));
  assert.equal(run('## 완료\n- [x] a\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'b' }), ['완료']).output, '## 완료\n- [x] a\n- [x] b\n');
  assert.equal(run('## 할 일\n- [ ] a\n', (b, t) => ({ kind: 'addCard', lane: lane(b, t, 0), title: 'b' }), ['완료']).output, '## 할 일\n- [ ] a\n- [ ] b\n');
});

// --- delete and duplicate (kanban.md 4, 4.6) ---

test('delete removes the card range only; lines around it stay', () => {
  const src = '## A\n- [ ] one\n\t- body\n\n- [ ] two\nlazy\n\n<!-- note -->\n';
  assert.equal(run(src, (b, t) => ({ kind: 'deleteCard', card: card(b, t, 0, 0) })).output, '## A\n\n- [ ] two\nlazy\n\n<!-- note -->\n');
  assert.equal(run(src, (b, t) => ({ kind: 'deleteCard', card: card(b, t, 0, 1) })).output, '## A\n- [ ] one\n\t- body\n\n\n<!-- note -->\n');
  // Deleting the only card would turn a later list into the lane's cards: refused (2.5, 4).
  assert.equal(refuse('## A\n- [ ] one\n\ntext\n\n- [ ] later\n', (b, t) => ({ kind: 'deleteCard', card: card(b, t, 0, 0) })), 'unsafe');
});

test('delete the last card of a file without trailing newline keeps that', () => {
  assert.equal(run('## A\n- [ ] a\n- [ ] b', (b, t) => ({ kind: 'deleteCard', card: card(b, t, 0, 1) })).output, '## A\n- [ ] a');
});

test('duplicate copies the card (check, body, indentation) right after it', () => {
  const src = '## A\n- [x] one\n\t- body\n    - spaced\n- [ ] two\n';
  assert.equal(
    run(src, (b, t) => ({ kind: 'duplicateCard', card: card(b, t, 0, 0) })).output,
    '## A\n- [x] one\n\t- body\n    - spaced\n- [x] one\n\t- body\n    - spaced\n- [ ] two\n',
  );
});

test('duplicate keeps each copied line\'s own line ending when known', () => {
  // LF-dominant file; the card's lines end in CRLF.
  const src = '## A\n- [ ] one\r\n\t- body\r\n- [ ] two\n- [ ] three\n';
  const { doc, texts, board } = open(src);
  const plan = planBoardRequest(texts, board, { kind: 'duplicateCard', card: card(board, texts, 0, 0) }, { eols: doc.lines.map((l) => l.eol) });
  assert.ok(plan.ok);
  const result = computePatch(doc, 1, { expectedVersion: 1, ...plan });
  assert.ok(result.ok);
  assert.equal(applyEdits(doc, result.edits), '## A\n- [ ] one\r\n\t- body\r\n- [ ] one\r\n\t- body\r\n- [ ] two\n- [ ] three\n');
  // Without known line endings the copy uses the dominant one.
  assert.equal(
    run(src, (b, t) => ({ kind: 'duplicateCard', card: card(b, t, 0, 0) })).output,
    '## A\n- [ ] one\r\n\t- body\r\n- [ ] one\n\t- body\n- [ ] two\n- [ ] three\n',
  );
});

test('duplicate the last card of a file without trailing newline', () => {
  assert.equal(run('## A\n- [ ] a', (b, t) => ({ kind: 'duplicateCard', card: card(b, t, 0, 0) })).output, '## A\n- [ ] a\n- [ ] a');
});

test('delete and duplicate refuse stale identities; duplicating an unclosed fence is unsafe', () => {
  assert.equal(refuse(BOARD, () => ({ kind: 'deleteCard', card: { laneIndex: 0, cardIndex: 0, firstLine: '- [ ] other' } })), 'stale');
  assert.equal(refuse(BOARD, () => ({ kind: 'duplicateCard', card: { laneIndex: 0, cardIndex: 9, firstLine: '- [ ] one' } })), 'stale');
  const open = '## A\n- [ ] a\n- [ ] open\n\t```\n\tcode\n';
  assert.equal(refuse(open, (b, t) => ({ kind: 'duplicateCard', card: card(b, t, 0, 1) })), 'unsafe');
  // Deleting it is fine.
  assert.equal(run(open, (b, t) => ({ kind: 'deleteCard', card: card(b, t, 0, 1) })).output, '## A\n- [ ] a\n');
});

test('4.9 check box switch: sets show-checkboxes in the settings JSON in its own style', () => {
  const head = '---\nkanban-plugin: board\n---\n\n## A\n\n- [ ] a\n\n';
  const show = (value: boolean) => () => ({ kind: 'setShowCheckboxes', value }) as const;
  // Obsidian's one-line JSON in a fence: the member is appended, nothing else changes (CRLF kept).
  const fenced = `${head}%% kanban:settings\n\`\`\`\n{"kanban-plugin":"board"}\n\`\`\`\n%%\n`;
  assert.equal(run(fenced, show(true)).output, fenced.replace('{"kanban-plugin":"board"}', '{"kanban-plugin":"board","show-checkboxes":true}'));
  const crlf = fenced.replaceAll('\n', '\r\n');
  assert.equal(run(crlf, show(false)).output, crlf.replace('"board"}', '"board","show-checkboxes":false}'));
  // An existing value is replaced in place; the other members keep their order and spelling.
  const existing = `${head}%% kanban:settings\n\`\`\`\n{"show-checkboxes":false,"date-format":"YYYY.MM.DD","x":1.0}\n\`\`\`\n%%`;
  assert.equal(run(existing, show(true)).output, existing.replace('"show-checkboxes":false', '"show-checkboxes":true'));
  // JSON over several lines without a fence: indented like its neighbors.
  const multi = `${head}%% kanban:settings\n{\n  "kanban-plugin": "basic"\n}\n%%\n`;
  assert.equal(run(multi, show(true)).output, `${head}%% kanban:settings\n{\n  "kanban-plugin": "basic",\n  "show-checkboxes": true\n}\n%%\n`);
  // Nothing is written without a readable block: none, broken JSON, an array, JSON split by a fence line.
  assert.equal(refuse(head, show(true)), 'unsafe');
  assert.equal(refuse(`${head}%% kanban:settings\n\`\`\`\n{"a":\n\`\`\`\n%%`, show(true)), 'unsafe');
  assert.equal(refuse(`${head}%% kanban:settings\n\`\`\`\n[1]\n\`\`\`\n%%`, show(true)), 'unsafe');
  assert.equal(refuse(`${head}%% kanban:settings\n{\n\`\`\`\n}\n%%`, show(true)), 'unsafe');
});

test('4.10 width slider: sets or removes lane-width in the settings JSON in its own style', () => {
  const head = '---\nkanban-plugin: board\n---\n\n## A\n\n- [ ] a\n\n';
  const width = (value?: number) => () => ({ kind: 'setLaneWidth', ...(value === undefined ? {} : { value }) }) as const;
  // Obsidian's one-line JSON in a fence: the member is appended as a number (CRLF kept).
  const fenced = `${head}%% kanban:settings\n\`\`\`\n{"kanban-plugin":"board"}\n\`\`\`\n%%\n`;
  const wide = fenced.replace('"board"}', '"board","lane-width":320}');
  assert.equal(run(fenced, width(320)).output, wide);
  const crlf = fenced.replaceAll('\n', '\r\n');
  assert.equal(run(crlf, width(400)).output, crlf.replace('"board"}', '"board","lane-width":400}'));
  // An existing value is replaced in place, a string one by a number as Obsidian writes it.
  const existing = `${head}%% kanban:settings\n\`\`\`\n{"lane-width":"272","date-format":"YYYY.MM.DD","x":1.0}\n\`\`\`\n%%`;
  assert.equal(run(existing, width(296)).output, existing.replace('"lane-width":"272"', '"lane-width":296'));
  // The reset removes the member with its comma; the same value again changes nothing.
  assert.equal(run(wide, width()).output, fenced);
  assert.equal(run(existing, width()).output, existing.replace('"lane-width":"272",', ''));
  assert.equal(run(fenced, width()).output, fenced, 'nothing to reset');
  assert.equal(run(wide, width(320)).output, wide);
  // JSON over several lines: indented like its neighbors, removed with its line.
  const multi = `${head}%% kanban:settings\n{\n  "kanban-plugin": "basic"\n}\n%%\n`;
  const multiWide = `${head}%% kanban:settings\n{\n  "kanban-plugin": "basic",\n  "lane-width": 504\n}\n%%\n`;
  assert.equal(run(multi, width(504)).output, multiWide);
  assert.equal(run(multiWide, width()).output, multi);
  // Only the slider's integers: anything else is refused before the file is looked at.
  for (const value of [199, 601, 300.5, NaN]) assert.equal(refuse(fenced, width(value)), 'invalid', String(value));
  // No readable block, or a frontmatter lane-width (Obsidian keeps using that): nothing is written.
  assert.equal(refuse(head, width(320)), 'unsafe');
  assert.equal(refuse(`${head}%% kanban:settings\n\`\`\`\n{"a":\n\`\`\`\n%%`, width(320)), 'unsafe');
  const inFrontmatter = fenced.replace('kanban-plugin: board\n', 'kanban-plugin: board\nlane-width: 250\n');
  assert.equal(refuse(inFrontmatter, width(320)), 'unsafe');
  assert.equal(refuse(inFrontmatter, width()), 'unsafe');
  // A duplicate member would still be read after the first one is removed: refused.
  assert.equal(refuse(`${head}%% kanban:settings\n{"lane-width":300,"lane-width":320}\n%%`, width()), 'unsafe');
});

test('4.8 add then remove a date on a card ending in a table row restores the file', () => {
  const source = '---\nkanban-plugin: board\n---\n\n## A\n\n- [ ] t\n\t| a | b |\n\t| - | - |\n\t| 1 | 2 |\n- [ ] next\n';
  const added = run(source, (board, texts) => ({ kind: 'setCardDate', card: card(board, texts, 0, 0), date: '2026-10-30' })).output;
  assert.ok(added.includes('\t| 1 | 2 |\n\t\n\t@{2026-10-30}\n- [ ] next'), added);
  const removed = run(added, (board, texts) => ({ kind: 'removeCardDate', card: card(board, texts, 0, 0), token: '@{2026-10-30}' })).output;
  assert.equal(removed, source);
  // A date line that was written by hand after a blank line elsewhere keeps the blank line.
  const hand = '## A\n\n- [ ] t\n\ttext\n\t\n\t@{2026-10-30}\n';
  assert.equal(run(hand, (board, texts) => ({ kind: 'removeCardDate', card: card(board, texts, 0, 0), token: '@{2026-10-30}' })).output, '## A\n\n- [ ] t\n\ttext\n\t\n');
});
