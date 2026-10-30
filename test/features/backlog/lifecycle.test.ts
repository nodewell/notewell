// Panel lifecycle (backlog.md 4.1, 5.1): the project going away under an open panel or between a
// click and the open, webview state left by an older or hostile build, and panels or projects
// disposed while a write is still running. Against the fake `vscode`, as panel.test.ts.
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
const { restoreUiState } = await import('../../../src/features/backlog/browser/filters.ts');

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const ROOT = '/work/demo';
const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';
const FILE1 = `${ROOT}/${TASK1}`;
const CONFIG = `${ROOT}/backlog/config.yml`;
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
  fake.settings.clear();
  fake.files.set(CONFIG, readFileSync(new URL('config.yml', PROJECT), 'utf8'));
  for (const sub of ['tasks', 'milestones']) {
    for (const name of readdirSync(new URL(`${sub}/`, PROJECT))) {
      fake.files.set(`${ROOT}/backlog/${sub}/${name}`, readFileSync(new URL(`${sub}/${name}`, PROJECT), 'utf8'));
    }
  }
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file(ROOT), name: 'demo', index: 0 }];
}

const types = (panel: (typeof fake.panels)[number]) => panel.posted.map((m) => (m as { type: string }).type);

// --- 2. The project goes away -----------------------------------------------------------------------

test('2: a project that disappears under an open panel is announced to the webview; it comes back with its board', async () => {
  reset();
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  panel.receive({ type: 'ready' });
  await settle(50);
  assert.deepEqual(types(panel), ['render']);
  // config.yml deleted (or the folder unregistered, or the workspace folder removed).
  const config = fake.files.get(CONFIG)!;
  fake.files.delete(CONFIG);
  fake.fireWatcher('delete', CONFIG);
  await settle();
  assert.equal(projects.projects.length, 0);
  assert.equal(types(panel).at(-1), 'unavailable', `posted: ${types(panel).join(',')}`);
  // An edit sent from the old board is refused and nothing is written.
  const before = fake.files.get(FILE1);
  panel.receive(setDone);
  await settle(50);
  assert.equal(fake.files.get(FILE1), before);
  assert.ok(!fake.log.some((l) => l.startsWith('writeFile')));
  // Back again: the board is drawn.
  fake.files.set(CONFIG, config);
  fake.fireWatcher('create', CONFIG);
  await settle();
  assert.equal(types(panel).at(-1), 'render');
  panels.dispose();
  projects.dispose();
});

test('2: the open command whose project vanished between the click and the open shows no empty panel', async () => {
  reset();
  const ctx = { extensionUri: fake.Uri.file('/ext'), subscriptions: [] as { dispose(): void }[] };
  registerBacklog(ctx as never);
  await settle(200);
  // The project disappears; the explorer item that was clicked still names its folder.
  fake.files.delete(CONFIG);
  fake.fireWatcher('delete', CONFIG);
  await settle();
  await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file(`${ROOT}/backlog`));
  await settle(50);
  assert.equal(fake.panels.length, 0, 'no panel for a project that is gone');
  assert.ok(fake.log.includes('info No Backlog.md project was found in this workspace.'), fake.log.join('\n'));
  for (const d of ctx.subscriptions) d.dispose();
});

// --- 4. Webview state from an older or hostile build ------------------------------------------------------

