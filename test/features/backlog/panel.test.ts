// The Backlog panel and registration against a fake `vscode` (backlog.md 4.1, 4.4, 5.1, 6):
// one panel per project, writes only to indexed task files, path and URL checks.
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
const { BacklogPanels, BACKLOG_VIEW_TYPE, dependencyGraph, openProjectPath, savedProject } = await import('../../../src/features/backlog/panel.ts');
const { registerBacklog, COMMANDS, DETECTED_CONTEXT, PROJECT_DIRS_CONTEXT, TASK_DIRS_CONTEXT } = await import('../../../src/features/backlog/index.ts');

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const ROOT = '/work/demo';
const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();

function reset(roots: string[] = [ROOT]): void {
  fake.files.clear();
  fake.textDocuments.length = 0;
  fake.log.length = 0;
  fake.panels.length = 0;
  fake.settings.clear();
  fake.editor.refuse = false;
  fake.editor.writeFails = false;
  fake.written.clear();
  fake.quickPick.label = undefined;
  fake.openDialog.folder = undefined;
  for (const root of roots) {
    fake.files.set(`${root}/backlog/config.yml`, readFileSync(new URL('config.yml', PROJECT), 'utf8'));
    for (const sub of ['tasks', 'milestones']) {
      for (const name of readdirSync(new URL(`${sub}/`, PROJECT))) {
        fake.files.set(`${root}/backlog/${sub}/${name}`, readFileSync(new URL(`${sub}/${name}`, PROJECT), 'utf8'));
      }
    }
  }
  fake.files.set(`${ROOT}/docs/build.md`, '# Build\n');
  fake.files.set('/work/secret.txt', 'secret\n');
  fake.workspace.workspaceFolders = roots.map((path, index) => ({ uri: fake.Uri.file(path), name: path.split('/').pop()!, index }));
}

async function openPanel() {
  reset();
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  const types = () => panel.posted.map((m) => {
    const message = m as { type: string; reason?: string };
    return message.type === 'error' ? `error:${message.reason}` : message.type;
  });
  return { projects, panels, panel, types };
}

test('one panel per project: created in the active column, revealed after', async () => {
  const { projects, panels, panel } = await openPanel();
  assert.equal(panel.viewType, BACKLOG_VIEW_TYPE);
  assert.equal(panel.title, 'Backlog — demo');
  assert.equal(panel.column, fake.ViewColumn.Active);
  assert.match(panel.html, /backlog\.js/);
  assert.match(panel.html, /backlog\.css/);
  panels.open(projects.projects[0]);
  assert.equal(fake.panels.length, 1);
  assert.equal(panel.revealed, 1);
  panels.dispose();
  assert.equal(panel.disposed, true);
  panels.open(projects.projects[0]);
  assert.equal(fake.panels.length, 2, 'a closed panel is created again');
  panels.dispose();
  projects.dispose();
});

test('ready renders the project view; showTask sends the detail', async () => {
  const { projects, panels, panel, types } = await openPanel();
  panel.receive({ type: 'ready' });
  panel.receive({ type: 'showTask', path: TASK1 });
  await settle(20);
  assert.deepEqual(types(), ['render', 'detail']);
  const render = panel.posted[0] as { view: { project: string; tasks: unknown[]; statuses: string[] } };
  assert.equal(render.view.project, 'demo');
  assert.equal(render.view.tasks.length, 7);
  const detail = panel.posted[1] as { detail: { id: string } };
  assert.equal(detail.detail.id, 'TASK-1');
  panels.dispose();
  projects.dispose();
});

const FILE1 = `${ROOT}/${TASK1}`;
const setDone = { type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'Done' };

test('saveOnEdit (default), no editor open: the exact bytes go to the file, no save; the index change redraws; undo restores', async () => {
  const { projects, panels, panel, types } = await openPanel();
  const source = fake.files.get(FILE1)!;
  panel.receive(setDone);
  await settle();
  assert.deepEqual(fake.log, [`writeFile ${FILE1}`], 'no WorkspaceEdit, no document.save');
  assert.match(fake.files.get(FILE1)!, /\nstatus: Done\n/);
  assert.deepEqual(types(), ['render'], 'debounced redraw after the index changed');
  panel.receive({ type: 'undo' });
  await settle();
  assert.equal(fake.files.get(FILE1), source);
  panels.dispose();
  projects.dispose();
});

