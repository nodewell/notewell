// Exercises the VS Code adapter (editor.ts, index.ts) against an in-memory fake `vscode`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE_VSCODE = new URL('./editor-fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./editor-fake-vscode.ts');
const { KanbanEditorProvider, KANBAN_VIEW_TYPE, localToday } = await import('../../../src/features/kanban/editor.ts');
const { registerKanban, COMMANDS } = await import('../../../src/features/kanban/index.ts');

type VsUri = import('vscode').Uri;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const BOARD = '---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] one\n- [ ] two\n';
const EXT = fake.Uri.file('/ext') as unknown as VsUri;

async function openBoard(text = BOARD, settings: Record<string, unknown> = {}, vaultUseTab?: boolean) {
  fake.reset();
  for (const [name, value] of Object.entries(settings)) fake.state.settings.set(name, value);
  fake.state.existing.add('/ws/board.md');
  const doc = fake.makeDocument('/ws/board.md', text);
  const panel = fake.makePanel();
  // A vault registry stand-in: only settingsFor/kanbanPluginFor/vaultFor are used by the editor.
  const vaults =
    vaultUseTab === undefined ? undefined : { settingsFor: () => ({ useTab: vaultUseTab }), kanbanPluginFor: () => ({ showCheckboxes: undefined }), vaultFor: () => undefined };
  const provider = new KanbanEditorProvider(EXT, { vaults: () => vaults as never });
  await provider.resolveCustomTextEditor(doc as never, panel as never);
  return { doc, panel };
}

