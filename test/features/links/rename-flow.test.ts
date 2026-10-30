// Link updates over repeated renames, end to end against a fake vscode: the link store indexes
// the vault, planFileRenames plans the edits, the edits are applied as VS Code applies a
// rename participant's WorkspaceEdit (closed files open in the background, unsaved), then the
// files move. The index must follow each step so the next move finds the links again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE = new URL('../../vault/fake-vscode-links.ts', import.meta.url).href;
registerHooks({ resolve: (s, c, n) => (s === 'vscode' ? { url: FAKE, shortCircuit: true } : n(s, c)) });

const fake = await import('../../vault/fake-vscode-links.ts');
const { LinkStore } = await import('../../../src/vault/link-store.ts');
const { planFileRenames } = await import('../../../src/features/links/rename.ts');

type Delivery = import('../../vault/fake-vscode-links.ts').EditDelivery;

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const V = '/vault';
const DELIVERIES: Delivery[] = ['openedEdited', 'openedThenChanged'];

const VAULT: Record<string, string> = {
  '대상.md': '# 대상 노트\n',
  '링크1.md': '[[대상]]\n[[대상|다른 이름]]\n[[대상#대상 노트]]\n[보기](대상.md)\n',
  '폴더/링크2.md': '[위로](../대상.md)\n',
};

async function setup(files: Record<string, string> = VAULT) {
  fake.files.clear();
  fake.textDocuments.length = 0;
  for (const [path, text] of Object.entries(files)) fake.files.set(`${V}/${path}`, text);
  const store = new LinkStore({ roots: () => [fake.Uri.file(V)] as never, onDidChangeRoots: new fake.EventEmitter<void>().event });
  await store.ready();
  const index = () => store.indexFor(fake.Uri.file(`${V}/_`) as never)!.index;
  /** A rename from the Explorer, as VS Code runs it with our participant. */
  const move = async (from: string, to: string, delivery: Delivery): Promise<number[][]> => {
    const asked: number[][] = [];
    const outcome = await planFileRenames([{ oldPath: `${V}/${from}`, newPath: `${V}/${to}` }], {
      vaultOf: (path) => (path.startsWith(`${V}/`) ? V : undefined),
      indexFor: () => index(),
      mode: () => 'prompt',
      trusted: () => true,
      confirm: async (links, count) => {
        asked.push([links, count]);
        return true;
      },
      readText: async (path) => fake.textDocuments.find((d) => d.uri.path === path)?.text ?? fake.files.get(path),
      reindex: (paths) => {
        for (const path of paths) store.refresh(fake.Uri.file(path) as never);
      },
    });
    fake.applyEdit(outcome.edits, delivery);
    await settle();
    fake.rename(`${V}/${from}`, `${V}/${to}`);
    await settle();
    return asked;
  };
  /** The text VS Code shows: the open document, else the disk. */
  const text = (path: string): string => fake.textDocuments.find((d) => d.uri.path === `${V}/${path}`)?.text ?? fake.files.get(`${V}/${path}`)!;
  const sources = (path: string): string[] => [...new Set(index().incoming(path).map((l) => l.source))].sort();
  return { store, index, move, text, sources };
}

for (const delivery of DELIVERIES) {
  test(`move into a folder and back out, then again (edits ${delivery}, left unsaved)`, async () => {
    const { store, move, text, sources } = await setup();
    // Wikilinks by name still fit and stay. The Markdown links follow note-relative: `대상.md`
    // next to 링크1.md becomes `폴더/대상.md`, `../대상.md` stays relative as `./대상.md` (2.4 #2).
    assert.deepEqual(await move('대상.md', '폴더/대상.md', delivery), [[2, 2]]);
    assert.equal(text('링크1.md'), VAULT['링크1.md']!.replace('](대상.md)', '](폴더/대상.md)'));
    assert.equal(text('폴더/링크2.md'), '[위로](./대상.md)\n');
    assert.deepEqual(sources('폴더/대상.md'), ['링크1.md', '폴더/링크2.md'], 'the unsaved link edits are indexed');

    assert.deepEqual(await move('폴더/대상.md', '대상.md', delivery), [[2, 2]], 'moving back asks again');
    assert.equal(text('링크1.md'), VAULT['링크1.md']);
    assert.equal(text('폴더/링크2.md'), VAULT['폴더/링크2.md']);
    assert.deepEqual(sources('대상.md'), ['링크1.md', '폴더/링크2.md']);

    assert.deepEqual(await move('대상.md', '폴더/대상.md', delivery), [[2, 2]], 'and a third time');
    assert.equal(text('폴더/링크2.md'), '[위로](./대상.md)\n');
    store.dispose();
  });
}

test('saved between moves: the saved text is indexed', async () => {
  const { store, move, text, sources } = await setup();
  await move('대상.md', '폴더/대상.md', 'openedEdited');
  fake.saveDocument(`${V}/폴더/링크2.md`);
  await settle();
  assert.deepEqual(sources('폴더/대상.md'), ['링크1.md', '폴더/링크2.md']);
  assert.deepEqual(await move('폴더/대상.md', '대상.md', 'openedEdited'), [[2, 2]]);
  assert.equal(text('폴더/링크2.md'), VAULT['폴더/링크2.md']);
  store.dispose();
});

