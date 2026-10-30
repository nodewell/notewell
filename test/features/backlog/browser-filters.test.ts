// Webview UI state, filters, sorting and board columns (backlog.md 4.2, 4.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardColumns,
  DEFAULT_UI_STATE,
  filterOptions,
  filterTasks,
  format,
  nextSort,
  restoreUiState,
  sortTasks,
  valueOption,
  type UiState,
  clampColumnWidth,
  columnKeyWidth,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from '../../../src/features/backlog/browser/filters.ts';
import { DEFAULT_STRINGS, type BacklogView, type TaskSummary } from '../../../src/features/backlog/view.ts';
import { fixtureView } from './browser-view.ts';

const ids = (tasks: readonly TaskSummary[]) => tasks.map((t) => t.id);
const withState = (change: Partial<UiState>): UiState => ({ ...DEFAULT_UI_STATE, ...change });

test('persisted state is restored field by field', () => {
  assert.deepEqual(restoreUiState(undefined), DEFAULT_UI_STATE);
  assert.deepEqual(restoreUiState('junk'), DEFAULT_UI_STATE);
  const full = { mode: 'list', search: 'abc', status: 'all', milestone: '=m-0', label: '=ui', assignee: 'all', sort: { column: 'priority', descending: true }, selected: 'backlog/tasks/a.md', paneSizes: { bottom: 0.3 }, columnWidths: { id: 80, title: 400 } };
  assert.deepEqual(restoreUiState(full), full);
  assert.deepEqual(restoreUiState({ mode: 'grid', search: 5, sort: { column: 'evil' }, selected: '' }), DEFAULT_UI_STATE);
  assert.equal(restoreUiState({ search: 'x'.repeat(5000) }).search, '');
});

test('list filters: not done by default, statuses, milestone (incl. none), label, assignee', () => {
  const view = fixtureView(['other-status.md']);
  assert.deepEqual(ids(filterTasks(view, DEFAULT_UI_STATE, true)), ['TASK-1', 'TASK-1.1', 'TASK-2', 'TASK-4', 'TASK-5', 'TASK-6', 'TASK-24']);
  assert.equal(filterTasks(view, withState({ status: 'all' }), true).length, 8);
  assert.deepEqual(ids(filterTasks(view, withState({ status: valueOption('Done') }), true)), ['TASK-3']);
  assert.deepEqual(ids(filterTasks(view, withState({ status: valueOption('Blocked') }), true)), ['TASK-24']);
  assert.deepEqual(ids(filterTasks(view, withState({ status: 'all', milestone: valueOption('M-0') }), true)), ['TASK-1']);
  assert.equal(filterTasks(view, withState({ status: 'all', milestone: 'none' }), true).length, 7);
  assert.deepEqual(ids(filterTasks(view, withState({ label: valueOption('UI') }), true)), ['TASK-2']);
  assert.deepEqual(ids(filterTasks(view, withState({ assignee: valueOption('@alice') }), true)), ['TASK-1']);
  // A stale persisted option filters nothing.
  assert.equal(filterTasks(view, withState({ status: 'all', label: 'gone' }), true).length, 8);
  // The board ignores the status filter.
  assert.equal(filterTasks(view, withState({ status: valueOption('Done') }), false).length, 8);
});

test('search: every word, in any order, case-insensitive, anywhere in the task', () => {
  const view = fixtureView();
  const found = (search: string) => ids(filterTasks(view, withState({ search, status: 'all' }), true));
  assert.deepEqual(found('task-1'), ['TASK-1', 'TASK-1.1']);
  assert.deepEqual(found('  ESBUILD '), ['TASK-1']);
  assert.deepEqual(found('<b>html-like</b>'), ['TASK-2']);
  assert.deepEqual(found('한국어'), ['TASK-5']);
  assert.deepEqual(found('infra'), ['TASK-1']);
  assert.deepEqual(found('nothing like this'), []);
  // Body sections beyond the description, and assignees.
  assert.deepEqual(found('typecheck passes'), ['TASK-1'], 'acceptance criteria');
  assert.deepEqual(found('docs updated'), ['TASK-1'], 'definition of done');
  assert.deepEqual(found('wire ci'), ['TASK-1'], 'plan');
  assert.deepEqual(found('looks good'), ['TASK-1'], 'comments');
  assert.deepEqual(found('shipped'), ['TASK-3'], 'final summary');
  assert.deepEqual(found('@alice'), ['TASK-1']);
  // Words in any order and in different places; all must appear.
  assert.deepEqual(found('passes typecheck'), ['TASK-1']);
  assert.deepEqual(found('esbuild alice'), ['TASK-1']);
  assert.deepEqual(found('esbuild 한국어'), []);
  // Spacing in the task is ignored, not the boundary between two items.
  assert.deepEqual(found('두번째기준'), ['TASK-5']);
  assert.deepEqual(found('typecheckpasses'), ['TASK-1']);
  assert.deepEqual(found('setupthebuildcompile'), [], 'title and description are separate items');
});

