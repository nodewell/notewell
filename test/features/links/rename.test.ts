// What a VS Code rename does to links (links.md 3): modes, confirmation, trust, moves out of
// the vault, vault grouping, unchanged-link notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkIndex } from '../../../src/vault/link-index.ts';
import { planFileRenames, type RenamePorts, type UpdateMode } from '../../../src/features/links/rename.ts';

const VAULT = '/ws/vault';
const files: Record<string, string> = { 'Note.md': '', 'Home.md': '[[Note]] [n](Note.md)', 'x/Leaf.md': '', 'y/Leaf.md': '', 'Other.md': '[[Leaf]]' };
const index = LinkIndex.build(Object.keys(files), (p) => files[p]);

function ports(overrides: Partial<RenamePorts> & { asked?: number[][] } = {}): RenamePorts & { asked: number[][] } {
  const asked: number[][] = [];
  return {
    vaultOf: (path) => (path.startsWith(`${VAULT}/`) ? VAULT : undefined),
    indexFor: () => index,
    mode: () => 'obsidian' as UpdateMode,
    trusted: () => true,
    confirm: async (links, filesCount) => {
      asked.push([links, filesCount]);
      return true;
    },
    readText: async (path) => files[path.slice(VAULT.length + 1)],
    reindex: () => undefined,
    ...overrides,
    asked,
  };
}

const rename = [{ oldPath: `${VAULT}/Note.md`, newPath: `${VAULT}/notes/Renamed.md` }];

test('obsidian mode: no question of ours (VS Code confirms the edits); edits carry absolute file paths', async () => {
  const p = ports();
  const outcome = await planFileRenames(rename, p);
  assert.deepEqual(p.asked, [], "one question only: VS Code's own confirmation of participant edits (links.md 3.3)");
  assert.deepEqual(outcome.edits.map((e) => [e.path, e.newText]), [[`${VAULT}/Home.md`, 'Renamed'], [`${VAULT}/Home.md`, 'notes/Renamed.md']]);
  assert.deepEqual(outcome.files, [{ path: `${VAULT}/Home.md`, newPath: `${VAULT}/Home.md` }]);
});

test('modes: always and obsidian update, prompt asks, never leaves links alone', async () => {
  let p = ports({ mode: () => 'always' });
  assert.equal((await planFileRenames(rename, p)).edits.length, 2);
  assert.deepEqual(p.asked, []);
  p = ports({ mode: () => 'prompt' });
  assert.equal((await planFileRenames(rename, p)).edits.length, 2);
  assert.deepEqual(p.asked, [[2, 1]]);
  p = ports({ mode: () => 'never' });
  assert.deepEqual((await planFileRenames(rename, p)).edits, []);
  assert.deepEqual(p.asked, []);
});

test('declining the question leaves links alone (the rename still happens)', async () => {
  const outcome = await planFileRenames(rename, ports({ mode: () => 'prompt', confirm: async () => false }));
  assert.deepEqual(outcome.edits, []);
});

test('untrusted workspace: no edits, a notice (and no question)', async () => {
  const p = ports({ trusted: () => false, mode: () => 'always' });
  const outcome = await planFileRenames(rename, p);
  assert.deepEqual(outcome.edits, []);
  assert.deepEqual(outcome.notices, [{ kind: 'untrusted' }]);
  assert.deepEqual(p.asked, []);
});

test('moving out of the vault warns with the number of links that will break; nothing changes', async () => {
  const outcome = await planFileRenames([{ oldPath: `${VAULT}/Note.md`, newPath: '/ws/elsewhere/Note.md' }], ports({ mode: () => 'always' }));
  assert.deepEqual(outcome.edits, []);
  assert.deepEqual(outcome.notices, [{ kind: 'leftVault', links: 2 }]);
});

test('files outside any vault are ignored; an index still being built is reported', async () => {
  assert.deepEqual(await planFileRenames([{ oldPath: '/ws/out/a.md', newPath: '/ws/out/b.md' }], ports()), { edits: [], files: [], notices: [] });
  const outcome = await planFileRenames(rename, ports({ indexFor: () => undefined }));
  assert.deepEqual(outcome.notices, [{ kind: 'notReady' }]);
});

test('links left unchanged (ambiguous) are counted in a notice', async () => {
  const outcome = await planFileRenames([{ oldPath: `${VAULT}/x/Leaf.md`, newPath: `${VAULT}/x/Branch.md` }], ports({ mode: () => 'always' }));
  assert.deepEqual(outcome.edits, []);
  assert.deepEqual(outcome.notices, [{ kind: 'unchanged', links: 1 }]);
});
