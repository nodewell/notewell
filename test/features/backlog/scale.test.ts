// Scale and CLI formats (backlog.md 3.1, 4.2-4.5): dependency graphs with many edges, IDs as
// newer CLI options write them, a detail with tens of thousands of checklist items, and
// milestone folders in odd states. Pure: the index, view models and renderers with a fake document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, parseConfig } from '../../../src/features/backlog/config.ts';
import { buildIndex, compareTaskIds, idKey, type SourceFile } from '../../../src/features/backlog/task-index.ts';
import { buildBacklogView, buildTaskDetail } from '../../../src/features/backlog/view-build.ts';
import { DEFAULT_STRINGS } from '../../../src/features/backlog/view.ts';
import { dependenciesAllowed, type DependencyGraph } from '../../../src/features/backlog/session.ts';
import { renderDetail } from '../../../src/features/backlog/browser/render-detail.ts';
import { renderBoard } from '../../../src/features/backlog/browser/render-board.ts';
import { boardColumns } from '../../../src/features/backlog/browser/filters.ts';
import { fakeDocument, type FakeElement } from './browser-view.ts';

const task = (id: string, extra: string[] = [], body = ''): string => ['---', `id: ${id}`, `title: Task ${id}`, 'status: To Do', ...extra, '---', '', body].join('\n');
const timed = <T>(f: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = f();
  return { value, ms: performance.now() - start };
};

// --- 1. Dependency graphs with many edges ------------------------------------------------------------

test('1: 3,000 tasks with 100 dependencies each (300,000 edges, cycles included): index, view and checks stay fast', () => {
  const n = 3000;
  const files: SourceFile[] = Array.from({ length: n }, (_, i) => ({
    path: `backlog/tasks/task-${i + 1}.md`,
    text: task(`TASK-${i + 1}`, ['dependencies:', ...Array.from({ length: 100 }, (_, k) => `  - TASK-${((i + k + 1) % n) + 1}`)]),
  }));
  const { value: view, ms } = timed(() => buildBacklogView(buildIndex(files, [], DEFAULT_CONFIG), DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS));
  assert.equal(view.tasks.length, n);
  assert.ok(view.tasks.every((t) => t.blockedBy.length === 100), 'every dependency is open (none done)');
  assert.ok(ms < 4000, `index + view: ${Math.round(ms)} ms`);
  const keyOf = (id: string) => idKey(id, 'task');
  const graph: DependencyGraph = { keyOf, tasks: new Map(view.tasks.map((t) => [keyOf(t.id), files[Number(t.id.slice(5)) - 1].text.match(/TASK-\d+/g)!.slice(1)])) };
  const check = timed(() => [dependenciesAllowed(graph, 'TASK-1', [], ['TASK-2']), dependenciesAllowed(graph, 'TASK-NEW', [], ['TASK-1'])]);
  assert.deepEqual(check.value, [false, true], 'a cycle through the ring is found; a task outside it may depend on it');
  assert.ok(check.ms < 2000, `cycle checks: ${Math.round(check.ms)} ms`);
  const detail = timed(() => buildTaskDetail(buildIndex(files, [], DEFAULT_CONFIG), 'backlog/tasks/task-1.md'));
  assert.equal(detail.value?.dependencies.length, 100);
  assert.ok(detail.ms < 4000);
});

// --- 2. IDs as newer CLI options write them ---------------------------------------------------------------

test('2: zero-padded IDs, a custom prefix, draft IDs and deep subtasks link, sort and block consistently', () => {
  const config = parseConfig('statuses: ["To Do", "Done"]\ntask_prefix: "BUG"\nzero_padded_ids: 3\n').config;
  const files: SourceFile[] = [
    { path: 'backlog/tasks/bug-001.md', text: task('BUG-001') },
    { path: 'backlog/tasks/bug-002.md', text: task('BUG-002', ['status: Done', 'dependencies:', '  - BUG-001']).replace('status: To Do\n', '') },
    { path: 'backlog/tasks/bug-010.md', text: task('BUG-010', ['dependencies:', '  - BUG-002', '  - bug-001']) },
    { path: 'backlog/tasks/bug-001.01.md', text: task('BUG-001.01', ['parent_task_id: BUG-001']) },
    { path: 'backlog/tasks/bug-1.2.3.4.md', text: task('BUG-1.2.3.4', ['parent_task_id: BUG-1.2.3']) },
    { path: 'backlog/tasks/bug-1.2.3.md', text: task('BUG-1.2.3') },
    { path: 'backlog/tasks/draft-7.md', text: task('DRAFT-7') },
  ];
  const index = buildIndex(files, [], config);
  const view = buildBacklogView(index, config, 'demo', DEFAULT_STRINGS);
  const byId = new Map(view.tasks.map((t) => [t.id, t]));
  assert.equal(view.tasks.length, 7, 'every file is a task');
  assert.deepEqual(byId.get('BUG-010')!.blockedBy, ['bug-001'], 'the done dependency does not block; the open one does, spelled as written');
  assert.equal(byId.get('BUG-001')!.subtaskCount, 1);
  assert.equal(byId.get('BUG-1.2.3')!.subtaskCount, 1, 'four-level subtask IDs');
  const sorted = view.tasks.map((t) => t.id).filter((id) => id.startsWith('BUG')).sort(compareTaskIds);
  assert.deepEqual(sorted, ['BUG-001', 'BUG-001.01', 'BUG-1.2.3', 'BUG-1.2.3.4', 'BUG-002', 'BUG-010']);
  // Bare numbers name prefix tasks, never another prefix's.
  assert.equal(idKey('7', config.taskPrefix), 'BUG-7');
  assert.notEqual(idKey('7', config.taskPrefix), idKey('DRAFT-7', config.taskPrefix));
  // Duplicate-ID marking works with padded IDs too.
  const dup = buildIndex([...files, { path: 'backlog/tasks/bug-001-copy.md', text: task('BUG-001') }], [], config);
  const dupView = buildBacklogView(dup, config, 'demo', DEFAULT_STRINGS);
  assert.equal(dupView.tasks.filter((t) => t.id === 'BUG-001' && t.duplicateId).length, 2);
});

