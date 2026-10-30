// The link index adapter against a fake vscode: background build, watcher and rename updates,
// unsaved editor text, vaults appearing and going.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE = new URL('./fake-vscode-links.ts', import.meta.url).href;
registerHooks({ resolve: (s, c, n) => (s === 'vscode' ? { url: FAKE, shortCircuit: true } : n(s, c)) });

const fake = await import('./fake-vscode-links.ts');
const { LinkStore } = await import('../../src/vault/link-store.ts');
const { LinkIndex } = await import('../../src/vault/link-index.ts');

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const V = '/vault';

function setup(files: Record<string, string>) {
  fake.files.clear();
  fake.textDocuments.length = 0;
  for (const [path, text] of Object.entries(files)) fake.files.set(`${V}/${path}`, text);
  const rootsChanged = new fake.EventEmitter<void>();
  let roots = [fake.Uri.file(V)];
  const store = new LinkStore({ roots: () => roots as never, onDidChangeRoots: rootsChanged.event });
  const backlinks = (path: string) => {
    const incoming = store.indexFor(fake.Uri.file(`${V}/${path}`) as never)?.index.incoming(path) ?? [];
    return [...new Set(incoming.map((l) => l.source))].sort();
  };
  return { store, backlinks, setRoots: (r: string[]) => { roots = r.map((p) => fake.Uri.file(p)); rootsChanged.fire(); } };
}

test('builds in the background (not during construction) and indexes the vault', async () => {
  const { store, backlinks } = setup({ 'a.md': '[[b]]', 'b.md': '[[a]] ![[pic.png]]', 'pic.png': '' });
  assert.equal(store.indexFor(fake.Uri.file(`${V}/a.md`) as never), undefined, 'nothing is built synchronously');
  await store.ready();
  assert.deepEqual(backlinks('b.md'), ['a.md']);
  assert.deepEqual(backlinks('pic.png'), ['b.md']);
  assert.equal(store.relativePath(fake.Uri.file(`${V}/x/y.md`) as never), 'x/y.md');
  assert.equal(store.relativePath(fake.Uri.file('/elsewhere/y.md') as never), undefined);
  store.dispose();
});

test('watcher events: change, create and delete update the index', async () => {
  const { store, backlinks } = setup({ 'a.md': '[[b]]', 'c.md': '' });
  await store.ready();
  assert.deepEqual(backlinks('b.md'), []);
  fake.files.set(`${V}/b.md`, '');
  fake.fireWatcher('create', `${V}/b.md`);
  await settle();
  assert.deepEqual(backlinks('b.md'), ['a.md'], 'a created file resolves waiting links');
  fake.files.set(`${V}/c.md`, '[[b]]');
  fake.fireWatcher('change', `${V}/c.md`);
  await settle();
  assert.deepEqual(backlinks('b.md'), ['a.md', 'c.md']);
  fake.files.delete(`${V}/a.md`);
  fake.fireWatcher('delete', `${V}/a.md`);
  await settle();
  assert.deepEqual(backlinks('b.md'), ['c.md']);
  store.dispose();
});

test('renames of files and folders move their entries', async () => {
  const { store, backlinks } = setup({ 'a.md': '[[Note]] [m](sub/Note.md)', 'sub/Note.md': '[[a]]' });
  await store.ready();
  assert.deepEqual(backlinks('sub/Note.md'), ['a.md']);
  fake.rename(`${V}/sub`, `${V}/moved`);
  await settle();
  const index = store.indexFor(fake.Uri.file(`${V}/a.md`) as never)!.index;
  assert.deepEqual(index.outgoing('a.md').map((o) => (o.resolution.kind === 'found' ? o.resolution.path : o.resolution.kind)), ['moved/Note.md', 'missing'], 'by name it still resolves; the Markdown path is now broken');
  assert.deepEqual(index.outgoing('moved/Note.md').map((o) => o.link.rawPath), ['a'], 'the moved file kept its links');
  store.dispose();
});

test('unsaved editor text is indexed; closing the editor reads the disk again', async () => {
  const { store, backlinks } = setup({ 'a.md': '', 'b.md': '' });
  await store.ready();
  const doc = fake.openDocument(`${V}/a.md`, '');
  fake.editDocument(doc, 'typing [[b]]');
  await settle();
  assert.deepEqual(backlinks('b.md'), ['a.md']);
  fake.closeDocument(doc);
  await settle();
  assert.deepEqual(backlinks('b.md'), []);
  store.dispose();
});

test('events during the build are applied after it; vaults that go are dropped', async () => {
  const { store, backlinks, setRoots } = setup({ 'a.md': '[[b]]' });
  fake.files.set(`${V}/b.md`, '');
  fake.fireWatcher('create', `${V}/b.md`);
  await store.ready();
  await settle();
  assert.deepEqual(backlinks('b.md'), ['a.md']);
  setRoots([]);
  assert.equal(store.indexFor(fake.Uri.file(`${V}/a.md`) as never), undefined);
  store.dispose();
});

