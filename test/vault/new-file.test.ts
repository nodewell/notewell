// New note paths and the checks before creating one (daily-notes.md 4.3, 6, 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE_VSCODE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context)) });

const fake = await import('./fake-vscode.ts');
const { vaultPath, newNotePath } = await import('../../src/vault/new-file.ts');
const { checkNewFile } = await import('../../src/vault/new-file-check.ts');
const { DEFAULT_APP_SETTINGS } = await import('../../src/vault/settings.ts');

test('vault paths: normalized, never outside the vault, into hidden folders or with refused names', () => {
  assert.equal(vaultPath('Daily/2026-10-21.md'), 'Daily/2026-10-21.md');
  assert.equal(vaultPath('/Daily//./x.md'), 'Daily/x.md');
  assert.equal(vaultPath('a/../b.md'), 'b.md');
  assert.equal(vaultPath(''), '');
  for (const bad of ['../x.md', 'a/../../x.md', '.obsidian/x.md', 'a/.trash/x.md', 'a:b.md', 'C:/x.md', 'a\\b.md', 'q?.md', 'a*.md', '"x".md', 'a<b.md', 'a|b.md', 'tab\there.md', 'dot./x.md', 'space /x.md', 'CON.md', 'a/nul', 'Com1.md', 'LPT9.txt']) {
    assert.equal(vaultPath(bad), undefined, bad);
  }
});

test('new note from a link: three locations for a bare name, a folder in the link from the vault root', () => {
  const at = (newFileLocation: 'root' | 'current' | 'folder', newFileFolderPath = '') => ({ ...DEFAULT_APP_SETTINGS, newFileLocation, newFileFolderPath });
  const from = 'Projects/A/note.md';
  // Bare name: root, current folder, set folder.
  assert.equal(newNotePath(at('root'), from, 'Idea'), 'Idea.md');
  assert.equal(newNotePath(at('current'), from, 'Idea'), 'Projects/A/Idea.md');
  assert.equal(newNotePath(at('folder', 'Inbox/New/'), from, 'Idea'), 'Inbox/New/Idea.md');
  assert.equal(newNotePath(at('current'), 'root.md', 'Idea'), 'Idea.md');
  // With a folder: that folder from the vault root whatever the setting.
  for (const setting of [at('root'), at('current'), at('folder', 'Inbox')]) {
    assert.equal(newNotePath(setting, from, 'Areas/Idea'), 'Areas/Idea.md');
    assert.equal(newNotePath(setting, from, '/Areas/Idea'), 'Areas/Idea.md');
  }
  // Relative paths from the linking note; .md kept once.
  assert.equal(newNotePath(at('root'), from, './Sub/Idea'), 'Projects/A/Sub/Idea.md');
  assert.equal(newNotePath(at('root'), from, '../Idea.md'), 'Projects/Idea.md');
  assert.equal(newNotePath(at('root'), from, 'Idea.MD'), 'Idea.MD');
});

test('new note from a link: nothing for attachments, refused names and paths leaving the vault', () => {
  const s = DEFAULT_APP_SETTINGS;
  for (const link of ['photo.png', 'doc.pdf', 'board.canvas', '', '  ', '../../../x', 'a:b', '.obsidian/x', 'Q?']) {
    assert.equal(newNotePath(s, 'n.md', link), undefined, link);
  }
  assert.equal(newNotePath({ ...s, newFileLocation: 'folder', newFileFolderPath: '../out' }, 'n.md', 'x'), undefined);
  assert.equal(newNotePath(s, 'n.md', 'Meeting 2026.10'), 'Meeting 2026.10.md');
});

test('checks before creating: exists, missing folders outermost first, links and files on the way refused', async () => {
  const entries: Record<string, number> = { '/v/Daily': 2, '/v/Daily/2026-10-21.md': 1, '/v/link': 2 | 64, '/v/file.md': 1 };
  const stat = async (uri: { path: string }) => {
    const type = entries[uri.path];
    if (type === undefined) throw new Error('FileNotFound');
    return { type, ctime: 0, mtime: 0, size: 0 };
  };
  const root = fake.Uri.file('/v') as never;
  assert.deepEqual(await checkNewFile(root, 'Daily/2026-10-21.md', stat as never), { kind: 'exists' });
  assert.deepEqual(await checkNewFile(root, 'Daily/2026-10-22.md', stat as never), { kind: 'ready', missingFolders: [] });
  assert.deepEqual(await checkNewFile(root, 'Daily/2026/10/22.md', stat as never), { kind: 'ready', missingFolders: ['Daily/2026', 'Daily/2026/10'] });
  assert.deepEqual(await checkNewFile(root, 'New/x.md', stat as never), { kind: 'ready', missingFolders: ['New'] });
  assert.deepEqual(await checkNewFile(root, 'top.md', stat as never), { kind: 'ready', missingFolders: [] });
  assert.deepEqual(await checkNewFile(root, 'link/x.md', stat as never), { kind: 'refused' });
  assert.deepEqual(await checkNewFile(root, 'file.md/x.md', stat as never), { kind: 'refused' });
});
