// Paste and drop providers (links.md 4) against a fake `vscode`: the note only gets the inserted
// embed, exactly one new file is created per item and never over an existing one, vault files are
// linked without copying, settings pointing outside the vault and declined large files add nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE, shortCircuit: true } : next(specifier, context)) });

const fake = await import('./fake-vscode.ts');
const { registerAttachments } = await import('../../../src/features/attachments/index.ts');
type Edit = { insertText: string; title: string; kind: { value: string }; additionalEdit?: InstanceType<typeof fake.WorkspaceEdit> };

const ROOT = '/vault';
const NOTE = `${ROOT}/notes/today.md`;
const token = { isCancellationRequested: false };

function vaults(settings: Partial<{ useMarkdownLinks: boolean; newLinkFormat: string; attachmentFolderPath: string }> = {}) {
  const vault = { root: fake.Uri.file(ROOT), settings: { useMarkdownLinks: false, newLinkFormat: 'shortest', attachmentFolderPath: '/', ...settings } };
  return { vaultFor: (uri: { path: string }) => (uri.path.startsWith(`${ROOT}/`) ? vault : undefined) };
}

function setup(settings: Parameters<typeof vaults>[0] = {}) {
  fake.files.clear();
  fake.folders.clear();
  fake.symlinks.clear();
  fake.sizes.clear();
  fake.settings.clear();
  fake.warnings.length = 0;
  fake.answers.length = 0;
  const subscriptions: unknown[] = [];
  registerAttachments({ subscriptions } as never, { vaults: () => vaults(settings) as never });
  return {
    paste: fake.providers.paste as { provideDocumentPasteEdits: (...a: unknown[]) => Promise<Edit[] | undefined> },
    drop: fake.providers.drop as { provideDocumentDropEdits: (...a: unknown[]) => Promise<Edit | undefined> },
  };
}

const doc = (path = NOTE) => ({ uri: fake.Uri.file(path) });
const bytes = (n: number) => new Uint8Array(n).fill(7);

/** A DataTransfer with files: mime -> { name, uri?, size }. */
function transfer(items: { mime: string; name: string; uri?: string; size?: number }[]) {
  return {
    forEach(callback: (item: { asFile(): unknown }, mime: string) => void) {
      for (const it of items) {
        callback({ asFile: () => ({ name: it.name, uri: it.uri ? fake.Uri.file(it.uri) : undefined, data: async () => bytes(it.size ?? 3) }) }, it.mime);
      }
    },
  };
}

test('paste of a clipboard image: one new file with the Obsidian name, only the embed is inserted', async () => {
  const { paste } = setup({ attachmentFolderPath: './assets' });
  const edits = (await paste.provideDocumentPasteEdits(doc(), [], transfer([{ mime: 'image/png', name: 'image.png' }]), {}, token))!;
  assert.equal(edits.length, 1);
  const [edit] = edits;
  assert.match(edit.insertText, /^!\[\[Pasted image \d{14}\.png\]\]$/);
  assert.equal(edit.kind.value, 'notewell.attachment');
  const created = edit.additionalEdit!.creates;
  assert.equal(created.length, 1);
  assert.match(created[0].uri.path, /^\/vault\/notes\/assets\/Pasted image \d{14}\.png$/);
  assert.deepEqual([created[0].options.overwrite, created[0].options.ignoreIfExists, created[0].options.contents?.byteLength], [false, false, 3]);
  assert.deepEqual(edit.additionalEdit!.textEdits, [], 'the note itself is changed only by insertText');
});

test('dropped external file keeps its name; an existing name gets " 1"; Markdown links are encoded', async () => {
  const { drop } = setup({ useMarkdownLinks: true });
  fake.files.set(`${ROOT}/My file.pdf`, bytes(1));
  const edit = (await drop.provideDocumentDropEdits(doc(), {}, transfer([{ mime: 'application/pdf', name: 'My file.pdf', uri: '/elsewhere/My file.pdf' }]), token))!;
  assert.equal(edit.additionalEdit!.creates[0].uri.path, `${ROOT}/My file 1.pdf`);
  assert.equal(edit.insertText, '![](My%20file%201.pdf)');
});

test('a file already in the vault is linked, not copied', async () => {
  const { drop } = setup();
  fake.files.set(`${ROOT}/img/a.png`, bytes(1));
  const edit = (await drop.provideDocumentDropEdits(doc(), {}, transfer([{ mime: 'image/png', name: 'a.png', uri: `${ROOT}/img/a.png` }]), token))!;
  assert.equal(edit.insertText, '![[a.png]]');
  assert.deepEqual(edit.additionalEdit!.creates, []);
});

test('several files: one embed per line, distinct names', async () => {
  const { paste } = setup();
  const edits = (await paste.provideDocumentPasteEdits(doc(), [], transfer([{ mime: 'text/plain', name: 'a.txt' }, { mime: 'text/plain', name: 'a.txt' }]), {}, token))!;
  assert.equal(edits[0].insertText, '![[a.txt]]\n![[a 1.txt]]');
  assert.deepEqual(edits[0].additionalEdit!.creates.map((c) => c.uri.path), [`${ROOT}/a.txt`, `${ROOT}/a 1.txt`]);
});

