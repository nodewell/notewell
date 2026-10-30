// Panel stability (backlog.md 4.1, 5.1): editors and the panel editing the same task, config
// changes while the panel is open, one folder reachable as two projects, bursts of external
// writes, and webviews that reload mid-operation. Against the fake `vscode`, as panel.test.ts.
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

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const ROOT = '/work/demo';
const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';
const FILE1 = `${ROOT}/${TASK1}`;
const CONFIG = `${ROOT}/backlog/config.yml`;
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();
const setDone = { type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'Done' };
/** AC #2 of TASK1, unchecked in the fixture. */
const AC2 = '- [ ] #2 Typecheck passes';

function reset(roots: string[] = [ROOT]): void {
  fake.files.clear();
  fake.textDocuments.length = 0;
  fake.log.length = 0;
  fake.panels.length = 0;
  fake.settings.clear();
  fake.editor.refuse = false;
  fake.editor.writeFails = false;
  fake.written.clear();
  for (const root of roots) {
    fake.files.set(`${root}/backlog/config.yml`, readFileSync(new URL('config.yml', PROJECT), 'utf8'));
    for (const sub of ['tasks', 'milestones']) {
      for (const name of readdirSync(new URL(`${sub}/`, PROJECT))) {
        fake.files.set(`${root}/backlog/${sub}/${name}`, readFileSync(new URL(`${sub}/${name}`, PROJECT), 'utf8'));
      }
    }
  }
  fake.workspace.workspaceFolders = roots.map((path, index) => ({ uri: fake.Uri.file(path), name: path.split('/').pop()!, index }));
}

type Options = Parameters<typeof BacklogProjects.create>[0];

async function openPanel(options: Partial<Options> = {}) {
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined, ...options });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels.at(-1)!;
  const errors = () => panel.posted.filter((m) => (m as { type: string }).type === 'error').map((m) => (m as { reason: string }).reason);
  const renders = () => panel.posted.filter((m) => (m as { type: string }).type === 'render') as { view: { statuses: string[]; tasks: { path: string; status: string; ordinal: number | null }[] } }[];
  const done = () => {
    panels.dispose();
    projects.dispose();
  };
  return { projects, panels, panel, errors, renders, done };
}

const lineIndex = (text: string, line: string): number => text.split(/\r?\n/).indexOf(line);
const toggleAc2 = (text: string) => ({ type: 'toggleCheck', path: TASK1, list: 'ac', line: lineIndex(text, AC2), source: AC2, checked: true });
const written = () => fake.log.filter((l) => l.startsWith('writeFile') || l.startsWith('applyEdit') || l.startsWith('save'));

// --- 1. The same task in a text editor and in the panel ------------------------------------------

test('1: dirty editor, panel edit, then Ctrl+Z in the editor: the panel undo is stale and changes nothing', async () => {
  reset();
  const { panel, errors, done } = await openPanel();
  const disk = fake.files.get(FILE1)!;
  const unsaved = `${disk}typed\n`;
  const doc = fake.openEditorDocument(FILE1, unsaved);
  panel.receive(setDone);
  await settle(30);
  assert.match(doc.text, /status: Done/);
  // Ctrl+Z in the editor takes the panel's edit back out.
  doc.text = unsaved;
  doc.version++;
  panel.receive({ type: 'undo' });
  await settle(30);
  assert.equal(doc.text, unsaved);
  assert.equal(fake.files.get(FILE1), disk, 'the disk was never written');
  assert.deepEqual(errors(), ['stale']);
  assert.ok(!fake.log.some((l) => l.startsWith('writeFile') || l.startsWith('save')));
  done();
});

test('1: saveOnEdit on, clean editor: typing that starts while the panel reads is never overwritten on disk', async () => {
  reset();
  const { panel, errors, done } = await openPanel();
  const disk = fake.files.get(FILE1)!;
  const doc = fake.openEditorDocument(FILE1);
  const readFile = fake.workspace.fs.readFile;
  let reads = 0;
  // The user types right after the panel read the file (the document becomes dirty).
  fake.workspace.fs.readFile = async (uri) => {
    const bytes = await readFile(uri);
    if (uri.path === FILE1 && ++reads === 1) {
      doc.text = `${doc.text}typing\n`;
      doc.isDirty = true;
      doc.version++;
    }
    return bytes;
  };
  try {
    panel.receive(setDone);
    await settle(30);
  } finally {
    fake.workspace.fs.readFile = readFile;
  }
  assert.deepEqual(written(), [], 'neither the disk nor the document is changed');
  assert.equal(fake.files.get(FILE1), disk);
  assert.equal(doc.text, `${disk}typing\n`);
  assert.deepEqual(errors(), ['stale']);
  done();
});

