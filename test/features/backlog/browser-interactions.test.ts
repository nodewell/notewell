// Keyboard and drag decisions for the Backlog webview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardColumns } from '../../../src/features/backlog/browser/filters.ts';
import {
  altSideArrow,
  altVerticalArrow,
  CompositionGuard,
  dropIndex,
  dropStatus,
  findCard,
  isOpenShortcut,
  isUndoShortcut,
  moveInColumnMessage,
  navigateBoard,
  navigateList,
  neighbourStatus,
  plainArrow,
  setStatusMessage,
  stepIndex,
} from '../../../src/features/backlog/browser/interactions.ts';
import { validateWebviewMessage } from '../../../src/features/backlog/messages.ts';
import { fixtureView } from './browser-view.ts';

const view = fixtureView(['other-status.md']);
const columns = boardColumns(view, view.tasks);
const task = (id: string) => view.tasks.find((t) => t.id === id)!;
const keyOf = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test('arrow navigation on the board skips empty columns and clamps the row', () => {
  assert.deepEqual(navigateBoard(columns, { column: 0, card: 3 }, 'right'), { column: 1, card: 0 });
  assert.deepEqual(navigateBoard(columns, { column: 1, card: 0 }, 'left'), { column: 0, card: 0 });
  assert.deepEqual(navigateBoard(columns, { column: 0, card: 0 }, 'down'), { column: 0, card: 1 });
  assert.equal(navigateBoard(columns, { column: 0, card: 0 }, 'up'), undefined);
  assert.equal(navigateBoard(columns, { column: 3, card: 0 }, 'right'), undefined);
  const sparse = [columns[0]!, { ...columns[1]!, tasks: [] }, columns[2]!];
  assert.deepEqual(navigateBoard(sparse, { column: 0, card: 4 }, 'right'), { column: 2, card: 0 });
  assert.deepEqual(findCard(columns, task('TASK-24').path), { column: 3, card: 0 });
});

test('Alt+Left/Right picks the neighbouring configured status', () => {
  const statuses = view.statuses;
  assert.equal(neighbourStatus(statuses, task('TASK-2'), 'right'), 'In Progress');
  assert.equal(neighbourStatus(statuses, task('TASK-2'), 'left'), undefined);
  assert.equal(neighbourStatus(statuses, task('TASK-3'), 'right'), undefined);
  assert.equal(neighbourStatus(statuses, task('TASK-24'), 'left'), 'Done', 'Other status moves back into the last column');
  assert.equal(neighbourStatus(statuses, task('TASK-24'), 'right'), undefined);
});

test('drops: known columns only, never onto the same status; the message carries fromStatus', () => {
  assert.equal(dropStatus(columns[1]!, task('TASK-2')), 'In Progress');
  assert.equal(dropStatus(columns[0]!, task('TASK-2')), undefined);
  assert.equal(dropStatus(columns[3]!, task('TASK-2')), undefined, 'Other status takes no drops');
  assert.equal(dropStatus(columns[0]!, task('TASK-24')), 'To Do');
  const message = setStatusMessage(task('TASK-2'), 'Done')!;
  assert.deepEqual(message, { type: 'setStatus', path: task('TASK-2').path, statusLine: '', status: 'Done', fromStatus: 'To Do' });
  assert.equal(setStatusMessage(task('TASK-2'), 'To Do'), undefined);
  // The board message without fromStatus is already a valid setStatus for the current validator.
  const { fromStatus: _, ...base } = message;
  assert.ok(validateWebviewMessage(base));
});

test('reorder within a column: neighbours as afterPath (above) and beforePath (below)', () => {
  const todo = columns[0]!; // TASK-1.1, TASK-2, TASK-4, TASK-5, TASK-6
  const paths = todo.tasks.map((t) => t.path);
  const t2 = task('TASK-2');
  // To the top: nothing above, TASK-1.1 below.
  assert.deepEqual(moveInColumnMessage(todo, t2, 0), { type: 'moveInColumn', path: t2.path, fromStatus: 'To Do', beforePath: paths[0] });
  // To the bottom: TASK-6 above, nothing below.
  assert.deepEqual(moveInColumnMessage(todo, t2, 4), { type: 'moveInColumn', path: t2.path, fromStatus: 'To Do', afterPath: paths[4] });
  // Between TASK-4 and TASK-5 (index counted without the moved card).
  assert.deepEqual(moveInColumnMessage(todo, t2, 2), { type: 'moveInColumn', path: t2.path, fromStatus: 'To Do', afterPath: paths[2], beforePath: paths[3] });
  assert.equal(moveInColumnMessage(todo, t2, 1), undefined, 'same place');
  assert.equal(moveInColumnMessage(todo, t2, 9), undefined);
  assert.equal(moveInColumnMessage(columns[3]!, task('TASK-24'), 0), undefined, 'Other status has no order');
  assert.equal(moveInColumnMessage(columns[1]!, t2, 0), undefined, 'not in that column');
  // Every message is valid for the extension's validator.
  assert.ok(validateWebviewMessage(moveInColumnMessage(todo, t2, 2)));
});

