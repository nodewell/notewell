// Daily notes, templates and notes for missing link targets (daily-notes.md 4-6), as Obsidian's
// Daily notes and Templates core plugins make them. New files only: an existing file is opened,
// never written. Templates go into the open editor as one undoable edit and are not saved.
import * as vscode from 'vscode';
import { findFrontmatter } from '../../core/frontmatter.ts';
import { formatDate, type DateLocale } from '../../core/date-format.ts';
import { BOM } from '../../core/lines.ts';
import { renderTemplate } from '../../core/template.ts';
import { extractLinks, type LinkRef } from '../../vault/link-index.ts';
import type { LinkStore } from '../../vault/link-store.ts';
import type { LinkResolution } from '../../vault/links.ts';
import { newNotePath, vaultPath } from '../../vault/new-file.ts';
import { checkNewFile } from '../../vault/new-file-check.ts';
import type { Vault, VaultRegistry } from '../../vault/registry.ts';
import { DEFAULT_DAILY_NOTES_SETTINGS, DEFAULT_TEMPLATES_SETTINGS, type ObsidianAppSettings, type TemplatesSettings } from '../../vault/settings.ts';
import { vaultRelativePath } from '../../vault/uri-paths.ts';
import { atTimeOf, dailyNotePath, noteTitle, parseDateInput, templateInsertion, templatePath } from './model.ts';

export interface DailyNotesDependencies {
  readonly vaults: () => VaultRegistry | undefined;
  readonly vaultsChanged: vscode.Event<void>;
  readonly links: () => LinkStore | undefined;
}

const CREATE_FROM_LINK = 'notewell.notes.createFromLink';
const SELECTOR: vscode.DocumentSelector = { language: 'markdown' };
const uriOf = (root: vscode.Uri, path: string): vscode.Uri => vscode.Uri.joinPath(root, ...path.split('/').filter((s) => s !== ''));

function enabled(section: 'dailyNotes' | 'templates', scope?: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration(`notewell.${section}`, scope).get<boolean>('enabled', true);
}

/**
 * Language of month and weekday names (daily-notes.md 3). Obsidian uses its app language, which
 * is not stored in the vault, so it is a Notewell setting; `auto` follows VS Code's language.
 */
function dateLocale(scope: vscode.Uri): DateLocale {
  const chosen = vscode.workspace.getConfiguration('notewell.dailyNotes', scope).get<string>('dateLanguage', 'auto');
  if (chosen === 'en' || chosen === 'ko') return chosen;
  return vscode.env.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function createMissingNotes(scope: vscode.Uri): boolean {
  const config = vscode.workspace.getConfiguration('notewell.links', scope);
  return config.get<boolean>('enabled', true) && config.get<string>('createMissingNotes', 'ask') !== 'never';
}

/** Daily notes are offered where Obsidian has their settings file (daily-notes.md 1.4, 9.2). */
const hasDailyNotes = (vault: Vault): boolean => vault.dailyNotes !== undefined && enabled('dailyNotes', vault.root);
const hasTemplates = (vault: Vault): boolean => vault.templates !== undefined && enabled('templates', vault.root);

/** The file of the active editor or editor tab (also a Kanban board or canvas). */
function activeUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined) return editor.document.uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

/** The active file's vault when it qualifies, else the only qualifying vault, else the user's choice. */
async function chooseVault(registry: VaultRegistry | undefined, qualifies: (vault: Vault) => boolean): Promise<Vault | undefined> {
  if (registry === undefined) return undefined;
  const uri = activeUri();
  const active = uri === undefined ? undefined : registry.vaultFor(uri);
  if (active !== undefined && qualifies(active)) return active;
  const vaults = registry.vaults.filter(qualifies);
  if (vaults.length <= 1) return vaults[0];
  const picked = await vscode.window.showQuickPick(
    vaults.map((vault) => ({ label: vscode.workspace.asRelativePath(vault.root, true), vault })),
    { placeHolder: vscode.l10n.t('Choose a vault') },
  );
  return picked?.vault;
}

async function readUtf8(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function isType(uri: vscode.Uri, type: vscode.FileType): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & type) !== 0;
  } catch {
    return false;
  }
}

/**
 * Where Obsidian puts a new note that has no folder of its own: "Default location for new
 * notes", but the vault root when that folder does not exist (1.14, measured).
 */
