import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { BrokenSettingsWarnings, DEFAULT_APP_SETTINGS, parseAppSettings } from '../../src/vault/settings.ts';

test('defaults match the Obsidian defaults used by Notewell', () => {
  assert.deepEqual(DEFAULT_APP_SETTINGS, {
    useMarkdownLinks: false,
    newLinkFormat: 'shortest',
    attachmentFolderPath: '/',
    userIgnoreFilters: [],
    useTab: true,
    alwaysUpdateLinks: undefined,
    newFileLocation: 'root',
    newFileFolderPath: '',
  });
});

test('missing file, empty file and empty object give defaults without error', () => {
  for (const text of [undefined, '', '  \n', '{}', '\uFEFF{}']) {
    assert.deepEqual(parseAppSettings(text), { settings: DEFAULT_APP_SETTINGS }, String(text));
  }
});

test('reads all five keys', () => {
  const { settings, error } = parseAppSettings(
    JSON.stringify({
      useMarkdownLinks: true,
      newLinkFormat: 'relative',
      attachmentFolderPath: './assets',
      userIgnoreFilters: ['Archive/', '/\\.tmp$/'],
      useTab: false,
      alwaysUpdateLinks: true,
    }),
  );
  assert.equal(error, undefined);
  assert.deepEqual(settings, {
    useMarkdownLinks: true,
    newLinkFormat: 'relative',
    attachmentFolderPath: './assets',
    userIgnoreFilters: ['Archive/', '/\\.tmp$/'],
    useTab: false,
    alwaysUpdateLinks: true,
    newFileLocation: 'root',
    newFileFolderPath: '',
  });
  assert.equal(parseAppSettings('{"alwaysUpdateLinks": false}').settings.alwaysUpdateLinks, false);
  assert.equal(parseAppSettings('{"alwaysUpdateLinks": "yes"}').settings.alwaysUpdateLinks, undefined, 'not a boolean: unknown');
});

test('useTab: boolean only, otherwise the default (tabs)', () => {
  assert.equal(parseAppSettings('{"useTab":false}').settings.useTab, false);
  assert.equal(parseAppSettings('{"useTab":true}').settings.useTab, true);
  for (const value of ['"false"', '0', 'null', '[]']) {
    assert.equal(parseAppSettings(`{"useTab":${value}}`).settings.useTab, true, value);
  }
  assert.equal(parseAppSettings('{}').settings.useTab, true);
});

test('missing keys use defaults individually', () => {
  const { settings } = parseAppSettings('{"newLinkFormat":"absolute"}');
  assert.deepEqual(settings, { ...DEFAULT_APP_SETTINGS, newLinkFormat: 'absolute' });
});

test('keys with unexpected types or values use defaults', () => {
  const { settings, error } = parseAppSettings(
    JSON.stringify({
      useMarkdownLinks: 'yes',
      newLinkFormat: 'nearest',
      attachmentFolderPath: 3,
      userIgnoreFilters: null,
    }),
  );
  assert.equal(error, undefined);
  assert.deepEqual(settings, DEFAULT_APP_SETTINGS);
  assert.deepEqual(parseAppSettings('{"userIgnoreFilters":["a",1,null,"b"]}').settings.userIgnoreFilters, ['a', 'b']);
});

test('broken JSON or a non-object gives defaults plus an error', () => {
  for (const text of ['{"useMarkdownLinks": true,', 'not json', '[]', 'null', '"x"', '42']) {
    const result = parseAppSettings(text);
    assert.deepEqual(result.settings, DEFAULT_APP_SETTINGS, text);
    assert.equal(typeof result.error, 'string', text);
  }
});

test('results are frozen', () => {
  const { settings } = parseAppSettings('{"userIgnoreFilters":["a"]}');
  assert.ok(Object.isFrozen(settings));
  assert.ok(Object.isFrozen(settings.userIgnoreFilters));
  assert.ok(Object.isFrozen(DEFAULT_APP_SETTINGS));
});