test('1: saveOnEdit off: edits and undo go to the document only and restore it exactly; a save in between keeps both in step', async () => {
  reset();
  fake.settings.set('notewell.backlog.saveOnEdit', false);
  const { panel, done } = await openPanel();
  const disk = fake.files.get(FILE1)!;
  panel.receive(setDone);
  await settle(30);
  const doc = fake.textDocuments.find((d) => d.uri.path === FILE1)! as unknown as { text: string; isDirty: boolean; save(): Promise<boolean> };
  assert.match(doc.text, /status: Done/);
  assert.equal(fake.files.get(FILE1), disk);
  panel.receive({ type: 'undo' });
  await settle(30);
  assert.equal(doc.text, disk, 'the document is back byte for byte');
  assert.equal(fake.files.get(FILE1), disk);
  assert.ok(!fake.log.some((l) => l.startsWith('writeFile') || l.startsWith('save')));
  // Edit, the user saves, then undo: disk and document end up equal.
  fake.settings.delete('notewell.backlog.saveOnEdit');
  fake.openEditorDocument(FILE1, `${doc.text}typed\n`);
  panel.receive(setDone);
  await settle(30);
  await doc.save();
  panel.receive({ type: 'undo' });
  await settle(30);
  assert.equal(fake.files.get(FILE1), `${disk}typed\n`);
  assert.equal(doc.text, fake.files.get(FILE1));
  done();
});

// --- 2. config.yml changes while the panel is open -----------------------------------------------

async function changeConfig(text: string): Promise<void> {
  fake.files.set(CONFIG, text);
  fake.fireWatcher('change', CONFIG);
  await settle();
}

test('2: statuses renamed, removed or reordered: the board redraws; a status from the old list is never written', async () => {
  reset();
  const { panel, errors, renders, done } = await openPanel();
  panel.receive({ type: 'ready' });
  await settle(30);
  const before = fake.files.get(FILE1)!;
  await changeConfig('statuses: ["Done", "To Do", "Doing"]\ntask_prefix: "issue"\n');
  assert.deepEqual(renders().at(-1)!.view.statuses, ['Done', 'To Do', 'Doing'], 'redrawn with the new order');
  // Detail select and board drop still showing "In Progress".
  panel.receive({ type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'In Progress' });
  panel.receive({ type: 'setStatus', path: TASK1, statusLine: '', fromStatus: 'In Progress', status: 'Review' });
  await settle(30);
  assert.equal(fake.files.get(FILE1), before);
  assert.deepEqual(errors(), ['invalid', 'invalid']);
  // A renamed spelling is written as configured.
  await changeConfig('statuses: ["To Do", "In Progress", "DONE"]\n');
  panel.receive({ type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'Done' });
  await settle(30);
  assert.match(fake.files.get(FILE1)!, /\nstatus: DONE\n/);
  done();
});