async function newNoteSettings(vault: Vault): Promise<ObsidianAppSettings> {
  const settings = vault.settings;
  if (settings.newFileLocation !== 'folder') return settings;
  const folder = vaultPath(settings.newFileFolderPath);
  if (folder !== undefined && folder !== '' && (await isType(uriOf(vault.root, folder), vscode.FileType.Directory))) return settings;
  return { ...settings, newFileLocation: 'root' };
}

type Created = { readonly kind: 'created' | 'exists' } | { readonly kind: 'refused' } | { readonly kind: 'noFolder'; readonly folder: string };

/**
 * Makes `path` in the vault with `text` as its bytes (UTF-8, line breaks as given), or reports
 * that a file is there already. Missing folders are made only where `mayMakeFolder` allows. The
 * place is checked again right before the write (8). Written to disk directly: as a workspace
 * edit, Undo in the new note would go on to delete it without asking (measured in VS Code).
 */
async function createFile(root: vscode.Uri, path: string, text: string, mayMakeFolder: (folder: string) => boolean): Promise<Created> {
  const check = await checkNewFile(root, path);
  if (check.kind !== 'ready') return check;
  const refused = check.missingFolders.find((folder) => !mayMakeFolder(folder));
  if (refused !== undefined) return { kind: 'noFolder', folder: refused };
  for (const folder of check.missingFolders) await vscode.workspace.fs.createDirectory(uriOf(root, folder));
  const again = await checkNewFile(root, path);
  if (again.kind !== 'ready') return again;
  await vscode.workspace.fs.writeFile(uriOf(root, path), new TextEncoder().encode(text));
  return { kind: 'created' };
}

async function open(uri: vscode.Uri, atEnd: boolean): Promise<void> {
  const editor = await vscode.window.showTextDocument(uri);
  if (!atEnd) return;
  const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  editor.revealRange(new vscode.Range(end, end));
}

function reportCreateFailure(result: Created, path: string): void {
  if (result.kind === 'noFolder') {
    void vscode.window.showErrorMessage(vscode.l10n.t('The folder "{0}" does not exist. Create it first, then try again.', result.folder));
  } else if (result.kind === 'refused') {
    void vscode.window.showErrorMessage(vscode.l10n.t('"{0}" could not be created: a folder on the way is a link or a file.', path));
  }
}

/** Core plugins turned off in Obsidian: said once per vault and session (9.2). */
const offNoticeShown = new Set<string>();
function noticeIfOff(vault: Vault, plugin: 'dailyNotes' | 'templates'): void {
  const id = `${plugin}:${vault.root.toString()}`;
  if (vault.corePlugins[plugin] !== false || offNoticeShown.has(id)) return;
  offNoticeShown.add(id);
  const message =
    plugin === 'dailyNotes'
      ? vscode.l10n.t('The Daily notes core plugin is turned off in this vault. Notewell uses its settings anyway.')
      : vscode.l10n.t('The Templates core plugin is turned off in this vault. Notewell uses its settings anyway.');
  void vscode.window.showInformationMessage(message);
}

function formatError(format: string, token: string): void {
  void vscode.window.showErrorMessage(vscode.l10n.t('The date format "{0}" is not supported (token "{1}"). Nothing was created or inserted.', format, token));
}