test('broken settings warn once per vault until a successful read re-arms', () => {
  const warnings = new BrokenSettingsWarnings();
  const broken = parseAppSettings('{');
  const ok = parseAppSettings('{}');
  assert.equal(warnings.record('/a', broken), true);
  assert.equal(warnings.record('/a', broken), false);
  assert.equal(warnings.record('/b', broken), true, 'per vault');
  assert.equal(warnings.record('/a', ok), false);
  assert.equal(warnings.record('/a', broken), true, 're-armed after a good read');
  warnings.forget('/b');
  assert.equal(warnings.record('/b', broken), true, 'forgotten vault warns again');
});

test('Kanban plugin data.json: show-checkboxes as a boolean, anything else means no default', async () => {
  const { parseKanbanPluginSettings } = await import('../../src/vault/settings.ts');
  assert.equal(parseKanbanPluginSettings('{"lane-width":400,"show-checkboxes":true}').showCheckboxes, true);
  assert.equal(parseKanbanPluginSettings('\uFEFF{"show-checkboxes":false}').showCheckboxes, false);
  for (const text of [undefined, '', '{', '[]', 'null', '{"show-checkboxes":"true"}', '{}']) {
    assert.equal(parseKanbanPluginSettings(text).showCheckboxes, undefined, String(text));
  }
});

test('Kanban plugin data.json: lane-width as Obsidian uses it', async () => {
  const { laneWidthValue, parseKanbanPluginSettings } = await import('../../src/vault/settings.ts');
  assert.equal(parseKanbanPluginSettings('{"lane-width":400,"show-checkboxes":true}').laneWidth, 400);
  assert.equal(parseKanbanPluginSettings('{"lane-width":"350"}').laneWidth, 350);
  assert.equal(parseKanbanPluginSettings('{"lane-width":"x"}').laneWidth, null, 'set but not a width: 272px');
  for (const text of [undefined, '{', '[]', '{}']) assert.equal(parseKanbanPluginSettings(text).laneWidth, undefined, String(text));
  assert.deepEqual(
    [300, 0.5, '300', '300.5', 0, -1, Infinity, '', ' 300', '300px', '1e3', true, null, [300], {}].map(laneWidthValue),
    [300, 0.5, 300, 300.5, null, null, null, null, null, null, null, null, null, null, null],
  );
});

test("Obsidian Kanban's date format fallback: Daily notes, Natural Language Dates, Templates", async () => {
  const { obsidianDefaultDateFormat, parseKanbanPluginDefaults } = await import('../../src/vault/settings.ts');
  const daily = '{"format":"YYYY년 MM월 DD일","folder":"Daily"}';
  const templates = '{"folder":"Templates","dateFormat":"DD.MM.YYYY"}';
  assert.equal(obsidianDefaultDateFormat({}), undefined, 'nothing set: YYYY-MM-DD applies');
  assert.equal(obsidianDefaultDateFormat({ dailyNotes: daily }), 'YYYY년 MM월 DD일', 'core plugins on by default');
  assert.equal(obsidianDefaultDateFormat({ corePlugins: '{"daily-notes":false,"templates":true}', dailyNotes: daily, templates }), 'DD.MM.YYYY');
  assert.equal(obsidianDefaultDateFormat({ corePlugins: '["templates"]', dailyNotes: daily, templates }), 'DD.MM.YYYY', 'older list form');
  assert.equal(obsidianDefaultDateFormat({ corePlugins: '{"daily-notes":true}', dailyNotes: '{"format":""}', templates }), undefined, 'templates off in the object form');
  const nldates = { communityPlugins: '["nldates-obsidian"]', nldates: '{"format":"MMMM Do"}' };
  assert.equal(obsidianDefaultDateFormat({ ...nldates, templates }), 'MMMM Do', 'Natural Language Dates before Templates');
  assert.equal(obsidianDefaultDateFormat({ ...nldates, dailyNotes: daily }), 'YYYY년 MM월 DD일', 'Daily notes first');
  assert.equal(obsidianDefaultDateFormat({ communityPlugins: '[]', nldates: '{"format":"MMMM Do"}' }), undefined, 'not enabled');
  assert.equal(obsidianDefaultDateFormat({ dailyNotes: '{broken', templates: 'nope' }), undefined);
  assert.deepEqual(parseKanbanPluginDefaults('{"date-format":"DD/MM","date-trigger":"$","time-trigger":"!!","link-date-to-daily-note":true,"lane-width":400}'), {
    dateFormat: 'DD/MM',
    dateTrigger: '$',
    timeTrigger: '!!',
    linkDateToDailyNote: true,
  });
  assert.deepEqual(parseKanbanPluginDefaults('{"date-format":"","time-trigger":"","link-date-to-daily-note":"yes"}'), {});
});

