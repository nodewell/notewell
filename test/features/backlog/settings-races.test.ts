// Settings and activation races (backlog.md 4.1, 5.1, 6): the feature turned off with a panel
// open, saveOnEdit flipped between a read and its write, the open command before the first scan
// finished, and a rescan overlapping a write. Against the fake `vscode`, as panel.test.ts.
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
const { registerBacklog, COMMANDS } = await import('../../../src/features/backlog/index.ts');

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const ROOT = '/work/demo';
const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';
const FILE1 = `${ROOT}/${TASK1}`;
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();
const setDone = { type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'Done' };

function reset(): void {
  fake.files.clear();
  fake.sizes.clear();
  fake.links.clear();
  fake.textDocuments.length = 0;
  fake.log.length = 0;
  fake.panels.length = 0;
  fake.statusItems.length = 0;
  fake.settings.clear();
  fake.files.set(`${ROOT}/backlog/config.yml`, readFileSync(new URL('config.yml', PROJECT), 'utf8'));
  for (const sub of ['tasks', 'milestones']) {
    for (const name of readdirSync(new URL(`${sub}/`, PROJECT))) {
      fake.files.set(`${ROOT}/backlog/${sub}/${name}`, readFileSync(new URL(`${sub}/${name}`, PROJECT), 'utf8'));
    }
  }
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file(ROOT), name: 'demo', index: 0 }];
}

const context = () => ({ extensionUri: fake.Uri.file('/ext'), subscriptions: [] as { dispose(): void }[] });
const writes = () => fake.log.filter((l) => l.startsWith('writeFile') || l.startsWith('applyEdit'));

// --- 2. The feature turned off with a panel open ------------------------------------------------------

test('2: turning notewell.backlog.enabled off closes open panels; nothing is written afterwards; on again works', async () => {
  reset();
  const ctx = context();
  registerBacklog(ctx as never);
  await settle(200);
  await fake.commands.executeCommand(COMMANDS.open);
  const panel = fake.panels[0];
  panel.receive({ type: 'ready' });
  await settle(100);
  const before = fake.files.get(FILE1);
  fake.changeSetting('notewell.backlog.enabled', false);
  await settle(100);
  assert.equal(panel.disposed, true, 'the panel closes with the feature');
  panel.receive(setDone);
  await settle(100);
  assert.equal(fake.files.get(FILE1), before);
  assert.deepEqual(writes(), []);
  fake.changeSetting('notewell.backlog.enabled', true);
  await settle(200);
  await fake.commands.executeCommand(COMMANDS.open);
  const again = fake.panels.at(-1)!;
  assert.notEqual(again, panel);
  again.receive({ type: 'ready' });
  again.receive(setDone);
  await settle(150);
  assert.match(fake.files.get(FILE1)!, /\nstatus: Done\n/);
  for (const d of ctx.subscriptions) d.dispose();
});

// --- 3. saveOnEdit flipped between the read and the write -----------------------------------------------------

test('3: saveOnEdit flipped between the read and the write: one consistent write (disk or editor), never both, never garbled', async () => {
  for (const [from, to] of [[true, false], [false, true]] as const) {
    reset();
    fake.settings.set('notewell.backlog.saveOnEdit', from);
    const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
    const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
    panels.open(projects.projects[0]);
    const panel = fake.panels.at(-1)!;
    const disk = fake.files.get(FILE1)!;
    const readFile = fake.workspace.fs.readFile;
    let flipped = false;
    // The user changes the setting while the panel is between its read and its write.
    fake.workspace.fs.readFile = async (uri) => {
      const bytes = await readFile(uri);
      if (uri.path === FILE1 && !flipped) {
        flipped = true;
        fake.settings.set('notewell.backlog.saveOnEdit', to);
      }
      return bytes;
    };
    try {
      panel.receive(setDone);
      await settle(100);
    } finally {
      fake.workspace.fs.readFile = readFile;
    }
    const doc = fake.textDocuments.find((d) => d.uri.path === FILE1) as { text: string } | undefined;
    const onDisk = fake.files.get(FILE1)!;
    const errors = panel.posted.filter((m) => (m as { type: string }).type === 'error').map((m) => (m as { reason: string }).reason);
    const label = `${from} -> ${to}`;
    assert.ok(writes().length <= 1, `${label}: ${writes().join(', ')}`);
    if (writes()[0]?.startsWith('writeFile')) {
      assert.match(onDisk, /\nstatus: Done\n/, label);
    } else if (writes()[0]?.startsWith('applyEdit')) {
      assert.equal(onDisk, disk, `${label}: an editor edit leaves the disk alone`);
      assert.match(doc!.text, /\nstatus: Done\n/, label);
    } else {
      assert.equal(onDisk, disk, label);
      assert.deepEqual(errors, ['stale'], label);
    }
    panels.dispose();
    projects.dispose();
  }
});

// --- 4. Activation races ---------------------------------------------------------------------------------------------

test('4: the open command right after activation (first scan still running) opens the board, not an empty panel', async () => {
  reset();
  // A slow disk: the first scan takes a while.
  const readFile = fake.workspace.fs.readFile;
  fake.workspace.fs.readFile = async (uri) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return readFile(uri);
  };
  const ctx = context();
  try {
    registerBacklog(ctx as never);
    await fake.commands.executeCommand(COMMANDS.open);
    assert.equal(fake.panels.length, 1);
    const panel = fake.panels[0];
    panel.receive({ type: 'ready' });
    await settle(200);
    const types = panel.posted.map((m) => (m as { type: string }).type);
    assert.ok(!types.includes('unavailable'), types.join(','));
    const render = panel.posted.find((m) => (m as { type: string }).type === 'render') as { view: { tasks: unknown[] } };
    assert.equal(render.view.tasks.length, 7);
  } finally {
    fake.workspace.fs.readFile = readFile;
    for (const d of ctx.subscriptions) d.dispose();
  }
});

test('4: a rescan overlapping writes (webview reload while the user edits): writes land once, the index ends equal to the disk', async () => {
  reset();
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  const readFile = fake.workspace.fs.readFile;
  fake.workspace.fs.readFile = async (uri) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return readFile(uri);
  };
  try {
    const ac2 = '- [ ] #2 Typecheck passes';
    const line = fake.files.get(FILE1)!.split('\n').indexOf(ac2);
    // A reload (ready -> rescan) racing a status change and a toggle, and an outside edit in between.
    panel.receive({ type: 'ready' });
    panel.receive(setDone);
    fake.files.set(`${ROOT}/backlog/tasks/task-6 - Minimal.md`, fake.files.get(`${ROOT}/backlog/tasks/task-6 - Minimal.md`)!.replace(/^title: .*$/m, 'title: Changed outside'));
    panel.receive({ type: 'ready' });
    panel.receive({ type: 'toggleCheck', path: TASK1, list: 'ac', line, source: ac2, checked: true });
    await settle(400);
    await projects.idle();
    const text = fake.files.get(FILE1)!;
    assert.match(text, /\nstatus: Done\n/);
    assert.match(text, /- \[x\] #2 Typecheck passes/);
    assert.equal(writes().length, 2);
    const index = projects.projects[0].index;
    assert.equal(index.byPath.get(TASK1)?.data.status, 'Done');
    assert.equal(index.byPath.get('backlog/tasks/task-6 - Minimal.md')?.data.title, 'Changed outside', 'the outside edit (no event) is caught by the rescan');
  } finally {
    fake.workspace.fs.readFile = readFile;
    panels.dispose();
    projects.dispose();
  }
});