test('direct writes keep the BOM and CRLF byte for byte', async () => {
  reset();
  const BOM_BYTES = [0xef, 0xbb, 0xbf];
  const source = `${String.fromCharCode(0xfeff)}${readFileSync(new URL('../../fixtures/backlog/variants/crlf.md', import.meta.url), 'utf8')}`;
  fake.files.set(FILE1, source);
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  panel.receive(setDone);
  await settle();
  const bytes = fake.written.get(FILE1)!;
  assert.deepEqual([...bytes.slice(0, 3)], BOM_BYTES);
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const lines = (s: string) => s.split('\r\n');
  const changed = lines(text).map((line, i) => [line, lines(source)[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(changed.map(([a]) => a.split(':')[0]), ['status', 'updated_date'], 'only the status and updated_date lines differ');
  assert.equal(lines(text).length, lines(source).length);
  assert.doesNotMatch(text, /[^\r]\n/, 'no bare LF');
  panel.receive({ type: 'undo' });
  await settle();
  assert.deepEqual([...fake.written.get(FILE1)!], [...new TextEncoder().encode(source)], 'undo writes the original bytes');
  panels.dispose();
  projects.dispose();
});

test('an open, clean editor: written directly and the document reloads (not dirty)', async () => {
  const { projects, panels, panel } = await openPanel();
  const doc = fake.openEditorDocument(FILE1);
  panel.receive(setDone);
  await settle();
  assert.deepEqual(fake.log, [`writeFile ${FILE1}`]);
  assert.match(doc.text, /\nstatus: Done\n/);
  assert.equal(doc.isDirty, false);
  panels.dispose();
  projects.dispose();
});

test('an editor with unsaved changes: WorkspaceEdit only, never saved or written', async () => {
  const { projects, panels, panel, types } = await openPanel();
  const source = fake.files.get(FILE1)!;
  const doc = fake.openEditorDocument(FILE1, `${source}typed but not saved\n`);
  panel.receive(setDone);
  await settle(20);
  assert.deepEqual(fake.log, [`applyEdit ${FILE1}`]);
  assert.match(doc.text, /\nstatus: Done\n[\s\S]*typed but not saved\n$/);
  assert.equal(doc.isDirty, true);
  assert.equal(fake.files.get(FILE1), source, 'the file on disk is untouched');
  // No error; the edited document is indexed again and the board redrawn (a render, once quiet).
  assert.deepEqual(types().filter((t) => t !== 'render'), []);
  panels.dispose();
  projects.dispose();
});

test('saveOnEdit off: WorkspaceEdit only', async () => {
  const { projects, panels, panel } = await openPanel();
  fake.settings.set('notewell.backlog.saveOnEdit', false);
  panel.receive({ type: 'toggleCheck', path: TASK1, list: 'ac', line: 41, source: '- [ ] #2 Typecheck passes', checked: true });
  await settle(20);
  assert.deepEqual(fake.log, [`applyEdit ${FILE1}`]);
  panels.dispose();
  projects.dispose();
});

test('the file changing on disk between read and write is stale: nothing written', async () => {
  const { projects, panels, panel, types } = await openPanel();
  const source = fake.files.get(FILE1)!;
  const readFile = fake.workspace.fs.readFile;
  let reads = 0;
  // Another program saves the file right after the panel read it.
  fake.workspace.fs.readFile = async (uri) => {
    const bytes = await readFile(uri);
    if (uri.path === FILE1 && ++reads === 1) fake.files.set(FILE1, `${source}changed elsewhere\n`);
    return bytes;
  };
  try {
    panel.receive(setDone);
    await settle(20);
  } finally {
    fake.workspace.fs.readFile = readFile;
  }
  assert.deepEqual(fake.log, []);
  assert.deepEqual(types(), ['render', 'error:stale']);
  assert.equal(fake.files.get(FILE1), `${source}changed elsewhere\n`);
  panels.dispose();
  projects.dispose();
});

test('a refused file write is reported (read-only) and changes nothing', async () => {
  const { projects, panels, panel, types } = await openPanel();
  const source = fake.files.get(FILE1)!;
  fake.editor.writeFails = true;
  panel.receive(setDone);
  await settle(20);
  assert.deepEqual(types(), ['render', 'error:readOnly']);
  assert.equal(fake.files.get(FILE1), source);
  panels.dispose();
  projects.dispose();
});

test('the dependency graph merges tasks that share an ID', async () => {
  reset();
  fake.files.set(`${ROOT}/backlog/tasks/task-9 - Same-ID.md`, "---\nid: TASK-2\ntitle: Same ID\nstatus: To Do\ndependencies:\n  - TASK-3\n---\n");
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const graph = dependencyGraph(projects.projects[0]);
  assert.deepEqual([...graph.tasks.get(graph.keyOf('task-2'))!].sort(), ['TASK-1', 'TASK-3']);
  projects.dispose();
});

test('paths that are not indexed task files are never read or written', async () => {
  const { projects, panels, panel, types } = await openPanel();
  for (const path of ['../secret.txt', 'docs/build.md', 'backlog/config.yml', 'backlog/tasks/missing.md']) {
    panel.receive({ type: 'setStatus', path, statusLine: 'status: To Do', status: 'Done' });
    panel.receive({ type: 'openTask', path });
  }
  await settle(20);
  assert.deepEqual(fake.log, []);
  assert.deepEqual(types(), Array(4).fill(['render', 'error:stale']).flat());
  panels.dispose();
  projects.dispose();
});

test('path tricks from the webview never reach a file: traversal, absolute, drive, UNC, other projects, non-task files', async () => {
  reset(['/work/demo', '/work/other']);
  fake.files.set('/work/demo/backlog/docs/doc-1 - Guide.md', '---\nid: doc-1\nstatus: To Do\n---\n');
  fake.files.set('/work/demo/backlog/tasks/notes.txt', 'status: To Do\n');
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects.find((p) => p.name === 'demo')!);
  const panel = fake.panels[0];
  const before = new Map(fake.files);
  const tricks = [
    '../other/backlog/tasks/task-1 - Set-up-the-build.md',
    `backlog/tasks/../tasks/${TASK1.split('/').pop()}`,
    `./${TASK1}`,
    `${TASK1}/`,
    `${TASK1} `,
    TASK1.toUpperCase(),
    TASK1.replaceAll('/', '\\'),
    `/work/demo/${TASK1}`,
    `C:\\work\\demo\\${TASK1.replaceAll('/', '\\')}`,
    `\\\\server\\share\\${TASK1}`,
    `file:///work/demo/${TASK1}`,
    'backlog/config.yml',
    'backlog/docs/doc-1 - Guide.md',
    'backlog/tasks/notes.txt',
    'backlog/tasks',
    `${TASK1}::$DATA`,
    `${TASK1}\u0000.md`,
  ];
  for (const path of tricks) {
    panel.receive({ type: 'setStatus', path, statusLine: 'status: In Progress', status: 'Done' });
    panel.receive({ type: 'setSection', path, section: 'notes', text: 'x', expected: 'Started with esbuild.' });
    panel.receive({ type: 'openTask', path });
  }
  await settle(50);
  assert.deepEqual(fake.log.filter((l) => !l.startsWith('command setContext')), [], 'nothing written, applied or opened');
  assert.deepEqual(new Map(fake.files), before);
  panels.dispose();
  projects.dispose();
});

test('a task file deleted or moved while the panel is open is never recreated, not even by undo', async () => {
  const { projects, panels, panel } = await openPanel();
  const source = fake.files.get(FILE1)!;
  // Deleted before the index noticed.
  fake.files.delete(FILE1);
  panel.receive(setDone);
  await settle();
  assert.equal(fake.files.has(FILE1), false);
  // Edited, then deleted, then undone.
  fake.files.set(FILE1, source);
  panel.receive(setDone);
  await settle();
  assert.match(fake.files.get(FILE1)!, /status: Done/);
  fake.files.delete(FILE1);
  panel.receive({ type: 'undo' });
  await settle();
  assert.equal(fake.files.has(FILE1), false, 'undo does not recreate it');
  // Moved (renamed): the old path is never written again.
  const moved = `${ROOT}/backlog/tasks/task-1 - Renamed.md`;
  fake.files.set(moved, source);
  fake.log.length = 0;
  panel.receive(setDone);
  panel.receive({ type: 'undo' });
  await settle();
  assert.equal(fake.files.has(FILE1), false);
  assert.equal(fake.files.get(moved), source);
  assert.ok(!fake.log.some((l) => l.startsWith('writeFile') || l.startsWith('applyEdit')), fake.log.join('\n'));
  panels.dispose();
  projects.dispose();
});

test('a dirty editor: the panel edits the document only; undo after an external change on disk restores the document, not the disk', async () => {
  const { projects, panels, panel, types } = await openPanel();
  const source = fake.files.get(FILE1)!;
  const unsaved = `${source}typed but not saved\n`;
  const doc = fake.openEditorDocument(FILE1, unsaved);
  panel.receive(setDone);
  await settle(20);
  assert.match(doc.text, /status: Done/);
  // Another tool rewrites the file on disk meanwhile.
  fake.files.set(FILE1, `${source}from the CLI\n`);
  panel.receive({ type: 'undo' });
  await settle(20);
  assert.equal(doc.text, unsaved, 'the document is back to what the user had');
  assert.equal(fake.files.get(FILE1), `${source}from the CLI\n`, 'the disk is untouched');
  assert.ok(!fake.log.some((l) => l.startsWith('writeFile') || l.startsWith('save')), fake.log.join('\n'));
  // The user types after a panel edit: undo is stale and changes nothing.
  panel.receive(setDone);
  await settle(20);
  doc.text = `${doc.text}more typing\n`;
  doc.version++;
  const typed = doc.text;
  panel.receive({ type: 'undo' });
  await settle(20);
  assert.equal(doc.text, typed);
  assert.equal(types().at(-1), 'error:stale');
  panels.dispose();
  projects.dispose();
});

test('a task file that is not valid UTF-8 is never written', async () => {
  const { projects, panels, panel, types } = await openPanel();
  const source = fake.files.get(FILE1)!;
  const readFile = fake.workspace.fs.readFile;
  // Latin-1 bytes: decoding would turn them into U+FFFD and writing would destroy them.
  const bytes = new Uint8Array([...new TextEncoder().encode(source), 0x63, 0x61, 0x66, 0xe9, 0x0a]);
  fake.workspace.fs.readFile = async (uri) => (uri.path === FILE1 ? bytes : readFile(uri));
  try {
    panel.receive(setDone);
    await settle(20);
  } finally {
    fake.workspace.fs.readFile = readFile;
  }
  assert.ok(!fake.log.some((l) => l.startsWith('writeFile')), fake.log.join('\n'));
  assert.equal(fake.files.get(FILE1), source);
  assert.equal(types().at(-1)?.startsWith('error:'), true);
  panels.dispose();
  projects.dispose();
});

test('a WorkspaceEdit the editor refuses is reported as failed', async () => {
  const { projects, panels, panel, types } = await openPanel();
  fake.settings.set('notewell.backlog.saveOnEdit', false);
  fake.editor.refuse = true;
  panel.receive({ type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'Done' });
  await settle(20);
  assert.deepEqual(types(), ['render', 'error:failed']);
  panels.dispose();
  projects.dispose();
});

test('openTask, openPath and openUrl', async () => {
  const { projects, panels, panel, types } = await openPanel();
  panel.receive({ type: 'openTask', path: TASK1 });
  panel.receive({ type: 'openPath', path: 'docs/build.md' });
  panel.receive({ type: 'openPath', path: '../secret.txt' });
  panel.receive({ type: 'openPath', path: 'docs/missing.md' });
  panel.receive({ type: 'openUrl', url: 'https://example.com/build' });
  panel.receive({ type: 'openUrl', url: 'javascript:alert(1)' });
  await settle(20);
  assert.deepEqual(fake.log, [
    `showTextDocument ${ROOT}/${TASK1} preview=false`,
    `command vscode.open ${ROOT}/docs/build.md`,
    'warning This path is outside the project and was not opened.',
    'warning "docs/missing.md" was not found.',
    'openExternal https://example.com/build',
  ]);
  assert.deepEqual(types(), ['error:invalid']);
  panels.dispose();
  projects.dispose();
});

test('openProjectPath refuses every path outside the workspace folder', async () => {
  reset();
  for (const path of ['../secret.txt', '/work/secret.txt', 'docs/../../secret.txt', '..\\secret.txt', 'C:\\x', 'file:///work/secret.txt']) {
    fake.log.length = 0;
    await openProjectPath(fake.Uri.file(ROOT) as never, path);
    assert.deepEqual(fake.log, ['warning This path is outside the project and was not opened.'], path);
  }
  fake.log.length = 0;
  await openProjectPath(fake.Uri.file(ROOT) as never, './docs/./build.md');
  assert.deepEqual(fake.log, [`command vscode.open ${ROOT}/docs/build.md`]);
});

test('configuration changes redraw; a disposed panel stops listening', async () => {
  const { projects, panels, panel, types } = await openPanel();
  fake.changeSetting('notewell.backlog.saveOnEdit', false);
  fake.changeSetting('editor.fontSize', 12);
  await settle(100);
  assert.deepEqual(types(), ['render']);
  panels.dispose();
  fake.changeSetting('notewell.backlog.saveOnEdit', true);
  await settle(100);
  assert.deepEqual(types(), ['render']);
  projects.dispose();
});

function context() {
  const subscriptions: { dispose(): void }[] = [];
  return { extensionUri: fake.Uri.file('/ext'), subscriptions, dispose: () => subscriptions.forEach((s) => s.dispose()) };
}

test('registerBacklog: context key and the open command', async () => {
  reset();
  const ctx = context();
  registerBacklog(ctx as never);
  await settle();
  assert.equal(fake.log[0], `command setContext "${DETECTED_CONTEXT}" true`);
  await fake.commands.executeCommand(COMMANDS.open);
  assert.equal(fake.panels.length, 1);
  assert.equal(fake.panels[0].title, 'Backlog — demo');
  fake.changeSetting('notewell.backlog.enabled', false);
  assert.deepEqual(fake.log.slice(-3), [
    `command setContext "${DETECTED_CONTEXT}" false`,
    `command setContext "${PROJECT_DIRS_CONTEXT}" []`,
    `command setContext "${TASK_DIRS_CONTEXT}" []`,
  ]);
  await fake.commands.executeCommand(COMMANDS.open);
  assert.equal(fake.log.at(-1), 'info The Notewell Backlog feature is turned off (notewell.backlog.enabled).');
  ctx.dispose();
  assert.equal(fake.panels[0].disposed, true);
});

test('after a restart a kept panel shows its project again; otherwise it closes (backlog.md 4.1)', async () => {
  reset(['/work/one', '/work/two']);
  let ctx = context();
  registerBacklog(ctx as never);
  fake.quickPick.label = 'two';
  await fake.commands.executeCommand(COMMANDS.open);
  // The page tells its script the project, which the script keeps with its view state.
  const saved = /data-project="([^"]+)"/.exec(fake.panels[0].html)?.[1];
  assert.match(saved ?? '', /\/work\/two\/backlog$/i);
  assert.equal(savedProject({ mode: 'list', project: saved }), saved);
  for (const odd of [undefined, null, 'x', {}, { project: 1 }, { project: '' }, { project: 'p'.repeat(5000) }]) assert.equal(savedProject(odd), undefined);
  ctx.dispose();

  // VS Code restarts: the same project comes back in the kept panel, which loads and draws.
  ctx = context();
  registerBacklog(ctx as never);
  let panel = await fake.restorePanel(BACKLOG_VIEW_TYPE, 'Backlog — two', { mode: 'list', selected: TASK1, project: saved });
  assert.equal(panel.disposed, false);
  assert.equal(panel.title, 'Backlog — two');
  assert.match(panel.html, /backlog\.js/);
  assert.match(panel.html, new RegExp(`data-project="${saved}"`));
  panel.receive({ type: 'ready' });
  await settle();
  assert.equal((panel.posted[0] as { view: { project: string } }).view.project, 'two');
  // A second kept panel of the same project closes; so does one of a project not found here.
  assert.equal((await fake.restorePanel(BACKLOG_VIEW_TYPE, 'Backlog — two', { project: saved })).disposed, true);
  assert.equal((await fake.restorePanel(BACKLOG_VIEW_TYPE, 'Backlog — gone', { project: 'file:/work/gone/backlog' })).disposed, true);
  // Saved without a project (an older version): opened only when there is one project.
  assert.equal((await fake.restorePanel(BACKLOG_VIEW_TYPE, 'Backlog', {})).disposed, true);
  // The open command finds the restored panel instead of making another.
  await fake.commands.executeCommand(COMMANDS.open);
  assert.equal(fake.panels.filter((p) => !p.disposed).length, 1);
  ctx.dispose();

  reset();
  ctx = context();
  registerBacklog(ctx as never);
  panel = await fake.restorePanel(BACKLOG_VIEW_TYPE, 'Backlog', null);
  assert.equal(panel.disposed, false, 'the only project');
  assert.equal(panel.title, 'Backlog — demo');
  ctx.dispose();

  // Turned off: the kept panel closes and nothing starts.
  reset();
  fake.settings.set('notewell.backlog.enabled', false);
  ctx = context();
  registerBacklog(ctx as never);
  panel = await fake.restorePanel(BACKLOG_VIEW_TYPE, 'Backlog — demo', { project: saved });
  assert.equal(panel.disposed, true);
  ctx.dispose();
});

