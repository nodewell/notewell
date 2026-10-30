// Exercises the appearance adapter against the in-memory fake `vscode` module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const FAKE_VSCODE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./fake-vscode.ts');
const { AppearanceStore, MAX_CSS_BYTES, vaultRootOfObsidianFile } = await import('../../src/vault/appearance-store.ts');

const FIXTURE = new URL('../fixtures/obsidian-theme/.obsidian/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, FIXTURE), 'utf8');
const root = fake.Uri.file('/ws') as unknown as import('vscode').Uri;

function setup(files: Record<string, string>) {
  fake.files.clear();
  for (const [path, text] of Object.entries(files)) fake.files.set(path, text);
  const warnings: string[] = [];
  const changes: string[] = [];
  const store = new AppearanceStore({ onBrokenAppearance: (r, error) => void warnings.push(`${r.path}: ${error}`) });
  store.onDidChange((path) => void changes.push(path));
  return { store, warnings, changes };
}

const FIXTURE_FILES = {
  '/ws/.obsidian/appearance.json': read('appearance.json'),
  '/ws/.obsidian/themes/Sample/theme.css': read('themes/Sample/theme.css'),
  '/ws/.obsidian/snippets/soft-cards.css': read('snippets/soft-cards.css'),
  '/ws/.obsidian/snippets/hostile.css': read('snippets/hostile.css'),
};

test('reads appearance.json, the theme and the enabled snippets in order; missing ones are skipped', async () => {
  const { store, warnings } = setup(FIXTURE_FILES);
  try {
    const result = await store.appearanceFor(root);
    assert.equal(result.appearance.cssTheme, 'Sample');
    assert.equal(result.themeCss, FIXTURE_FILES['/ws/.obsidian/themes/Sample/theme.css']);
    assert.deepEqual(result.snippetCss, [FIXTURE_FILES['/ws/.obsidian/snippets/soft-cards.css'], FIXTURE_FILES['/ws/.obsidian/snippets/hostile.css']]);
    assert.deepEqual(warnings, []);
  } finally {
    store.dispose();
  }
});

test('no appearance.json: default theme, no sources, no warning', async () => {
  const { store, warnings } = setup({});
  try {
    const result = await store.appearanceFor(root);
    assert.deepEqual(result, { appearance: { cssTheme: '', mode: 'system', enabledCssSnippets: [] }, snippetCss: [] });
    assert.deepEqual(warnings, []);
  } finally {
    store.dispose();
  }
});

test('broken appearance.json: defaults and one warning per broken period', async () => {
  const { store, warnings } = setup({ '/ws/.obsidian/appearance.json': '{ broken' });
  try {
    assert.equal((await store.appearanceFor(root)).appearance.cssTheme, '');
    fake.fireWatcher('change', '/ws/.obsidian/appearance.json');
    await store.appearanceFor(root);
    assert.equal(warnings.length, 1);
    fake.files.set('/ws/.obsidian/appearance.json', '{"cssTheme":"Sample"}');
    fake.fireWatcher('change', '/ws/.obsidian/appearance.json');
    await store.appearanceFor(root);
    fake.files.set('/ws/.obsidian/appearance.json', '[]');
    fake.fireWatcher('change', '/ws/.obsidian/appearance.json');
    await store.appearanceFor(root);
    assert.equal(warnings.length, 2, 'warns again after it was fixed and broke again');
  } finally {
    store.dispose();
  }
});

test('a missing or oversized theme file skips only that layer', async () => {
  const { store } = setup({
    '/ws/.obsidian/appearance.json': '{"cssTheme":"Gone","enabledCssSnippets":["big","ok"]}',
    '/ws/.obsidian/snippets/big.css': 'x'.repeat(MAX_CSS_BYTES + 1),
    '/ws/.obsidian/snippets/ok.css': 'body { --a: 1px; }',
  });
  try {
    const result = await store.appearanceFor(root);
    assert.equal(result.themeCss, undefined);
    assert.deepEqual(result.snippetCss, ['body { --a: 1px; }']);
  } finally {
    store.dispose();
  }
});

test('changes to appearance.json, theme.css or snippets fire and re-read', async () => {
  const { store, changes } = setup(FIXTURE_FILES);
  try {
    await store.appearanceFor(root);
    fake.files.set('/ws/.obsidian/themes/Sample/theme.css', '.theme-dark { --text-normal: #abcdef; }');
    fake.fireWatcher('change', '/ws/.obsidian/themes/Sample/theme.css');
    assert.equal((await store.appearanceFor(root)).themeCss, '.theme-dark { --text-normal: #abcdef; }');
    fake.fireWatcher('create', '/ws/.obsidian/snippets/new.css');
    fake.fireWatcher('delete', '/ws/.obsidian/appearance.json');
    assert.deepEqual(changes, ['/ws', '/ws', '/ws']);
  } finally {
    store.dispose();
  }
});

test('vault root of a file inside .obsidian', () => {
  assert.equal(vaultRootOfObsidianFile('/ws/notes/.obsidian/snippets/a.css'), '/ws/notes');
  assert.equal(vaultRootOfObsidianFile('/ws/notes/a.css'), undefined);
});
