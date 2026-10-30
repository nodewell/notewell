// Exercises the VS Code adapter against an in-memory fake of the `vscode` module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE_VSCODE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./fake-vscode.ts');
const { VaultRegistry } = await import('../../src/vault/registry.ts');

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const uri = (path: string) => fake.Uri.file(path) as unknown as import('vscode').Uri;

async function setup(files: Record<string, string>) {
  fake.files.clear();
  for (const [path, text] of Object.entries(files)) fake.files.set(path, text);
  const warnings: string[] = [];
  let changes = 0;
  const registry = await VaultRegistry.create({ onBrokenSettings: (root) => void warnings.push(root.path) });
  registry.onDidChange(() => void changes++);
  return { registry, warnings, changes: () => changes };
}

test('detects root, nested and sibling vaults and reads their settings', async () => {
  const { registry } = await setup({
    '/ws/.obsidian/app.json': '{"useMarkdownLinks":true}',
    '/ws/notes/inner/.obsidian/workspace.json': '{}',
    '/other/v/.obsidian/app.json': '{"newLinkFormat":"relative"}',
  });
  try {
    assert.deepEqual(registry.vaults.map((v) => v.root.path).sort(), ['/other/v', '/ws', '/ws/notes/inner']);
    assert.equal(registry.vaultFor(uri('/ws/a.md'))?.root.path, '/ws');
    assert.equal(registry.vaultFor(uri('/ws/notes/inner/b.md'))?.root.path, '/ws/notes/inner');
    assert.equal(registry.vaultFor(uri('/elsewhere/c.md')), undefined);
    assert.equal(registry.settingsFor(uri('/ws/a.md')).useMarkdownLinks, true);
    assert.equal(registry.settingsFor(uri('/ws/notes/inner/b.md')).useMarkdownLinks, false, 'no app.json');
    assert.equal(registry.settingsFor(uri('/other/v/x.md')).newLinkFormat, 'relative');
    assert.equal(registry.settingsFor(uri('/elsewhere/c.md')).newLinkFormat, 'shortest', 'defaults outside');
  } finally {
    registry.dispose();
  }
});

test('re-reads app.json when it changes', async () => {
  const { registry, changes } = await setup({ '/ws/.obsidian/app.json': '{}' });
  try {
    const before = changes();
    fake.files.set('/ws/.obsidian/app.json', '{"attachmentFolderPath":"files"}');
    fake.fireWatcher('change', '/ws/.obsidian/app.json');
    await settle();
    assert.equal(registry.settingsFor(uri('/ws/n.md')).attachmentFolderPath, 'files');
    assert.equal(changes(), before + 1);

    fake.files.delete('/ws/.obsidian/app.json');
    fake.fireWatcher('delete', '/ws/.obsidian/app.json');
    await settle();
    assert.equal(registry.settingsFor(uri('/ws/n.md')).attachmentFolderPath, '/', 'back to defaults');
  } finally {
    registry.dispose();
  }
});

test('broken app.json uses defaults and warns once per vault until fixed', async () => {
  const { registry, warnings } = await setup({
    '/ws/.obsidian/app.json': '{"useMarkdownLinks":true,',
    '/v2/.obsidian/app.json': '{',
  });
  try {
    assert.deepEqual(warnings.sort(), ['/v2', '/ws']);
    assert.equal(registry.settingsFor(uri('/ws/n.md')).useMarkdownLinks, false);

    fake.fireWatcher('change', '/ws/.obsidian/app.json');
    await settle();
    assert.equal(warnings.length, 2, 'still broken: no second warning');

    fake.files.set('/ws/.obsidian/app.json', '{"useMarkdownLinks":true}');
    fake.fireWatcher('change', '/ws/.obsidian/app.json');
    await settle();
    assert.equal(registry.settingsFor(uri('/ws/n.md')).useMarkdownLinks, true);

    fake.files.set('/ws/.obsidian/app.json', 'oops');
    fake.fireWatcher('change', '/ws/.obsidian/app.json');
    await settle();
    assert.equal(warnings.length, 3, 'broken again after a good read warns again');
  } finally {
    registry.dispose();
  }
});

test('rescans when a vault appears or disappears', async () => {
  const { registry } = await setup({ '/ws/.obsidian/app.json': '{}' });
  try {
    fake.files.set('/ws/new/.obsidian/app.json', '{"useMarkdownLinks":true}');
    fake.fireWatcher('create', '/ws/new/.obsidian');
    await settle(400);
    assert.equal(registry.vaultFor(uri('/ws/new/n.md'))?.root.path, '/ws/new');
    assert.equal(registry.settingsFor(uri('/ws/new/n.md')).useMarkdownLinks, true);

    fake.files.delete('/ws/new/.obsidian/app.json');
    fake.fireWatcher('delete', '/ws/new/.obsidian');
    await settle(400);
    assert.equal(registry.vaultFor(uri('/ws/new/n.md'))?.root.path, '/ws');
  } finally {
    registry.dispose();
  }
});

