import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVaultIndex, normalizePath, relativePath, samePath, vaultRootsFromObsidianPaths } from '../../src/vault/paths.ts';

test('normalizePath unifies separators and resolves dot segments', () => {
  assert.equal(normalizePath('C:\\Work\\vault\\note.md'), 'C:/Work/vault/note.md');
  assert.equal(normalizePath('/c:/Work//vault/./sub/../note.md'), '/c:/Work/vault/note.md');
  assert.equal(normalizePath('/work/vault/'), '/work/vault');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('/../x'), '/x');
});

test('vault roots come from .obsidian folders and files directly inside them', () => {
  assert.deepEqual(
    vaultRootsFromObsidianPaths([
      '/ws/.obsidian/app.json',
      '/ws/.obsidian/workspace.json',
      '/ws/notes/sub-vault/.obsidian',
      '/ws/.obsidian/plugins/x/data.json',
      '/ws/notes/not-a-vault.md',
      'D:\\other\\.obsidian\\app.json',
      '/.obsidian/app.json',
    ]),
    ['/ws', '/ws/notes/sub-vault', 'D:/other', '/'],
  );
});

const posix = { caseInsensitive: false };
const windows = { caseInsensitive: true };

test('workspace root as the vault', () => {
  const index = createVaultIndex(['/ws'], posix);
  assert.equal(index.vaultOf('/ws/note.md'), '/ws');
  assert.equal(index.vaultOf('/ws/a/b/c.md'), '/ws');
  assert.equal(index.vaultOf('/ws'), '/ws');
});

test('vault in a subfolder; files outside it have no vault', () => {
  const index = createVaultIndex(['/ws/notes'], posix);
  assert.equal(index.vaultOf('/ws/notes/todo.md'), '/ws/notes');
  assert.equal(index.vaultOf('/ws/README.md'), undefined);
  assert.equal(index.vaultOf('/ws/notes-old/x.md'), undefined, 'segment-aware prefix');
  assert.equal(index.vaultOf('/ws'), undefined);
});

test('multiple and nested vaults resolve to the closest ancestor', () => {
  const index = createVaultIndex(['/ws', '/ws/a/inner', '/other/v'], posix);
  assert.equal(index.vaultOf('/ws/a/inner/x/y.md'), '/ws/a/inner');
  assert.equal(index.vaultOf('/ws/a/x.md'), '/ws');
  assert.equal(index.vaultOf('/other/v/z.md'), '/other/v');
  assert.equal(index.vaultOf('/other/z.md'), undefined);
});

test('root "/" contains every absolute path', () => {
  const index = createVaultIndex(['/'], posix);
  assert.equal(index.vaultOf('/any/where.md'), '/');
});

test('Windows: case and separator differences do not matter, original case is returned', () => {
  const index = createVaultIndex(['/c:/Work/Vault'], windows);
  assert.equal(index.vaultOf('/C:/work/vault/Note.md'), '/c:/Work/Vault');
  assert.equal(index.vaultOf('c:\\Work\\Vault\\Note.md'), undefined, 'fsPath form is not a URI path');
  const fsIndex = createVaultIndex(['C:\\Work\\Vault'], windows);
  assert.equal(fsIndex.vaultOf('c:/WORK/vault/sub/n.md'), 'C:/Work/Vault');
  assert.equal(fsIndex.vaultOf('c:\\work\\VAULT\\n.md'), 'C:/Work/Vault');
});

test('case-sensitive file systems keep case distinct', () => {
  const index = createVaultIndex(['/ws/Vault'], posix);
  assert.equal(index.vaultOf('/ws/vault/n.md'), undefined);
});

test('duplicate roots differing only by case collapse on case-insensitive systems', () => {
  assert.deepEqual(createVaultIndex(['/c:/V', '/C:/v'], windows).roots, ['/c:/V']);
  assert.deepEqual(createVaultIndex(['/c:/V', '/C:/v'], posix).roots.length, 2);
});

test('relativePath: drive letter case, folder case and separators as the file system compares them', () => {
  // VS Code may give the root as '/D:/...' and the document as '/d:/...' (or the reverse).
  assert.equal(relativePath('/D:/Work/My Vault', '/d:/Work/My Vault/notes/Today.md', windows), 'notes/Today.md');
  assert.equal(relativePath('/d:/Work/My Vault', '/D:/WORK/my vault/notes/Today.md', windows), 'notes/Today.md', 'case kept from the path');
  assert.equal(relativePath('D:\\Work\\My Vault\\', 'd:/Work/My Vault/a/b.png', windows), 'a/b.png');
  assert.equal(relativePath('/d:/Work/My Vault', String.raw`D:\Work\My Vault\a\b.png`, windows), undefined, 'a URI path and an fsPath do not mix');
  // Drive letters ignore case even where the rest does not; folders do not.
  assert.equal(relativePath('/D:/ws/Vault', '/d:/ws/Vault/n.md', posix), 'n.md');
  assert.equal(relativePath('/ws/Vault', '/ws/vault/n.md', posix), undefined);
});

test('relativePath: strictly inside only; sibling prefixes and the root itself are outside', () => {
  assert.equal(relativePath('/c:/v', '/c:/v', windows), undefined);
  assert.equal(relativePath('/c:/v', '/c:/v/', windows), undefined);
  assert.equal(relativePath('/c:/v', '/c:/v2/n.md', windows), undefined);
  assert.equal(relativePath('/c:/v', '/c:/n.md', windows), undefined);
  assert.equal(relativePath('/c:/v', '/c:/v/a/../../n.md', windows), undefined);
  assert.equal(relativePath('/', '/x/y.md', posix), 'x/y.md');
  assert.equal(relativePath('/v', '/v//a/./b.md', posix), 'a/b.md');
});

test('samePath follows the same rule', () => {
  assert.ok(samePath('/D:/v/Note.md', '/d:/V/note.md', windows));
  assert.ok(samePath('/D:/v/Note.md', '/d:/v/Note.md', posix));
  assert.ok(!samePath('/D:/v/Note.md', '/d:/v/note.md', posix));
});

test('vaultOf ignores drive letter case on case-sensitive systems too', () => {
  assert.equal(createVaultIndex(['/D:/ws/Vault'], posix).vaultOf('/d:/ws/Vault/n.md'), '/D:/ws/Vault');
});
