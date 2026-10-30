// Parity with the Backlog.md CLI 1.54.0 (backlog.md 3.2, 4.2, 5.4). Each scalar below was written
// by Notewell's planners into a task and read back by `backlog task view --json` as exactly the
// value given (as a title, a status and a label; checked 2026-10-15 with 1.53.0 and 2026-10-17
// with 1.54.0). This locks the formatting.
// Archived tasks (archive/tasks/, and completed/ from before 1.54.0) meet a dependency only in
// the final status, as the CLI 1.54.0 readiness does; unknown ones block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../../../src/features/backlog/config.ts';
import { buildIndex, type SourceFile } from '../../../src/features/backlog/task-index.ts';
import { buildBacklogView, buildTaskDetail } from '../../../src/features/backlog/view-build.ts';
import { DEFAULT_STRINGS } from '../../../src/features/backlog/view.ts';
import { formatScalar, parseScalar } from '../../../src/features/backlog/yaml-lite.ts';

const checks = new URL('../../fixtures/backlog/cli-checks/', import.meta.url);
/** The plain-style scalar Notewell writes for each value: every pair verified against the CLI. */
const CLI_VERIFIED: readonly { value: string; written: string }[] = JSON.parse(readFileSync(new URL('scalars.json', checks), 'utf8'));

test('scalars are written exactly in their CLI-verified form, and our parser reads them back too', () => {
  assert.equal(CLI_VERIFIED.length, 55);
  for (const { value, written } of CLI_VERIFIED) {
    assert.equal(formatScalar(value, 'plain'), written, JSON.stringify(value));
    assert.equal(parseScalar(written)?.value, value, JSON.stringify(value));
  }
});

const task = (id: string, extra: string[] = []): string => ['---', `id: ${id}`, `title: Task ${id}`, 'status: To Do', ...extra, '---', ''].join('\n');

const withStatus = (id: string, status: string | null, title = `Task ${id}`): string =>
  ['---', `id: ${id}`, `title: ${title}`, ...(status === null ? [] : [`status: ${status}`]), '---', ''].join('\n');

// Checked with CLI 1.54.0 (`task list --ready`, `task view`): an archived dependency, in
// archive/tasks/ or a leftover completed/, is met only when it is in the final status.
test('an archived dependency is met only in the final status, in archive/tasks/ and completed/ alike', () => {
  const deps = ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5', 'task-9'];
  const files: SourceFile[] = [{ path: 'backlog/tasks/task-10.md', text: task('TASK-10', ['dependencies:', ...deps.map((d) => `  - ${d}`)]) }];
  const archived: SourceFile[] = [
    { path: 'backlog/archive/tasks/task-1 - A.md', text: withStatus('TASK-1', 'Done', 'Shipped part') },
    { path: 'backlog/archive/tasks/task-2 - B.md', text: withStatus('TASK-2', 'To Do', 'Dropped part') },
    { path: 'backlog/completed/task-3 - C.md', text: withStatus('TASK-3', 'done') },
    { path: 'backlog/completed/task-4 - D.md', text: withStatus('TASK-4', 'In Progress') },
    { path: 'backlog/archive/tasks/task-5 - E.md', text: withStatus('TASK-5', null) },
  ];
  const index = buildIndex(files, [], DEFAULT_CONFIG, archived);
  const view = buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
  assert.deepEqual(view.tasks.map((t) => t.id), ['TASK-10'], 'archived tasks are not on the board');
  // TASK-3's `done` matches the final status case-insensitively; TASK-5 has no status (the default).
  assert.deepEqual(view.tasks[0].blockedBy, ['TASK-2', 'TASK-4', 'TASK-5', 'task-9']);
  const detail = buildTaskDetail(index, 'backlog/tasks/task-10.md')!;
  assert.deepEqual(detail.dependencies, [
    { id: 'TASK-1', path: 'backlog/archive/tasks/task-1 - A.md', title: 'Shipped part', status: 'Done', archived: true },
    { id: 'TASK-2', path: 'backlog/archive/tasks/task-2 - B.md', title: 'Dropped part', status: 'To Do', archived: true },
    { id: 'TASK-3', path: 'backlog/completed/task-3 - C.md', title: 'Task TASK-3', status: 'Done', archived: true },
    { id: 'TASK-4', path: 'backlog/completed/task-4 - D.md', title: 'Task TASK-4', status: 'In Progress', archived: true },
    { id: 'TASK-5', path: 'backlog/archive/tasks/task-5 - E.md', title: 'Task TASK-5', status: 'To Do', archived: true },
    { id: 'task-9', path: null, title: null, status: null, archived: false },
  ]);
});