test('nothing outside a vault, when disabled, or when the folder setting leaves the vault', async () => {
  const { paste } = setup({ attachmentFolderPath: '../outside' });
  const files = transfer([{ mime: 'image/png', name: 'x.png' }]);
  assert.equal(await paste.provideDocumentPasteEdits(doc('/other/n.md'), [], files, {}, token), undefined);
  assert.equal(await paste.provideDocumentPasteEdits(doc(), [], files, {}, token), undefined);
  assert.equal(fake.warnings.length, 1);
  const enabled = setup();
  fake.settings.set('notewell.attachments.enabled', false);
  assert.equal(await enabled.paste.provideDocumentPasteEdits(doc(), [], files, {}, token), undefined);
});

test('over 50 MB asks first; declining adds nothing, accepting adds the file', async () => {
  const { paste } = setup();
  const big = transfer([{ mime: 'video/mp4', name: 'clip.mp4', size: 50 * 1024 * 1024 + 1 }]);
  fake.answers.push(undefined);
  assert.equal(await paste.provideDocumentPasteEdits(doc(), [], big, {}, token), undefined);
  assert.equal(fake.warnings.length, 1);
  fake.answers.push('Add');
  const edits = (await paste.provideDocumentPasteEdits(doc(), [], big, {}, token))!;
  assert.equal(edits[0].additionalEdit!.creates.length, 1);
});

/** Providers for a vault at `root`, found the way VaultRegistry finds it on Windows and macOS. */
function setupAt(root: string, settings: Parameters<typeof vaults>[0] = {}) {
  const providers = setup(settings);
  const vault = { root: fake.Uri.file(root), settings: { useMarkdownLinks: false, newLinkFormat: 'shortest', attachmentFolderPath: '/', ...settings } };
  const lookup = { vaultFor: (uri: { path: string }) => (uri.path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? vault : undefined) };
  registerAttachments({ subscriptions: [] } as never, { vaults: () => lookup as never });
  return {
    paste: fake.providers.paste as typeof providers.paste,
    drop: fake.providers.drop as typeof providers.drop,
  };
}

/** A DataTransfer with no file items, only a text/uri-list (as a drop from Windows Explorer can be). */
function uriList(text: string, items: Parameters<typeof transfer>[0] = []) {
  return {
    ...transfer(items),
    get: (mime: string) => (mime === 'text/uri-list' ? { asString: async () => text } : undefined),
  };
}

test('the drive letter case of the note and the vault root may differ', async () => {
  const { paste, drop } = setupAt('/D:/vault', { attachmentFolderPath: './assets' });
  const edits = (await paste.provideDocumentPasteEdits(doc('/d:/vault/notes/today.md'), [], transfer([{ mime: 'image/png', name: 'image.png' }]), {}, token))!;
  assert.ok(edits, 'the attachment edit is offered');
  assert.match(edits[0].insertText, /^!\[\[Pasted image \d{14}\.png\]\]$/);
  assert.match(edits[0].additionalEdit!.creates[0].uri.path, /^\/D:\/vault\/notes\/assets\/Pasted image \d{14}\.png$/);
  fake.files.set('/D:/vault/img/a.png', bytes(1));
  const linked = (await drop.provideDocumentDropEdits(doc('/d:/vault/n.md'), {}, transfer([{ mime: 'image/png', name: 'a.png', uri: '/d:/vault/img/a.png' }]), token))!;
  assert.equal(linked.insertText, '![[a.png]]');
  assert.deepEqual(linked.additionalEdit!.creates, [], 'a vault file is linked, not copied');
});

test('folder name case may differ on case-insensitive file systems', { skip: process.platform === 'linux' }, async () => {
  const { paste } = setupAt('/c:/Work/Vault');
  const edits = await paste.provideDocumentPasteEdits(doc('/C:/work/vault/n.md'), [], transfer([{ mime: 'image/png', name: 'image.png' }]), {}, token);
  assert.ok(edits, 'the attachment edit is offered');
  assert.match(edits![0].additionalEdit!.creates[0].uri.path, /^\/c:\/Work\/Vault\/Pasted image \d{14}\.png$/);
});

test('drop of a text/uri-list only: external files are read and copied, vault files linked', async () => {
  const { drop } = setupAt('/c:/vault');
  fake.files.set('/c:/elsewhere/My doc.pdf', bytes(5));
  fake.files.set('/c:/vault/img/b.png', bytes(1));
  fake.folders.add('/c:/elsewhere/folder');
  fake.reads.length = 0;
  const list = [
    '# comment',
    'file:///c:/elsewhere/My%20doc.pdf',
    '',
    'https://example.com/x.png',
    'file:///c:/elsewhere/folder',
    'file:///c:/elsewhere/missing.png',
    'file:///c:/vault/img/b.png',
  ].join('\r\n');
  const edit = (await drop.provideDocumentDropEdits(doc('/c:/vault/n.md'), {}, uriList(list), token))!;
  assert.equal(edit.insertText, '![[My doc.pdf]]\n![[b.png]]');
  const created = edit.additionalEdit!.creates;
  assert.deepEqual(created.map((c) => [c.uri.path, c.options.contents?.byteLength, c.options.overwrite]), [['/c:/vault/My doc.pdf', 5, false]]);
  assert.deepEqual(fake.reads, ['/c:/elsewhere/My doc.pdf'], 'only the external file is read; nothing else is touched');
});

