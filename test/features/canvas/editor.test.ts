// Exercises the canvas editor adapter (editor.ts, index.ts) against an in-memory fake `vscode`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE_VSCODE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context)),
});

const fake = await import('./fake-vscode.ts');
const { CanvasEditorProvider, CANVAS_VIEW_TYPE, pathContext, resolveCanvasPath } = await import('../../../src/features/canvas/editor.ts');
const { registerCanvas } = await import('../../../src/features/canvas/index.ts');

type VsUri = import('vscode').Uri;
type Panel = ReturnType<typeof fake.makePanel>;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const EXT = fake.Uri.file('/ext') as unknown as VsUri;

const CANVAS = JSON.stringify({
  nodes: [
    { id: 't', type: 'text', text: '# Hi', x: 0, y: 0, width: 200, height: 100 },
    { id: 'img', type: 'file', file: 'pics/a.png', x: 300, y: 0, width: 200, height: 200 },
    { id: 'note', type: 'file', file: 'notes/n.md', subpath: '#Second', x: 0, y: 300, width: 200, height: 80 },
    { id: 'out', type: 'file', file: '../secret.md', x: 300, y: 300, width: 200, height: 80 },
    { id: 'gone', type: 'file', file: 'notes/missing.md', x: 600, y: 300, width: 200, height: 80 },
    { id: 'g', type: 'group', label: 'G', background: 'pics/a.png', x: -50, y: -50, width: 900, height: 500 },
  ],
  edges: [{ id: 'e', fromNode: 't', toNode: 'img', label: 'L' }],
});

const VAULT = { vaultFor: (uri: { path: string }) => (uri.path.startsWith('/vault/') ? { root: fake.Uri.file('/vault') } : undefined) };

async function open(options: { text?: string; path?: string; settings?: Record<string, unknown>; vault?: boolean } = {}) {
  fake.reset();
  for (const [name, value] of Object.entries(options.settings ?? {})) fake.state.settings.set(name, value);
  for (const path of ['/vault/pics/a.png', '/vault/notes/n.md', '/ws/pics/a.png']) fake.state.existing.add(path);
  fake.state.documents.set('/vault/notes/n.md', fake.makeDocument('/vault/notes/n.md', '# First\n\ntext\n\n## Second\n'));
  const doc = fake.makeDocument(options.path ?? '/vault/board.canvas', options.text ?? CANVAS);
  const panel = fake.makePanel();
  const vaults = options.vault === false ? undefined : VAULT;
  const provider = new CanvasEditorProvider(EXT, { vaults: () => vaults as never });
  await provider.resolveCustomTextEditor(doc as never, panel as never);
  return { doc, panel };
}

async function ready(panel: Panel) {
  panel.send({ type: 'ready' });
  await settle(5);
  return panel.posted.at(-1) as { type: string; version: number; view: Record<string, unknown> & { state: string } };
}

interface NodeLike {
  id: string;
  image?: string;
  missing?: boolean;
  outside?: boolean;
  background?: string;
}

test('registers notewell.canvas, several editors per document allowed', () => {
  fake.reset();
  const context = { extensionUri: EXT, subscriptions: [] as unknown[] };
  registerCanvas(context as never, { vaults: () => undefined });
  assert.equal(CANVAS_VIEW_TYPE, 'notewell.canvas');
  assert.deepEqual(fake.state.providers.get('notewell.canvas')?.options, { supportsMultipleEditorsPerDocument: true });
  assert.equal(context.subscriptions.length, 1);
});