test('archived tasks open read-only: their detail, the list of them, links back to the board', () => {
  const files: SourceFile[] = [
    { path: 'backlog/tasks/task-10.md', text: task('TASK-10', ['dependencies:', '  - TASK-1']) },
    { path: 'backlog/tasks/task-11.md', text: task('TASK-11', ['parent_task_id: TASK-2']) },
  ];
  const archived: SourceFile[] = [
    { path: 'backlog/archive/tasks/task-1 - A.md', text: [...withStatus('TASK-1', 'Done', 'Shipped part').split('\n').slice(0, -2), "updated_date: '2026-10-01 10:00'", 'dependencies:', '  - TASK-10', '---', ''].join('\n') },
    { path: 'backlog/completed/task-2 - B.md', text: withStatus('TASK-2', 'In Progress', 'Old parent') },
  ];
  const index = buildIndex(files, [], DEFAULT_CONFIG, archived);
  const view = buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
  assert.deepEqual(view.tasks.map((t) => t.id), ['TASK-10', 'TASK-11']);
  assert.deepEqual(view.archived.map((t) => [t.id, t.path, t.status]), [
    ['TASK-1', 'backlog/archive/tasks/task-1 - A.md', 'Done'],
    ['TASK-2', 'backlog/completed/task-2 - B.md', 'In Progress'],
  ]);
  const detail = buildTaskDetail(index, 'backlog/archive/tasks/task-1 - A.md')!;
  assert.deepEqual([detail.id, detail.title, detail.archived, detail.editable, detail.statusLine], ['TASK-1', 'Shipped part', true, false, null], 'read-only even with a writable updated_date');
  // Its own dependency is a board task; the board task that depends on it shows under Blocks.
  assert.deepEqual(detail.dependencies, [{ id: 'TASK-10', path: 'backlog/tasks/task-10.md', title: 'Task TASK-10', status: 'To Do', archived: false }]);
  assert.deepEqual(detail.blocks.map((r) => [r.id, r.archived]), [['TASK-10', false]]);
  // A board task whose parent is archived links to it.
  assert.deepEqual(buildTaskDetail(index, 'backlog/tasks/task-11.md')!.parent, { id: 'TASK-2', path: 'backlog/completed/task-2 - B.md', title: 'Old parent', status: 'In Progress', archived: true });
  assert.equal(buildTaskDetail(index, 'backlog/tasks/task-10.md')!.archived, false);
  assert.equal(buildTaskDetail(index, 'backlog/archive/tasks/nothing.md'), null);
});