test('registerBacklog: no project, several projects, disabled from the start', async () => {
  reset([]);
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file('/empty'), name: 'empty', index: 0 }];
  let ctx = context();
  registerBacklog(ctx as never);
  await fake.commands.executeCommand(COMMANDS.open);
  assert.ok(fake.log.includes('info No Backlog.md project was found in this workspace.'));
  assert.equal(fake.panels.length, 0);
  ctx.dispose();

  reset(['/work/one', '/work/two']);
  ctx = context();
  registerBacklog(ctx as never);
  fake.quickPick.label = 'two';
  await fake.commands.executeCommand(COMMANDS.open);
  assert.ok(fake.log.includes('pick Choose a Backlog.md project: one,two'));
  assert.equal(fake.panels[0].title, 'Backlog — two');
  fake.quickPick.label = undefined;
  await fake.commands.executeCommand(COMMANDS.open);
  assert.equal(fake.panels.length, 1, 'cancelling the pick opens nothing');
  ctx.dispose();

  reset();
  fake.settings.set('notewell.backlog.enabled', false);
  ctx = context();
  registerBacklog(ctx as never);
  await settle();
  assert.deepEqual(fake.log, [], 'nothing runs or shows while disabled');
  ctx.dispose();
});

test('registerBacklog: a broken config is reported once', async () => {
  reset();
  fake.files.set(`${ROOT}/backlog/config.yml`, 'statuses: [\nproject_name: demo\n');
  const ctx = context();
  registerBacklog(ctx as never);
  await settle();
  const warnings = fake.log.filter((line) => line.startsWith('warning '));
  assert.equal(warnings.length, 1, fake.log.join('\n'));
  assert.match(warnings[0], /Could not read the Backlog\.md settings in \/work\/demo\/backlog\/config\.yml/);
  ctx.dispose();
});

