// Toolbar, board and list rendering with a fake document: safe elements only, task text as
// text, and the data hooks main.ts relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardColumns, DEFAULT_UI_STATE, filterOptions } from '../../../src/features/backlog/browser/filters.ts';
import { renderBoard, renderNotices, renderSearch, renderToolbar } from '../../../src/features/backlog/browser/render-board.ts';
import { renderList } from '../../../src/features/backlog/browser/render-list.ts';
import type { BacklogView } from '../../../src/features/backlog/view.ts';
import { fakeDocument as doc, fixtureView, type FakeElement } from './browser-view.ts';

const ALLOWED_TAGS = new Set(['div', 'span', 'button', 'select', 'option', 'input', 'p', 'section', 'header', 'h2', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col']);
const ALLOWED_ATTRS = new Set([
  'dir',
  'type', 'role', 'aria-selected', 'aria-pressed', 'data-position', 'aria-label', 'aria-describedby', 'aria-hidden', 'aria-current', 'aria-sort', 'aria-rowcount',
  'data-action', 'data-mode', 'data-filter', 'data-path', 'data-column', 'data-card', 'data-row', 'data-status', 'data-known',
  'title', 'value', 'selected', 'placeholder', 'spellcheck', 'tabindex', 'draggable', 'id', 'scope', 'aria-orientation', 'data-col',
]);

function assertSafe(root: FakeElement): void {
  for (const element of root.walk()) {
    assert.ok(ALLOWED_TAGS.has(element.tagName), element.tagName);
    for (const attr of element.attrs.keys()) assert.ok(ALLOWED_ATTRS.has(attr), attr);
  }
}

const view = fixtureView(['other-status.md', 'no-frontmatter.md']);
const board = () => renderBoard(doc, view, boardColumns(view, view.tasks), { selected: view.tasks[0]!.path });

test('board: columns in config order plus Other status, with drop hooks', () => {
  const root = board();
  assertSafe(root);
  const sections = root.find((e) => e.tagName === 'section');
  assert.deepEqual(sections.map((s) => [s.byClass('column-title')[0]!.textContent, s.attrs.get('data-known'), s.byClass('column-count')[0]!.textContent]), [
    ['To Do', 'true', '5'],
    ['In Progress', 'true', '1'],
    ['Done', 'true', '1'],
    ['Other status', 'false', '1'],
  ]);
  assert.ok(sections[2]!.classes.has('done'));
  assert.ok(sections[3]!.classes.has('other'));
});

test('a read-only card (backlog.md 4.4): badge with the reason as tooltip, not draggable', () => {
  const shown = fixtureView(['unbalanced.md']);
  const root = renderBoard(doc, shown, boardColumns(shown, shown.tasks), { selected: null });
  assertSafe(root);
  const card = (id: string) => root.find((e) => e.tagName === 'li' && e.byClass('card-id')[0]?.textContent === id)[0]!;
  const locked = card('TASK-22');
  const badge = locked.byClass('card-read-only')[0]!;
  assert.deepEqual([badge.textContent, badge.attrs.get('title')], [shown.strings.readOnlyLabel, shown.strings.readOnlyMarkers.replace('{0}', '10')]);
  assert.deepEqual([locked.attrs.get('draggable'), locked.classes.has('read-only')], ['false', true]);
  const open = card('TASK-1');
  assert.deepEqual([open.byClass('card-read-only').length, open.attrs.get('draggable'), open.classes.has('read-only')], [0, 'true', false]);
});

test('cards: ID, title, priority, labels, AC, subtasks, blocked, milestone, selection', () => {
  const root = board();
  const card = (id: string) => root.find((e) => e.tagName === 'li' && e.byClass('card-id')[0]?.textContent === id)[0]!;
  const t1 = card('TASK-1');
  assert.deepEqual(
    [t1.byClass('card-title')[0]!.textContent, t1.byClass('priority')[0]!.textContent, t1.byClass('label').map((l) => l.textContent)],
    ['Set up the build', 'High', ['build', 'infra']],
  );
  assert.equal(t1.byClass('card-ac')[0]!.textContent, '1/2');
  assert.equal(t1.byClass('card-subtasks')[0]!.textContent, '1 subtasks');
  assert.equal(t1.byClass('card-milestone')[0]!.textContent, 'v1 Launch');
  assert.ok(t1.classes.has('selected'));
  assert.equal(t1.attrs.get('aria-current'), 'true');
  assert.deepEqual([t1.attrs.get('data-action'), t1.attrs.get('tabindex'), t1.attrs.get('draggable')], ['show-task', '0', 'true']);

  const t2 = card('TASK-2');
  const blocked = t2.byClass('card-blocked')[0]!;
  assert.deepEqual([blocked.textContent, blocked.attrs.get('title')], ['Blocked', 'Blocked by TASK-1']);
  assert.ok(t2.classes.has('blocked'));
  assert.equal(card('TASK-6').byClass('card-meta').length, 0, 'no empty meta row');
  // Titles with markup-like text stay text.
  assert.equal(card('TASK-4').byClass('card-title')[0]!.textContent, 'Title: with colon & "quotes"');
});

test('duplicate IDs are flagged on cards and rows', () => {
  const dupes = fixtureView(['crlf.md']);
  const root = renderBoard(doc, dupes, boardColumns(dupes, dupes.tasks), { selected: null });
  // The warning is visible text; the "!" mark is decoration only.
  assert.deepEqual(root.byClass('duplicate-note').map((d) => d.textContent), [dupes.strings.duplicateId, dupes.strings.duplicateId]);
  assert.deepEqual(root.byClass('duplicate').map((d) => d.attrs.get('aria-hidden')), ['true', 'true']);
  const list = renderList(doc, dupes, dupes.tasks, { sort: null, selected: null });
  assert.equal(list.byClass('duplicate-note').length, 2);
});

test('board with nothing to show says so', () => {
  const root = renderBoard(doc, view, boardColumns(view, []), { selected: null });
  assert.equal(root.byClass('empty')[0]!.textContent, view.strings.noTasks);
});

test('toolbar: tabs, filters per mode, help; search is separate', () => {
  const options = filterOptions(view, view.strings);
  const boardBar = renderToolbar(doc, view, DEFAULT_UI_STATE, options);
  assertSafe(boardBar);
  assert.deepEqual(boardBar.find((e) => e.tagName === 'select').map((s) => s.attrs.get('data-filter')), ['milestone', 'label', 'assignee']);
  const tabs = boardBar.byClass('view-tab');
  assert.deepEqual(tabs.map((t) => [t.textContent, t.attrs.get('aria-selected')]), [['Board', 'true'], ['List', 'false']]);
  assert.equal(boardBar.byClass('help-text')[0]!.attrs.get('role'), 'tooltip');

  const listBar = renderToolbar(doc, view, { ...DEFAULT_UI_STATE, mode: 'list', label: '=ui', status: 'stale' }, options);
  const selects = listBar.find((e) => e.tagName === 'select');
  assert.deepEqual(selects.map((s) => s.attrs.get('data-filter')), ['status', 'milestone', 'label', 'assignee']);
  const selected = (s: FakeElement) => s.find((o) => o.tagName === 'option' && o.attrs.has('selected')).map((o) => o.attrs.get('value'));
  assert.deepEqual(selects.map(selected), [['notDone'], ['all'], ['=ui'], ['all']], 'an unknown value selects the first option');

  const search = renderSearch(doc, 'Search tasks', 'abc');
  assert.deepEqual([search.tagName, search.attrs.get('type'), search.attrs.get('value')], ['input', 'search', 'abc']);
});

test('unreadable files are counted in a notice', () => {
  const [notice] = renderNotices(doc, view);
  assert.equal(notice!.textContent, '1 task files could not be read.');
  assert.equal(notice!.attrs.get('title'), 'backlog/tasks/no-frontmatter.md (no frontmatter)', 'each path with its reason');
  assert.deepEqual(renderNotices(doc, fixtureView()), []);
});

test('list: header buttons with aria-sort, rows with hooks and cell text', () => {
  const root = renderList(doc, view, view.tasks, { sort: { column: 'priority', descending: true }, selected: view.tasks[1]!.path });
  assertSafe(root);
  const headers = root.find((e) => e.tagName === 'th');
  assert.deepEqual(headers.map((h) => [h.textContent, h.attrs.get('aria-sort')]), [
    ['ID', 'none'],
    ['Title', 'none'],
    ['Status', 'none'],
    ['Priority', 'descending'],
    ['Assignee', 'none'],
    ['Milestone', 'none'],
  ]);
  assert.deepEqual(headers.map((h) => h.find((b) => b.tagName === 'button')[0]!.attrs.get('data-column')), ['id', 'title', 'status', 'priority', 'assignee', 'milestone']);
  const rows = root.find((e) => e.tagName === 'tr' && e.classes.has('row'));
  assert.equal(rows.length, view.tasks.length);
  const cells = (row: FakeElement) => row.find((e) => e.tagName === 'td').map((td) => td.textContent);
  assert.deepEqual(cells(rows[0]!), ['TASK-1', 'Set up the buildbuildinfra', 'In Progress', 'High', '@alice', 'v1 Launch']);
  assert.deepEqual([rows[1]!.attrs.get('aria-selected'), rows[1]!.attrs.get('data-action'), rows[1]!.attrs.get('data-row')], ['true', 'show-task', '1']);
  const other = rows.find((r) => r.attrs.get('data-path')!.endsWith('other-status.md'))!;
  assert.deepEqual([other.byClass('status')[0]!.textContent, other.byClass('status')[0]!.classes.has('other')], ['Blocked', true]);
});

test('empty list keeps the headers and says so', () => {
  const root = renderList(doc, view, [], { sort: null, selected: null });
  assert.equal(root.find((e) => e.tagName === 'th').length, 6);
  assert.equal(root.byClass('empty')[0]!.textContent, view.strings.noTasks);
});

test('HTML-like task text is never markup', () => {
  const evil: BacklogView = {
    ...view,
    tasks: [{ ...view.tasks[0]!, title: '<img src=x onerror=alert(1)>', labels: ['<script>'], id: '<b>ID</b>', milestone: null, milestoneTitle: null }],
  };
  for (const root of [renderBoard(doc, evil, boardColumns(evil, evil.tasks), { selected: null }), renderList(doc, evil, evil.tasks, { sort: null, selected: null })]) {
    assertSafe(root);
    assert.ok(root.textContent!.includes('<img src=x onerror=alert(1)>'));
    assert.ok(root.textContent!.includes('<script>'));
    assert.ok(root.textContent!.includes('<b>ID</b>'));
  }
});

test('list: every header has a keyboard-focusable width handle and a matching <col>', () => {
  const root = renderList(doc, view, view.tasks, { sort: null, selected: null });
  assertSafe(root);
  const handles = root.find((e) => e.attrs.get('data-action') === 'resize-column');
  assert.deepEqual(handles.map((h) => h.attrs.get('data-column')), ['id', 'title', 'status', 'priority', 'assignee', 'milestone']);
  for (const h of handles) {
    assert.equal(h.attrs.get('role'), 'separator');
    assert.equal(h.attrs.get('tabindex'), '0');
    assert.equal(h.attrs.get('aria-orientation'), 'vertical');
    assert.match(h.attrs.get('aria-label') ?? '', /column/);
  }
  assert.deepEqual(root.find((e) => e.tagName === 'col').map((c) => c.attrs.get('data-col')), ['id', 'title', 'status', 'priority', 'assignee', 'milestone']);
});