test('archived dependencies: the final status follows the config; bare numbers and case match; the board copy is shown first', () => {
  const config = { ...DEFAULT_CONFIG, statuses: ['Todo', 'Doing', 'Shipped'] };
  const files: SourceFile[] = [
    { path: 'backlog/tasks/task-10.md', text: task('TASK-10', ['dependencies:', '  - 1', '  - task-2', '  - TASK-3']) },
    // TASK-3 is on the board (not done) and also archived (done): met, and the board copy is shown.
    { path: 'backlog/tasks/task-3.md', text: withStatus('TASK-3', 'Doing', 'On the board') },
  ];
  const archived: SourceFile[] = [
    { path: 'backlog/archive/tasks/task-1.md', text: withStatus('TASK-1', 'Shipped') },
    { path: 'backlog/archive/tasks/task-2.md', text: withStatus('TASK-2', 'Done') },
    { path: 'backlog/archive/tasks/task-3.md', text: withStatus('TASK-3', 'Shipped', 'Archived copy') },
  ];
  const index = buildIndex(files, [], config, archived);
  const view = buildBacklogView(index, config, 'demo', DEFAULT_STRINGS);
  assert.deepEqual(view.tasks.find((t) => t.id === 'TASK-10')!.blockedBy, ['task-2'], '"Done" is not final here');
  const detail = buildTaskDetail(index, 'backlog/tasks/task-10.md')!;
  assert.deepEqual(detail.dependencies.map((d) => [d.id, d.path, d.title, d.status, d.archived]), [
    ['1', 'backlog/archive/tasks/task-1.md', 'Task TASK-1', 'Shipped', true],
    ['task-2', 'backlog/archive/tasks/task-2.md', 'Task TASK-2', 'Done', true],
    ['TASK-3', 'backlog/tasks/task-3.md', 'On the board', 'Doing', false],
  ]);
});

test('archived tasks with one ID: met when any is done; the first by path is shown; unreadable ones are ignored', () => {
  const files: SourceFile[] = [{ path: 'backlog/tasks/task-10.md', text: task('TASK-10', ['dependencies:', '  - TASK-1', '  - TASK-2']) }];
  const archived: SourceFile[] = [
    { path: 'backlog/completed/task-1.md', text: withStatus('TASK-1', 'Done', 'Old copy') },
    { path: 'backlog/archive/tasks/task-1.md', text: withStatus('TASK-1', 'To Do', 'New copy') },
    { path: 'backlog/archive/tasks/task-2.md', text: 'no frontmatter, id: TASK-2' },
  ];
  const index = buildIndex(files, [], DEFAULT_CONFIG, archived);
  assert.deepEqual(buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS).tasks[0].blockedBy, ['TASK-2']);
  assert.deepEqual(buildTaskDetail(index, 'backlog/tasks/task-10.md')!.dependencies[0], { id: 'TASK-1', path: 'backlog/archive/tasks/task-1.md', title: 'New copy', status: 'To Do', archived: true });
  assert.deepEqual(index.unreadable, [], 'archived files never show as unreadable tasks');
});