async function openDailyNote(registry: VaultRegistry | undefined, date: Date): Promise<void> {
  const vault = await chooseVault(registry, hasDailyNotes);
  if (vault === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No vault with Obsidian Daily notes settings was found.'));
    return;
  }
  noticeIfOff(vault, 'dailyNotes');
  const settings = vault.dailyNotes ?? DEFAULT_DAILY_NOTES_SETTINGS;
  const locale = dateLocale(vault.root);
  // Without a folder setting, Obsidian puts the daily note where new notes go (1.14, measured).
  let folder = settings.folder;
  if (folder === '') {
    const app = await newNoteSettings(vault);
    if (app.newFileLocation === 'folder') folder = app.newFileFolderPath;
  }
  const target = dailyNotePath({ ...settings, folder }, date, locale);
  if (!target.ok) {
    if (target.reason === 'format') formatError(settings.format, target.token);
    else void vscode.window.showErrorMessage(vscode.l10n.t('"{0}" is not a valid note path in this vault.', target.path));
    return;
  }
  const uri = uriOf(vault.root, target.path);
  const check = await checkNewFile(vault.root, target.path);
  if (check.kind === 'exists') return open(uri, false);

  let text = '';
  if (settings.template.trim() !== '') {
    const path = templatePath(settings.template);
    const templateUri = path === undefined ? undefined : uriOf(vault.root, path);
    const template = templateUri !== undefined && (await isType(templateUri, vscode.FileType.File)) ? await readUtf8(templateUri) : undefined;
    if (template === undefined) {
      // Obsidian then makes no note either (1.14, measured).
      void vscode.window.showErrorMessage(vscode.l10n.t('The daily note was not created: the template "{0}" was not found or is not UTF-8 text.', path ?? settings.template));
      return;
    }
    // As in Obsidian (1.14, measured): the template's BOM is left out, `{{title}}` is the formatted
    // date with its subfolders, and `{{date}}`/`{{time}}` use the default formats, not the
    // Templates settings.
    const rendered = renderTemplate(template.startsWith(BOM) ? template.slice(BOM.length) : template, {
      title: target.title,
      now: atTimeOf(date, new Date()),
      dateFormat: DEFAULT_TEMPLATES_SETTINGS.dateFormat,
      timeFormat: DEFAULT_TEMPLATES_SETTINGS.timeFormat,
      locale,
    });
    if (!rendered.ok) return formatError(rendered.format, rendered.token);
    text = rendered.text;
  }
  // Obsidian makes the date-format subfolders but not the Daily notes folder itself (0, measured).
  const result = await createFile(vault.root, target.path, text, (folder) => folder !== target.folder && folder.startsWith(target.folder === '' ? '' : `${target.folder}/`));
  if (result.kind === 'created' || result.kind === 'exists') return open(uri, result.kind === 'created');
  reportCreateFailure(result, target.path);
}

function dateWords() {
  return {
    today: ['today', vscode.l10n.t('today')],
    yesterday: ['yesterday', vscode.l10n.t('yesterday')],
    tomorrow: ['tomorrow', vscode.l10n.t('tomorrow')],
  };
}

/** The active Markdown editor of a vault note, with its vault's Templates settings. */
function templateTarget(registry: VaultRegistry | undefined): { editor: vscode.TextEditor; vault: Vault; path: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  const vault = editor === undefined ? undefined : registry?.vaultFor(editor.document.uri);
  const path = vault === undefined || editor === undefined ? undefined : vaultRelativePath(vault.root, editor.document.uri);
  // A keybinding still reaches the command when the feature is off: it then does nothing.
  if (vault !== undefined && !enabled('templates', vault.root)) return undefined;
  if (editor === undefined || vault === undefined || path === undefined || editor.document.languageId !== 'markdown') {
    void vscode.window.showInformationMessage(vscode.l10n.t('Open a Markdown note of an Obsidian vault first.'));
    return undefined;
  }
  return { editor, vault, path };
}

