// Daily note, template and missing-note commands (daily-notes.md 4-6) against a fake `vscode`,
// compared with what Obsidian wrote (test/fixtures/daily-notes/obsidian/).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const FAKE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE, shortCircuit: true } : next(specifier, context)) });

const fake = await import('./fake-vscode.ts');
const { registerDailyNotes } = await import('../../../src/features/daily-notes/index.ts');
const { LinkIndex } = await import('../../../src/vault/link-index.ts');
const { parseAppSettings, parseDailyNotesSettings, parseTemplatesSettings, DEFAULT_KANBAN_PLUGIN_SETTINGS } = await import('../../../src/vault/settings.ts');

const fixtureBytes = (name: string) => readFileSync(new URL(`../../fixtures/daily-notes/obsidian/${name}`, import.meta.url));
const fixture = (name: string) => fixtureBytes(name).toString('utf8');
const ROOT = '/v';
const NOW = new Date(2026, 9, 21, 14, 37, 5);

interface VaultOptions {
  app?: string;
  daily?: string;
  templates?: string;
  core?: { dailyNotes?: boolean; templates?: boolean };
}

function vaultOf(options: VaultOptions) {
  return {
    root: fake.Uri.file(ROOT),
    settings: parseAppSettings(options.app ?? '{}').settings,
    kanbanPlugin: DEFAULT_KANBAN_PLUGIN_SETTINGS,
    dailyNotes: options.daily === undefined ? undefined : parseDailyNotesSettings(options.daily).settings,
    templates: options.templates === undefined ? undefined : parseTemplatesSettings(options.templates).settings,
    corePlugins: { dailyNotes: options.core?.dailyNotes, templates: options.core?.templates },
  };
}

function setup(options: VaultOptions, files: Record<string, string | Uint8Array> = {}) {
  fake.reset();
  fake.registered.clear();
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string') fake.writeText(`${ROOT}/${path}`, content);
    else {
      fake.writeText(`${ROOT}/${path}`, '');
      fake.files.set(`${ROOT}/${path}`, content);
    }
  }
  fake.folders.add(ROOT);
  const vault = vaultOf(options);
  const rel = (uri: { path: string }) => (uri.path.startsWith(`${ROOT}/`) ? uri.path.slice(ROOT.length + 1) : undefined);
  const registry = { vaults: [vault], vaultFor: (uri: { path: string }) => (rel(uri) !== undefined ? vault : undefined) };
  const index = () => {
    const texts = new Map([...fake.files.keys()].filter((p) => p.startsWith(`${ROOT}/`)).map((p) => [p.slice(ROOT.length + 1), fake.readText(p)!]));
    return LinkIndex.build(texts.keys(), (p) => texts.get(p));
  };
  const store = { indexFor: (uri: { path: string }) => (rel(uri) !== undefined ? { root: fake.Uri.file(ROOT), index: index() } : undefined), relativePath: rel };
  const changed = new fake.EventEmitter<void>();
  registerDailyNotes({ subscriptions: [] } as never, { vaults: () => registry as never, vaultsChanged: changed.event as never, links: () => store as never });
  return { run: (id: string, ...args: unknown[]) => fake.registered.get(id)!(...args) as Promise<void> };
}

function editor(path: string, text: string, from = 0, to = from) {
  const document = new fake.TextDocument(fake.Uri.file(`${ROOT}/${path}`), text);
  fake.textDocuments.push(document);
  const ed = new fake.TextEditor(document, [new fake.Selection(document.positionAt(from), document.positionAt(to))]);
  fake.window.activeTextEditor = ed;
  return ed;
}

const OBSIDIAN = { daily: fixture('daily-notes.json'), templates: fixture('templates.json') };
const VAULT_FILES = { 'Daily/.keep': '', 'Templates/일일.md': fixtureBytes('Templates/일일.md') };