test('the project reads archive/tasks/ and completed/ (and follows changes there) for dependencies only', async () => {
  const { registerHooks } = await import('node:module');
  const fakeUrl = new URL('./fake-vscode.ts', import.meta.url).href;
  registerHooks({ resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: fakeUrl, shortCircuit: true } : next(specifier, context)) });
  const fake = await import('./fake-vscode.ts');
  const { BacklogProjects } = await import('../../../src/features/backlog/project.ts');
  fake.files.clear();
  fake.files.set('/ws/backlog/config.yml', 'statuses: ["To Do", "Done"]\n');
  fake.files.set('/ws/backlog/tasks/task-4.md', task('TASK-4', ['dependencies:', '  - TASK-2', '  - TASK-3']));
  fake.files.set('/ws/backlog/completed/task-2 - Done.md', withStatus('TASK-2', 'Done'));
  fake.files.set('/ws/backlog/archive/tasks/task-3 - Later.md', withStatus('TASK-3', 'To Do'));
  // Not read: other archive folders, nested folders.
  fake.files.set('/ws/backlog/archive/docs/doc-1 - Guide.md', withStatus('TASK-7', 'Done'));
  fake.files.set('/ws/backlog/archive/tasks/old/task-8.md', withStatus('TASK-8', 'Done'));
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file('/ws'), name: 'ws', index: 0 }];
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const { whenQuiet } = await import('../../../src/features/backlog/quiescence.ts');
  const blockedBy = () => buildBacklogView(index(), index().config, 'demo', DEFAULT_STRINGS).tasks[0].blockedBy;
  const index = () => projects.projects[0].index;
  try {
    assert.deepEqual(index().tasks.map((t) => t.id), ['TASK-4']);
    assert.deepEqual([...index().archived.keys()].sort(), ['TASK-2', 'TASK-3']);
    assert.deepEqual(blockedBy(), ['TASK-3']);
    // `backlog task edit` cannot touch archived tasks; a restore, a hand edit or git can.
    fake.files.set('/ws/backlog/archive/tasks/task-3 - Later.md', withStatus('TASK-3', 'Done'));
    fake.fireWatcher('change', '/ws/backlog/archive/tasks/task-3 - Later.md');
    await whenQuiet();
    assert.deepEqual(blockedBy(), [], 'a change in archive/tasks/ is followed');
    fake.files.delete('/ws/backlog/completed/task-2 - Done.md');
    fake.fireWatcher('delete', '/ws/backlog/completed/task-2 - Done.md');
    await whenQuiet();
    assert.equal(index().archived.has('TASK-2'), false, 'a change in completed/ is followed');
    assert.deepEqual(blockedBy(), ['TASK-2']);
    // `backlog doctor --fix` moves completed/ into archive/tasks/ (the event may be missed).
    fake.files.set('/ws/backlog/archive/tasks/task-2 - Done.md', withStatus('TASK-2', 'Done'));
    await projects.rescan();
    assert.deepEqual(blockedBy(), [], 'a rescan finds it');
    // Removing the whole archive folder drops what was read from it.
    for (const path of [...fake.files.keys()]) if (path.startsWith('/ws/backlog/archive/')) fake.files.delete(path);
    fake.fireWatcher('delete', '/ws/backlog/archive');
    await whenQuiet();
    assert.deepEqual(blockedBy(), ['TASK-2', 'TASK-3']);
  } finally {
    projects.dispose();
  }
});

// Frontmatter exactly as the CLI 1.53.0 re-serializes it after an edit (js-yaml): long values are
// folded (`>-`), values with tabs or characters outside the BMP become double-quoted escapes.
const CLI_SERIALIZED = [
  '---',
  'id: TASK-1',
  'title: >-',
  '  A very long title that keeps going and going well past eighty characters to',
  '  see whether it folds at all, yes or no',
  String.raw`status: "In\tProgress"`,
  'assignee:',
  String.raw`  - "@ü\U0001F600"`,
  'labels:',
  String.raw`  - "lab\U0001F600el"`,
  String.raw`  - "back\\slash \"q\" \x41é"`,
  String.raw`milestone: "emoji \U0001F389 ok"`,
  'priority: low',
  '---',
  '',
].join('\n');

test('folded titles and double-quoted escapes as the CLI writes them are read as the CLI reads them', () => {
  const index = buildIndex([{ path: 'backlog/tasks/t.md', text: CLI_SERIALIZED }], [], DEFAULT_CONFIG);
  const [t] = index.tasks;
  assert.equal(t.data.title, 'A very long title that keeps going and going well past eighty characters to see whether it folds at all, yes or no');
  assert.equal(t.data.status, 'In\tProgress');
  assert.deepEqual(t.data.assignees, [`@ü${String.fromCodePoint(0x1f600)}`]);
  assert.deepEqual(t.data.labels, [`lab${String.fromCodePoint(0x1f600)}el`, 'back\\slash "q" Aé']);
  assert.equal(t.data.milestone, `emoji ${String.fromCodePoint(0x1f389)} ok`);
  assert.deepEqual(t.data.otherFields, [], 'nothing is left as an unknown shape');
  // Shapes that are not read stay unknown (refused for writing) rather than guessed.
  for (const odd of [String.raw`title: "bad \q escape"`, String.raw`title: "\uD800 lone"`, 'title: >-\n  first\n    more indented\n  third', 'title: |2-\n    explicit indent']) {
    const text = CLI_SERIALIZED.replace(/title: >-\n.*\n.*\n/, `${odd}\n`);
    const data = buildIndex([{ path: 'backlog/tasks/t.md', text }], [], DEFAULT_CONFIG).tasks[0]?.data;
    assert.equal(data?.title ?? '', '', odd);
  }
});