// --- Registering Backlog folders (backlog.md 2.1) ---

/** A Backlog folder outside the workspace's auto-detected locations. */
function addBacklogFolder(dir: string): void {
  fake.files.set(`${dir}/config.yml`, ['statuses: [Open, Closed]', ''].join('\n'));
  fake.files.set(`${dir}/tasks/task-1 - Registered.md`, ['---', 'id: TASK-1', 'title: Registered', 'status: Open', '---', ''].join('\n'));
}

test('Add Backlog Folder: the picked folder is written to the workspace setting (relative) and its board opens', async () => {
  reset();
  addBacklogFolder(`${ROOT}/team/plan`);
  const ctx = context();
  registerBacklog(ctx as never);
  await settle();
  fake.log.length = 0;
  fake.openDialog.folder = `${ROOT}/team/plan`;
  await fake.commands.executeCommand(COMMANDS.addFolder);
  await settle();
  assert.equal(fake.log[0], 'dialog folders=true files=false Choose a Backlog.md folder (the folder with config.yml)');
  assert.ok(fake.log.includes('config notewell.backlog.projects=["team/plan"] target=2'), fake.log.join('\n'));
  assert.equal(fake.panels.at(-1)!.title, 'Backlog — team');
  // Registering it again writes nothing and just shows the board.
  fake.log.length = 0;
  await fake.commands.executeCommand(COMMANDS.registerFolder, fake.Uri.file(`${ROOT}/team/plan`));
  await settle();
  assert.ok(!fake.log.some((l) => l.startsWith('config ')), fake.log.join('\n'));
  assert.equal(fake.panels.at(-1)!.revealed, 1);
  // Cancelling the dialog does nothing.
  fake.openDialog.folder = undefined;
  fake.log.length = 0;
  await fake.commands.executeCommand(COMMANDS.addFolder);
  assert.deepEqual(fake.log.filter((l) => !l.startsWith('dialog')), []);
  ctx.dispose();
});

