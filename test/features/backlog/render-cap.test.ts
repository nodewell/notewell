// Render caps (backlog.md 4.2, 4.3): the board draws the first cards of a column and the list
// the first rows, then a "Show all (M)" button; the counts come from main.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBoard } from '../../../src/features/backlog/browser/render-board.ts';
import { renderList } from '../../../src/features/backlog/browser/render-list.ts';
import { boardColumns } from '../../../src/features/backlog/browser/filters.ts';
import { DEFAULT_STRINGS } from '../../../src/features/backlog/view.ts';
import { fakeDocument, fixtureView, type FakeElement } from './browser-view.ts';

const base = fixtureView();
const many = (count: number) => {
  const tasks = Array.from({ length: count }, (_, i) => ({ ...base.tasks[0], path: `backlog/tasks/t-${i}.md`, id: `TASK-${i + 1}`, status: 'To Do', statusKnown: true }));
  return { ...base, tasks };
};
const cards = (root: FakeElement) => root.find((e) => e.attrs.get('data-action') === 'show-task');
const buttons = (root: FakeElement) => root.find((e) => e.attrs.get('data-action') === 'show-all');

test('board: a column beyond its limit draws that many cards and a "Show all (M)" button; within it, no button', () => {
  const view = many(1000);
  const columns = boardColumns(view, view.tasks);
  const todo = columns.findIndex((c) => c.status === 'To Do');
  const limits = columns.map((c, i) => (i === todo ? 300 : c.tasks.length));
  const root = renderBoard(fakeDocument as never, view, columns, { selected: null, limits }) as unknown as FakeElement;
  assert.equal(cards(root).length, 300);
  const [button] = buttons(root);
  assert.equal(button.textContent, 'Show all (1000)');
  assert.equal(button.attrs.get('data-column'), String(todo));
  assert.equal(button.attrs.get('type'), 'button');
  // The last card drawn is the 300th of the column, in board order.
  assert.equal(cards(root).at(-1)!.attrs.get('data-path'), 'backlog/tasks/t-299.md');
  const full = renderBoard(fakeDocument as never, view, columns, { selected: null }) as unknown as FakeElement;
  assert.equal(cards(full).length, 1000);
  assert.equal(buttons(full).length, 0);
});

test('list: rows beyond the limit wait behind "Show all (M)"; aria-rowcount still counts every row', () => {
  const view = many(2500);
  const root = renderList(fakeDocument as never, view, view.tasks, { sort: null, selected: null, limit: 1000 }) as unknown as FakeElement;
  assert.equal(cards(root).length, 1000);
  assert.equal(buttons(root)[0].textContent, 'Show all (2500)');
  assert.equal(buttons(root)[0].attrs.get('data-column'), 'list');
  assert.equal(root.find((e) => e.tagName === 'table')[0].attrs.get('aria-rowcount'), '2501');
  const full = renderList(fakeDocument as never, view, view.tasks, { sort: null, selected: null }) as unknown as FakeElement;
  assert.equal(buttons(full).length, 0);
});

test('the button text is localized', () => {
  assert.equal(DEFAULT_STRINGS.showAll, 'Show all ({0})');
});