test('sorting by each column; empty values last in both directions; ties keep board order', () => {
  const view = fixtureView(['other-status.md']);
  const sorted = (column: 'id' | 'title' | 'status' | 'priority' | 'assignee' | 'milestone', descending = false) =>
    ids(sortTasks(view.tasks, { column, descending }, view));
  assert.deepEqual(sorted('id', true), ['TASK-24', 'TASK-6', 'TASK-5', 'TASK-4', 'TASK-3', 'TASK-2', 'TASK-1.1', 'TASK-1']);
  assert.deepEqual(sorted('status'), ['TASK-1.1', 'TASK-2', 'TASK-4', 'TASK-5', 'TASK-6', 'TASK-1', 'TASK-3', 'TASK-24']);
  assert.deepEqual(sorted('priority').slice(0, 3), ['TASK-1', 'TASK-1.1', 'TASK-2']);
  assert.deepEqual(sorted('priority', true).slice(0, 3), ['TASK-2', 'TASK-1.1', 'TASK-1'], 'no-priority tasks stay last');
  assert.deepEqual(sorted('assignee')[0], 'TASK-1');
  assert.deepEqual(sorted('assignee', true)[0], 'TASK-1');
  assert.deepEqual(sorted('milestone', true)[0], 'TASK-1');
  // Collation order across scripts depends on ICU, so compare the Latin titles only.
  assert.deepEqual(sorted('title').filter((id) => id !== 'TASK-5').slice(0, 3), ['TASK-6', 'TASK-2', 'TASK-1']);
  assert.deepEqual(ids(sortTasks(view.tasks, null, view)), ids(view.tasks));
});

test('sorting by priority follows the configured priorities; others after them, by name', () => {
  const task = (id: string, priority: string | null) => ({ ...fixtureView().tasks[0], id, path: `${id}.md`, priority });
  const tasks = [task('A', 'low'), task('B', 'Urgent'), task('C', null), task('D', 'zeta'), task('E', 'HIGH'), task('F', 'alpha')];
  const view = { ...fixtureView(), priorities: ['urgent', 'High', 'low'] };
  assert.deepEqual(ids(sortTasks(tasks, { column: 'priority', descending: false }, view)), ['B', 'E', 'A', 'F', 'D', 'C']);
  assert.deepEqual(ids(sortTasks(tasks, { column: 'priority', descending: true }, view)), ['D', 'F', 'A', 'E', 'B', 'C'], 'no priority stays last');
  const defaults = { ...view, priorities: ['High', 'Medium', 'Low'] };
  assert.deepEqual(ids(sortTasks(tasks, { column: 'priority', descending: false }, defaults)), ['E', 'A', 'F', 'B', 'D', 'C']);
});

test('header clicks cycle ascending, descending, board order', () => {
  assert.deepEqual(nextSort(null, 'title'), { column: 'title', descending: false });
  assert.deepEqual(nextSort({ column: 'title', descending: false }, 'title'), { column: 'title', descending: true });
  assert.equal(nextSort({ column: 'title', descending: true }, 'title'), null);
  assert.deepEqual(nextSort({ column: 'title', descending: true }, 'id'), { column: 'id', descending: false });
});

test('board columns: configured order, then Other status', () => {
  const view = fixtureView(['other-status.md']);
  const columns = boardColumns(view, view.tasks);
  assert.deepEqual(columns.map((c) => [c.status, c.known, ids(c.tasks)]), [
    ['To Do', true, ['TASK-1.1', 'TASK-2', 'TASK-4', 'TASK-5', 'TASK-6']],
    ['In Progress', true, ['TASK-1']],
    ['Done', true, ['TASK-3']],
    ['', false, ['TASK-24']],
  ]);
  // Filtered empty, the Other column stays so columns do not shift.
  assert.equal(boardColumns(view, []).length, 4);
  assert.equal(boardColumns(fixtureView(), fixtureView().tasks).length, 3);
});

