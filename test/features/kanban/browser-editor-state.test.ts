// An open editor is reopened after a redraw only on the same card or lane (identity incl.
// the exact source line); otherwise its draft is kept aside instead of landing elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTarget, laneTarget, locateEditor } from '../../../src/features/kanban/browser/editor-state.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView } from '../../../src/features/kanban/view.ts';

const board = (lines: string[]) => buildBoardView(lines, parseBoard(lines), { today: '2026-10-20' });
const before = board(['## A', '- [ ] one', '- [ ] two', '## B', '- [ ] three']);

test('card editor: reopened when the card is unchanged, even if other cards changed', () => {
  const target = cardTarget(before, { lane: 0, card: 1 })!;
  const otherEdited = board(['## A', '- [x] one', '- [ ] two', '## B', '- [ ] three', '- [ ] four']);
  assert.deepEqual(locateEditor(otherEdited, target), { kind: 'card', ref: { lane: 0, card: 1 } });
});

test('card editor: not reopened when its card changed or another card took its place', () => {
  const target = cardTarget(before, { lane: 0, card: 1 })!;
  assert.equal(locateEditor(board(['## A', '- [ ] one', '- [x] two', '## B']), target), undefined, 'same card, line changed');
  assert.equal(locateEditor(board(['## A', '- [ ] two', '- [ ] one', '## B']), target), undefined, 'reordered');
  assert.equal(locateEditor(board(['## A', '- [ ] one', '## B']), target), undefined, 'removed');
});

test('lane rename and add-card editors follow the lane heading', () => {
  const rename = laneTarget(before, 'lane', 1)!;
  const add = laneTarget(before, 'add', 0)!;
  assert.deepEqual(locateEditor(before, rename), { kind: 'lane', lane: 1 });
  assert.deepEqual(locateEditor(before, add), { kind: 'add', lane: 0 });
  const renamed = board(['## A', '- [ ] one', '- [ ] two', '## Beta', '- [ ] three']);
  assert.equal(locateEditor(renamed, rename), undefined);
  assert.deepEqual(locateEditor(renamed, add), { kind: 'add', lane: 0 });
  assert.equal(laneTarget(before, 'lane', 9), undefined);
  assert.equal(cardTarget(before, { lane: 1, card: 4 }), undefined);
});