test("today's daily note: created as Obsidian made it, byte for byte, then opened at the end", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup(OBSIDIAN, VAULT_FILES);
  await run('notewell.dailyNotes.openToday');
  assert.deepEqual(fake.files.get(`${ROOT}/Daily/2026-10-21.md`), new Uint8Array(fixtureBytes('results/Daily/2026-10-21.md')));
  assert.deepEqual(fake.opened, [`${ROOT}/Daily/2026-10-21.md`]);
  const { line } = fake.window.activeTextEditor!.selection.start;
  assert.equal(line, fake.window.activeTextEditor!.document.lineCount - 1);
  assert.deepEqual(fake.messages, []);
});

test('an existing daily note is opened and never written', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup(OBSIDIAN, { ...VAULT_FILES, 'Daily/2026-10-21.md': 'mine\r\n' });
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/Daily/2026-10-21.md`), 'mine\r\n');
  assert.deepEqual(fake.opened, [`${ROOT}/Daily/2026-10-21.md`]);
});

test('the Daily notes folder must exist (as in Obsidian); date-format subfolders are made', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let { run } = setup(OBSIDIAN, { 'Templates/일일.md': fixtureBytes('Templates/일일.md') });
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.files.has(`${ROOT}/Daily/2026-10-21.md`), false);
  assert.equal(fake.folders.has(`${ROOT}/Daily`), false);
  assert.match(fake.messages[0]!.text, /The folder "Daily" does not exist/);

  ({ run } = setup({ daily: '{"folder":"Daily","format":"YYYY/MM/YYYY-MM-DD"}' }, { 'Daily/.keep': '' }));
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/Daily/2026/10/2026-10-21.md`), '');
  assert.deepEqual(fake.messages, []);
});

test('another date: typed day, the template with that date and the current time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup({ ...OBSIDIAN, daily: fixture('daily-notes.json') }, VAULT_FILES);
  fake.answers.input.push('yesterday');
  await run('notewell.dailyNotes.openForDate');
  assert.equal(fake.readText(`${ROOT}/Daily/2026-10-20.md`), fixture('results/Daily/2026-10-21.md').replaceAll('2026-10-21', '2026-10-20'));
  fake.answers.input.push(undefined);
  await run('notewell.dailyNotes.openForDate');
  assert.equal(fake.opened.length, 1, 'dismissed: nothing');
});

test('template missing: no note, as in Obsidian; unsupported formats and bad paths create nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  // Obsidian looks only for the note with `.md` added, not for a file named as written.
  let { run } = setup({ daily: '{"folder":"Daily","template":"Templates/None"}' }, { 'Daily/.keep': '', 'Templates/None': 'not a note' });
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.files.has(`${ROOT}/Daily/2026-10-21.md`), false);
  assert.equal(fake.messages[0]!.level, 'error');
  assert.match(fake.messages[0]!.text, /template "Templates\/None\.md" was not found/);

  for (const daily of ['{"format":"LL"}', '{"format":"YYYY-MM-DD HH:mm"}', '{"folder":"../outside"}']) {
    ({ run } = setup({ daily }));
    await run('notewell.dailyNotes.openToday');
    assert.deepEqual([...fake.files.keys()], [], daily);
    assert.equal(fake.messages[0]!.level, 'error', daily);
  }
  ({ run } = setup({ daily: '{"template":"T"}' }, { 'T.md': '{{date}} {{date:Do LL}}' }));
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.files.has(`${ROOT}/2026-10-21.md`), false, 'template date format unsupported');
});

test('template bytes: CRLF and unknown variables kept, the BOM left out (as Obsidian); a folder link on the way is refused', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let { run } = setup({ daily: '{"template":"T.md"}' }, { 'T.md': new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# {{title}}\r\n{{tp.date}} <% x %>\r\n')]) });
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.files.get(`${ROOT}/2026-10-21.md`)![0], '#'.charCodeAt(0));
  assert.equal(fake.readText(`${ROOT}/2026-10-21.md`), '# 2026-10-21\r\n{{tp.date}} <% x %>\r\n');

  ({ run } = setup({ daily: '{"folder":"Linked"}' }));
  fake.links.add(`${ROOT}/Linked`);
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.files.size, 0);
  assert.match(fake.messages[0]!.text, /a folder on the way is a link/);
});