test('drop positions and Alt+Up/Down steps map to indexes without the moved card', () => {
  const todo = columns[0]!;
  const t2 = task('TASK-2'); // shown at 1
  assert.equal(dropIndex(todo, t2, 0), 0, 'before the first card');
  assert.equal(dropIndex(todo, t2, 1), 1, 'before itself: unchanged');
  assert.equal(dropIndex(todo, t2, 2), 1, 'after itself: unchanged');
  assert.equal(dropIndex(todo, t2, 3), 2, 'after the next card');
  assert.equal(dropIndex(todo, t2, 5), 4, 'end of the column');
  assert.equal(moveInColumnMessage(todo, t2, dropIndex(todo, t2, 2)), undefined);
  assert.equal(stepIndex(todo, t2, 'up'), 0);
  assert.equal(stepIndex(todo, t2, 'down'), 2);
  assert.equal(stepIndex(todo, task('TASK-1.1'), 'up'), undefined);
  assert.equal(stepIndex(todo, task('TASK-6'), 'down'), undefined);
  // Alt+Down from TASK-2 lands between TASK-4 and TASK-5.
  const down = moveInColumnMessage(todo, t2, stepIndex(todo, t2, 'down')!)!;
  assert.deepEqual([down.afterPath, down.beforePath], [task('TASK-4').path, task('TASK-5').path]);
  const up = moveInColumnMessage(todo, t2, stepIndex(todo, t2, 'up')!)!;
  assert.deepEqual([up.afterPath, up.beforePath], [undefined, task('TASK-1.1').path]);
  assert.equal(altVerticalArrow(keyOf('ArrowUp', { altKey: true })), 'up');
  assert.equal(altVerticalArrow(keyOf('ArrowDown', { altKey: true })), 'down');
  assert.equal(altVerticalArrow(keyOf('ArrowDown')), undefined);
  assert.equal(altVerticalArrow(keyOf('ArrowDown', { altKey: true, shiftKey: true })), undefined);
});

test('list navigation keys', () => {
  assert.equal(navigateList(5, 0, 'ArrowDown'), 1);
  assert.equal(navigateList(5, 0, 'ArrowUp'), 0);
  assert.equal(navigateList(5, 4, 'ArrowDown'), 4);
  assert.equal(navigateList(5, 2, 'Home'), 0);
  assert.equal(navigateList(5, 2, 'End'), 4);
  assert.equal(navigateList(30, 2, 'PageDown'), 12);
  assert.equal(navigateList(30, 2, 'PageUp'), 0);
  assert.equal(navigateList(5, 2, 'x'), undefined);
  assert.equal(navigateList(0, 0, 'ArrowDown'), undefined);
});

test('shortcut predicates', () => {
  assert.ok(isUndoShortcut(keyOf('z', { ctrlKey: true })));
  assert.ok(isUndoShortcut(keyOf('z', { metaKey: true })));
  assert.ok(!isUndoShortcut(keyOf('z', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Z is redo');
  assert.ok(!isUndoShortcut(keyOf('z')));
  assert.ok(isOpenShortcut(keyOf('Enter')) && isOpenShortcut(keyOf(' ')));
  assert.ok(!isOpenShortcut(keyOf('Enter', { ctrlKey: true })));
  assert.equal(plainArrow(keyOf('ArrowLeft')), 'left');
  assert.equal(plainArrow(keyOf('ArrowLeft', { altKey: true })), undefined);
  assert.equal(altSideArrow(keyOf('ArrowRight', { altKey: true })), 'right');
  assert.equal(altSideArrow(keyOf('ArrowUp', { altKey: true })), undefined);
  assert.equal(altSideArrow(keyOf('ArrowRight', { altKey: true, ctrlKey: true })), undefined);
});

test('IME: Enter that confirms a composition is swallowed', () => {
  const enter = (isComposing = false, keyCode = 13) => ({ key: 'Enter', isComposing, keyCode });
  const guard = new CompositionGuard();
  assert.equal(guard.swallowEnter(enter(), 0), false);
  assert.equal(guard.swallowEnter(enter(true), 0), true);
  assert.equal(guard.swallowEnter(enter(false, 229), 0), true);
  guard.start();
  assert.equal(guard.swallowEnter(enter(), 0), true);
  guard.end(1000);
  assert.equal(guard.swallowEnter(enter(), 1050), true, 'compositionend then Enter');
  assert.equal(guard.swallowEnter(enter(), 1060), false, 'only once');
  guard.end(2000);
  assert.equal(guard.swallowEnter(enter(), 2500), false, 'a later Enter acts');
  assert.equal(guard.swallowEnter({ key: 'a', isComposing: true, keyCode: 229 }, 0), false);
});