test('linking files already open in editors', async () => {
  const { store, move, text } = await setup();
  fake.openDocumentWithEvent(`${V}/링크1.md`, VAULT['링크1.md']!);
  fake.openDocumentWithEvent(`${V}/폴더/링크2.md`, VAULT['폴더/링크2.md']!);
  await move('대상.md', '폴더/대상.md', 'openedEdited');
  assert.deepEqual(await move('폴더/대상.md', '대상.md', 'openedEdited'), [[2, 2]]);
  assert.equal(text('링크1.md'), VAULT['링크1.md']);
  assert.equal(text('폴더/링크2.md'), VAULT['폴더/링크2.md']);
  store.dispose();
});

test('undo back to the saved text is indexed although the document is clean again', async () => {
  const { store, move, sources } = await setup();
  await move('대상.md', '폴더/대상.md', 'openedThenChanged');
  fake.undoToSaved(`${V}/폴더/링크2.md`);
  await settle();
  assert.deepEqual(sources('폴더/대상.md'), ['링크1.md'], '`../대상.md` from the folder no longer names the moved file');
  store.dispose();
});

test('a moved note with relative links of its own, moved out and back in', async () => {
  const { store, move, text, sources } = await setup();
  for (const delivery of DELIVERIES) {
    await move('폴더/링크2.md', '링크2.md', delivery);
    assert.equal(text('링크2.md'), '[위로](./대상.md)\n', 'its own relative link follows the move');
    assert.deepEqual(sources('대상.md'), ['링크1.md', '링크2.md']);
    await move('링크2.md', '폴더/링크2.md', delivery);
    assert.equal(text('폴더/링크2.md'), VAULT['폴더/링크2.md']);
    assert.deepEqual(sources('대상.md'), ['링크1.md', '폴더/링크2.md']);
  }
  store.dispose();
});

test('folder renames, repeated', async () => {
  const { store, move, text, sources } = await setup({ '폴더/대상.md': '', '링크1.md': '[[대상]]\n[보기](폴더/대상.md)\n' });
  for (const [from, to] of [['폴더', '다른'], ['다른', '폴더'], ['폴더', '다른']] as const) {
    await move(from, to, 'openedEdited');
    assert.deepEqual(sources(`${to}/대상.md`), ['링크1.md'], `${from} -> ${to}`);
    assert.match(text('링크1.md'), new RegExp(`\\[보기\\]\\(${to}/대상\\.md\\)`));
  }
  store.dispose();
});

test('the watcher reporting the move before the rename event does not lose the file', async () => {
  const { store, index, sources } = await setup();
  fake.files.set(`${V}/폴더/대상.md`, fake.files.get(`${V}/대상.md`)!);
  fake.files.delete(`${V}/대상.md`);
  fake.fireWatcher('delete', `${V}/대상.md`);
  await settle();
  fake.renameEvents.fire({ files: [{ oldUri: fake.Uri.file(`${V}/대상.md`), newUri: fake.Uri.file(`${V}/폴더/대상.md`) }] });
  await settle();
  assert.ok(index().has('폴더/대상.md'));
  assert.deepEqual(sources('폴더/대상.md'), ['링크1.md'], '`[[대상]]` and `대상.md` find it by name; `../대상.md` is broken');
  store.dispose();
});

test('a folder deleted alone (reported without its files) drops the files under it', async () => {
  const { store, index } = await setup();
  for (const path of [...fake.files.keys()]) if (path.startsWith(`${V}/폴더/`)) fake.files.delete(path);
  fake.fireWatcher('delete', `${V}/폴더`);
  await settle();
  assert.equal(index().has('폴더/링크2.md'), false);
  store.dispose();
});

test('case 12: an open document with unsaved text is edited on top of that text and never saved', async () => {
  const { store, move, text, sources } = await setup();
  const doc = fake.openDocumentWithEvent(`${V}/폴더/링크2.md`, VAULT['폴더/링크2.md']!);
  fake.editDocument(doc, 'typed, unsaved\n[위로](../대상.md)\n');
  await settle();
  assert.deepEqual(await move('대상.md', '폴더/대상.md', 'openedEdited'), [[2, 2]]);
  assert.equal(text('폴더/링크2.md'), 'typed, unsaved\n[위로](./대상.md)\n', 'the edit lands on the unsaved line');
  assert.equal(fake.files.get(`${V}/폴더/링크2.md`), VAULT['폴더/링크2.md'], 'nothing written to disk');
  assert.deepEqual(sources('폴더/대상.md'), ['링크1.md', '폴더/링크2.md']);
  store.dispose();
});