test('the uri-list is ignored when file items are present, and alone with no usable entry offers nothing', async () => {
  const { drop } = setupAt('/c:/vault');
  fake.files.set('/c:/elsewhere/a.txt', bytes(2));
  fake.reads.length = 0;
  const both = (await drop.provideDocumentDropEdits(doc('/c:/vault/n.md'), {}, uriList('file:///c:/elsewhere/a.txt', [{ mime: 'text/plain', name: 'a.txt', uri: '/c:/elsewhere/a.txt' }]), token))!;
  assert.equal(both.insertText, '![[a.txt]]', 'one embed, not two');
  assert.deepEqual(fake.reads, []);
  assert.equal(await drop.provideDocumentDropEdits(doc('/c:/vault/n.md'), {}, uriList('https://example.com/x.png\r\n# c'), token), undefined);
});

test('case 20: a dropped file named to climb out of the folder lands inside it', async () => {
  const { drop } = setup({ attachmentFolderPath: 'files' });
  const edit = (await drop.provideDocumentDropEdits(doc(), {}, transfer([{ mime: 'image/png', name: '..\\..\\evil.png', uri: '/elsewhere/evil.png' }]), token))!;
  assert.deepEqual(edit.additionalEdit!.creates.map((c) => c.uri.path), [`${ROOT}/files/evil.png`]);
});

test('case 20: a name taken between the check and the write is never overwritten (the create fails instead)', async () => {
  const { paste } = setup();
  const edits = (await paste.provideDocumentPasteEdits(doc(), [], transfer([{ mime: 'text/plain', name: 'a.txt' }]), {}, token))!;
  const [create] = edits[0].additionalEdit!.creates;
  assert.deepEqual([create.options.overwrite, create.options.ignoreIfExists], [false, false]);
});

test('case 20: an attachment folder that is (or is inside) a symbolic link is refused', async () => {
  const { paste } = setup({ attachmentFolderPath: 'linked/img' });
  fake.folders.add(`${ROOT}/linked`);
  fake.symlinks.add(`${ROOT}/linked`);
  assert.equal(await paste.provideDocumentPasteEdits(doc(), [], transfer([{ mime: 'image/png', name: 'x.png' }]), {}, token), undefined);
  assert.equal(fake.warnings.length, 1);
});

test('case 20: a large file from disk is not read before the size question is answered', async () => {
  const { drop } = setup();
  fake.files.set('/elsewhere/big.mp4', bytes(4));
  fake.sizes.set('/elsewhere/big.mp4', 60 * 1024 * 1024);
  let read = 0;
  const items = {
    forEach(callback: (item: { asFile(): unknown }, mime: string) => void) {
      callback({ asFile: () => ({ name: 'big.mp4', uri: fake.Uri.file('/elsewhere/big.mp4'), data: async () => (read++, bytes(4)) }) }, 'video/mp4');
    },
  };
  fake.answers.push(undefined);
  assert.equal(await drop.provideDocumentDropEdits(doc(), {}, items, token), undefined);
  assert.equal(read, 0, 'declined before reading');
});

test('round 6: a file system that reports every name as taken does not hang the paste', async () => {
  const { paste } = setup();
  const stat = fake.workspace.fs.stat;
  fake.workspace.fs.stat = async () => ({ type: fake.FileType.File, size: 1 });
  const started = performance.now();
  try {
    const result = await paste.provideDocumentPasteEdits(doc(), [], transfer([{ mime: 'text/plain', name: 'a.txt' }]), {}, token);
    assert.equal(result, undefined);
  } finally {
    fake.workspace.fs.stat = stat;
  }
  assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
  assert.equal(fake.warnings.length, 1, 'the user is told');
});

test('round 6: a paste cancelled while files are being read creates nothing', async () => {
  const { paste } = setup();
  const cancel = { isCancellationRequested: false };
  let reads = 0;
  const items = {
    forEach(callback: (item: { asFile(): unknown }, mime: string) => void) {
      for (const name of ['a.bin', 'b.bin', 'c.bin']) {
        callback({ asFile: () => ({ name, uri: undefined, data: async () => { reads++; if (reads === 2) cancel.isCancellationRequested = true; return bytes(3); } }) }, 'application/octet-stream');
      }
    },
  };
  assert.equal(await paste.provideDocumentPasteEdits(doc(), [], items, {}, cancel), undefined);
  assert.ok(reads <= 2, 'stops reading after the cancel');
});