test('Register as Backlog Folder: a folder without config.yml is refused; an auto-detected one just opens; outside the workspace is absolute', async () => {
  reset();
  fake.files.set(`${ROOT}/docs/readme.md`, '# Docs\n');
  addBacklogFolder('/outside/proj/backlog');
  const ctx = context();
  registerBacklog(ctx as never);
  await settle();
  fake.log.length = 0;
  await fake.commands.executeCommand(COMMANDS.registerFolder, fake.Uri.file(`${ROOT}/docs`));
  assert.ok(fake.log.some((l) => l.startsWith('warning ') && l.includes('is not a Backlog.md folder')), fake.log.join('\n'));
  assert.ok(!fake.log.some((l) => l.startsWith('config ')));
  // The workspace folder's own backlog/ is already a project: opened, not registered.
  fake.log.length = 0;
  await fake.commands.executeCommand(COMMANDS.registerFolder, fake.Uri.file(`${ROOT}/backlog`));
  await settle();
  assert.ok(!fake.log.some((l) => l.startsWith('config ')));
  assert.equal(fake.panels.at(-1)!.title, 'Backlog — demo');
  // Outside every workspace folder: absolute path.
  await fake.commands.executeCommand(COMMANDS.registerFolder, fake.Uri.file('/outside/proj/backlog'));
  await settle();
  assert.ok(fake.log.some((l) => /^config notewell\.backlog\.projects=\[".*outside.*proj.*backlog"\] target=2$/.test(l)), fake.log.join('\n'));
  assert.equal(fake.panels.at(-1)!.title, 'Backlog — proj');
  ctx.dispose();
});

