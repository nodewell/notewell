// View strings from an extension host of another build (backlog.md 4): a webview script may
// receive strings without the keys it knows, so missing ones fall back to English and no
// renderer throws; one task that cannot be drawn never blanks the board or list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { boardColumns, DEFAULT_UI_STATE, filterOptions, filterTasks, format, withDefaultStrings } from '../../../src/features/backlog/browser/filters.ts';
import { renderBoard, renderToolbar } from '../../../src/features/backlog/browser/render-board.ts';
import { renderDetail } from '../../../src/features/backlog/browser/render-detail.ts';
import { renderList } from '../../../src/features/backlog/browser/render-list.ts';
import { parseConfig } from '../../../src/features/backlog/config.ts';
import { buildIndex } from '../../../src/features/backlog/task-index.ts';
import { buildTaskDetail } from '../../../src/features/backlog/view-build.ts';
import { DEFAULT_STRINGS, type BacklogView, type TaskSummary } from '../../../src/features/backlog/view.ts';
import { fakeDocument as doc, fixtureView } from './browser-view.ts';

/** Strings as an older extension host sends them: without the newer keys. */
function olderStrings(): Record<string, unknown> {
  const { resizeColumn: _resize, drawFailed: _failed, editTitle: _edit, ...rest } = DEFAULT_STRINGS;
  return rest;
}

test('format never throws on a missing template', () => {
  assert.equal(format(undefined as unknown as string, 'x'), '');
  assert.equal(format(null as unknown as string), '');
});

test('withDefaultStrings fills missing keys and ignores values that are not strings', () => {
  const strings = withDefaultStrings({ ...olderStrings(), boardView: 'Kanban', listView: 42, extra: 'x' });
  assert.equal(strings.resizeColumn, DEFAULT_STRINGS.resizeColumn);
  assert.equal(strings.drawFailed, DEFAULT_STRINGS.drawFailed);
  assert.equal(strings.boardView, 'Kanban');
  assert.equal(strings.listView, DEFAULT_STRINGS.listView);
  assert.equal(Object.hasOwn(strings, 'extra'), false);
  assert.deepEqual(withDefaultStrings(undefined), DEFAULT_STRINGS);
  assert.deepEqual(withDefaultStrings('nope'), DEFAULT_STRINGS);
});

test('board, list, toolbar and detail render with strings from an older host', () => {
  const base = fixtureView();
  const view: BacklogView = { ...base, strings: withDefaultStrings(olderStrings()) };
  const listState = { ...DEFAULT_UI_STATE, mode: 'list' as const };
  const list = renderList(doc, view, filterTasks(view, listState, true), { sort: null, selected: null });
  const handles = list.find((e) => e.attrs.get('data-action') === 'resize-column');
  assert.equal(handles.length, 6);
  assert.equal(handles[0]!.attrs.get('aria-label'), 'Resize the ID column');
  renderBoard(doc, view, boardColumns(view, filterTasks(view, DEFAULT_UI_STATE, false)), { selected: null });
  renderToolbar(doc, view, listState, filterOptions(view, view.strings));

  const project = new URL('../../fixtures/backlog/project/', import.meta.url);
  const config = parseConfig(readFileSync(new URL('config.yml', project), 'utf8')).config;
  const tasks = new URL('tasks/', project);
  const files = readdirSync(tasks)
    .filter((n) => n.endsWith('.md'))
    .map((n) => ({ path: `backlog/tasks/${n}`, text: readFileSync(new URL(n, tasks), 'utf8') }));
  const index = buildIndex(files, [], config);
  for (const file of files) {
    const detail = buildTaskDetail(index, file.path);
    if (detail !== null) renderDetail(doc, detail, view.strings, view.statuses);
  }
});

test('a task that cannot be drawn keeps the rest of the list and board', () => {
  const view = fixtureView();
  const tasks = filterTasks(view, { ...DEFAULT_UI_STATE, status: 'all' }, true);
  assert.ok(tasks.length >= 3);
  // Data no extension build sends, standing in for any renderer failure on one task.
  const broken = { ...tasks[1]!, labels: null, assignees: null } as unknown as TaskSummary;
  const withBroken = [tasks[0]!, broken, ...tasks.slice(2)];

  const list = renderList(doc, view, withBroken, { sort: null, selected: null });
  const rows = list.find((e) => e.tagName === 'tr' && e.attrs.get('data-action') === 'show-task');
  assert.equal(rows.length, withBroken.length);
  assert.equal(rows[1]!.attrs.get('data-path'), broken.path);
  assert.ok(rows[1]!.textContent!.includes(broken.id));

  const brokenView: BacklogView = { ...view, tasks: view.tasks.map((t) => (t.path === broken.path ? broken : t)) };
  const board = renderBoard(doc, brokenView, boardColumns(brokenView, brokenView.tasks), { selected: null });
  const cards = board.find((e) => e.tagName === 'li' && e.attrs.get('data-action') === 'show-task');
  assert.equal(cards.length, brokenView.tasks.length);
  assert.ok(cards.some((c) => c.attrs.get('data-path') === broken.path));
});