test('as Obsidian 1.14 measured: {{title}} is the formatted date with its subfolders, {{date}}/{{time}} use the default formats', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup(
    { daily: '{"folder":"Journal","format":"YYYY/MM-MMMM/YYYY-MM-DD ddd","template":"T"}', templates: '{"folder":"T","dateFormat":"DD.MM.YYYY","timeFormat":"HH:mm [h]"}' },
    { 'Journal/.keep': '', 'T.md': '# {{title}}\n{{date}} {{time}} {{DATE}} [{{date:}}]\n' },
  );
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/Journal/2026/10-October/2026-10-21 Wed.md`), '# 2026/10-October/2026-10-21 Wed\n2026-10-21 14:37 2026-10-21 [2026-10-21]\n');
});

test('no Daily notes folder: where new notes go, the vault root when that folder is missing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const app = '{"newFileLocation":"folder","newFileFolderPath":"Inbox"}';
  let { run } = setup({ app, daily: '{}' }, { 'Inbox/.keep': '' });
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/Inbox/2026-10-21.md`), '');
  ({ run } = setup({ app, daily: '{}' }));
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/2026-10-21.md`), '');
  assert.equal(fake.folders.has(`${ROOT}/Inbox`), false);
  // "Same folder as current file": Obsidian asks for the daily note's place without a current file.
  ({ run } = setup({ app: '{"newFileLocation":"current"}', daily: '{}' }, { 'Notes/n.md': '' }));
  editor('Notes/n.md', '');
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/2026-10-21.md`), '');
});