test('the projects setting: relative entries per workspace folder, a missing config.yml warns once, changes are followed', async () => {
  reset(['/work/demo', '/work/other']);
  addBacklogFolder('/work/other/sub/plan');
  fake.settings.set('notewell.backlog.projects', ['sub/plan', 'missing/plan', 42, '']);
  const ctx = context();
  registerBacklog(ctx as never);
  await settle(200);
  await fake.commands.executeCommand(COMMANDS.open);
  assert.ok(fake.log.some((l) => l.startsWith('pick ') && l.endsWith('demo,other,sub')), fake.log.join('\n'));
  const warnings = fake.log.filter((l) => l.startsWith('warning '));
  assert.deepEqual(warnings, ['warning The Backlog folder "missing/plan" in notewell.backlog.projects has no config.yml and is ignored.']);
  fake.changeSetting('notewell.backlog.projects', ['missing/plan']);
  await settle(200);
  assert.equal(fake.log.filter((l) => l.startsWith('warning ')).length, 1, 'not warned again');
  assert.ok(fake.log.filter((l) => l.startsWith('command setContext "notewell.backlog.projectDirs"')).at(-1)!.includes('demo'));
  assert.ok(!fake.log.filter((l) => l.startsWith('command setContext "notewell.backlog.projectDirs"')).at(-1)!.includes('plan'));
  ctx.dispose();
});

test('manifest: the folder registration commands and setting', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const commands = manifest.contributes.commands.map((c: { command: string }) => c.command);
  assert.ok(commands.includes(COMMANDS.addFolder) && commands.includes(COMMANDS.registerFolder));
  const explorer = manifest.contributes.menus['explorer/context'].find((m: { command: string }) => m.command === COMMANDS.registerFolder);
  assert.match(explorer.when, /explorerResourceIsFolder/);
  assert.match(explorer.when, /config\.notewell\.backlog\.enabled/);
  const palette = manifest.contributes.menus.commandPalette;
  assert.equal(palette.find((m: { command: string }) => m.command === COMMANDS.registerFolder).when, 'false');
  const config = [manifest.contributes.configuration].flat().find((c: { properties: Record<string, unknown> }) => c.properties['notewell.backlog.projects']);
  assert.deepEqual(config.properties['notewell.backlog.projects'].default, []);
  for (const file of ['package.nls.json', 'package.nls.ko.json']) {
    const nls = JSON.parse(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'));
    for (const name of ['command.backlog.addFolder', 'command.backlog.registerFolder', 'config.backlog.projects']) assert.ok(nls[name], `${file} ${name}`);
  }
});

test('detail position: the view carries the setting (bottom by default); the toolbar message updates it globally and redraws', async () => {
  const { projects, panel, types } = await openPanel();
  const renders = () => panel.posted.filter((m) => (m as { type: string }).type === 'render') as { view: { detailPosition: string } }[];
  panel.receive({ type: 'ready' });
  await settle(100);
  assert.equal(renders().at(-1)!.view.detailPosition, 'bottom');
  fake.log.length = 0;
  panel.receive({ type: 'setDetailPosition', position: 'right' });
  await settle(100);
  assert.ok(fake.log.includes('config notewell.backlog.detailPosition=right target=1'), fake.log.join('\n'));
  assert.equal(renders().at(-1)!.view.detailPosition, 'right');
  assert.equal(types().at(-1), 'render');
  fake.settings.set('notewell.backlog.detailPosition', 'diagonal');
  fake.changeSetting('notewell.backlog.detailPosition', 'diagonal');
  await settle(100);
  assert.equal(renders().at(-1)!.view.detailPosition, 'bottom', 'an unknown value means the default');
  fake.settings.delete('notewell.backlog.detailPosition');
  projects.dispose();
});

/** A workspaceState stand-in: get/update over a map, updates logged. */
function memento() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (name: string) => values.get(name),
    async update(name: string, value: unknown): Promise<void> {
      values.set(name, JSON.parse(JSON.stringify(value)));
    },
  };
}

const EMPTY_LAYOUT = { columnWidths: {}, paneSizes: {} };