test('case 13: undo and redo of a rename keep the index right; renaming again still works', async () => {
  const { store, move, text, sources } = await setup();
  await move('대상.md', '폴더/대상.md', 'openedThenChanged');
  const updated = text('폴더/링크2.md');
  // Undo: the link edit is reverted (document clean again), then the file moves back.
  fake.undoToSaved(`${V}/폴더/링크2.md`);
  fake.rename(`${V}/폴더/대상.md`, `${V}/대상.md`);
  await settle();
  assert.equal(text('폴더/링크2.md'), VAULT['폴더/링크2.md']);
  assert.deepEqual(sources('대상.md'), ['링크1.md', '폴더/링크2.md']);
  // Redo: the edit comes back, the file moves again.
  fake.editDocument(fake.textDocuments.find((d) => d.uri.path === `${V}/폴더/링크2.md`)!, updated);
  fake.rename(`${V}/대상.md`, `${V}/폴더/대상.md`);
  await settle();
  assert.deepEqual(sources('폴더/대상.md'), ['링크1.md', '폴더/링크2.md']);
  assert.deepEqual(await move('폴더/대상.md', '대상.md', 'openedEdited'), [[2, 2]]);
  assert.equal(text('폴더/링크2.md'), VAULT['폴더/링크2.md']);
  store.dispose();
});

test('case 19: a rename while the index is still being built is applied once it is built', async () => {
  fake.files.clear();
  fake.textDocuments.length = 0;
  for (const [path, text] of Object.entries(VAULT)) fake.files.set(`${V}/${path}`, text);
  const store = new LinkStore({ roots: () => [fake.Uri.file(V)] as never, onDidChangeRoots: new fake.EventEmitter<void>().event });
  fake.rename(`${V}/대상.md`, `${V}/폴더/대상.md`);
  await store.ready();
  await settle();
  const index = store.indexFor(fake.Uri.file(`${V}/_`) as never)!.index;
  assert.ok(index.has('폴더/대상.md'));
  assert.equal(index.has('대상.md'), false);
  store.dispose();
});

test('case 1 (store): a file found stale is read again', async () => {
  const { store, move, text, sources } = await setup();
  fake.files.set(`${V}/폴더/링크2.md`, 'changed behind our back\n[위로](../대상.md)\n'); // no watcher event
  assert.deepEqual(await move('대상.md', '폴더/대상.md', 'openedEdited'), [[1, 1]], 'only 링크1.md is offered: 링크2.md is stale');
  assert.equal(text('폴더/링크2.md'), 'changed behind our back\n[위로](../대상.md)\n');
  await settle();
  assert.deepEqual(store.indexFor(fake.Uri.file(`${V}/_`) as never)!.index.outgoing('폴더/링크2.md').map((o) => o.link.line), [1], 'indexed again');
  store.dispose();
});

const ATTACHED: Record<string, string> = {
  'image.png': 'PNG',
  'attachments/Pasted image 1.png': 'PNG',
  'attachments/a b.pdf': 'PDF',
  '링크1.md': '![alt text](image.png)\n![[Pasted image 1.png]]\n[x](attachments/a%20b.pdf)\n![](./image.png)\n![[attachments/Pasted image 1.png]]\n',
};

test('attachments: moves and folder renames of images and PDFs update the links that would break', async () => {
  const { store, move, text, sources } = await setup(ATTACHED);
  // The wikilink `[[Pasted image 1.png]]` stays shortest. Markdown paths that matched next to the
  // note follow note-relative (2.4 #2): `image.png` -> `폴더/image.png`, `./image.png` -> `./폴더/image.png`.
  assert.deepEqual(await move('image.png', '폴더/image.png', 'openedEdited'), [[2, 1]]);
  assert.equal(text('링크1.md'), ATTACHED['링크1.md']!.replace('](image.png)', '](폴더/image.png)').replace('](./image.png)', '](./폴더/image.png)'));
  assert.deepEqual(sources('폴더/image.png'), ['링크1.md'], 'the index follows a non-Markdown rename');
  assert.deepEqual(await move('attachments', 'img', 'openedEdited'), [[2, 1]], 'folder rename: the vault paths follow');
  assert.match(text('링크1.md'), /\[x\]\(img\/a%20b\.pdf\)/);
  assert.match(text('링크1.md'), /!\[\[img\/Pasted image 1\.png\]\]/);
  assert.deepEqual(await move('img/a b.pdf', 'docs/a b.pdf', 'openedEdited'), [[1, 1]]);
  assert.match(text('링크1.md'), /\[x\]\(docs\/a%20b\.pdf\)/, 'encoded as it was');
  const index = store.indexFor(fake.Uri.file(`${V}/_`) as never)!.index;
  assert.deepEqual(
    index.outgoing('링크1.md').map((o) => (o.resolution.kind === 'found' ? o.resolution.path : o.resolution.kind)),
    ['폴더/image.png', 'img/Pasted image 1.png', 'docs/a b.pdf', '폴더/image.png', 'img/Pasted image 1.png'],
    'every link still names its file',
  );
  store.dispose();
});

test('attachments: a vault-path embed follows a move next to a same-named file', async () => {
  const { store, move, text } = await setup({ ...ATTACHED, '폴더/image.png': 'other' });
  await move('attachments/Pasted image 1.png', '폴더/Pasted image 1.png', 'openedEdited');
  assert.equal(text('링크1.md').split('\n')[4], '![[폴더/Pasted image 1.png]]');
  store.dispose();
});