test('month and weekday names: the setting, else the VS Code language', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const daily = '{"format":"YYYY-MM-DD dddd","template":"T"}';
  const files = { 'T.md': '{{date:MMMM Do A}}' };
  let { run } = setup({ daily }, files);
  fake.env.language = 'ko';
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/2026-10-21 수요일.md`), '10월 21일 오후');
  ({ run } = setup({ daily }, files));
  fake.env.language = 'ko';
  fake.settings.set('notewell.dailyNotes.dateLanguage', 'en');
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.readText(`${ROOT}/2026-10-21 Wednesday.md`), 'October 21st PM');
  ({ run } = setup({ daily, templates: '{"dateFormat":"dddd"}' }, files));
  fake.settings.set('notewell.dailyNotes.dateLanguage', 'ko');
  const ed = editor('n.md', '');
  await run('notewell.templates.insertDate');
  assert.equal(ed.document.text, '수요일');
});

test('core plugin turned off: a notice once, the settings still used', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup({ daily: '{"format":"[off] YYYY-MM-DD"}', core: { dailyNotes: false } });
  await run('notewell.dailyNotes.openToday');
  await run('notewell.dailyNotes.openToday');
  assert.equal(fake.messages.filter((m) => m.text.includes('turned off')).length, 1);
  assert.ok(fake.files.has(`${ROOT}/off 2026-10-21.md`));
});

test('insert template: at the cursor or over the selection; only that range changes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup(OBSIDIAN, VAULT_FILES);
  const note = fixture('루트 노트.md');
  const selected = '같은 이름 시험 ';
  const start = note.indexOf(selected);
  const ed = editor('루트 노트.md', note, start, start + selected.length);
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  // Obsidian's result without the frontmatter it merged on top (daily-notes.md 9.5).
  assert.equal(`---\n날짜: 2026-10-21\n---\n${ed.document.text}`, fixture('results/루트 노트.md'));
  assert.match(fake.messages[0]!.text, /frontmatter was left out/);
  const inserted = ed.document.text.slice(start, ed.document.text.length - (note.length - start - selected.length));
  assert.equal(ed.document.offsetAt(ed.selection.start), start + inserted.length, 'cursor after the inserted text');
});

test('insert template: frontmatter kept at the start of a note without one; CRLF note bytes outside kept', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup(OBSIDIAN, VAULT_FILES);
  let ed = editor('n.md', 'tail\r\nline two\r\n', 0);
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  // The editor gives the inserted text the note's CRLF.
  assert.equal(ed.document.text, `${fixture('results/Daily/2026-10-21.md').replace('# 2026-10-21', '# n').replace(/\n/g, '\r\n')}tail\r\nline two\r\n`);
  assert.deepEqual(fake.messages, []);
  // The cursor is where the note's own text resumes, counted in lines (VS Code converts line endings).
  assert.deepEqual([ed.selection.start.line, ed.selection.start.character], [ed.document.lines.indexOf('tail'), 0]);

  // Select All over a note with frontmatter: it is replaced, so the template's frontmatter goes in.
  ed = editor('s.md', '---\na: 1\n---\nold\n', 0, '---\na: 1\n---\nold\n'.length);
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  assert.equal(ed.document.text, fixture('results/Daily/2026-10-21.md').replace('# 2026-10-21', '# s'));

  // At the start of a note with frontmatter: the body only, below the frontmatter (as Obsidian puts it).
  ed = editor('m.md', '---\na: 1\n---\nbody\n', 0);
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  assert.ok(ed.document.text.startsWith('---\na: 1\n---\n\n# m\n'), ed.document.text);
  assert.ok(ed.document.text.endsWith('\nbody\n'));
  assert.match(JSON.stringify(fake.messages.at(-1)), /frontmatter was left out/);
  ed = editor('end.md', '---\na: 1\n---', 0);
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  assert.equal(ed.document.text, '---\na: 1\n---\n\n# end\n\n- 시간: 14:37\n- 할 일:\n', 'frontmatter without a line after it');
});

test('insert template into a note without a line break: LF as Obsidian writes, unless files.eol says otherwise', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup(OBSIDIAN, { ...VAULT_FILES, 'Templates/여러 줄.md': 'a\nb\n' });
  let ed = editor('n.md', '');
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  assert.equal(ed.document.text, 'a\nb\n');
  fake.settings.set('files.eol', '\r\n');
  ed = editor('o.md', '');
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  assert.equal(ed.document.text, 'a\r\nb\r\n');
});

test('insert template: no folder set, no templates, dismissed pick, not a vault note', async () => {
  let { run } = setup({ templates: '{}' });
  let ed = editor('n.md', 'x');
  await run('notewell.templates.insert');
  assert.match(fake.messages[0]!.text, /Set the template folder/);
  ({ run } = setup({ templates: '{"folder":"Templates"}' }, { 'Templates/.keep': '' }));
  ed = editor('n.md', 'x');
  await run('notewell.templates.insert');
  assert.match(fake.messages[0]!.text, /has no notes/);
  ({ run } = setup(OBSIDIAN, VAULT_FILES));
  ed = editor('n.md', 'x');
  fake.answers.quickPick.push(undefined);
  await run('notewell.templates.insert');
  assert.equal(ed.document.text, 'x');
  const outside = new fake.TextDocument(fake.Uri.file('/elsewhere/n.md'), 'x');
  fake.window.activeTextEditor = new fake.TextEditor(outside);
  await run('notewell.templates.insert');
  assert.equal(outside.text, 'x');
  assert.match(fake.messages.at(-1)!.text, /Open a Markdown note of an Obsidian vault/);
});

test('insert current date and time at every cursor, in the Templates formats', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup({ templates: '{"dateFormat":"DD.MM.YYYY","timeFormat":"h:mm A"}' });
  const ed = editor('n.md', 'a b');
  ed.selections = [new fake.Selection(new fake.Position(0, 0), new fake.Position(0, 0)), new fake.Selection(new fake.Position(0, 2), new fake.Position(0, 3))];
  await run('notewell.templates.insertDate');
  assert.equal(ed.document.text, '21.10.2026a 21.10.2026');
  ed.selections = [new fake.Selection(new fake.Position(0, 0), new fake.Position(0, 0))];
  await run('notewell.templates.insertTime');
  assert.equal(ed.document.text, '2:37 PM21.10.2026a 21.10.2026');
});

test('missing notes: a link only on wikilinks to missing notes; Ctrl+click asks, then creates where Obsidian would', async () => {
  const text = '[[Exists]] [[Missing]] [md](Missing.md) [[photo.png]] [[Areas/Idea]] [[./Here]]';
  const cases: [string, string, Record<string, string>][] = [
    ['root', '{}', { Missing: 'Missing.md', 'Areas/Idea': 'Areas/Idea.md', './Here': 'Notes/Here.md' }],
    ['current', '{"newFileLocation":"current"}', { Missing: 'Notes/Missing.md', 'Areas/Idea': 'Areas/Idea.md', './Here': 'Notes/Here.md' }],
    ['folder', '{"newFileLocation":"folder","newFileFolderPath":"Inbox"}', { Missing: 'Inbox/Missing.md', 'Areas/Idea': 'Areas/Idea.md', './Here': 'Notes/Here.md' }],
    // Obsidian falls back to the vault root when the folder for new notes is missing (1.14, measured).
    ['folder missing', '{"newFileLocation":"folder","newFileFolderPath":"Nope"}', { Missing: 'Missing.md', 'Areas/Idea': 'Areas/Idea.md', './Here': 'Notes/Here.md' }],
  ];
  for (const [name, app, expected] of cases) {
    const { run } = setup({ app }, { 'Exists.md': '', 'Notes/n.md': text, 'Inbox/.keep': '', 'Areas/.keep': '' });
    const document = new fake.TextDocument(fake.Uri.file(`${ROOT}/Notes/n.md`), text);
    fake.textDocuments.push(document);
    const found = await fake.providers.links!.provideDocumentLinks(document);
    assert.deepEqual(found.map((l) => text.slice(l.range.start.character, l.range.end.character)), ['Missing', 'Areas/Idea', './Here'], name);
    for (const link of found) {
      const written = text.slice(link.range.start.character, link.range.end.character);
      assert.equal(link.target.scheme, 'command');
      assert.equal(link.target.path, 'notewell.notes.createFromLink');
      const args = JSON.parse(decodeURIComponent(link.target.query)) as unknown[];
      fake.answers.message.push('Create');
      await run('notewell.notes.createFromLink', ...args);
      assert.equal(fake.readText(`${ROOT}/${expected[written]}`), '', `${name} ${written}`);
      assert.equal(fake.opened.at(-1), `${ROOT}/${expected[written]}`);
      assert.match(fake.messages.at(-1)!.text, /does not exist\. Create it\?/);
    }
  }
});

test('missing notes: dismissed, setting never, missing folders, stale arguments', async () => {
  const text = '[[Missing]] [[New/Deep/Idea]]';
  let { run } = setup({}, { 'n.md': text });
  const document = new fake.TextDocument(fake.Uri.file(`${ROOT}/n.md`), text);
  fake.textDocuments.push(document);
  const [missing, inFolder] = await fake.providers.links!.provideDocumentLinks(document);
  const args = (link: InstanceType<typeof fake.DocumentLink>) => JSON.parse(decodeURIComponent(link.target.query)) as unknown[];
  fake.answers.message.push(undefined);
  await run('notewell.notes.createFromLink', ...args(missing!));
  assert.equal(fake.files.has(`${ROOT}/Missing.md`), false, 'dismissed');
  fake.answers.message.push('Create');
  await run('notewell.notes.createFromLink', ...args(inFolder!));
  assert.equal(fake.readText(`${ROOT}/New/Deep/Idea.md`), '', 'the folders a link names are made, as in Obsidian');
  assert.equal(fake.opened.at(-1), `${ROOT}/New/Deep/Idea.md`);
  // The link changed since the links were computed: nothing happens.
  document.text = 'other text';
  fake.answers.message.push('Create');
  await run('notewell.notes.createFromLink', ...args(missing!));
  assert.equal(fake.files.has(`${ROOT}/Missing.md`), false);
  await run('notewell.notes.createFromLink', 'not', 'valid');

  // A link computed before its note was made opens that note instead of doing nothing.
  ({ run } = setup({}, { 'n.md': text }));
  const again = new fake.TextDocument(fake.Uri.file(`${ROOT}/n.md`), text);
  fake.textDocuments.push(again);
  const [stale] = await fake.providers.links!.provideDocumentLinks(again);
  fake.writeText(`${ROOT}/Missing.md`, 'made elsewhere');
  await run('notewell.notes.createFromLink', ...args(stale!));
  assert.deepEqual([fake.opened, fake.readText(`${ROOT}/Missing.md`), fake.messages.length], [[`${ROOT}/Missing.md`], 'made elsewhere', 0]);

  // An unknown setting value still asks first.
  ({ run } = setup({}, { 'n.md': text }));
  fake.settings.set('notewell.links.createMissingNotes', 'always');
  const third = new fake.TextDocument(fake.Uri.file(`${ROOT}/n.md`), text);
  fake.textDocuments.push(third);
  fake.answers.message.push(undefined);
  await run('notewell.notes.createFromLink', ...args((await fake.providers.links!.provideDocumentLinks(third))[0]!));
  assert.equal(fake.files.has(`${ROOT}/Missing.md`), false);
  assert.equal(fake.messages.length, 1);

  ({ run } = setup({}, { 'n.md': text }));
  fake.settings.set('notewell.links.createMissingNotes', 'never');
  assert.deepEqual(await fake.providers.links!.provideDocumentLinks(new fake.TextDocument(fake.Uri.file(`${ROOT}/n.md`), text)), []);
  fake.settings.set('notewell.links.createMissingNotes', 'ask');
  fake.settings.set('notewell.links.enabled', false);
  assert.deepEqual(await fake.providers.links!.provideDocumentLinks(new fake.TextDocument(fake.Uri.file(`${ROOT}/n.md`), text)), []);
});

test('commands show only where Obsidian has the settings and the feature is on', () => {
  setup({ daily: '{}' });
  assert.equal(fake.context.get('notewell.dailyNotes.available'), true);
  assert.equal(fake.context.get('notewell.templates.available'), false);
  // The feature turned off in VS Code settings hides its commands.
  fake.settings.set('notewell.dailyNotes.enabled', false);
  fake.registered.clear();
  const vault = vaultOf({ daily: '{}', templates: '{}' });
  registerDailyNotes({ subscriptions: [] } as never, { vaults: () => ({ vaults: [vault], vaultFor: () => vault }) as never, vaultsChanged: new fake.EventEmitter<void>().event as never, links: () => undefined });
  assert.equal(fake.context.get('notewell.dailyNotes.available'), false);
  assert.equal(fake.context.get('notewell.templates.available'), true);
});

test('a feature turned off does nothing even when its command is run by a keybinding', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { run } = setup({ daily: '{}', templates: '{"folder":"T"}' }, { 'T/a.md': 'x' });
  fake.settings.set('notewell.dailyNotes.enabled', false);
  fake.settings.set('notewell.templates.enabled', false);
  await run('notewell.dailyNotes.openToday');
  const ed = editor('n.md', 'keep');
  fake.answers.quickPick.push(0);
  await run('notewell.templates.insert');
  await run('notewell.templates.insertDate');
  assert.equal(fake.files.has(`${ROOT}/2026-10-21.md`), false);
  assert.equal(ed.document.text, 'keep');
});