test('a folded title can be renamed: the field becomes one line, nothing else changes', async () => {
  const { BacklogSession } = await import('../../../src/features/backlog/session.ts');
  const files = new Map([['t.md', CLI_SERIALIZED.replace('status: "In\tProgress"', 'status: To Do')]]);
  const errors: string[] = [];
  const session = new BacklogSession({
    view: () => undefined, detail: () => null,
    readTask: async (p) => ({ text: files.get(p)!, version: 1 }),
    write: async (p, { before, after }) => (files.get(p) === before ? (files.set(p, after), 'written') : 'stale'),
    statuses: () => ['To Do', 'Done'], post: (m) => void (m.type === 'error' && errors.push(m.reason)),
    openTask: async () => undefined, openPath: async () => undefined, openUrl: async () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 15)), errors: new Proxy({}, { get: (_, k) => String(k) }) as never,
    dependencies: () => ({ keyOf: (id) => id, tasks: new Map() }), saveLayout: async () => undefined, setDetailPosition: async () => undefined,
  });
  const before = files.get('t.md')!;
  const expected = before.split('\n').slice(2, 5).join('\n');
  await session.handle({ type: 'setField', path: 't.md', name: 'title', value: 'Short again', expected });
  assert.deepEqual(errors, []);
  const after = files.get('t.md')!;
  const withoutUpdated = (text: string) => text.split('\n').filter((l) => !l.startsWith('updated_date:')).join('\n');
  assert.equal(withoutUpdated(after), before.replace(/title: >-\n.*\n.*\n/, 'title: Short again\n'), 'only the title lines (and updated_date) change');
  // A double-quoted escaped value keeps its double quotes when replaced.
  await session.handle({ type: 'setField', path: 't.md', name: 'milestone', value: 'm-1 🙂', expected: String.raw`milestone: "emoji \U0001F389 ok"` });
  assert.deepEqual(errors, []);
  assert.match(files.get('t.md')!, /\nmilestone: "m-1 🙂"\n/);
});

// Default task order, as `backlog task list --plain` 1.54.0 printed it (cli-checks/order.json:
// [ordinal, priority] by task number; checked 2026-10-17): ordinal (missing last), then the
// configured priorities in order (case-insensitive), then the rest (none and unconfigured alike),
// then ID. The same cases are rechecked against an installed CLI when it changes.
interface OrderCases {
  readonly taskSets: Record<string, Record<string, readonly [number | null, string | null]>>;
  readonly cases: readonly { readonly name: string; readonly tasks: string; readonly config: string | null; readonly order: string }[];
}
const ORDER: OrderCases = JSON.parse(readFileSync(new URL('order.json', checks), 'utf8'));

test('board order matches the CLI 1.54.0 default task order (ordinal, configured priority, ID)', async () => {
  const { parseConfig } = await import('../../../src/features/backlog/config.ts');
  assert.equal(ORDER.cases.length, 6);
  for (const { name, tasks, config: line, order } of ORDER.cases) {
    const files: SourceFile[] = Object.entries(ORDER.taskSets[tasks])
      // Paths in reverse: the order never comes from the file names.
      .map(([n, [ordinal, priority]], i) => ({
        path: `backlog/tasks/${String.fromCharCode(122 - i)}.md`,
        text: task(`TASK-${n}`, [...(ordinal === null ? [] : [`ordinal: ${ordinal}`]), ...(priority === null ? [] : [`priority: ${priority}`])]),
      }));
    const config = line === null ? DEFAULT_CONFIG : parseConfig(`statuses: ["To Do", "Done"]\n${line}\n`).config;
    const view = buildBacklogView(buildIndex(files, [], config), config, 'demo', DEFAULT_STRINGS);
    assert.equal(view.tasks.map((t) => t.id.slice('TASK-'.length)).join(' '), order, name);
  }
});