test('4: webview state of any shape restores to a usable state', () => {
  const hostile: unknown[] = [
    undefined, null, 42, 'board', [], [1, 2],
    { mode: 'grid', search: 7, status: { a: 1 }, sort: { column: 'evil', descending: 'yes' }, selected: 3, paneSizes: { bottom: Number.NaN, right: -1 }, columnWidths: { title: Infinity, id: '90' } },
    JSON.parse('{"__proto__": {"polluted": true}, "mode": "list", "columnWidths": {"__proto__": {"title": 300}}}'),
    { search: 'x'.repeat(5_000_000), selected: 'y'.repeat(5_000_000) },
    { sort: null, selected: '' },
    Object.create(null),
  ];
  for (const raw of hostile) {
    const state = restoreUiState(raw);
    assert.ok(state.mode === 'board' || state.mode === 'list');
    assert.equal(typeof state.search, 'string');
    assert.ok(state.search.length < 100_000);
    assert.ok(state.selected === null || (typeof state.selected === 'string' && state.selected.length < 100_000));
    assert.ok(state.sort === null || ['id', 'title', 'status', 'priority', 'assignee', 'milestone'].includes(state.sort.column));
    for (const v of Object.values(state.columnWidths)) assert.ok(Number.isFinite(v) && v >= 48 && v <= 2000);
    for (const v of Object.values(state.paneSizes)) assert.ok(v === undefined || (Number.isFinite(v) && v > 0 && v < 1));
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, 'no prototype pollution');
});

// --- 5. Disposal while a write is running -------------------------------------------------------------------

test('5: closing the panel and disposing the projects while a write is running: no throw, the file is whole', async () => {
  reset();
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  const original = fake.files.get(FILE1)!;
  const fs = fake.workspace.fs as unknown as { writeFile: (uri: unknown, bytes: Uint8Array) => Promise<void> };
  const writeFile = fs.writeFile;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // The write is slow (network drive); meanwhile the panel closes and the extension deactivates.
  let atGate!: () => void;
  const reachedGate = new Promise<void>((resolve) => (atGate = resolve));
  fs.writeFile = async (uri, bytes) => {
    atGate();
    await gate;
    return writeFile(uri, bytes);
  };
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => void rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    panel.receive(setDone);
    panel.receive({ type: 'undo' });
    // The write is held at the gate (waiting for quiet would wait for the gate itself).
    await reachedGate;
    panel.close();
    panels.dispose();
    projects.dispose();
    release();
    await settle(100);
    // Messages after the close reach nothing.
    panel.receive(setDone);
    await settle(50);
  } finally {
    fs.writeFile = writeFile;
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, []);
  const final = fake.files.get(FILE1)!;
  assert.ok(final === original || /\nstatus: Done\n/.test(final), 'either the change or the original, never a mix');
  assert.ok(final.startsWith('---\nid: TASK-1\n') && final.endsWith('<!-- COMMENTS:END -->\n'));
});

test('a lost watcher event is caught up when the webview loads, the panel is shown again or the window regains focus', async () => {
  reset();
  const ctx = { extensionUri: fake.Uri.file('/ext'), subscriptions: [] as { dispose(): void }[] };
  registerBacklog(ctx as never);
  await settle(200);
  await fake.commands.executeCommand(COMMANDS.open);
  const panel = fake.panels[0];
  const lastTitles = () => {
    const render = panel.posted.filter((m) => (m as { type: string }).type === 'render').at(-1) as { view: { tasks: { path: string; title: string }[] } } | undefined;
    return render?.view.tasks.find((t) => t.path === TASK1)?.title;
  };
  const silently = (title: string) => fake.files.set(FILE1, fake.files.get(FILE1)!.replace(/^title: .*$/m, `title: ${title}`));
  // Changed by another tool, and the watcher event is lost.
  silently('Changed while loading');
  panel.receive({ type: 'ready' });
  await settle(300);
  assert.equal(lastTitles(), 'Changed while loading', 'the webview load rescans');
  silently('Changed while hidden');
  panel.setVisible(false);
  panel.setVisible(true);
  await settle(300);
  assert.equal(lastTitles(), 'Changed while hidden', 'showing the panel rescans');
  silently('Changed in a terminal');
  fake.windowStateEvents.fire({ focused: true });
  await settle(300);
  assert.equal(lastTitles(), 'Changed in a terminal', 'window focus rescans');
  for (const d of ctx.subscriptions) d.dispose();
});