async function insertTemplate(registry: VaultRegistry | undefined): Promise<void> {
  const target = templateTarget(registry);
  if (target === undefined) return;
  const { editor, vault, path } = target;
  noticeIfOff(vault, 'templates');
  const settings: TemplatesSettings = vault.templates ?? DEFAULT_TEMPLATES_SETTINGS;
  const folder = vaultPath(settings.folder);
  if (settings.folder.trim() === '' || folder === undefined || folder === '') {
    void vscode.window.showInformationMessage(vscode.l10n.t('Set the template folder location in Obsidian (Settings → Templates) first.'));
    return;
  }
  const folderUri = uriOf(vault.root, folder);
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folderUri, '**/*.md'), null);
  const items = found
    .map((uri) => ({ uri, relative: vaultRelativePath(folderUri, uri) }))
    .filter((t): t is { uri: vscode.Uri; relative: string } => t.relative !== undefined)
    .sort((a, b) => a.relative.localeCompare(b.relative))
    .map(({ uri, relative }) => ({ label: relative.replace(/\.md$/i, ''), uri }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('The template folder "{0}" has no notes.', folder));
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Choose a template') });
  if (picked === undefined) return;
  const template = await readUtf8(picked.uri);
  if (template === undefined) {
    void vscode.window.showErrorMessage(vscode.l10n.t('The template "{0}" could not be read as UTF-8 text.', picked.label));
    return;
  }
  const rendered = renderTemplate(template, { title: noteTitle(path), now: new Date(), dateFormat: settings.dateFormat, timeFormat: settings.timeFormat, locale: dateLocale(vault.root) });
  if (!rendered.ok) return formatError(rendered.format, rendered.token);
  const document = editor.document;
  const selection = editor.selection;
  const texts: string[] = [];
  for (let i = 0; i < document.lineCount; i++) texts.push(document.lineAt(i).text);
  const atStart = selection.start.line === 0 && selection.start.character === 0;
  const frontmatter = findFrontmatter(texts);
  // A selection from the start over the whole frontmatter replaces it: the note then has none.
  const replaced = frontmatter !== null && atStart && selection.end.line > frontmatter.closeLine;
  const insertion = templateInsertion(rendered.text, { hasFrontmatter: frontmatter !== null && !replaced, atStart });
  // At the very start of a note with frontmatter the template goes below the frontmatter, as in
  // Obsidian (1.14, measured): in front of it, the note's frontmatter would stop being one.
  let range: vscode.Range = selection;
  let text = insertion.text;
  if (frontmatter !== null && !replaced && atStart) {
    const next = frontmatter.closeLine + 1;
    if (next < document.lineCount) range = new vscode.Range(next, 0, next, 0);
    else {
      const end = document.lineAt(frontmatter.closeLine).range.end;
      range = new vscode.Range(end, end);
      text = `\n${text}`;
    }
  }
  // A note without a line break yet would take VS Code's default (CRLF on Windows); Obsidian
  // writes LF. An explicit `files.eol` setting is left to VS Code.
  const lf = document.lineCount === 1 && /\n/.test(text) && vscode.workspace.getConfiguration('files', document.uri).get<string>('eol', 'auto') === 'auto';
  const start = range.start;
  const edited = editor.edit((builder) => {
    if (lf) builder.setEndOfLine(vscode.EndOfLine.LF);
    builder.replace(range, text);
  });
  // The editor may have been closed while the template was being picked.
  if (!(await edited.then((ok) => ok, () => false))) return;
  // The editor writes the text with the note's line endings: count lines, not characters.
  const lines = text.split(/\r\n|\n/);
  const last = lines[lines.length - 1]!;
  const end = new vscode.Position(start.line + lines.length - 1, (lines.length === 1 ? start.character : 0) + last.length);
  editor.selection = new vscode.Selection(end, end);
  if (insertion.droppedFrontmatter) {
    void vscode.window.showInformationMessage(vscode.l10n.t("The template's frontmatter was left out: it can only go at the start of a note without frontmatter."));
  }
}

async function insertNow(registry: VaultRegistry | undefined, kind: 'date' | 'time'): Promise<void> {
  const target = templateTarget(registry);
  if (target === undefined) return;
  const settings = target.vault.templates ?? DEFAULT_TEMPLATES_SETTINGS;
  const format = kind === 'date' ? settings.dateFormat : settings.timeFormat;
  const text = formatDate(new Date(), format, dateLocale(target.vault.root));
  if (!text.ok) return formatError(format, text.token);
  const { editor } = target;
  await editor.edit((builder) => {
    for (const selection of editor.selections) builder.replace(selection, text.text);
  });
}

/** Wikilinks to missing notes in a vault note, which Ctrl+click can create (6). */
interface LinkContext {
  readonly root: vscode.Uri;
  readonly vault: Vault;
  readonly from: string;
  readonly resolve: (link: LinkRef) => LinkResolution;
}

/** The note's vault and link index, when both agree on the vault root. */
function linkContext(deps: DailyNotesDependencies, document: vscode.TextDocument): LinkContext | undefined {
  if (document.uri.scheme === 'untitled' || !createMissingNotes(document.uri)) return undefined;
  const store = deps.links();
  const found = store?.indexFor(document.uri);
  const from = store?.relativePath(document.uri);
  const vault = deps.vaults()?.vaultFor(document.uri);
  if (found === undefined || from === undefined || vault === undefined || found.root.toString() !== vault.root.toString()) return undefined;
  return { root: found.root, vault, from, resolve: (link) => found.index.resolver.resolve({ form: link.form, path: link.path }, from) };
}

/** Wikilinks to missing notes in a vault note, which Ctrl+click can create (6). */
async function missingLinks(deps: DailyNotesDependencies, document: vscode.TextDocument): Promise<{ link: LinkRef; path: string }[]> {
  const context = linkContext(deps, document);
  if (context === undefined) return [];
  const links = extractLinks(document.getText()).filter((link) => link.form === 'wikilink' && link.path !== '' && context.resolve(link).kind === 'missing');
  if (links.length === 0) return [];
  const settings = await newNoteSettings(context.vault);
  const out: { link: LinkRef; path: string }[] = [];
  for (const link of links) {
    const path = newNotePath(settings, context.from, link.path);
    if (path !== undefined) out.push({ link, path });
  }
  return out;
}