test('2: a broken config (statuses unreadable) refuses status changes instead of using the defaults', async () => {
  reset();
  const { panel, errors, done } = await openPanel();
  panel.receive({ type: 'ready' });
  await settle(30);
  const before = fake.files.get(FILE1)!;
  await changeConfig('statuses: [To Do, [broken]\n');
  panel.receive(setDone);
  panel.receive({ type: 'setStatus', path: TASK1, statusLine: '', fromStatus: 'In Progress', status: 'Done' });
  await settle(30);
  assert.equal(fake.files.get(FILE1), before);
  assert.equal(errors().length, 2);
  // Other edits still work.
  panel.receive(toggleAc2(before));
  await settle(30);
  assert.match(fake.files.get(FILE1)!, /- \[x\] #2 Typecheck passes/);
  // The config deleted: the project is gone and nothing is written.
  const now = fake.files.get(FILE1)!;
  fake.files.delete(CONFIG);
  fake.fireWatcher('delete', CONFIG);
  await settle();
  panel.receive({ type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'To Do' });
  await settle(30);
  assert.equal(fake.files.get(FILE1), now);
  done();
});

// --- 3. One Backlog folder, two ways to reach it ------------------------------------------------

test('3: a registered folder that also becomes a workspace project keeps one panel, which keeps working', async () => {
  reset([]);
  // The project folder exists, but is not a workspace folder yet: only the registration finds it.
  reset([ROOT]);
  fake.workspace.workspaceFolders = [];
  const registered = () => [{ entry: `${ROOT}/backlog/`, candidates: [fake.Uri.file(`${ROOT}/backlog/`) as never] }];
  const { projects, panels, panel, done } = await openPanel({ registered });
  assert.equal(projects.projects.length, 1);
  panel.receive({ type: 'ready' });
  await settle(30);
  // Now the same folder is also found at a workspace folder root.
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file(ROOT), name: 'demo', index: 0 }];
  fake.folderEvents.fire({});
  await settle();
  assert.equal(projects.projects.length, 1, 'one project');
  panels.open(projects.projects[0]);
  assert.equal(fake.panels.length, 1, 'the open panel is reused');
  assert.equal(panel.revealed, 1);
  panel.receive(setDone);
  await settle(30);
  assert.match(fake.files.get(FILE1)!, /\nstatus: Done\n/, 'the panel still writes its task');
  done();
});

test('3: spellings of one folder count once; a registered folder nested in another project never receives its writes', async () => {
  reset();
  fake.files.set(`${ROOT}/backlog/nested/config.yml`, 'statuses: [Open, Closed]\n');
  fake.files.set(`${ROOT}/backlog/nested/tasks/task-1 - Nested.md`, '---\nid: TASK-1\ntitle: Nested\nstatus: Open\n---\n');
  const spellings = [`${ROOT}/backlog`, `${ROOT}/backlog/`, `${ROOT}//backlog`, ...(process.platform === 'win32' ? [`${ROOT.toUpperCase()}/BACKLOG`] : [])];
  const registered = () => [
    ...spellings.map((p) => ({ entry: p, candidates: [fake.Uri.file(p) as never] })),
    { entry: 'nested', candidates: [fake.Uri.file(`${ROOT}/backlog/nested`) as never] },
  ];
  const { projects, panels, done } = await openPanel({ registered });
  assert.deepEqual(projects.projects.map((p) => p.directory), ['backlog', 'nested']);
  panels.open(projects.projects[1]);
  const nested = fake.panels.at(-1)!;
  const before = new Map(fake.files);
  for (const path of [TASK1, `../${TASK1}`, 'tasks/task-1 - Set-up-the-build.md', '../tasks/task-1 - Set-up-the-build.md']) {
    nested.receive({ type: 'setStatus', path, statusLine: 'status: In Progress', status: 'Done' });
  }
  await settle(30);
  assert.deepEqual(new Map(fake.files), before);
  assert.deepEqual(written(), []);
  done();
});

