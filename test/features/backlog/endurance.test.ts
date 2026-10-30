// Endurance (backlog.md 4.1, 5.1): inputs that could exhaust the extension host rather than
// corrupt a file: a huge stray file in tasks/, a task with tens of thousands of comments,
// thousands of task files read at once, config.yml from newer CLI versions, and the memory the
// undo stack keeps for large tasks.
import { test } from 'node:test';
import { whenQuiet } from '../../../src/features/backlog/quiescence.ts';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';

const FAKE_VSCODE = new URL('./fake-vscode-panel.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./fake-vscode-panel.ts');
const { BacklogProjects } = await import('../../../src/features/backlog/project.ts');
const { BacklogPanels } = await import('../../../src/features/backlog/panel.ts');
const { BacklogSession, UNDO_CHAR_LIMIT } = await import('../../../src/features/backlog/session.ts');
const { readTask, MAX_TASK_BYTES } = await import('../../../src/features/backlog/task-index.ts');
const { DEFAULT_STRINGS } = await import('../../../src/features/backlog/view.ts');

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const ROOT = '/work/demo';
const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';
const FILE1 = `${ROOT}/${TASK1}`;
const CONFIG = `${ROOT}/backlog/config.yml`;
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();

function reset(): void {
  fake.files.clear();
  fake.sizes.clear();
  fake.links.clear();
  fake.textDocuments.length = 0;
  fake.log.length = 0;
  fake.panels.length = 0;
  fake.settings.clear();
  fake.reads.clear();
  fake.files.set(CONFIG, readFileSync(new URL('config.yml', PROJECT), 'utf8'));
  for (const sub of ['tasks', 'milestones']) {
    for (const name of readdirSync(new URL(`${sub}/`, PROJECT))) {
      fake.files.set(`${ROOT}/backlog/${sub}/${name}`, readFileSync(new URL(`${sub}/${name}`, PROJECT), 'utf8'));
    }
  }
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file(ROOT), name: 'demo', index: 0 }];
}

async function openPanel() {
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels.at(-1)!;
  const errors = () => panel.posted.filter((m) => (m as { type: string }).type === 'error').map((m) => (m as { reason: string }).reason);
  const done = () => {
    panels.dispose();
    projects.dispose();
  };
  return { projects, panel, errors, done };
}

// --- 1. A huge stray file in tasks/ ----------------------------------------------------------------

test('1: a huge file in tasks/ is never read into memory: listed as too large, never written', async () => {
  reset();
  const huge = `${ROOT}/backlog/tasks/task-99 - Dump.md`;
  fake.files.set(huge, '---\nid: TASK-99\ntitle: Dump\nstatus: To Do\n---\n');
  fake.sizes.set(huge, 3 * 1024 * 1024 * 1024);
  const { projects, panel, errors, done } = await openPanel();
  const index = projects.projects[0].index;
  assert.equal(fake.reads.get(huge) ?? 0, 0, 'not read');
  assert.deepEqual(index.unreadable, [{ path: 'backlog/tasks/task-99 - Dump.md', reason: 'tooLarge' }]);
  assert.equal(index.tasks.length, 7, 'the others are read');
  // A change event for it does not read it either.
  fake.fireWatcher('change', huge);
  await settle();
  assert.equal(fake.reads.get(huge) ?? 0, 0);
  panel.receive({ type: 'setStatus', path: 'backlog/tasks/task-99 - Dump.md', statusLine: 'status: To Do', status: 'Done' });
  await settle(30);
  assert.ok(!fake.log.some((l) => l.startsWith('writeFile')));
  assert.equal(errors().length, 1);
  // Shrunk below the limit: read again.
  fake.sizes.delete(huge);
  fake.fireWatcher('change', huge);
  await settle();
  assert.ok(projects.projects[0].index.byPath.has('backlog/tasks/task-99 - Dump.md'));
  assert.ok(MAX_TASK_BYTES >= 1024 * 1024 && MAX_TASK_BYTES <= 64 * 1024 * 1024);
  done();
});

// --- 2. Tens of thousands of comments -----------------------------------------------------------------