test("reads the Kanban plugin's board defaults and re-reads them when data.json changes", async () => {
  const data = '/ws/.obsidian/plugins/obsidian-kanban/data.json';
  const { registry, changes } = await setup({ '/ws/.obsidian/app.json': '{}', [data]: '{"show-checkboxes":true}' });
  try {
    assert.equal(registry.kanbanPluginFor(uri('/ws/board.md')).showCheckboxes, true);
    assert.equal(registry.kanbanPluginFor(uri('/elsewhere/board.md')).showCheckboxes, undefined, 'none outside a vault');
    const before = changes();
    fake.files.set(data, '{"show-checkboxes":false}');
    fake.fireWatcher('change', data);
    await settle();
    assert.equal(registry.kanbanPluginFor(uri('/ws/board.md')).showCheckboxes, false);
    assert.equal(changes(), before + 1);
    fake.files.delete(data);
    fake.fireWatcher('delete', data);
    await settle();
    assert.equal(registry.kanbanPluginFor(uri('/ws/board.md')).showCheckboxes, undefined, 'removed: no default');
  } finally {
    registry.dispose();
  }
});

test('Kanban date format: the plugin setting, else the Daily notes format, re-read when they change', async () => {
  const daily = '/ws/.obsidian/daily-notes.json';
  const data = '/ws/.obsidian/plugins/obsidian-kanban/data.json';
  const { registry } = await setup({ '/ws/.obsidian/app.json': '{}', [daily]: '{"format":"YYYY.MM.DD"}' });
  try {
    const format = () => registry.kanbanPluginFor(uri('/ws/board.md')).defaults.dateFormat;
    assert.equal(format(), 'YYYY.MM.DD');
    fake.files.set(daily, '{"format":"DD/MM/YYYY"}');
    fake.fireWatcher('change', daily);
    await settle();
    assert.equal(format(), 'DD/MM/YYYY');
    fake.files.set(data, '{"date-format":"YY-MM-DD","date-trigger":"$"}');
    fake.fireWatcher('create', data);
    await settle();
    assert.equal(format(), 'YY-MM-DD', 'the plugin setting wins');
    assert.equal(registry.kanbanPluginFor(uri('/ws/board.md')).defaults.dateTrigger, '$');
    assert.equal(registry.kanbanPluginFor(uri('/elsewhere/b.md')).defaults.dateFormat, undefined, 'none outside a vault');
  } finally {
    registry.dispose();
  }
});

test('Daily notes and Templates settings: read, missing, broken (warned once per file), re-read on change', async () => {
  const daily = '/ws/.obsidian/daily-notes.json';
  const templates = '/ws/.obsidian/templates.json';
  const { registry, warnings } = await setup({
    '/ws/.obsidian/app.json': '{"newFileLocation":"folder","newFileFolderPath":"Inbox"}',
    [daily]: '{"folder":"Daily","format":"YYYY/MM/DD","template":"Templates/Day"}',
    '/ws/.obsidian/core-plugins.json': '{"daily-notes":true,"templates":false}',
    '/v2/.obsidian/app.json': '{}',
  });
  try {
    const vault = () => registry.vaultFor(uri('/ws/n.md'))!;
    assert.deepEqual(vault().dailyNotes, { folder: 'Daily', format: 'YYYY/MM/DD', template: 'Templates/Day' });
    assert.equal(vault().templates, undefined, 'no templates.json');
    assert.deepEqual(vault().corePlugins, { dailyNotes: true, templates: false });
    assert.equal(vault().settings.newFileLocation, 'folder');
    assert.equal(vault().settings.newFileFolderPath, 'Inbox');
    const other = registry.vaultFor(uri('/v2/n.md'))!;
    assert.equal(other.dailyNotes, undefined);
    assert.deepEqual(other.corePlugins, { dailyNotes: undefined, templates: undefined });

    fake.files.set(templates, '{"folder":"Templates","dateFormat":"DD.MM.YYYY"}');
    fake.fireWatcher('create', templates);
    await settle();
    assert.deepEqual(vault().templates, { folder: 'Templates', dateFormat: 'DD.MM.YYYY', timeFormat: 'HH:mm' });

    fake.files.set(daily, '{"folder":');
    fake.fireWatcher('change', daily);
    await settle();
    assert.deepEqual(vault().dailyNotes, { folder: '', format: 'YYYY-MM-DD', template: '' }, 'broken: defaults');
    assert.equal(warnings.length, 1);
    fake.fireWatcher('change', daily);
    await settle();
    assert.equal(warnings.length, 1, 'still broken: no second warning');
    fake.files.set(templates, 'nope');
    fake.fireWatcher('change', templates);
    await settle();
    assert.equal(warnings.length, 2, 'another file warns on its own');

    fake.files.delete(daily);
    fake.fireWatcher('delete', daily);
    await settle();
    assert.equal(vault().dailyNotes, undefined);
  } finally {
    registry.dispose();
  }
});