test('3: when the same folder is found again under another root, the panel follows it and resolves paths against the new root', async () => {
  reset([]);
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file('/work/ws'), name: 'ws', index: 0 }];
  fake.files.set('/work/ws/x/plan/config.yml', 'statuses: [Open, Closed]\n');
  fake.files.set('/work/ws/x/plan/tasks/t.md', '---\nid: TASK-1\ntitle: T\nstatus: Open\n---\n');
  // A decoy where the old relative path would land under the new root.
  fake.files.set('/work/ws/plan/tasks/t.md', '---\nid: TASK-1\ntitle: Decoy\nstatus: Open\n---\n');
  const registered = () => [{ entry: 'x/plan', candidates: [fake.Uri.file('/work/ws/x/plan') as never] }];
  const { projects, panel, errors, done } = await openPanel({ registered });
  assert.deepEqual(projects.projects.map((p) => [p.folder.path, p.directory]), [['/work/ws/x', 'plan']]);
  panel.receive({ type: 'ready' });
  await settle(30);
  // Detection now finds the same folder from the workspace root.
  fake.files.set('/work/ws/backlog.config.yml', 'backlog_directory: x/plan\nstatuses: [Open, Closed]\n');
  fake.fireWatcher('create', '/work/ws/backlog.config.yml');
  await settle();
  assert.deepEqual(projects.projects.map((p) => [p.folder.path, p.directory]), [['/work/ws', 'x/plan']]);
  const decoy = fake.files.get('/work/ws/plan/tasks/t.md');
  panel.receive({ type: 'setStatus', path: 'plan/tasks/t.md', statusLine: 'status: Open', status: 'Closed' });
  await settle(30);
  assert.equal(fake.files.get('/work/ws/plan/tasks/t.md'), decoy, 'the old path is not resolved against the new root');
  assert.deepEqual(errors(), ['stale']);
  panel.receive({ type: 'setStatus', path: 'x/plan/tasks/t.md', statusLine: 'status: Open', status: 'Closed' });
  await settle(30);
  assert.match(fake.files.get('/work/ws/x/plan/tasks/t.md')!, /\nstatus: Closed\n/);
  done();
});

// --- 4. Bursts of external writes -----------------------------------------------------------------