test('2: a task with 30,000 comments parses, renders and takes a new comment in bounded time', async () => {
  const comments = Array.from({ length: 30_000 }, (_, i) => `created: 2026-10-01 10:00\n---\nComment ${i}\n---`).join('\n\n');
  const text = `---\nid: TASK-1\ntitle: Busy\nstatus: To Do\ncreated_date: '2026-10-01 10:00'\nupdated_date: '2026-10-01 10:00'\n---\n\n## Comments\n\n<!-- COMMENTS:BEGIN -->\n${comments}\n<!-- COMMENTS:END -->\n`;
  const start = performance.now();
  const entry = readTask('tasks/busy.md', text);
  assert.equal(entry.kind, 'task');
  assert.equal(entry.kind === 'task' ? entry.data.comments?.length : 0, 30_000);
  const parsed = performance.now() - start;
  assert.ok(parsed < 3000, `parse: ${Math.round(parsed)} ms`);
  const files = new Map([['tasks/busy.md', text]]);
  const posted: { type: string; reason?: string }[] = [];
  const session = new BacklogSession({
    view: () => undefined,
    detail: () => null,
    readTask: async (path) => ({ text: files.get(path)!, version: 1 }),
    write: async (path, { before, after }) => {
      if (files.get(path) !== before) return 'stale';
      files.set(path, after);
      return 'written';
    },
    statuses: () => ['To Do', 'Done'],
    post: (m) => void posted.push(m as never),
    openTask: async () => undefined,
    openPath: async () => undefined,
    openUrl: async () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 15)),
    errors: Object.fromEntries(['stale', 'invalid', 'unsafe', 'failed', 'nothingToUndo', 'readOnly', 'encoding'].map((r) => [r, r])) as never,
    dependencies: () => ({ keyOf: (id) => id, tasks: new Map() }),
    saveLayout: async () => undefined,
    setDetailPosition: async () => undefined,
  });
  const t0 = performance.now();
  await session.handle({ type: 'addComment', path: 'tasks/busy.md', text: 'One more', seen: 30_000 });
  await session.handle({ type: 'setStatus', path: 'tasks/busy.md', statusLine: 'status: To Do', status: 'Done' });
  const edited = performance.now() - t0;
  assert.deepEqual(posted.filter((m) => m.type === 'error'), []);
  assert.match(files.get('tasks/busy.md')!, /One more\n\n---\n<!-- COMMENTS:END -->/);
  assert.ok(edited < 5000, `edits: ${Math.round(edited)} ms`);
  void DEFAULT_STRINGS;
});

// --- 3. Thousands of task files at once -----------------------------------------------------------------

test('3: 3,000 task files on a file system that refuses too many open reads: every task is indexed', async () => {
  reset();
  for (let i = 100; i < 3100; i++) fake.files.set(`${ROOT}/backlog/tasks/task-${i} - Bulk.md`, `---\nid: TASK-${i}\ntitle: Bulk ${i}\nstatus: To Do\n---\n`);
  const readFile = fake.workspace.fs.readFile;
  let inFlight = 0;
  let peak = 0;
  // Like EMFILE: more than 256 reads at once fail.
  fake.workspace.fs.readFile = async (uri) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (inFlight > 256) throw new fake.FileSystemError(uri.path, 'Unavailable');
      return await readFile(uri);
    } finally {
      inFlight--;
    }
  };
  try {
    const { projects, done } = await openPanel();
    await projects.idle();
    const index = projects.projects[0].index;
    assert.equal(index.tasks.length, 3007, `peak ${peak} reads at once`);
    // A burst of change events for all of them as well.
    for (let i = 100; i < 3100; i++) fake.fireWatcher('change', `${ROOT}/backlog/tasks/task-${i} - Bulk.md`);
    await settle(300);
    await projects.idle();
    assert.equal(projects.projects[0].index.tasks.length, 3007);
    done();
  } finally {
    fake.workspace.fs.readFile = readFile;
  }
});

// --- 4. config.yml from newer CLI versions --------------------------------------------------------------