const toggleOne = (version: number) => ({ type: 'toggleCard', version, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' });
const posted = (panel: ReturnType<typeof fake.makePanel>) =>
  panel.posted.map((m) => {
    const message = m as { type: string; reason?: string };
    return message.reason ?? message.type;
  });

test('the board page loads kanban.js under the CSP and renders on ready', async () => {
  const { panel } = await openBoard();
  assert.match(panel.webview.html, /Content-Security-Policy/);
  // The real cspSource (quoted keyword + host) must reach style-src unchanged.
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(panel.webview.html)?.[1]?.replace(/&#39;/g, "'");
  assert.match(csp ?? '', /style-src 'self' https:\/\/\*\.vscode-cdn\.net;/);
  assert.match(panel.webview.html, /\/ext\/dist\/webview\/kanban\.js/);
  assert.match(panel.webview.html, /\/ext\/dist\/webview\/kanban\.css/);
  assert.deepEqual((panel.webview.options as { enableScripts: boolean }).enableScripts, true);
  panel.send({ type: 'ready' });
  await settle();
  const render = panel.posted[0] as { type: string; version: number; view: { lanes: { name: string }[] } };
  assert.equal(render.type, 'render');
  assert.equal(render.version, 1);
  assert.deepEqual(render.view.lanes.map((l) => l.name), ['Todo']);
});

test('a board change is one minimal WorkspaceEdit on this document, then saved', async () => {
  const { doc, panel } = await openBoard();
  panel.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 1);
  const [entry] = fake.state.applied[0]!.entries;
  assert.equal(entry?.uri, doc.uri);
  assert.deepEqual([entry?.range.start, entry?.range.end, entry?.newText], [{ line: 6, character: 3 }, { line: 6, character: 4 }, 'x']);
  assert.equal(doc.saves, 1);
});

test('saveOnEdit=false keeps the document dirty (no save)', async () => {
  const { doc, panel } = await openBoard(BOARD, { 'notewell.kanban.saveOnEdit': false });
  panel.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 1);
  assert.equal(doc.saves, 0);
});

test('document changes (editor, disk, undo) redraw the board; other documents do not', async () => {
  const { doc, panel } = await openBoard();
  doc.text = BOARD.replace('- [ ] two', '- [x] two');
  doc.version = 2;
  fake.events.changeTextDocument.fire({ document: fake.makeDocument('/ws/other.md', ''), contentChanges: [{}] });
  fake.events.changeTextDocument.fire({ document: doc, contentChanges: [{}] });
  fake.events.changeTextDocument.fire({ document: doc, contentChanges: [{}] });
  await settle(100);
  assert.deepEqual(posted(panel), ['render'], 'debounced into one render');
  assert.equal((panel.posted[0] as { version: number }).version, 2);
  fake.events.changeConfiguration.fire({ affectsConfiguration: (section) => section === 'notewell.kanban' });
  await settle(100);
  // A settings change redraws and also resends the style (kanban.md 3.1).
  assert.deepEqual(posted(panel), ['render', 'render', 'style']);
});

test('a request built on an older version is refused and the board redrawn', async () => {
  const { doc, panel } = await openBoard();
  doc.version = 3;
  panel.send(toggleOne(2));
  await settle();
  assert.deepEqual(fake.state.applied, []);
  assert.deepEqual(posted(panel), ['render', 'stale']);
});

test('an edit VS Code refuses is reported as failed', async () => {
  const { doc, panel } = await openBoard();
  fake.state.acceptEdits = false;
  panel.send(toggleOne(1));
  await settle();
  assert.equal(doc.saves, 0);
  assert.deepEqual(posted(panel), ['render', 'failed']);
});

test('closing the board removes its listeners', async () => {
  const before = fake.events.changeTextDocument.size;
  const { panel } = await openBoard();
  assert.equal(fake.events.changeTextDocument.size, before + 1);
  panel.close();
  assert.equal(fake.events.changeTextDocument.size, before);
  assert.equal(panel.listeners(), 0);
});

test('with the feature off the file opens as text instead', async () => {
  const { panel } = await openBoard(BOARD, { 'notewell.kanban.enabled': false });
  assert.equal(panel.disposedByProvider, true);
  assert.equal(fake.state.info.length, 1);
  assert.deepEqual(fake.state.executed.map((c) => [c[0], c[2]]), [['vscode.openWith', 'default']]);
});

test('wikilinks open an existing file found with findFiles, never create one', async () => {
  const { panel } = await openBoard();
  fake.state.workspaceFolders = [{ uri: fake.Uri.file('/ws') }];
  const target = fake.Uri.file('/ws/폴더/노트.md');
  fake.state.files = [fake.Uri.file('/ws/other/노트2.md'), target];
  panel.send({ type: 'openLink', target: '폴더/노트' });
  await settle();
  assert.deepEqual(fake.state.executed, [['vscode.open', target]]);
  panel.send({ type: 'openLink', target: '없는 노트' });
  await settle();
  assert.equal(fake.state.executed.length, 1);
  assert.deepEqual(fake.state.info, ['No note named "없는 노트" was found in the workspace.']);
  assert.deepEqual(fake.state.applied, []);
});

test('wikilinks use the shared resolver: ambiguous names ask instead of guessing', async () => {
  const { panel } = await openBoard();
  fake.state.workspaceFolders = [{ uri: fake.Uri.file('/ws') }];
  const a = fake.Uri.file('/ws/a/Leaf.md');
  const b = fake.Uri.file('/ws/b/deep/Leaf.md');
  fake.state.files = [b, a, fake.Uri.file('/elsewhere/Leaf.md')];
  fake.state.pick = 'b/deep/Leaf.md';
  panel.send({ type: 'openLink', target: 'leaf' });
  await settle();
  assert.deepEqual(fake.state.picks, [{ items: ['a/Leaf.md', 'b/deep/Leaf.md'], placeHolder: 'Several files match "leaf". Choose one to open' }], 'only files in the folder, sorted');
  assert.deepEqual(fake.state.executed, [['vscode.open', b]]);
  // A cancelled pick opens nothing; a path that fits one file opens it directly.
  fake.state.pick = undefined;
  panel.send({ type: 'openLink', target: 'Leaf' });
  await settle();
  assert.equal(fake.state.executed.length, 1);
  panel.send({ type: 'openLink', target: 'a/leaf' });
  await settle();
  assert.deepEqual(fake.state.executed.at(-1), ['vscode.open', a]);
});

test('local date for due-date states', () => {
  assert.equal(localToday(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

// --- registration, commands and opening boards by default ---

function textTab(path: string, extra: Record<string, unknown> = {}) {
  return { input: new fake.TabInputText(fake.Uri.file(path)), isDirty: false, isPreview: false, isActive: false, group: { viewColumn: 1 }, ...extra };
}

let registered: { subscriptions: { dispose(): void }[] } | undefined;

/** Fresh registration; `before` runs after the reset, before registerKanban (e.g. to add documents). */
function register(settings: Record<string, unknown> = {}, initialTabs: unknown[] = [], before?: () => void, globalState?: InstanceType<typeof fake.Memento>) {
  for (const d of registered?.subscriptions ?? []) d.dispose();
  fake.reset();
  for (const [name, value] of Object.entries(settings)) fake.state.settings.set(name, value);
  fake.state.groups = [{ viewColumn: 1, tabs: initialTabs }];
  before?.();
  const context = { extensionUri: EXT, subscriptions: [] as { dispose(): void }[], globalState: globalState ?? new fake.Memento() };
  registerKanban(context as never, { vaults: () => undefined });
  registered = context;
  return context;
}

function addDocument(path: string, text: string) {
  const doc = fake.makeDocument(path, text);
  fake.state.documents.set(doc.uri.toString(), doc);
  return doc;
}

const openWithCalls = () => fake.state.executed.filter((c) => c[0] === 'vscode.openWith').map((c) => [(c[1] as VsUri).path, c[2]]);

test('registers the custom editor and both commands', () => {
  const context = register();
  assert.ok(fake.state.providers.has(KANBAN_VIEW_TYPE));
  assert.ok(fake.state.commands.has(COMMANDS.openAsBoard));
  assert.ok(fake.state.commands.has(COMMANDS.openAsText));
  assert.ok(fake.state.commands.has(COMMANDS.collapseAllCardBodies));
  assert.ok(fake.state.commands.has(COMMANDS.expandAllCardBodies));
  const tabListeners = fake.events.changeTabs.size;
  for (const d of context.subscriptions) d.dispose();
  assert.equal(fake.state.providers.size, 0);
  assert.equal(fake.state.commands.size, 0);
  assert.equal(fake.events.changeTabs.size, tabListeners - 1);
});

test('a text tab of a board file is reopened as a board and the text tab closed', async () => {
  register();
  addDocument('/ws/board.md', BOARD);
  addDocument('/ws/note.md', '# just a note\n');
  const board = textTab('/ws/board.md');
  const note = textTab('/ws/note.md');
  fake.state.groups[0]!.tabs.push(board, note);
  fake.events.changeTabs.fire({ opened: [board, note], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), [['/ws/board.md', KANBAN_VIEW_TYPE]]);
  assert.deepEqual(fake.state.closed, [board]);
});

test('boards already open at activation are switched too', async () => {
  const tab = textTab('/ws/board.md');
  register({}, [tab], () => addDocument('/ws/board.md', BOARD));
  await settle();
  assert.deepEqual(openWithCalls(), [['/ws/board.md', KANBAN_VIEW_TYPE]]);
  assert.deepEqual(fake.state.closed, [tab]);
});

test('a tab whose file cannot be opened is left alone', async () => {
  register();
  const tab = textTab('/ws/gone.md');
  fake.events.changeTabs.fire({ opened: [tab], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), []);
});

test('no automatic switch when turned off, for dirty tabs, other schemes or non-.md files', async () => {
  register({ 'notewell.kanban.openBoardsByDefault': false });
  addDocument('/ws/board.md', BOARD);
  const tab = textTab('/ws/board.md');
  fake.events.changeTabs.fire({ opened: [tab], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), []);

  register();
  addDocument('/ws/board.md', BOARD);
  const dirty = textTab('/ws/board.md', { isDirty: true });
  const git = { ...textTab('/ws/board.md'), input: new fake.TabInputText(fake.Uri.from({ scheme: 'git', path: '/ws/board.md' })) };
  const txt = textTab('/ws/board.txt');
  fake.events.changeTabs.fire({ opened: [dirty, git, txt], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), []);
});

test('"Open as Text" is respected: the file is not switched back automatically', async () => {
  register();
  addDocument('/ws/board.md', BOARD);
  const uri = fake.Uri.file('/ws/board.md');
  await fake.state.commands.get(COMMANDS.openAsText)!(uri);
  assert.deepEqual(openWithCalls(), [['/ws/board.md', 'default']]);
  const tab = textTab('/ws/board.md');
  fake.events.changeTabs.fire({ opened: [tab], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), [['/ws/board.md', 'default']]);
  // "Open as Board" clears the preference.
  await fake.state.commands.get(COMMANDS.openAsBoard)!(uri);
  assert.deepEqual(openWithCalls().at(-1), ['/ws/board.md', KANBAN_VIEW_TYPE]);
});

function boardTab(path: string, extra: Record<string, unknown> = {}) {
  return { ...textTab(path), input: new fake.TabInputCustom(fake.Uri.file(path), KANBAN_VIEW_TYPE), ...extra };
}

test('"Reopen Editor With... > Text Editor" on a board is respected in any event order', async () => {
  // One event: the board closes and the text tab opens.
  let board = boardTab('/ws/board.md');
  register({}, [board], () => addDocument('/ws/board.md', BOARD));
  let text = textTab('/ws/board.md');
  fake.state.groups[0]!.tabs = [text];
  fake.events.changeTabs.fire({ opened: [text], changed: [], closed: [board] });
  await settle();
  assert.deepEqual(openWithCalls(), []);
  // Later opens of the file stay text too, as after "Open as Text".
  const again = textTab('/ws/board.md');
  fake.events.changeTabs.fire({ opened: [again], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), []);

  // Text tab reported first, the board closed afterwards.
  board = boardTab('/ws/board.md');
  register({}, [board], () => addDocument('/ws/board.md', BOARD));
  text = textTab('/ws/board.md');
  fake.state.groups[0]!.tabs.push(text);
  fake.events.changeTabs.fire({ opened: [text], changed: [], closed: [] });
  fake.state.groups[0]!.tabs = [text];
  fake.events.changeTabs.fire({ opened: [], changed: [], closed: [board] });
  await settle(200);
  assert.deepEqual(openWithCalls(), []);

  // Board closed first, then the text tab in a separate event; or the input swapped in place.
  board = boardTab('/ws/board.md');
  register({}, [board], () => addDocument('/ws/board.md', BOARD));
  fake.state.groups[0]!.tabs = [];
  fake.events.changeTabs.fire({ opened: [], changed: [], closed: [board] });
  text = textTab('/ws/board.md');
  fake.state.groups[0]!.tabs = [text];
  fake.events.changeTabs.fire({ opened: [text], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), []);

  board = boardTab('/ws/board.md');
  register({}, [board], () => addDocument('/ws/board.md', BOARD));
  text = textTab('/ws/board.md');
  fake.state.groups[0]!.tabs = [text];
  fake.events.changeTabs.fire({ opened: [], changed: [text], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), []);
});

test('opening a file again while its board stays open in the group shows the board, frontmatter or not', async () => {
  for (const [path, text] of [['/ws/board.md', BOARD], ['/ws/plain.md', '# plain\n']] as const) {
    const board = boardTab(path);
    register({}, [board], () => addDocument(path, text));
    const opened = textTab(path);
    fake.state.groups[0]!.tabs.push(opened);
    fake.events.changeTabs.fire({ opened: [opened], changed: [], closed: [] });
    await settle(200);
    assert.deepEqual(openWithCalls(), [[path, KANBAN_VIEW_TYPE]]);
    assert.deepEqual(fake.state.closed, [opened]);
    // Not taken as a switch to text: the next open is switched as well.
    const next = textTab(path, { group: { viewColumn: 3 } });
    fake.events.changeTabs.fire({ opened: [next], changed: [], closed: [] });
    await settle();
    assert.equal(openWithCalls().length, path === '/ws/board.md' ? 2 : 1);
  }
});

test('a board in another group does not keep a new text tab from switching; reopening as a board ends the preference', async () => {
  const other = boardTab('/ws/board.md', { group: { viewColumn: 2 } });
  register({}, [], () => addDocument('/ws/board.md', BOARD));
  fake.state.groups.push({ viewColumn: 2, tabs: [other] });
  const text = textTab('/ws/board.md');
  fake.state.groups[0]!.tabs.push(text);
  fake.events.changeTabs.fire({ opened: [text], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), [['/ws/board.md', KANBAN_VIEW_TYPE]]);

  // Replaced with text, then reopened as a board by VS Code's menu: auto-switching resumes.
  const board = boardTab('/ws/board.md');
  register({}, [board], () => addDocument('/ws/board.md', BOARD));
  const swapped = textTab('/ws/board.md');
  fake.state.groups[0]!.tabs = [swapped];
  fake.events.changeTabs.fire({ opened: [swapped], changed: [], closed: [board] });
  const back = boardTab('/ws/board.md');
  fake.state.groups[0]!.tabs = [back];
  fake.events.changeTabs.fire({ opened: [back], changed: [], closed: [swapped] });
  await settle(1100);
  const later = textTab('/ws/board.md', { group: { viewColumn: 3 } });
  fake.events.changeTabs.fire({ opened: [later], changed: [], closed: [] });
  await settle();
  assert.deepEqual(openWithCalls(), [['/ws/board.md', KANBAN_VIEW_TYPE]]);
});

// --- boards remembered in the user's editor associations (kanban.md 5) ---

const { associationPattern } = await import('../../../src/features/kanban/associations.ts');
const ASSOC = 'workbench.editorAssociations';
const userAssociations = () => fake.state.globalSettings.get(ASSOC) as Record<string, string> | undefined;
const fireTabs = (change: { opened?: unknown[]; changed?: unknown[]; closed?: unknown[] }) =>
  fake.events.changeTabs.fire({ opened: [], changed: [], closed: [], ...change });

test('association pattern: scheme and path, glob characters matched as any one character', () => {
  assert.equal(associationPattern(fake.Uri.file('/d:/Work/📅 할 일 - 보드.md')), 'file:/d:/Work/📅 할 일 - 보드.md');
  assert.equal(associationPattern(fake.Uri.file('/ws/[a]{b}*c?.md')), 'file:/ws/?a??b??c?.md');
});

test('a board shown for a file is remembered once in the user settings; other entries are kept', async () => {
  register({}, [], () => fake.state.globalSettings.set(ASSOC, { '*.csv': 'csv.grid' }));
  const board = boardTab('/ws/board.md');
  fireTabs({ opened: [board] });
  await settle();
  assert.deepEqual(userAssociations(), { '*.csv': 'csv.grid', 'file:/ws/board.md': KANBAN_VIEW_TYPE });
  assert.equal(fake.state.updates.length, 1);
  assert.equal(fake.state.updates[0]!.target, fake.ConfigurationTarget.Global);
  // Shown again: nothing to write.
  fireTabs({ opened: [boardTab('/ws/board.md', { group: { viewColumn: 2 } })] });
  await settle();
  assert.equal(fake.state.updates.length, 1);
});

test('"Open as Text" and "Reopen Editor With... > Text Editor" remove the entry', async () => {
  const memento = new fake.Memento();
  register({}, [], () => fake.state.globalSettings.set(ASSOC, { '*.csv': 'csv.grid' }), memento);
  fireTabs({ opened: [boardTab('/ws/a.md'), boardTab('/ws/b.md')] });
  await settle();
  await fake.state.commands.get(COMMANDS.openAsText)!(fake.Uri.file('/ws/a.md'));
  await settle();
  assert.deepEqual(userAssociations(), { '*.csv': 'csv.grid', 'file:/ws/b.md': KANBAN_VIEW_TYPE });

  const board = boardTab('/ws/b.md');
  const text = textTab('/ws/b.md');
  fake.state.groups[0]!.tabs = [text];
  fireTabs({ opened: [text], closed: [board] });
  await settle();
  assert.deepEqual(userAssociations(), { '*.csv': 'csv.grid' });
  assert.deepEqual(memento.get('notewell.kanban.associations', null), []);
});

test("an entry the user wrote for the same file is never changed or removed", async () => {
  register({}, [], () => fake.state.globalSettings.set(ASSOC, { 'file:/ws/a.md': 'default', 'file:/ws/b.md': KANBAN_VIEW_TYPE }));
  fireTabs({ opened: [boardTab('/ws/a.md'), boardTab('/ws/b.md')] });
  await settle();
  await fake.state.commands.get(COMMANDS.openAsText)!(fake.Uri.file('/ws/a.md'));
  await fake.state.commands.get(COMMANDS.openAsText)!(fake.Uri.file('/ws/b.md'));
  await settle();
  assert.deepEqual(userAssociations(), { 'file:/ws/a.md': 'default', 'file:/ws/b.md': KANBAN_VIEW_TYPE });
  assert.equal(fake.state.updates.length, 0);
});

test('the last entry removed clears the setting; non-file schemes and non-.md files are never remembered', async () => {
  register();
  fireTabs({ opened: [boardTab('/ws/a.md')] });
  const git = { ...boardTab('/ws/g.md'), input: new fake.TabInputCustom(fake.Uri.from({ scheme: 'git', path: '/ws/g.md' }), KANBAN_VIEW_TYPE) };
  fireTabs({ opened: [git, boardTab('/ws/notes.txt')] });
  await settle();
  assert.deepEqual(userAssociations(), { 'file:/ws/a.md': KANBAN_VIEW_TYPE });
  await fake.state.commands.get(COMMANDS.openAsText)!(fake.Uri.file('/ws/a.md'));
  await settle();
  assert.equal(fake.state.globalSettings.has(ASSOC), false);
});

test('renamed files and folders move their entries; deleted ones lose them', async () => {
  register();
  fireTabs({ opened: [boardTab('/ws/a.md'), boardTab('/ws/dir/b.md'), boardTab('/ws/dir/sub/c.md'), boardTab('/ws/dirx.md')] });
  await settle();
  fake.events.renameFiles.fire({ files: [{ oldUri: fake.Uri.file('/ws/a.md'), newUri: fake.Uri.file('/ws/a2.md') }, { oldUri: fake.Uri.file('/ws/dir'), newUri: fake.Uri.file('/ws/moved') }] });
  await settle();
  assert.deepEqual(Object.keys(userAssociations()!).sort(), ['file:/ws/a2.md', 'file:/ws/dirx.md', 'file:/ws/moved/b.md', 'file:/ws/moved/sub/c.md']);
  fake.events.deleteFiles.fire({ files: [fake.Uri.file('/ws/moved'), fake.Uri.file('/ws/a2.md')] });
  await settle();
  assert.deepEqual(userAssociations(), { 'file:/ws/dirx.md': KANBAN_VIEW_TYPE });
});

test('turned off: nothing remembered, and entries already added are removed (also at activation)', async () => {
  register({ 'notewell.kanban.rememberBoards': false });
  fireTabs({ opened: [boardTab('/ws/a.md')] });
  await settle();
  assert.equal(fake.state.globalSettings.has(ASSOC), false);

  const memento = new fake.Memento();
  register({}, [], undefined, memento);
  fireTabs({ opened: [boardTab('/ws/a.md'), boardTab('/ws/b.md')] });
  await settle();
  // The kanban feature turned off for one file only.
  fake.state.settings.set('notewell.kanban.enabled', false);
  fake.events.changeConfiguration.fire({ affectsConfiguration: (s) => 'notewell.kanban.enabled'.startsWith(s) });
  await settle();
  assert.equal(fake.state.globalSettings.has(ASSOC), false);

  // Off while the extension was not running: removed when it starts.
  const saved = new fake.Memento();
  register({}, [], undefined, saved);
  fireTabs({ opened: [boardTab('/ws/a.md')] });
  await settle();
  const setting = userAssociations();
  register({ 'notewell.kanban.rememberBoards': false }, [], () => fake.state.globalSettings.set(ASSOC, setting), saved);
  await settle();
  assert.equal(fake.state.globalSettings.has(ASSOC), false);
});

test('boards open at activation are remembered; an unwritable settings file changes nothing', async () => {
  register({}, [boardTab('/ws/a.md')]);
  await settle();
  assert.deepEqual(userAssociations(), { 'file:/ws/a.md': KANBAN_VIEW_TYPE });

  const memento = new fake.Memento();
  register({}, [], () => (fake.state.failUpdates = true), memento);
  fireTabs({ opened: [boardTab('/ws/a.md')] });
  await settle();
  assert.equal(fake.state.globalSettings.has(ASSOC), false);
  assert.deepEqual(memento.get('notewell.kanban.associations', []), []);
  // Later writes still run.
  fake.state.failUpdates = false;
  fireTabs({ opened: [boardTab('/ws/b.md')] });
  await settle();
  assert.deepEqual(userAssociations(), { 'file:/ws/b.md': KANBAN_VIEW_TYPE });
});

test('"Open as Board" works for files without frontmatter and needs a Markdown file', async () => {
  register();
  await fake.state.commands.get(COMMANDS.openAsBoard)!(fake.Uri.file('/ws/plain.md'));
  assert.deepEqual(openWithCalls(), [['/ws/plain.md', KANBAN_VIEW_TYPE]]);
  await fake.state.commands.get(COMMANDS.openAsBoard)!(fake.Uri.file('/ws/data.json'));
  await fake.state.commands.get(COMMANDS.openAsBoard)!();
  assert.equal(openWithCalls().length, 1);
  assert.deepEqual(fake.state.info, ['Open a Markdown file first.', 'Open a Markdown file first.']);
  register({ 'notewell.kanban.enabled': false });
  await fake.state.commands.get(COMMANDS.openAsBoard)!(fake.Uri.file('/ws/plain.md'));
  assert.deepEqual(openWithCalls(), []);
  assert.equal(fake.state.info.length, 1);
});

// --- multi-line card edit (kanban.md 4.4) ---

const editOne = (text: string) => ({ type: 'editCardText', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one', text });

test('the vault useTab reaches card edits (tab outside a vault)', async () => {
  const outside = await openBoard();
  outside.panel.send(editOne('one\nnew'));
  await settle();
  assert.equal(fake.state.applied[0]?.entries[0]?.newText.includes('\tnew'), true);
  const spaces = await openBoard(BOARD, {}, false);
  spaces.panel.send(editOne('one\nnew'));
  await settle();
  assert.equal(fake.state.applied[0]?.entries[0]?.newText.includes('    new'), true);
});

// --- board style (kanban.md 3.1, core.md 3.6) ---

const { boardStyleMessage } = await import('../../../src/features/kanban/editor.ts');
const { NOTEWELL_PALETTE } = await import('../../../src/features/kanban/notewell-theme.ts');

/** Stand-ins for VaultRegistry and AppearanceStore: one vault at /ws. */
function styleDeps(appearance: { mode?: 'dark' | 'light' | 'system'; accentColor?: string }, themeCss?: string) {
  const root = fake.Uri.file('/ws');
  const changed = new fake.EventEmitter<string>();
  const vaults = { vaultFor: (uri: { path: string }) => (uri.path.startsWith('/ws/') ? { root } : undefined), settingsFor: () => ({ useTab: true }), kanbanPluginFor: () => ({ showCheckboxes: undefined }) };
  const store = {
    onDidChange: changed.event,
    appearanceFor: async () => ({
      appearance: { cssTheme: '', mode: 'dark', enabledCssSnippets: [], ...appearance },
      ...(themeCss === undefined ? {} : { themeCss }),
      snippetCss: [],
    }),
  };
  return { vaults: vaults as never, store: store as never, changed };
}

const VSCODE = { type: 'style', style: 'vscode', scheme: null, tokens: {} };
const inVault = fake.Uri.file('/ws/board.md') as never;
const outside = fake.Uri.file('/elsewhere/board.md') as never;
function useStyle(style: string | undefined, kind: number = fake.ColorThemeKind.Dark): void {
  fake.reset();
  if (style !== undefined) fake.state.settings.set('notewell.kanban.style', style);
  fake.window.activeColorTheme = { kind };
}

test('style vscode (default): no tokens, in or out of a vault, any theme kind', async () => {
  const { vaults, store } = styleDeps({ mode: 'dark' });
  for (const kind of [fake.ColorThemeKind.Dark, fake.ColorThemeKind.Light, fake.ColorThemeKind.HighContrast]) {
    useStyle(undefined, kind);
    assert.deepEqual(await boardStyleMessage(inVault, vaults, store), VSCODE);
    useStyle('vscode', kind);
    assert.deepEqual(await boardStyleMessage(outside, vaults, store), VSCODE);
  }
  // An unknown value falls back to the default.
  useStyle('fancy');
  assert.deepEqual(await boardStyleMessage(inVault, vaults, store), VSCODE);
});

test('style obsidian: vault theme for dark/light/system; vscode outside a vault, before vaults, under high contrast', async () => {
  useStyle('obsidian');
  const dark = await boardStyleMessage(inVault, styleDeps({ mode: 'dark' }).vaults, styleDeps({ mode: 'dark' }).store);
  assert.equal(dark.style, 'obsidian');
  assert.equal(dark.scheme, 'dark');
  assert.equal(dark.tokens['--nw-board-bg'], '#1c1c1c');
  const light = await boardStyleMessage(inVault, styleDeps({ mode: 'light' }).vaults, styleDeps({ mode: 'light' }).store);
  assert.equal(light.scheme, 'light');
  assert.equal(light.tokens['--nw-board-bg'], '#ffffff');
  useStyle('obsidian', fake.ColorThemeKind.Light);
  const system = styleDeps({ mode: 'system', accentColor: '#2e8b57' }, '.theme-light { --background-primary: #fbfaf7; }');
  const followed = await boardStyleMessage(inVault, system.vaults, system.store);
  assert.equal(followed.scheme, 'light');
  assert.equal(followed.tokens['--nw-board-bg'], '#fbfaf7');
  assert.equal(followed.tokens['--nw-accent'], 'hsl(146.5, 50.3%, 36.3%)');
  const { vaults, store } = styleDeps({ mode: 'dark' });
  assert.deepEqual(await boardStyleMessage(outside, vaults, store), VSCODE);
  assert.deepEqual(await boardStyleMessage(inVault, undefined, store), VSCODE);
  for (const kind of [fake.ColorThemeKind.HighContrast, fake.ColorThemeKind.HighContrastLight]) {
    useStyle('obsidian', kind);
    assert.deepEqual(await boardStyleMessage(inVault, vaults, store), VSCODE);
  }
});

test('style notewell: built-in palette by VS Code brightness, in or out of a vault; vscode under high contrast', async () => {
  const { vaults, store } = styleDeps({ mode: 'light' });
  useStyle('notewell', fake.ColorThemeKind.Dark);
  const dark = await boardStyleMessage(outside, vaults, store);
  assert.deepEqual([dark.style, dark.scheme], ['notewell', 'dark']);
  assert.deepEqual(dark.tokens, NOTEWELL_PALETTE.dark);
  useStyle('notewell', fake.ColorThemeKind.Light);
  const light = await boardStyleMessage(inVault, vaults, store);
  assert.deepEqual([light.style, light.scheme], ['notewell', 'light']);
  assert.deepEqual(light.tokens, NOTEWELL_PALETTE.light);
  useStyle('notewell', fake.ColorThemeKind.HighContrastLight);
  assert.deepEqual(await boardStyleMessage(inVault, vaults, store), VSCODE);
});

test('style: sent after the first render on ready, and again on setting, theme, vault and color theme changes', async () => {
  useStyle('obsidian');
  const { vaults, store, changed } = styleDeps({ mode: 'dark' });
  const vaultsChanged = new fake.EventEmitter<void>();
  const doc = fake.makeDocument('/ws/board.md', BOARD);
  const panel = fake.makePanel();
  const provider = new KanbanEditorProvider(EXT, { vaults: () => vaults, appearances: () => store, vaultsChanged: vaultsChanged.event as never });
  await provider.resolveCustomTextEditor(doc as never, panel as never);
  panel.send({ type: 'ready' });
  await settle();
  assert.deepEqual(posted(panel), ['render', 'style']);
  assert.equal((panel.posted[1] as { style: string }).style, 'obsidian');
  // Switching the setting resends right away (plus the usual redraw for settings).
  fake.state.settings.set('notewell.kanban.style', 'vscode');
  fake.events.changeConfiguration.fire({ affectsConfiguration: (section) => section === 'notewell.kanban' });
  await settle(100);
  const last = panel.posted[panel.posted.length - 1] as { type: string; style: string };
  assert.deepEqual([last.type, last.style], ['style', 'vscode']);
  const before = panel.posted.length;
  changed.fire('/ws');
  await settle(100);
  changed.fire('/other-vault');
  await settle(100);
  vaultsChanged.fire();
  await settle(100);
  fake.events.changeColorTheme.fire({});
  await settle(100);
  // One style per relevant change; the other vault's change is ignored. A vault change also
  // redraws: it may change the Kanban plugin's check box default (kanban.md 2.9).
  assert.deepEqual(posted(panel).slice(before), ['style', 'render', 'style', 'style']);
  panel.close();
  changed.fire('/ws');
  await settle(100);
  assert.equal(panel.posted.length, before + 4, 'nothing is sent after the board is closed');
});

// --- delete confirmation dialog (kanban.md 4.6) ---

test('delete shows a modal with the card title and deletes only on the Delete button', async () => {
  const { doc, panel } = await openBoard();
  fake.state.warningAnswer = 'Delete';
  panel.send({ type: 'deleteCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' });
  await settle();
  assert.deepEqual(fake.state.warnings, ['Delete this card?']);
  assert.deepEqual(fake.state.warningCalls, [[{ modal: true, detail: 'one' }, 'Delete']]);
  assert.equal(fake.state.applied.length, 1);
  assert.equal(doc.saves, 1);
});

test('closing the delete dialog (no button) changes nothing', async () => {
  const { panel } = await openBoard();
  panel.send({ type: 'deleteCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' });
  await settle();
  assert.equal(fake.state.warnings.length, 1);
  assert.deepEqual(fake.state.applied, []);
  assert.deepEqual(panel.posted, []);
});

test('cardBodies setting reaches the view; fold commands go to the active board only', async () => {
  fake.reset();
  fake.state.settings.set('notewell.kanban.cardBodies', 'collapsed');
  fake.state.existing.add('/ws/a.md');
  fake.state.existing.add('/ws/b.md');
  const provider = new KanbanEditorProvider(EXT, { vaults: () => undefined });
  const a = fake.makePanel();
  const b = fake.makePanel();
  await provider.resolveCustomTextEditor(fake.makeDocument('/ws/a.md', BOARD) as never, a as never);
  await provider.resolveCustomTextEditor(fake.makeDocument('/ws/b.md', BOARD) as never, b as never);
  a.send({ type: 'ready' });
  await settle();
  assert.equal((a.posted[0] as { view: { cardBodies: string } }).view.cardBodies, 'collapsed');
  fake.state.settings.set('notewell.kanban.cardBodies', 'bogus');
  a.send({ type: 'ready' });
  await settle();
  assert.equal((a.posted.at(-2) as { view: { cardBodies: string } }).view.cardBodies, 'expanded');

  assert.equal(provider.postToActiveBoard({ type: 'cardBodies', collapsed: true }), false);
  b.active = true;
  a.posted.length = 0;
  assert.equal(provider.postToActiveBoard({ type: 'cardBodies', collapsed: true }), true);
  await settle();
  assert.deepEqual(b.posted.at(-1), { type: 'cardBodies', collapsed: true });
  assert.equal(a.posted.length, 0);
  // A closed board is forgotten.
  b.close();
  assert.equal(provider.postToActiveBoard({ type: 'cardBodies', collapsed: false }), false);
});

// --- open a card in text beside the board (kanban.md 4.7) ---

const BODY_BOARD = '---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] one\n\t- body\n- [ ] two\n';
const openOne = { type: 'openCardInText', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' };

/** Registers the feature with a board of /ws/board.md shown in group 1 (remembered), resolved by the registered provider. */
async function registeredBoard(settings: Record<string, unknown> = {}) {
  const board = boardTab('/ws/board.md');
  register(settings, [board]);
  fake.state.existing.add('/ws/board.md');
  const doc = addDocument('/ws/board.md', BODY_BOARD);
  fireTabs({ opened: [board] });
  await settle();
  const panel = fake.makePanel();
  const provider = fake.state.providers.get(KANBAN_VIEW_TYPE) as InstanceType<typeof KanbanEditorProvider>;
  await provider.resolveCustomTextEditor(doc as never, panel as never);
  return { doc, panel, board };
}

const shownRange = (i = 0) => {
  const { selection } = fake.state.shownDocuments[i]!.options;
  return selection && [selection.start.line, selection.start.character, selection.end.line, selection.end.character];
};

test('open in text: the same document beside the board, card range selected, centered and focused', async () => {
  const { doc, panel } = await registeredBoard();
  panel.send(openOne);
  await settle();
  assert.equal(fake.state.shownDocuments.length, 1);
  const { document, options } = fake.state.shownDocuments[0]!;
  assert.equal(document, doc, 'the board document itself, so edits and undo are shared');
  assert.equal(options.viewColumn, fake.ViewColumn.Beside);
  assert.equal(options.preserveFocus, false);
  assert.deepEqual(shownRange(), [6, 0, 7, '\t- body'.length]);
  const editor = fake.window.visibleTextEditors[0]!;
  assert.deepEqual(editor.revealed.map((r) => r.type), [fake.TextEditorRevealType.InCenter]);
  // Nothing written, the board stays open.
  assert.equal(fake.state.applied.length, 0);
  assert.equal(doc.saves, 0);
  assert.equal(panel.disposedByProvider, false);
  assert.deepEqual(panel.posted, []);
});

test('open in text: the text tab is not switched back to a board and the association stays', async () => {
  const { panel } = await registeredBoard();
  const remembered = { 'file:/ws/board.md': KANBAN_VIEW_TYPE };
  assert.deepEqual(userAssociations(), remembered);
  const updates = fake.state.updates.length;
  // The new text tab is reported while the open is still in progress, and again afterwards.
  const text = textTab('/ws/board.md', { group: { viewColumn: 2 } });
  fake.state.onShowTextDocument = () => {
    fake.state.groups.push({ viewColumn: 2, tabs: [text] });
    fireTabs({ opened: [text] });
  };
  panel.send(openOne);
  await settle(200);
  fireTabs({ changed: [text] });
  await settle(200);
  assert.deepEqual(openWithCalls(), [], 'not reopened as a board (openBoardsByDefault)');
  assert.deepEqual(fake.state.closed, [], 'neither tab closed');
  assert.deepEqual(userAssociations(), remembered, '"Open as Text" was not assumed');
  assert.equal(fake.state.updates.length, updates);

  // A board shown in that group too (e.g. a split) does not close the text tab either.
  fake.state.groups[1]!.tabs.push(boardTab('/ws/board.md', { group: { viewColumn: 2 } }));
  fireTabs({ changed: [text] });
  await settle(200);
  assert.deepEqual(openWithCalls(), []);
  assert.deepEqual(fake.state.closed, []);
});

test('open in text: the exemption ends when that text tab closes', async () => {
  const { panel } = await registeredBoard();
  const text = textTab('/ws/board.md', { group: { viewColumn: 2 } });
  panel.send(openOne);
  await settle();
  fake.state.groups.push({ viewColumn: 2, tabs: [text] });
  fireTabs({ opened: [text] });
  await settle();
  assert.deepEqual(openWithCalls(), []);
  fake.state.groups[1]!.tabs = [];
  fireTabs({ closed: [text] });
  // Opened there again by other means: the usual rules apply.
  const again = textTab('/ws/board.md', { group: { viewColumn: 2 } });
  fake.state.groups[1]!.tabs = [again];
  fireTabs({ opened: [again] });
  await settle();
  assert.deepEqual(openWithCalls(), [['/ws/board.md', KANBAN_VIEW_TYPE]]);
});

test('open in text: a text editor of the document already visible is reused', async () => {
  const { doc, panel } = await registeredBoard();
  fake.window.visibleTextEditors.push({ document: doc, viewColumn: 3, selection: undefined, revealed: [], revealRange() {} });
  panel.send({ ...openOne, cardIndex: 1, firstLine: '- [ ] two' });
  await settle();
  assert.equal(fake.state.shownDocuments[0]!.options.viewColumn, 3);
  assert.deepEqual(shownRange(), [8, 0, 8, '- [ ] two'.length]);
});

test('open in text: a card that no longer matches is not opened; the board is redrawn', async () => {
  const { panel } = await registeredBoard();
  panel.send({ ...openOne, firstLine: '- [ ] changed' });
  await settle();
  assert.equal(fake.state.shownDocuments.length, 0);
  assert.deepEqual(posted(panel), ['render', 'stale']);
});

test('open in text without registerKanban: the provider shows the text beside by itself', async () => {
  const { doc, panel } = await openBoard(BODY_BOARD);
  panel.send(openOne);
  await settle();
  assert.equal(fake.state.shownDocuments[0]!.document, doc);
  assert.equal(fake.state.shownDocuments[0]!.options.viewColumn, fake.ViewColumn.Beside);
  // A closed board opens nothing.
  panel.close();
  panel.send(openOne);
  await settle();
  assert.equal(fake.state.shownDocuments.length, 1);
});