// --- 3. A detail with 50,000 checklist items and a 1 MB description ------------------------------------------

test('3: a detail with 50,000 AC items and a 1 MB description builds and renders in bounded time', () => {
  const ac = Array.from({ length: 50_000 }, (_, i) => `- [${i % 3 === 0 ? 'x' : ' '}] #${i + 1} Criterion ${i + 1}`).join('\n');
  const description = `${'A paragraph of text with **bold** and `code` and a [link](https://example.com).\n\n'.repeat(13_000)}`;
  assert.ok(description.length > 1_000_000);
  const text = task('TASK-1', [], `## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n${description}<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n${ac}\n<!-- AC:END -->\n`);
  const index = buildIndex([{ path: 'backlog/tasks/t.md', text }], [], DEFAULT_CONFIG);
  const built = timed(() => buildTaskDetail(index, 'backlog/tasks/t.md')!);
  assert.equal(built.value.ac?.items.length, 50_000);
  assert.ok(built.ms < 3000, `detail model: ${Math.round(built.ms)} ms`);
  const drawn = timed(() => renderDetail(fakeDocument as never, built.value, DEFAULT_STRINGS, ['To Do', 'Done']) as unknown as FakeElement);
  assert.ok(drawn.ms < 5000, `detail render: ${Math.round(drawn.ms)} ms`);
  const boxes = drawn.value.find((e) => e.tagName === 'input' && e.attrs.get('type') === 'checkbox');
  assert.ok(boxes.length >= 50_000, `${boxes.length} checkboxes`);
  // The board card shows the progress without walking anything per render.
  const view = buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
  const card = timed(() => renderBoard(fakeDocument as never, view, boardColumns(view, view.tasks), { selected: null }));
  assert.ok(card.ms < 500, `board: ${Math.round(card.ms)} ms`);
});

// --- 4. Milestone folders in odd states -------------------------------------------------------------------

test('4: missing, duplicate, broken and archived milestones never break the board or misname a task\'s milestone', () => {
  const tasks: SourceFile[] = [
    { path: 'backlog/tasks/a.md', text: task('TASK-1', ['milestone: m-1']) },
    { path: 'backlog/tasks/b.md', text: task('TASK-2', ['milestone: m-9']) },
    { path: 'backlog/tasks/c.md', text: task('TASK-3', ['milestone: "v2: launch"']) },
  ];
  const milestones: SourceFile[] = [
    { path: 'backlog/milestones/m-1 - One.md', text: '---\nid: m-1\ntitle: One\n---\n' },
    { path: 'backlog/milestones/m-1 - Copy.md', text: '---\nid: m-1\ntitle: Copy of one\n---\n' },
    { path: 'backlog/milestones/broken.md', text: 'no frontmatter at all' },
    { path: 'backlog/milestones/empty.md', text: '' },
    { path: 'backlog/milestones/m-2.md', text: '---\nid: m-2\ntitle: |\n  multi\n---\n' },
  ];
  for (const set of [milestones, []]) {
    const index = buildIndex(tasks, set, DEFAULT_CONFIG);
    const view = buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
    assert.equal(view.tasks.length, 3);
    const title = (id: string) => view.tasks.find((t) => t.id === id)!.milestoneTitle;
    if (set.length > 0) assert.ok(['One', 'Copy of one'].includes(title('TASK-1')!), 'one of the duplicates, never another milestone');
    else assert.equal(title('TASK-1'), null);
    assert.equal(title('TASK-2'), null, 'an unknown milestone shows its id only');
    assert.ok(new Set(view.milestones.map((m) => m.id)).size === view.milestones.length, 'milestone choices have no duplicate ids');
    const root = renderBoard(fakeDocument as never, view, boardColumns(view, view.tasks), { selected: null }) as unknown as FakeElement;
    assert.equal(root.find((e) => e.attrs.get('data-action') === 'show-task').length, 3);
  }
});

// --- 5. The board and list with a very large number of tasks ---------------------------------------------------

test('5: the board and list draw 150,000 tasks without overflowing the call stack', async () => {
  const { renderList } = await import('../../../src/features/backlog/browser/render-list.ts');
  const base = buildBacklogView(buildIndex([{ path: 'backlog/tasks/t.md', text: task('TASK-1') }], [], DEFAULT_CONFIG), DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
  const tasks = Array.from({ length: 150_000 }, (_, i) => ({ ...base.tasks[0], path: `backlog/tasks/t-${i}.md`, id: `TASK-${i + 1}` }));
  const view = { ...base, tasks };
  const board = timed(() => renderBoard(fakeDocument as never, view, boardColumns(view, tasks), { selected: null }) as unknown as FakeElement);
  assert.equal(board.value.find((e) => e.attrs.get('data-action') === 'show-task').length, 150_000);
  const list = timed(() => renderList(fakeDocument as never, view, tasks, { sort: null, selected: null }) as unknown as FakeElement);
  assert.equal(list.value.find((e) => e.tagName === 'tr').length, 150_001);
  assert.ok(board.ms + list.ms < 15_000, `${Math.round(board.ms)} + ${Math.round(list.ms)} ms`);
});