test('4: config.yml with keys and shapes this version does not know: detected, statuses never guessed, never written', async () => {
  const configs: { text: string; statuses: string[] | 'unreadable' }[] = [
    { text: 'statuses: ["To Do", "Doing", "Done"]\nmcp:\n  enabled: true\n  port: 8080\nchecks: {a: 1, b: [x, y]}\ndefaults: &d\n  x: 1\nother: *d\nonStatusChange: "echo $1"\n', statuses: ['To Do', 'Doing', 'Done'] },
    { text: 'statuses: [\n  "To Do",\n  "Done"\n]\n', statuses: 'unreadable' },
    { text: 'statuses:\n  - To Do\n  # Doing was removed\n  - Done\n', statuses: 'unreadable' },
    { text: 'statuses: ["To Do", "Done"] # trailing comment\n', statuses: 'unreadable' },
    { text: 'statuses: |\n  To Do\n  Done\n', statuses: 'unreadable' },
    { text: 'statuses: &s ["To Do", "Done"]\n', statuses: 'unreadable' },
  ];
  for (const { text, statuses } of configs) {
    reset();
    fake.files.set(CONFIG, text);
    const { projects, panel, errors, done } = await openPanel();
    assert.equal(projects.projects.length, 1, text);
    assert.equal(projects.projects[0].index.tasks.length, 7, text);
    if (statuses !== 'unreadable') assert.deepEqual(projects.projects[0].config.statuses, statuses, text);
    else assert.ok(projects.projects[0].unreadable.includes('statuses'), text);
    const before = fake.files.get(FILE1);
    panel.receive({ type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'Done' });
    await settle(30);
    if (statuses === 'unreadable') {
      assert.equal(fake.files.get(FILE1), before, `no status from the defaults: ${text}`);
      assert.equal(errors().length, 1);
    } else {
      assert.match(fake.files.get(FILE1)!, /\nstatus: Done\n/);
    }
    assert.equal(fake.files.get(CONFIG), text, 'config.yml is never written');
    assert.ok(!fake.log.some((l) => l.includes('config.yml')), fake.log.join('\n'));
    done();
  }
});

// --- 5. Undo memory with large tasks ---------------------------------------------------------------------

test('5: the undo stack keeps a bounded amount of text: edits of a 5 MB task do not pile up 50 full copies', async () => {
  const lines = Array.from({ length: 100_000 }, (_, i) => `Line ${i} ${'x'.repeat(40)}`).join('\n');
  const big = `---\nid: TASK-1\ntitle: Big\nstatus: To Do\ncreated_date: '2026-10-01 10:00'\nupdated_date: '2026-10-01 10:00'\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n${lines}\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 First\n<!-- AC:END -->\n`;
  assert.ok(big.length > 4_000_000);
  const files = new Map([['t.md', big]]);
  const errors: string[] = [];
  const session = new BacklogSession({
    view: () => undefined,
    detail: () => null,
    readTask: async (path) => ({ text: files.get(path)!, version: 1 }),
    write: async (path, { before, after }) => {
      if (files.get(path) !== before) return 'stale';
      files.set(path, after);
      return 'written';
    },
    statuses: () => ['To Do', 'Done'],
    post: (m) => void (m.type === 'error' && errors.push(m.reason)),
    openTask: async () => undefined,
    openPath: async () => undefined,
    openUrl: async () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 15)),
    errors: Object.fromEntries(['stale', 'invalid', 'unsafe', 'failed', 'nothingToUndo', 'readOnly', 'encoding'].map((r) => [r, r])) as never,
    dependencies: () => ({ keyOf: (id) => id, tasks: new Map() }),
    saveLayout: async () => undefined,
    setDetailPosition: async () => undefined,
  });
  const line = big.split('\n').indexOf('- [ ] #1 First');
  const states = [big];
  for (let i = 0; i < 40; i++) {
    const checked = i % 2 === 0;
    await session.handle({ type: 'toggleCheck', path: 't.md', list: 'ac', line, source: checked ? '- [ ] #1 First' : '- [x] #1 First', checked });
    states.push(files.get('t.md')!);
  }
  assert.deepEqual(errors, []);
  let undone = 0;
  while (undone < 60) {
    await session.handle({ type: 'undo' });
    if (errors.length > 0) break;
    undone++;
    assert.equal(files.get('t.md'), states[states.length - 1 - undone], `undo ${undone} restores the exact bytes`);
  }
  assert.deepEqual(errors, ['nothingToUndo']);
  assert.ok(undone >= 1, 'the latest change can always be undone');
  assert.ok(undone * 2 * big.length <= UNDO_CHAR_LIMIT + 2 * big.length, `${undone} entries of ${big.length} chars kept`);
  assert.ok(undone < 40, 'older entries were dropped');
});