test('new note location: root, current or folder with its path; anything else is the vault folder', () => {
  const read = (json: string) => parseAppSettings(json).settings;
  assert.equal(read('{"newFileLocation":"current"}').newFileLocation, 'current');
  assert.deepEqual(
    [read('{"newFileLocation":"folder","newFileFolderPath":"Inbox/New"}')].map((s) => [s.newFileLocation, s.newFileFolderPath]),
    [['folder', 'Inbox/New']],
  );
  for (const value of ['"elsewhere"', '1', 'null']) assert.equal(read(`{"newFileLocation":${value}}`).newFileLocation, 'root', value);
  assert.equal(read('{"newFileFolderPath":3}').newFileFolderPath, '');
});

test('daily-notes.json and templates.json: keys as Obsidian writes them, empty values mean the default', async () => {
  const { parseDailyNotesSettings, parseTemplatesSettings, DEFAULT_DAILY_NOTES_SETTINGS, DEFAULT_TEMPLATES_SETTINGS } = await import('../../src/vault/settings.ts');
  const fixture = (name: string) => readFileSync(new URL(`../fixtures/daily-notes/obsidian/${name}`, import.meta.url), 'utf8');
  assert.deepEqual(parseDailyNotesSettings(fixture('daily-notes.json')), { settings: { format: 'YYYY-MM-DD', folder: 'Daily', template: 'Templates/일일' } });
  assert.equal(parseDailyNotesSettings(fixture('daily-notes-korean.json')).settings.format, 'YYYY년 MM월 DD일 dddd');
  assert.deepEqual(parseTemplatesSettings(fixture('templates.json')), { settings: { folder: 'Templates', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' } });
  assert.deepEqual(DEFAULT_DAILY_NOTES_SETTINGS, { folder: '', format: 'YYYY-MM-DD', template: '' });
  assert.deepEqual(DEFAULT_TEMPLATES_SETTINGS, { folder: '', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' });
  for (const text of ['', '{}', '{"format":"","folder":"  ","template":3}', '\uFEFF{"autorun":true}']) {
    assert.deepEqual(parseDailyNotesSettings(text), { settings: DEFAULT_DAILY_NOTES_SETTINGS }, text);
  }
  assert.deepEqual(parseTemplatesSettings('{"dateFormat":"DD.MM.YYYY","timeFormat":""}').settings, { folder: '', dateFormat: 'DD.MM.YYYY', timeFormat: 'HH:mm' });
  for (const text of ['{', '[]', 'null']) {
    const result = parseDailyNotesSettings(text);
    assert.deepEqual(result.settings, DEFAULT_DAILY_NOTES_SETTINGS, text);
    assert.equal(typeof result.error, 'string', text);
    assert.equal(typeof parseTemplatesSettings(text).error, 'string', text);
  }
  assert.ok(Object.isFrozen(parseDailyNotesSettings('{"folder":"x"}').settings));
});

test('core plugins: object or list form, unknown without the file', async () => {
  const { corePluginEnabled } = await import('../../src/vault/settings.ts');
  assert.equal(corePluginEnabled('{"daily-notes":true,"templates":false}', 'daily-notes'), true);
  assert.equal(corePluginEnabled('{"daily-notes":true,"templates":false}', 'templates'), false);
  assert.equal(corePluginEnabled('["templates"]', 'templates'), true);
  assert.equal(corePluginEnabled('["templates"]', 'daily-notes'), false);
  assert.equal(corePluginEnabled(undefined, 'templates'), undefined);
  assert.equal(corePluginEnabled('{', 'templates'), undefined);
});