test('filter options come from the config, milestones and the tasks', () => {
  const view = fixtureView(['other-status.md']);
  const options = filterOptions(view, DEFAULT_STRINGS);
  assert.deepEqual(options.status.map((o) => o.value), ['notDone', 'all', '=To Do', '=In Progress', '=Done', '=Blocked']);
  assert.deepEqual(options.milestone, [
    { value: 'all', label: 'All milestones' },
    { value: 'none', label: 'No milestone' },
    { value: '=m-0', label: 'v1 Launch' },
  ]);
  assert.equal(options.label[0]!.label, 'All labels');
  assert.deepEqual(options.label.slice(1).map((o) => o.label).filter((l) => l !== '한국어'), ['build', 'infra', 'ui']);
  assert.ok(options.label.some((o) => o.value === '=한국어'));
  assert.deepEqual(options.assignee.map((o) => o.label), ['All assignees', '@alice']);
});

test('format replaces numbered placeholders only', () => {
  assert.equal(format('{0} of {1}, {2}', 1, 'two'), '1 of two, {2}');
  assert.equal(format(DEFAULT_STRINGS.blockedBy, 'TASK-1, TASK-2'), 'Blocked by TASK-1, TASK-2');
});

test('a view with no statuses still works', () => {
  const view: BacklogView = { ...fixtureView(), statuses: [], doneStatus: null };
  assert.equal(filterTasks(view, DEFAULT_UI_STATE, true).length, 7);
});

test('column widths: restored within limits; keys step 16px (Shift 64px) and clamp', () => {
  assert.deepEqual(restoreUiState({ columnWidths: { id: 80, title: 10, status: 'x', bogus: 100, priority: 99999 } }).columnWidths, { id: 80 });
  assert.equal(columnKeyWidth(200, { key: 'ArrowRight', shiftKey: false }), 216);
  assert.equal(columnKeyWidth(200, { key: 'ArrowLeft', shiftKey: true }), 136);
  assert.equal(columnKeyWidth(50, { key: 'ArrowLeft', shiftKey: true }), MIN_COLUMN_WIDTH);
  assert.equal(columnKeyWidth(200, { key: 'Enter', shiftKey: false }), undefined);
  assert.equal(clampColumnWidth(1e9), MAX_COLUMN_WIDTH);
});

test('list status filter: Archived lists the archived tasks (any status), offered only when there are some', async () => {
  const { ARCHIVED } = await import('../../../src/features/backlog/browser/filters.ts');
  const base = fixtureView();
  const archivedTask = (id: string, status: string, label: string) => ({ ...base.tasks[0], id, path: `backlog/archive/tasks/${id}.md`, status, labels: [label], searchText: `${id.toLowerCase()} ${label}` });
  const view = { ...base, archived: [archivedTask('TASK-30', 'Done', 'ui'), archivedTask('TASK-31', 'To Do', 'infra')] };
  assert.deepEqual(ids(filterTasks(view, withState({ status: ARCHIVED }), true)), ['TASK-30', 'TASK-31']);
  assert.deepEqual(ids(filterTasks(view, withState({ status: ARCHIVED, search: 'infra' }), true)), ['TASK-31'], 'search applies');
  assert.deepEqual(ids(filterTasks(view, withState({ status: ARCHIVED, label: valueOption('ui') }), true)), ['TASK-30'], 'other filters apply');
  assert.deepEqual(ids(filterTasks(view, withState({ status: ARCHIVED }), false)), ids(base.tasks), 'the board never shows them');
  assert.ok(!ids(filterTasks(view, withState({ status: 'all' }), true)).includes('TASK-30'), '"All statuses" is the board tasks');
  const statusValues = (v: BacklogView) => filterOptions(v, DEFAULT_STRINGS).status.map((o) => o.value);
  assert.equal(statusValues(view).at(-1), ARCHIVED);
  assert.equal(filterOptions(view, DEFAULT_STRINGS).status.at(-1)!.label, DEFAULT_STRINGS.archivedTasks);
  assert.ok(!statusValues(base).includes(ARCHIVED), 'no archived tasks, no option');
  assert.equal(restoreUiState({ status: ARCHIVED }).status, ARCHIVED, 'the choice is remembered');
});