test('4: an agent rewriting 50 task files (atomic replace) while the user toggles: external changes kept, edits on top or refused', async () => {
  reset();
  for (let i = 10; i < 60; i++) {
    fake.files.set(`${ROOT}/backlog/tasks/task-${i} - Bulk.md`, `---\nid: TASK-${i}\ntitle: Bulk ${i}\nstatus: To Do\n---\n`);
  }
  const { projects, panel, errors, done } = await openPanel();
  await projects.idle();
  panel.receive({ type: 'ready' });
  await settle(30);
  const original = fake.files.get(FILE1)!;
  let external = original;
  for (let round = 0; round < 50; round++) {
    const path = `${ROOT}/backlog/tasks/task-${10 + round} - Bulk.md`;
    // Atomic replace: the old file disappears, the new one appears.
    const text = fake.files.get(path)!.replace(/title: .*/, `title: Rewritten ${round}`);
    fake.files.delete(path);
    fake.fireWatcher('delete', path);
    fake.files.set(path, text);
    fake.fireWatcher('create', path);
    if (round % 10 === 0) {
      // The agent also touches TASK1 (a new notes line), without the index having caught up.
      external = external.replace('Started with esbuild.', `Started with esbuild.\nRound ${round}.`);
      fake.files.delete(FILE1);
      fake.fireWatcher('delete', FILE1);
      fake.files.set(FILE1, external);
      fake.fireWatcher('create', FILE1);
    }
    if (round === 25) panel.receive(toggleAc2(original));
  }
  await settle(300);
  await projects.idle();
  const final = fake.files.get(FILE1)!;
  for (let round = 0; round < 50; round += 10) assert.match(final, new RegExp(`Round ${round}\\.`), 'external change kept');
  if (errors().length === 0) assert.match(final, /- \[x\] #2 Typecheck passes/);
  else assert.equal(final, external);
  for (let i = 10; i < 60; i++) {
    assert.match(fake.files.get(`${ROOT}/backlog/tasks/task-${i} - Bulk.md`)!, new RegExp(`title: Rewritten ${i - 10}\\n`));
    assert.equal(projects.projects[0].index.byPath.get(`backlog/tasks/task-${i} - Bulk.md`)?.data.title, `Rewritten ${i - 10}`, 'the index caught up');
  }
  done();
});

test('4: a file replaced between the panel\'s read and its write is never overwritten or recreated', async () => {
  reset();
  const { panel, errors, done } = await openPanel();
  const readFile = fake.workspace.fs.readFile;
  let reads = 0;
  // The agent's atomic replace happens while the panel is between its two reads.
  fake.workspace.fs.readFile = async (uri) => {
    const bytes = await readFile(uri);
    if (uri.path === FILE1 && ++reads === 1) fake.files.delete(FILE1);
    return bytes;
  };
  try {
    panel.receive(setDone);
    await settle(30);
  } finally {
    fake.workspace.fs.readFile = readFile;
  }
  assert.equal(fake.files.has(FILE1), false, 'not recreated');
  assert.equal(errors().length, 1);
  done();
});

test('4: a move between neighbours whose ordinals changed on disk (index behind) is stale', async () => {
  reset();
  const { panel, errors, renders, done } = await openPanel();
  panel.receive({ type: 'ready' });
  await settle(30);
  const view = renders().at(-1)!.view;
  const column = view.tasks.filter((t) => t.status === 'To Do');
  assert.ok(column.length >= 2, 'the fixture has two To Do tasks');
  const [a, b] = column;
  const pathB = `${ROOT}/${b.path}`;
  // The agent changes B's ordinal; no watcher event reached the index yet.
  const textB = fake.files.get(pathB)!;
  fake.files.set(pathB, /\nordinal: /.test(textB) ? textB.replace(/\nordinal: .*/, '\nordinal: 1') : textB.replace(/\n---\n/, '\nordinal: 1\n---\n'));
  const beforeA = fake.files.get(`${ROOT}/${a.path}`);
  panel.receive({ type: 'moveInColumn', path: a.path, fromStatus: 'To Do', afterPath: b.path });
  await settle(30);
  assert.equal(fake.files.get(`${ROOT}/${a.path}`), beforeA);
  assert.deepEqual(errors(), ['stale']);
  done();
});

// --- 5. Webviews that reload mid-operation --------------------------------------------------------

test('5: after a new ready, late messages from the old webview are dropped; the new one works', async () => {
  reset();
  const { panel, errors, done } = await openPanel();
  panel.receive({ type: 'ready', instance: 'old' });
  await settle(30);
  panel.receive({ type: 'ready', instance: 'new' });
  const before = fake.files.get(FILE1)!;
  panel.receive({ ...setDone, instance: 'old' });
  panel.receive({ ...toggleAc2(before), instance: 'old' });
  panel.receive({ type: 'undo', instance: 'old' });
  await settle(30);
  assert.equal(fake.files.get(FILE1), before, 'nothing from the old webview');
  assert.deepEqual(written(), []);
  panel.receive({ ...setDone, instance: 'new' });
  await settle(30);
  assert.match(fake.files.get(FILE1)!, /\nstatus: Done\n/);
  assert.ok(!errors().includes('failed'));
  done();
});

test('5: a comment sent twice (double submit, or resent by a reloaded webview) is added once', async () => {
  reset();
  const { panel, errors, done } = await openPanel();
  const comment = { type: 'addComment', path: TASK1, text: 'Once only', seen: 1 };
  panel.receive(comment);
  panel.receive(comment);
  await settle(30);
  const text = fake.files.get(FILE1)!;
  assert.equal(text.split('Once only').length - 1, 1);
  assert.deepEqual(errors(), ['stale']);
  done();
});

test('5: a task selected while the webview is hidden (torn down) is sent after its next ready, once', async () => {
  reset();
  const { projects, panels, panel, done } = await openPanel();
  panel.receive({ type: 'ready' });
  await settle(30);
  panel.setVisible(false);
  panels.open(projects.projects[0], TASK1);
  await settle(30);
  const selects = () => panel.posted.filter((m) => (m as { type: string }).type === 'select');
  assert.equal(selects().length, 0, 'not posted into a torn-down webview');
  panel.setVisible(true);
  panel.receive({ type: 'ready' });
  await settle(30);
  assert.equal(selects().length, 1);
  panel.receive({ type: 'ready' });
  await settle(30);
  assert.equal(selects().length, 1, 'not sent again');
  done();
});

test('5: a debounced saveLayout arriving after the panel closed, and a second ready, do not crash or write', async () => {
  reset();
  const store = new Map<string, unknown>();
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const memento = { get: (name: string) => store.get(name), update: async (name: string, value: unknown) => void store.set(name, value) };
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects, memento as never);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  panel.receive({ type: 'ready' });
  panel.receive({ type: 'ready' });
  await settle(30);
  panel.close();
  panel.receive({ type: 'saveLayout', title: 300 });
  await settle(30);
  assert.deepEqual(written(), []);
  assert.ok(panel.disposed);
  panels.dispose();
  projects.dispose();
});