test('the page loads canvas.js under the CSP, with img-src from the webview source only', async () => {
  const { panel } = await open();
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(panel.webview.html)?.[1]?.replace(/&#39;/g, "'");
  assert.equal(csp?.replace(/'nonce-[^']+'/, "'nonce-N'"), "default-src 'none'; script-src 'nonce-N'; style-src 'self' https://*.vscode-cdn.net; img-src 'self' https://*.vscode-cdn.net;");
  assert.match(panel.webview.html, /\/ext\/dist\/webview\/canvas\.js/);
  assert.match(panel.webview.html, /\/ext\/dist\/webview\/canvas\.css/);
  // Resources: the built assets and the vault (for local images), nothing else.
  const roots = (panel.webview.options as { localResourceRoots: { path: string }[] }).localResourceRoots.map((u) => u.path);
  assert.deepEqual(roots, ['/ext/dist/webview', '/vault']);
});

test('outside a vault no folder is opened to the webview and no image is shown', async () => {
  const { panel } = await open({ path: '/ws/board.canvas', vault: false });
  const roots = (panel.webview.options as { localResourceRoots: { path: string }[] }).localResourceRoots.map((u) => u.path);
  assert.deepEqual(roots, ['/ext/dist/webview']);
  const render = await ready(panel);
  const nodes = render.view['nodes'] as NodeLike[];
  assert.equal(nodes.find((n) => n.id === 'img')?.image, undefined);
  assert.equal(nodes.find((n) => n.id === 'img')?.missing, undefined, 'resolved next to the canvas: exists');
  assert.equal(nodes.find((n) => n.id === 'g')?.background, undefined);
});

test('the feature turned off reopens the file as text', async () => {
  const { panel } = await open({ settings: { 'notewell.canvas.enabled': false } });
  assert.equal(panel.disposedByProvider, true);
  assert.equal(panel.webview.html, '');
  assert.deepEqual(fake.state.executed, [['vscode.openWith', fake.Uri.file('/vault/board.canvas'), 'default']]);
  assert.equal(fake.state.info.length, 1);
});

test('ready renders the view with resolved resources; nothing before ready', async () => {
  const { panel } = await open();
  await settle(60);
  assert.equal(panel.posted.length, 0);
  const render = await ready(panel);
  assert.equal(render.type, 'render');
  assert.equal(render.version, 1);
  assert.equal(render.view.state, 'canvas');
  const nodes = render.view['nodes'] as NodeLike[];
  assert.equal(nodes.find((n) => n.id === 'img')?.image, 'https://webview.test/vault/pics/a.png');
  assert.equal(nodes.find((n) => n.id === 'g')?.background, 'https://webview.test/vault/pics/a.png');
  assert.equal(nodes.find((n) => n.id === 'note')?.image, undefined, 'not an image');
  assert.equal(nodes.find((n) => n.id === 'out')?.outside, true);
  assert.equal(nodes.find((n) => n.id === 'gone')?.missing, true);
});

test('document changes redraw (debounced); other documents do not', async () => {
  const { doc, panel } = await open();
  await ready(panel);
  const before = panel.posted.length;
  fake.events.changeTextDocument.fire({ document: {}, contentChanges: [{}] });
  await settle(80);
  assert.equal(panel.posted.length, before);
  doc.text = '{"nodes":[]}';
  doc.version = 2;
  fake.events.changeTextDocument.fire({ document: doc, contentChanges: [{}] });
  fake.events.changeTextDocument.fire({ document: doc, contentChanges: [{}] });
  await settle(80);
  assert.equal(panel.posted.length, before + 1);
  const render = panel.posted.at(-1) as { version: number; view: { nodes: unknown[] } };
  assert.equal(render.version, 2);
  assert.deepEqual(render.view.nodes, []);
});

test('an unreadable canvas renders the error view with its line', async () => {
  const { panel } = await open({ text: '{\n  "nodes": [\n    {"id": 1}\n  ]\n}\n' });
  const render = await ready(panel);
  assert.equal(render.view.state, 'error');
  assert.equal(render.view['line'], 3);
  assert.equal(render.view['message'], 'This canvas cannot be read (line 3).');
});

test('Open as Text reopens the file as text in the same column and closes the canvas', async () => {
  const { panel } = await open({ text: '{' });
  await ready(panel);
  panel.send({ type: 'openAsText' });
  await settle();
  assert.deepEqual(fake.state.executed, [['vscode.openWith', fake.Uri.file('/vault/board.canvas'), 'default', { viewColumn: 2, preview: false }]]);
  assert.equal(panel.disposedByProvider, true);
});

test('links open in the browser only after confirmation, http(s) only', async () => {
  const { panel } = await open();
  await ready(panel);
  panel.send({ type: 'openUrl', url: 'https://example.com/a' });
  await settle();
  assert.deepEqual(fake.state.external, [], 'not confirmed');
  assert.deepEqual(fake.state.warningCalls[0], [{ modal: true, detail: 'https://example.com/a' }, 'Open']);
  fake.state.warningAnswer = 'Open';
  panel.send({ type: 'openUrl', url: 'https://example.com/a' });
  await settle();
  assert.deepEqual(fake.state.external, ['https://example.com/a']);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'command:workbench.action.quit', 'not a url']) {
    panel.send({ type: 'openUrl', url });
    await settle();
  }
  assert.deepEqual(fake.state.external, ['https://example.com/a']);
  assert.equal(fake.state.warnings.filter((w) => w === 'Only http and https links can be opened.').length, 4);
});