test('layout: saveLayout is stored per project and carried by the view of a reopened panel', async () => {
  reset(['/work/one', '/work/two']);
  const store = memento();
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects, store as never);
  const lastLayout = (panel: (typeof fake.panels)[number]) =>
    (panel.posted.filter((m) => (m as { type: string }).type === 'render').at(-1) as { view: { layout: unknown } }).view.layout;

  panels.open(projects.projects[0]);
  const first = fake.panels[0];
  first.receive({ type: 'ready' });
  await settle(50);
  assert.deepEqual(lastLayout(first), EMPTY_LAYOUT, 'nothing stored: automatic layout');
  first.receive({ type: 'saveLayout', id: 90, title: 320, status: 120, priority: 80, assignee: 100, milestone: 110, bottom: 450, right: 380 });
  await settle(20);
  assert.equal(store.values.size, 1);
  const saved = {
    columnWidths: { id: 90, title: 320, status: 120, priority: 80, assignee: 100, milestone: 110 },
    paneSizes: { bottom: 450, right: 380 },
  };
  assert.deepEqual(store.values.get(`notewell.backlog.layout:${projects.projects[0].folder.toString()}`), saved);

  // The other project keeps its own (empty) layout.
  panels.open(projects.projects[1]);
  const other = fake.panels[1];
  other.receive({ type: 'ready' });
  await settle(50);
  assert.deepEqual(lastLayout(other), EMPTY_LAYOUT);

  // Closed and opened again: the fresh panel's first render carries the stored layout.
  first.close();
  panels.open(projects.projects[0]);
  const reopened = fake.panels[2];
  assert.notEqual(reopened, first);
  reopened.receive({ type: 'ready' });
  await settle(50);
  assert.deepEqual(lastLayout(reopened), saved);

  // Double-click resets: a saveLayout without column fields (then without panes) clears them.
  reopened.receive({ type: 'saveLayout', bottom: 450, right: 380 });
  await settle(20);
  reopened.receive({ type: 'saveLayout' });
  await settle(20);
  reopened.close();
  panels.open(projects.projects[0]);
  const afterReset = fake.panels[3];
  afterReset.receive({ type: 'ready' });
  await settle(50);
  assert.deepEqual(lastLayout(afterReset), EMPTY_LAYOUT, 'reset layout reopens automatic');
  panels.dispose();
  projects.dispose();
});

test('layout: a stored value that is not a valid width or share is dropped', async () => {
  const { readLayout } = await import('../../../src/features/backlog/panel.ts');
  assert.deepEqual(readLayout(undefined), EMPTY_LAYOUT);
  assert.deepEqual(readLayout('wide'), EMPTY_LAYOUT);
  assert.deepEqual(readLayout({ columnWidths: [], paneSizes: null }), EMPTY_LAYOUT);
  assert.deepEqual(
    readLayout({
      columnWidths: { id: 47, title: 2001, status: 120.5, priority: '80', assignee: 48, milestone: 2000, labels: 100 },
      paneSizes: { bottom: 0, right: 999, left: 500 },
    }),
    { columnWidths: { assignee: 48, milestone: 2000 }, paneSizes: { right: 999 } },
  );
  assert.deepEqual(readLayout({ paneSizes: { bottom: 1, right: 1000 } }), { columnWidths: {}, paneSizes: { bottom: 1 } });

  // A corrupt stored entry gives the automatic layout instead of breaking the view.
  reset();
  const store = memento();
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  store.values.set(`notewell.backlog.layout:${projects.projects[0].folder.toString()}`, { columnWidths: { title: -5 }, paneSizes: 'x' });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects, store as never);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  panel.receive({ type: 'ready' });
  await settle(50);
  const render = panel.posted.find((m) => (m as { type: string }).type === 'render') as { view: { layout: unknown } };
  assert.deepEqual(render.view.layout, EMPTY_LAYOUT);
  // Out-of-range values from the webview are refused before they reach the store.
  panel.receive({ type: 'saveLayout', title: 5000 });
  await settle(20);
  assert.ok(panel.posted.some((m) => (m as { type: string; reason?: string }).type === 'error'));
  assert.deepEqual(store.values.get(`notewell.backlog.layout:${projects.projects[0].folder.toString()}`), { columnWidths: { title: -5 }, paneSizes: 'x' });
  panels.dispose();
  projects.dispose();
});

// --- Entry points (backlog.md 4.1) ---

const statusItem = () => fake.statusItems.at(-1)!;
const contextValue = (name: string): unknown => {
  const line = fake.log.filter((l) => l.startsWith(`command setContext "${name}" `)).at(-1);
  return line === undefined ? undefined : JSON.parse(line.slice(`command setContext "${name}" `.length));
};