test('a note whose drive letter case differs from the vault root still finds its vault', async () => {
  fake.files.clear();
  fake.textDocuments.length = 0;
  fake.files.set('/D:/v/a.md', '[[b]]');
  fake.files.set('/D:/v/b.md', '');
  const store = new LinkStore({ roots: () => [fake.Uri.file('/D:/v')] as never, onDidChangeRoots: new fake.EventEmitter<void>().event });
  await store.ready();
  assert.equal(store.relativePath(fake.Uri.file('/d:/v/sub/y.md') as never), 'sub/y.md');
  assert.deepEqual(store.indexFor(fake.Uri.file('/d:/v/b.md') as never)?.index.incoming('b.md').map((l) => l.source), ['a.md']);
  store.dispose();
});

test('round 4: a vault nested inside another is not part of the outer vault index (its notes are never edited from it)', async () => {
  fake.files.clear();
  fake.textDocuments.length = 0;
  fake.files.set('/outer/x.md', '[[y]] [z](inner/z.md)');
  fake.files.set('/outer/inner/y.md', '[[x]]');
  fake.files.set('/outer/inner/z.md', '[[x]]');
  const store = new LinkStore({ roots: () => [fake.Uri.file('/outer'), fake.Uri.file('/outer/inner')] as never, onDidChangeRoots: new fake.EventEmitter<void>().event });
  await store.ready();
  const outer = store.indexFor(fake.Uri.file('/outer/x.md') as never)!.index;
  assert.deepEqual([...outer.files()].sort(), ['x.md'], 'the inner vault belongs to itself');
  assert.deepEqual(outer.incoming('x.md'), [], 'inner notes are not backlinks of outer notes');
  const inner = store.indexFor(fake.Uri.file('/outer/inner/y.md') as never)!.index;
  assert.deepEqual([...inner.files()].sort(), ['y.md', 'z.md']);
  // A file created later inside the inner vault goes to the inner index only.
  fake.files.set('/outer/inner/w.md', '[[y]]');
  fake.fireWatcher('create', '/outer/inner/w.md');
  await settle();
  assert.equal(outer.has('inner/w.md'), false);
  assert.equal(inner.has('w.md'), true);
  store.dispose();
});

test('round 4: a note moved from the outer vault into the nested one leaves the outer index', async () => {
  fake.files.clear();
  fake.textDocuments.length = 0;
  fake.files.set('/outer/x.md', '[[y]]');
  fake.files.set('/outer/inner/y.md', '');
  const store = new LinkStore({ roots: () => [fake.Uri.file('/outer'), fake.Uri.file('/outer/inner')] as never, onDidChangeRoots: new fake.EventEmitter<void>().event });
  await store.ready();
  fake.rename('/outer/x.md', '/outer/inner/x.md');
  await settle();
  assert.deepEqual([...store.indexFor(fake.Uri.file('/outer/a.md') as never)!.index.files()], []);
  assert.deepEqual([...store.indexFor(fake.Uri.file('/outer/inner/a.md') as never)!.index.files()].sort(), ['x.md', 'y.md']);
  store.dispose();
});

test('round 5: a rename during a rebuild (nested vault appeared) is applied once the rebuild finishes', async () => {
  fake.files.clear();
  fake.textDocuments.length = 0;
  fake.files.set('/outer/x.md', '[[y]]');
  fake.files.set('/outer/sub/y.md', '');
  let roots = [fake.Uri.file('/outer')];
  const rootsChanged = new fake.EventEmitter<void>();
  const store = new LinkStore({ roots: () => roots as never, onDidChangeRoots: rootsChanged.event });
  await store.ready();
  roots = [fake.Uri.file('/outer'), fake.Uri.file('/outer/sub')];
  rootsChanged.fire();
  assert.equal(store.indexFor(fake.Uri.file('/outer/x.md') as never), undefined, 'being rebuilt: renames see "not ready", never a stale index');
  fake.rename('/outer/x.md', '/outer/z.md');
  await store.ready();
  await settle();
  const outer = store.indexFor(fake.Uri.file('/outer/z.md') as never)!.index;
  assert.deepEqual([...outer.files()].sort(), ['z.md']);
  assert.deepEqual([...store.indexFor(fake.Uri.file('/outer/sub/y.md') as never)!.index.files()], ['y.md']);
  store.dispose();
});