async function createFromLink(deps: DailyNotesDependencies, args: unknown): Promise<void> {
  if (!Array.isArray(args) || typeof args[0] !== 'string' || !Number.isInteger(args[1]) || !Number.isInteger(args[2])) return;
  let documentUri: vscode.Uri;
  try {
    documentUri = vscode.Uri.parse(args[0], true);
  } catch {
    return;
  }
  const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === documentUri.toString());
  const context = document === undefined ? undefined : linkContext(deps, document);
  if (document === undefined || context === undefined) return;
  // Looked up again from the current text: the link must still be there.
  const link = extractLinks(document.getText()).find((l) => l.form === 'wikilink' && l.line === args[1] && l.pathStart === args[2]);
  if (link === undefined) return;
  // Links are only recomputed on edits: one whose note exists by now just opens it.
  const resolution = context.resolve(link);
  if (resolution.kind === 'found') return open(uriOf(context.root, resolution.path), false);
  const path = resolution.kind === 'missing' ? newNotePath(await newNoteSettings(context.vault), context.from, link.path) : undefined;
  if (path === undefined) return;
  // Only `ask` and `never` exist; anything but `never` (which offers no links) asks.
  const create = vscode.l10n.t('Create');
  const answer = await vscode.window.showInformationMessage(vscode.l10n.t('The note "{0}" does not exist. Create it?', path), create);
  if (answer !== create) return;
  // Obsidian makes the folders a link names (1.14, measured).
  const result = await createFile(context.root, path, '', () => true);
  if (result.kind === 'created' || result.kind === 'exists') return open(uriOf(context.root, path), false);
  reportCreateFailure(result, path);
}

export function registerDailyNotes(context: vscode.ExtensionContext, deps: DailyNotesDependencies): void {
  const updateContext = (): void => {
    const vaults = deps.vaults()?.vaults ?? [];
    void vscode.commands.executeCommand('setContext', 'notewell.dailyNotes.available', vaults.some(hasDailyNotes));
    void vscode.commands.executeCommand('setContext', 'notewell.templates.available', vaults.some(hasTemplates));
  };
  updateContext();

  const linkProvider: vscode.DocumentLinkProvider = {
    async provideDocumentLinks(document) {
      return (await missingLinks(deps, document)).map(({ link, path }) => {
        const args = encodeURIComponent(JSON.stringify([document.uri.toString(), link.line, link.pathStart]));
        const item = new vscode.DocumentLink(new vscode.Range(link.line, link.pathStart, link.line, link.pathEnd), vscode.Uri.parse(`command:${CREATE_FROM_LINK}?${args}`));
        item.tooltip = vscode.l10n.t('Create the note "{0}"', path);
        return item;
      });
    },
  };

  context.subscriptions.push(
    deps.vaultsChanged(updateContext),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('notewell.dailyNotes') || e.affectsConfiguration('notewell.templates')) updateContext();
    }),
    vscode.commands.registerCommand('notewell.dailyNotes.openToday', () => openDailyNote(deps.vaults(), new Date())),
    vscode.commands.registerCommand('notewell.dailyNotes.openForDate', async () => {
      const words = dateWords();
      const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Date of the daily note: YYYY-MM-DD, today, yesterday or tomorrow'),
        value: (() => {
          const today = formatDate(new Date(), 'YYYY-MM-DD');
          return today.ok ? today.text : '';
        })(),
        validateInput: (text) => (parseDateInput(text, new Date(), words) === undefined ? vscode.l10n.t('Type a date as YYYY-MM-DD, or today, yesterday or tomorrow.') : undefined),
      });
      if (input === undefined) return;
      const date = parseDateInput(input, new Date(), words);
      if (date !== undefined) await openDailyNote(deps.vaults(), date);
    }),
    vscode.commands.registerCommand('notewell.templates.insert', () => insertTemplate(deps.vaults())),
    vscode.commands.registerCommand('notewell.templates.insertDate', () => insertNow(deps.vaults(), 'date')),
    vscode.commands.registerCommand('notewell.templates.insertTime', () => insertNow(deps.vaults(), 'time')),
    vscode.commands.registerCommand(CREATE_FROM_LINK, (...args: unknown[]) => createFromLink(deps, args)),
    vscode.languages.registerDocumentLinkProvider(SELECTOR, linkProvider),
  );
}