test('status bar: shown only with a detected project and the feature on; opens the panel', async () => {
  reset([]);
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file('/empty'), name: 'empty', index: 0 }];
  let ctx = context();
  registerBacklog(ctx as never);
  await settle();
  assert.equal(statusItem().visible, false, 'no project: hidden');
  ctx.dispose();

  reset();
  ctx = context();
  registerBacklog(ctx as never);
  await settle();
  const item = statusItem();
  assert.deepEqual(
    { visible: item.visible, text: item.text, command: item.command, tooltip: item.tooltip, alignment: item.alignment, name: item.name },
    { visible: true, text: '$(checklist) Backlog', command: COMMANDS.open, tooltip: 'demo: open the Backlog.md board', alignment: fake.StatusBarAlignment.Left, name: 'Notewell Backlog' },
  );
  assert.ok(item.priority < 0, 'low priority: after other left items');
  await fake.commands.executeCommand(item.command);
  assert.equal(fake.panels.length, 1);
  fake.changeSetting('notewell.backlog.enabled', false);
  assert.equal(item.visible, false, 'turned off: hidden');
  fake.changeSetting('notewell.backlog.enabled', true);
  // On again: the projects are scanned afresh (nothing ran while off), then the item shows.
  await settle();
  assert.equal(item.visible, true);
  ctx.dispose();
  assert.equal(item.disposed, true);

  reset(['/work/one', '/work/two']);
  ctx = context();
  registerBacklog(ctx as never);
  await settle();
  assert.equal(statusItem().tooltip, 'Open the Backlog.md board', 'several projects: no name');
  ctx.dispose();

  reset();
  fake.settings.set('notewell.backlog.enabled', false);
  ctx = context();
  registerBacklog(ctx as never);
  await settle();
  assert.equal(statusItem().visible, false, 'disabled from the start: hidden');
  ctx.dispose();
});

test('context keys hold the fsPaths of the task folders and their tasks folders', async () => {
  reset(['/work/one', '/work/two']);
  const ctx = context();
  registerBacklog(ctx as never);
  await settle();
  const fsPath = (path: string) => (fake.Uri.file(path) as unknown as { fsPath: string }).fsPath;
  assert.deepEqual(contextValue(PROJECT_DIRS_CONTEXT), [fsPath('/work/one/backlog'), fsPath('/work/two/backlog')]);
  assert.deepEqual(contextValue(TASK_DIRS_CONTEXT), [fsPath('/work/one/backlog/tasks'), fsPath('/work/two/backlog/tasks')]);
  ctx.dispose();
});

test('the open command with a folder Uri opens the project whose task folder it is or is in', async () => {
  reset(['/work/one', '/work/two']);
  const ctx = context();
  registerBacklog(ctx as never);
  await settle();
  await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file('/work/two/backlog'));
  assert.deepEqual(fake.panels.map((p) => p.title), ['Backlog — two']);
  await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file('/work/one/backlog/milestones'));
  assert.deepEqual(fake.panels.map((p) => p.title), ['Backlog — two', 'Backlog — one']);
  assert.ok(!fake.log.some((l) => l.startsWith('pick ')), 'no project picker');
  // A folder outside every project falls back to the picker.
  fake.quickPick.label = 'two';
  await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file('/work/one/docs'));
  assert.ok(fake.log.some((l) => l.startsWith('pick ')));
  if (process.platform === 'win32') {
    await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file('/WORK/One/Backlog'));
    assert.equal(fake.panels.filter((p) => !p.disposed).length, 2, 'Windows paths compare case-insensitively (the existing panel is revealed)');
  }
  ctx.dispose();
});

test('the open command with a task file Uri opens its project and selects the task once the webview is ready', async () => {
  reset();
  const ctx = context();
  registerBacklog(ctx as never);
  await settle();
  const selects = (panel: { posted: unknown[] }) => panel.posted.filter((m) => (m as { type: string }).type === 'select');
  await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file(`${ROOT}/${TASK1}`));
  const panel = fake.panels[0];
  assert.equal(panel.title, 'Backlog — demo');
  await settle(20);
  assert.deepEqual(selects(panel), [], 'a new panel: held until ready');
  panel.receive({ type: 'ready' });
  await settle(20);
  assert.deepEqual(selects(panel), [{ type: 'select', path: TASK1 }]);
  assert.deepEqual(
    panel.posted.map((m) => (m as { type: string }).type).slice(0, 2),
    ['render', 'select'],
    'after the first render',
  );
  // The panel is open and ready: another task file selects right away.
  const other = 'backlog/tasks/task-3 - Ship-it.md';
  await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file(`${ROOT}/${other}`));
  await settle(20);
  assert.deepEqual(selects(panel).at(-1), { type: 'select', path: other });
  assert.equal(panel.revealed, 1);
  // A Markdown file elsewhere in the project folder only opens the panel.
  const before = selects(panel).length;
  await fake.commands.executeCommand(COMMANDS.open, fake.Uri.file(`${ROOT}/backlog/docs/notes.md`));
  await settle(20);
  assert.equal(selects(panel).length, before);
  ctx.dispose();
});

test('manifest: the entry points use the context keys', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    contributes: { menus: Record<string, { command: string; when?: string; group?: string }[]> };
  };
  const entry = (menu: string) => manifest.contributes.menus[menu].find((m) => m.command === COMMANDS.open);
  assert.deepEqual(entry('explorer/context'), {
    command: COMMANDS.open,
    when: `explorerResourceIsFolder && resourcePath in ${PROJECT_DIRS_CONTEXT}`,
    group: '2_workspace',
  });
  assert.deepEqual(entry('editor/title'), {
    command: COMMANDS.open,
    when: `resourceExtname == .md && resourceDirname in ${TASK_DIRS_CONTEXT} && activeCustomEditorId != notewell.kanban`,
    group: 'navigation',
  });
  assert.equal(entry('commandPalette')?.when, DETECTED_CONTEXT);
});