// Seed 8 found a rename handled before the delete of a file in the moved folder (a ghost file);
// seed 1017 a file created again at a renamed path while the rename was being applied.
for (const start of [5, 8, 1017]) test(`fuzz (seed ${start}): file and editor events in random order (some twice) leave the index equal to a fresh build`, async () => {
  let seed = start;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];
  const FOLDERS = ['', 'x', 'x/y', 'z'];
  const path = () => `${V}/${pick(FOLDERS) ? `${pick(FOLDERS)}/` : ''}${pick(NAMES)}${rand() < 0.8 ? '.md' : '.png'}`.replace('//', '/');
  const body = () => Array.from({ length: 3 }, () => pick(['[[a]]', '[[b]]', '[c](c.md)', '[d](x/d.md)', '![[e.png]]', '[[x/y/f]]', 'text'])).join(' ');
  fake.files.clear();
  fake.textDocuments.length = 0;
  for (let i = 0; i < 12; i++) {
    const p = path();
    fake.files.set(p, p.endsWith('.md') ? body() : 'PNG');
  }
  const store = new LinkStore({ roots: () => [fake.Uri.file(V)] as never, onDidChangeRoots: new fake.EventEmitter<void>().event });
  await store.ready();
  const docAt = (p: string) => fake.textDocuments.find((d) => d.uri.path === p);

  for (let batch = 0; batch < 150; batch++) {
    const events: (() => void)[] = [];
    for (let op = 0; op < 3; op++) {
      const existing = [...fake.files.keys()];
      const roll = rand();
      if (roll < 0.2 || existing.length === 0) {
        const p = path();
        if (fake.files.has(p)) continue;
        fake.files.set(p, p.endsWith('.md') ? body() : 'PNG');
        events.push(() => fake.fireWatcher('create', p));
      } else if (roll < 0.35) {
        const p = pick(existing);
        if (!p.endsWith('.md') || docAt(p)) continue;
        fake.files.set(p, body());
        events.push(() => fake.fireWatcher('change', p));
      } else if (roll < 0.45) {
        const p = pick(existing);
        if (docAt(p)) continue;
        fake.files.delete(p);
        events.push(() => fake.fireWatcher('delete', p));
      } else if (roll < 0.65) {
        // A file or a whole folder moves (with any open editors), as VS Code reports it.
        const from = rand() < 0.3 ? `${V}/${pick(['x', 'x/y', 'z'])}` : pick(existing);
        const to = from.endsWith('.md') || from.endsWith('.png') ? path() : `${V}/${pick(['m', 'n', 'x/w'])}`;
        const under = (p: string) => p === from || p.startsWith(`${from}/`);
        const moved = [...fake.files.keys()].filter(under);
        if (moved.length === 0 || to === from || to.startsWith(`${from}/`) || [...fake.files.keys()].some((p) => p === to || p.startsWith(`${to}/`))) continue;
        for (const p of moved) {
          const text = fake.files.get(p)!;
          fake.files.delete(p);
          fake.files.set(`${to}${p.slice(from.length)}`, text);
        }
        for (const doc of [...fake.textDocuments].filter((d) => under(d.uri.path))) {
          const target = `${to}${doc.uri.path.slice(from.length)}`;
          fake.textDocuments.splice(fake.textDocuments.indexOf(doc), 1);
          const reopened = fake.openDocument(target, doc.text);
          reopened.isDirty = doc.isDirty;
          events.push(() => fake.documentEvents.closed.fire(doc));
          events.push(() => fake.openEvents.fire(reopened));
        }
        events.push(() => fake.renameEvents.fire({ files: [{ oldUri: fake.Uri.file(from), newUri: fake.Uri.file(to) }] }));
        for (const p of moved) {
          events.push(() => fake.fireWatcher('delete', p));
          events.push(() => fake.fireWatcher('create', `${to}${p.slice(from.length)}`));
        }
      } else if (roll < 0.8) {
        // An editor opens a note and types (unsaved).
        const p = pick(existing.filter((q) => q.endsWith('.md')));
        if (p === undefined) continue;
        const doc = docAt(p) ?? fake.openDocument(p, fake.files.get(p)!);
        events.push(() => fake.openEvents.fire(doc));
        doc.text = body();
        doc.isDirty = true;
        events.push(() => fake.documentEvents.changed.fire({ document: doc }));
      } else if (roll < 0.9) {
        // Save, or close without saving.
        const doc = pick(fake.textDocuments);
        if (doc === undefined) continue;
        if (rand() < 0.5) {
          fake.files.set(doc.uri.path, doc.text);
          doc.isDirty = false;
          events.push(() => fake.documentEvents.changed.fire({ document: doc }));
          events.push(() => fake.fireWatcher('change', doc.uri.path));
        } else {
          fake.textDocuments.splice(fake.textDocuments.indexOf(doc), 1);
          events.push(() => fake.documentEvents.closed.fire(doc));
        }
      }
    }
    // Delivered in random order, some twice.
    for (let i = events.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [events[i], events[j]] = [events[j]!, events[i]!];
    }
    for (const fire of events) {
      fire();
      if (rand() < 0.2) fire();
    }
    await settle(5);
  }
  await settle(30);
  const index = store.indexFor(fake.Uri.file(`${V}/_`) as never)!.index;
  const textOf = (p: string) => {
    const doc = docAt(p);
    return doc?.isDirty === true ? doc.text : fake.files.get(p);
  };
  const rel = [...fake.files.keys()].map((p) => p.slice(V.length + 1));
  const fresh = LinkIndex.build(rel, (p) => textOf(`${V}/${p}`));
  assert.deepEqual([...index.files()].sort(), [...fresh.files()].sort(), 'same files');
  const view = (i: InstanceType<typeof LinkIndex>, p: string) => i.outgoing(p).map((o) => `${o.link.rawPath}->${o.resolution.kind === 'found' ? o.resolution.path : o.resolution.kind}`);
  for (const p of rel) assert.deepEqual(view(index, p), view(fresh, p), p);
  store.dispose();
});