test('file cards open inside the vault only; headings select their line', async () => {
  const { panel } = await open();
  await ready(panel);
  panel.send({ type: 'openFile', index: 1, id: 'img' });
  await settle();
  assert.deepEqual(fake.state.executed.at(-1), ['vscode.open', fake.Uri.file('/vault/pics/a.png')]);
  panel.send({ type: 'openFile', index: 2, id: 'note' });
  await settle();
  assert.equal(fake.state.shown[0]?.path, '/vault/notes/n.md');
  const selection = (fake.state.shown[0]?.options as { selection: { start: { line: number } } }).selection;
  assert.equal(selection.start.line, 4);
  panel.send({ type: 'openFile', index: 3, id: 'out' });
  await settle();
  assert.deepEqual(fake.state.warnings, ['"../secret.md" is outside the vault, so it is not opened.']);
  panel.send({ type: 'openFile', index: 4, id: 'gone' });
  await settle();
  assert.deepEqual(fake.state.info, ['"notes/missing.md" was not found.']);
  // Wrong id for the index, a non-file node, an index past the end: nothing happens.
  const executed = fake.state.executed.length;
  for (const message of [
    { type: 'openFile', index: 1, id: 'note' },
    { type: 'openFile', index: 0, id: 't' },
    { type: 'openFile', index: 99, id: 'img' },
  ]) panel.send(message);
  await settle();
  assert.equal(fake.state.executed.length, executed);
  assert.equal(fake.state.shown.length, 1);
});

test('invalid messages are ignored', async () => {
  const { panel } = await open();
  for (const message of [null, 'ready', { type: 'nope' }, { type: 'ready', extra: 1 }, { type: 'openUrl', url: '' }, { type: 'openFile', index: -1, id: 'x' }]) {
    panel.send(message);
  }
  await settle(5);
  assert.equal(panel.posted.length, 0);
  assert.deepEqual(fake.state.executed, []);
});

test('nothing is posted after the panel closes', async () => {
  const { doc, panel } = await open();
  await ready(panel);
  const before = panel.posted.length;
  panel.close();
  doc.version = 2;
  fake.events.changeTextDocument.fire({ document: doc, contentChanges: [{}] });
  panel.send({ type: 'ready' });
  await settle(80);
  assert.equal(panel.posted.length, before);
});

test('path context: vault-relative in a vault, else relative to the canvas inside its folder', () => {
  fake.reset();
  const inVault = pathContext(fake.Uri.file('/vault/sub/c.canvas') as never, VAULT as never);
  assert.deepEqual([inVault.root.path, inVault.base, inVault.vault], ['/vault', '', true]);
  assert.equal(resolveCanvasPath(inVault, 'a/b.md')?.path, '/vault/a/b.md');
  assert.equal(resolveCanvasPath(inVault, '../x.md'), undefined);

  fake.state.workspaceFolders = [{ uri: fake.Uri.file('/ws') }];
  const inFolder = pathContext(fake.Uri.file('/ws/sub/c.canvas') as never, undefined);
  assert.deepEqual([inFolder.root.path, inFolder.base, inFolder.vault], ['/ws', 'sub', false]);
  assert.equal(resolveCanvasPath(inFolder, 'n.md')?.path, '/ws/sub/n.md');
  assert.equal(resolveCanvasPath(inFolder, '../n.md')?.path, '/ws/n.md');
  assert.equal(resolveCanvasPath(inFolder, '../../n.md'), undefined);

  fake.state.workspaceFolders = undefined;
  const loose = pathContext(fake.Uri.file('/tmp/c.canvas') as never, undefined);
  assert.deepEqual([loose.root.path, loose.base, loose.vault], ['/tmp', '', false]);
});

test('a note in a file card: read from disk (or its open document), redrawn when it changes', async () => {
  const { panel } = await open();
  fake.state.fileTexts.set('/vault/notes/n.md', '# First\n\ntext\n\n## Second\n\nsecond part\n');
  const view = (await ready(panel)).view as unknown as { nodes: { id: string; note?: string; caption?: string }[] };
  const note = view.nodes.find((n) => n.id === 'note')!;
  assert.deepEqual([note.caption, note.note], ['n#Second', '## Second\n\nsecond part\n']);
  assert.equal(view.nodes.find((n) => n.id === 'gone')!.note, undefined);
  assert.ok(fake.state.watchers.includes('**/*.md'));
  // An open, edited note wins over the disk and redraws the canvas.
  const before = panel.posted.length;
  const edited = { uri: fake.Uri.file('/vault/notes/n.md'), getText: () => '## Second\n\nedited\n' };
  fake.workspace.textDocuments.push(edited as never);
  fake.events.changeTextDocument.fire({ document: edited, contentChanges: [{}] });
  await settle(80);
  assert.equal(panel.posted.length, before + 1);
  const again = (panel.posted.at(-1) as { view: { nodes: { id: string; note?: string }[] } }).view.nodes.find((n) => n.id === 'note')!;
  assert.equal(again.note, '## Second\n\nedited\n');
  fake.workspace.textDocuments.length = 0;
});
