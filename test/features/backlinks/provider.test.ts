// Backlinks tree (links.md 5) against a fake `vscode` and a real LinkIndex: shown for vault
// notes only, linked mentions open the exact range, unlinked mentions behind the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE, shortCircuit: true } : next(specifier, context)) });

const fake = await import('./fake-vscode.ts');
const { BacklinksProvider, BACKLINKS_CONTEXT } = await import('../../../src/features/backlinks/index.ts');
const { LinkIndex } = await import('../../../src/vault/link-index.ts');

const ROOT = '/vault';
const TEXTS: Record<string, string> = {
  'Target.md': '# Target\n',
  'a.md': 'See [[Target]].\n',
  'archive/old.md': 'Target without link\n',
  'c.md': 'Target without link\n',
};

function setup(ready = true) {
  fake.files.clear();
  fake.settings.clear();
  fake.contextKeys.clear();
  for (const [p, t] of Object.entries(TEXTS)) fake.files.set(`${ROOT}/${p}`, t);
  const index = LinkIndex.build(Object.keys(TEXTS), (p) => TEXTS[p]);
  const inVault = (uri: { path: string }) => (uri.path.startsWith(`${ROOT}/`) ? uri.path.slice(ROOT.length + 1) : undefined);
  const store = {
    indexFor: (uri: { path: string }) => (ready && inVault(uri) !== undefined ? { root: fake.Uri.file(ROOT), index } : undefined),
    relativePath: inVault,
  };
  const vaults = { vaultFor: () => ({ settings: { userIgnoreFilters: ['archive/'] } }) };
  return new BacklinksProvider({ links: () => store as never, vaults: () => vaults as never, linksChanged: new fake.EventEmitter<void>().event });
}

type Item = InstanceType<typeof fake.TreeItem>;

test('a vault note: Linked mentions by file; a mention opens the exact range', async () => {
  const provider = setup();
  fake.tabs.active = fake.Uri.file(`${ROOT}/Target.md`);
  await provider.refresh();
  assert.equal(fake.contextKeys.get(BACKLINKS_CONTEXT), true);
  const [section] = provider.getChildren();
  const sectionItem = provider.getTreeItem(section) as Item;
  assert.deepEqual([sectionItem.label, sectionItem.description], ['Linked mentions', '1']);
  const [file] = provider.getChildren(section);
  assert.equal((provider.getTreeItem(file) as Item).label, 'a');
  const [mention] = provider.getChildren(file);
  const item = provider.getTreeItem(mention) as Item;
  assert.equal(item.label, 'See [[Target]].');
  assert.equal(item.command!.command, 'notewell.backlinks.open');
  const [uri, options] = item.command!.arguments as [{ path: string }, { selection: InstanceType<typeof fake.Range> }];
  assert.equal(uri.path, `${ROOT}/a.md`);
  assert.deepEqual([options.selection.startLine, options.selection.startCharacter, options.selection.endCharacter], [0, 4, 14]);
  assert.equal(provider.getChildren().length, 1, 'no unlinked section by default');
});

test('Unlinked mentions behind the setting, excluding ignored files and the note itself', async () => {
  const provider = setup();
  fake.settings.set('notewell.backlinks.unlinked', true);
  fake.tabs.active = fake.Uri.file(`${ROOT}/Target.md`);
  await provider.refresh();
  const sections = provider.getChildren();
  assert.equal(sections.length, 2);
  const groups = provider.getChildren(sections[1]).map((n) => (provider.getTreeItem(n) as Item).tooltip);
  assert.deepEqual(groups, ['c.md']);
});

test('outside a vault the view hides; while indexing it says so; no backlinks says so', async () => {
  let provider = setup();
  fake.tabs.active = fake.Uri.file('/elsewhere/n.md');
  await provider.refresh();
  assert.equal(fake.contextKeys.get(BACKLINKS_CONTEXT), false);
  assert.deepEqual(provider.getChildren(), []);

  provider = setup(false);
  fake.tabs.active = fake.Uri.file(`${ROOT}/Target.md`);
  await provider.refresh();
  assert.equal((provider.getTreeItem(provider.getChildren()[0]) as Item).label, 'Indexing the vault…');

  provider = setup();
  fake.tabs.active = fake.Uri.file(`${ROOT}/c.md`);
  await provider.refresh();
  const [section] = provider.getChildren();
  assert.equal((provider.getTreeItem(provider.getChildren(section)[0]) as Item).label, 'No backlinks');
});

test('round 7: a mention whose file was renamed or deleted since the view was built is not opened at the old path', async () => {
  const provider = setup();
  fake.tabs.active = fake.Uri.file(`${ROOT}/Target.md`);
  await provider.refresh();
  const [section] = provider.getChildren();
  const [file] = provider.getChildren(section);
  const [mention] = provider.getChildren(file);
  const item = provider.getTreeItem(mention) as Item;
  fake.executed.length = 0;
  fake.info.length = 0;
  // Still there: opened at the mention.
  await provider.open(...(item.command!.arguments as [never, never]));
  assert.deepEqual(fake.executed.map((c) => [c[0], (c[1] as { path: string }).path]), [['vscode.open', `${ROOT}/a.md`]]);
  // Gone (renamed away before the view refreshed): not opened, the view is refreshed, the user is told.
  fake.files.delete(`${ROOT}/a.md`);
  fake.executed.length = 0;
  await provider.open(...(item.command!.arguments as [never, never]));
  assert.deepEqual(fake.executed, [], 'never opens (and so never recreates) the old path');
  assert.equal(fake.info.length, 1);
});

test('fuzz: the backlinks tree for random vaults and active notes builds and renders without errors', async () => {
  let seed = 9;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const SOUP = ['[[Target]]', '[[target|x]]', 'Target', 'targets', '`Target`', '```\nTarget\n```\n', '[t](Target.md)', '[[Target#h]]', '\n', ' ', '<b>', '[[', '%%'];
  for (let round = 0; round < 100; round++) {
    fake.files.clear();
    fake.settings.clear();
    if (rand() < 0.5) fake.settings.set('notewell.backlinks.unlinked', true);
    const texts: Record<string, string> = { 'Target.md': '' };
    for (const p of ['a.md', 'b/c.md', 'archive/d.md', 'Target copy.md']) texts[p] = Array.from({ length: Math.floor(rand() * 12) }, () => pick(SOUP)).join('');
    for (const [p, t] of Object.entries(texts)) fake.files.set(`${ROOT}/${p}`, t);
    const index = LinkIndex.build(Object.keys(texts), (p) => texts[p]);
    const inVault = (uri: { path: string }) => (uri.path.startsWith(`${ROOT}/`) ? uri.path.slice(ROOT.length + 1) : undefined);
    const store = { indexFor: (uri: { path: string }) => (inVault(uri) !== undefined ? { root: fake.Uri.file(ROOT), index } : undefined), relativePath: inVault };
    const vaults = { vaultFor: () => ({ settings: { userIgnoreFilters: ['archive/'] } }) };
    const provider = new BacklinksProvider({ links: () => store as never, vaults: () => vaults as never, linksChanged: new fake.EventEmitter<void>().event });
    fake.tabs.active = fake.Uri.file(`${ROOT}/${pick(Object.keys(texts))}`);
    await provider.refresh();
    const walk = (node?: unknown): void => {
      for (const child of provider.getChildren(node as never)) {
        provider.getTreeItem(child);
        walk(child);
      }
    };
    walk();
  }
});
