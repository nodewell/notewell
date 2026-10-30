// Parsing of `.obsidian/app.json` (core.md 3.2). No VS Code API.
// Missing or invalid keys fall back to Obsidian's defaults; Notewell never writes this file.

export type NewLinkFormat = 'shortest' | 'relative' | 'absolute';

export interface ObsidianAppSettings {
  /** true: new links are written as `[text](path)`; false: as `[[wikilinks]]`. */
  readonly useMarkdownLinks: boolean;
  readonly newLinkFormat: NewLinkFormat;
  /**
   * Raw value as stored by Obsidian (`/` is believed to mean the vault root).
   * Interpreting it is left to the attachments feature (v0.2).
   */
  readonly attachmentFolderPath: string;
  /** Excluded-files entries as written by Obsidian (path prefixes or `/regex/`). */
  readonly userIgnoreFilters: readonly string[];
  /** Editor "Indent using tabs": true -> new indentation is a tab, false -> 4 spaces. */
  readonly useTab: boolean;
  /**
   * "Automatically update internal links" (links.md 3.3; key name confidence low). Undefined
   * when app.json does not say: the default is unconfirmed (10 #1), so callers ask.
   */
  readonly alwaysUpdateLinks: boolean | undefined;
  /** "Default location for new notes" (daily-notes.md 6): vault folder, same folder as the current file, or below. */
  readonly newFileLocation: NewFileLocation;
  /** The folder for `newFileLocation: 'folder'`, as written by Obsidian. */
  readonly newFileFolderPath: string;
}

export type NewFileLocation = 'root' | 'current' | 'folder';

export const DEFAULT_APP_SETTINGS: ObsidianAppSettings = Object.freeze({
  useMarkdownLinks: false,
  newLinkFormat: 'shortest',
  attachmentFolderPath: '/',
  userIgnoreFilters: Object.freeze([]) as readonly string[],
  useTab: true,
  alwaysUpdateLinks: undefined,
  newFileLocation: 'root',
  newFileFolderPath: '',
});

const LINK_FORMATS: readonly string[] = ['shortest', 'relative', 'absolute'];
const NEW_FILE_LOCATIONS: readonly string[] = ['root', 'current', 'folder'];

export interface AppSettingsResult {
  readonly settings: ObsidianAppSettings;
  /** Set when the file exists but is not a JSON object; settings are then the defaults. */
  readonly error?: string;
}

/**
 * Parses app.json text. `undefined` means the file does not exist, which is
 * normal for a fresh vault. Keys with an unexpected type use the default.
 */
export function parseAppSettings(text: string | undefined): AppSettingsResult {
  if (text === undefined) return { settings: DEFAULT_APP_SETTINGS };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return { settings: DEFAULT_APP_SETTINGS };

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return { settings: DEFAULT_APP_SETTINGS, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { settings: DEFAULT_APP_SETTINGS, error: 'app.json is not a JSON object' };
  }

  const raw = data as Record<string, unknown>;
  const d = DEFAULT_APP_SETTINGS;
  const linkFormat = raw['newLinkFormat'];
  const ignore = raw['userIgnoreFilters'];
  return {
    settings: Object.freeze({
      useMarkdownLinks: typeof raw['useMarkdownLinks'] === 'boolean' ? raw['useMarkdownLinks'] : d.useMarkdownLinks,
      newLinkFormat:
        typeof linkFormat === 'string' && LINK_FORMATS.includes(linkFormat)
          ? (linkFormat as NewLinkFormat)
          : d.newLinkFormat,
      attachmentFolderPath:
        typeof raw['attachmentFolderPath'] === 'string' ? raw['attachmentFolderPath'] : d.attachmentFolderPath,
      userIgnoreFilters: Array.isArray(ignore)
        ? Object.freeze(ignore.filter((v): v is string => typeof v === 'string'))
        : d.userIgnoreFilters,
      useTab: typeof raw['useTab'] === 'boolean' ? raw['useTab'] : d.useTab,
      alwaysUpdateLinks: typeof raw['alwaysUpdateLinks'] === 'boolean' ? raw['alwaysUpdateLinks'] : d.alwaysUpdateLinks,
      newFileLocation:
        typeof raw['newFileLocation'] === 'string' && NEW_FILE_LOCATIONS.includes(raw['newFileLocation'])
          ? (raw['newFileLocation'] as NewFileLocation)
          : d.newFileLocation,
      newFileFolderPath: typeof raw['newFileFolderPath'] === 'string' ? raw['newFileFolderPath'] : d.newFileFolderPath,
    }),
  };
}

/** `.obsidian/daily-notes.json` (daily-notes.md 2). Paths are as written; checking them is the caller's. */
export interface DailyNotesSettings {
  /** Folder of daily notes from the vault root; '' is the vault root. */
  readonly folder: string;
  readonly format: string;
  /** Template note, often written without `.md`; '' means none. */
  readonly template: string;
}

export const DEFAULT_DAILY_NOTES_SETTINGS: DailyNotesSettings = Object.freeze({ folder: '', format: 'YYYY-MM-DD', template: '' });

/** `.obsidian/templates.json` (daily-notes.md 2). */
export interface TemplatesSettings {
  /** Template folder; '' means not set (the template command then asks to set it in Obsidian). */
  readonly folder: string;
  readonly dateFormat: string;
  readonly timeFormat: string;
}

export const DEFAULT_TEMPLATES_SETTINGS: TemplatesSettings = Object.freeze({ folder: '', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' });

export interface SettingsFileResult<T> {
  readonly settings: T;
  /** Set when the file exists but is not a JSON object; settings are then the defaults. */
  readonly error?: string;
}

/** Parses a settings file of a core plugin: string keys only, empty strings mean the default. */
function parsePluginSettings<T extends object>(text: string, defaults: T): SettingsFileResult<T> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return { settings: defaults };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return { settings: defaults, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { settings: defaults, error: 'not a JSON object' };
  const raw = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const value = raw[name];
    out[name] = typeof value === 'string' && value.trim() !== '' ? value : fallback;
  }
  return { settings: Object.freeze(out) as T };
}

export function parseDailyNotesSettings(text: string): SettingsFileResult<DailyNotesSettings> {
  return parsePluginSettings(text, DEFAULT_DAILY_NOTES_SETTINGS);
}

export function parseTemplatesSettings(text: string): SettingsFileResult<TemplatesSettings> {
  return parsePluginSettings(text, DEFAULT_TEMPLATES_SETTINGS);
}

/**
 * Whether a core plugin is on in `.obsidian/core-plugins.json` (an object of id -> enabled, or
 * an older list of enabled ids). Undefined when the file is missing or unreadable.
 */
export function corePluginEnabled(text: string | undefined, id: string): boolean | undefined {
  const object = jsonObject(text);
  if (object !== undefined) return object[id] === true;
  const list = jsonArray(text);
  return list === undefined ? undefined : list.includes(id);
}

/**
 * Tracks which vaults have already been warned about a broken app.json.
 * A vault warns once while broken; a successful read re-arms it.
 */
export class BrokenSettingsWarnings {
  readonly #warned = new Set<string>();

  /** Returns true when a warning should be shown for this read. */
  record(vaultKey: string, result: { readonly error?: string }): boolean {
    if (result.error === undefined) {
      this.#warned.delete(vaultKey);
      return false;
    }
    if (this.#warned.has(vaultKey)) return false;
    this.#warned.add(vaultKey);
    return true;
  }

  forget(vaultKey: string): void {
    this.#warned.delete(vaultKey);
  }
}

/** Board defaults of the Kanban community plugin (`.obsidian/plugins/obsidian-kanban/data.json`). */
export interface KanbanPluginSettings {
  /** "Display card checkbox" for boards that do not set `show-checkboxes` themselves (kanban.md 2.9). */
  readonly showCheckboxes: boolean | undefined;
  /** "List width" for boards that do not set `lane-width` themselves, as `laneWidthValue` reads it. */
  readonly laneWidth: number | null | undefined;
  /**
   * Other board defaults: the plugin's own settings, and for `dateFormat` Obsidian's fallback
   * (Daily notes, Natural Language Dates, Templates) when the plugin sets none.
   */
  readonly defaults: KanbanPluginDefaults;
}

export const DEFAULT_KANBAN_PLUGIN_SETTINGS: KanbanPluginSettings = Object.freeze({ showCheckboxes: undefined, laneWidth: undefined, defaults: Object.freeze({}) });

/**
 * A `lane-width` value as Obsidian Kanban 2.0.51 uses it (read from the plugin code 2026-10-30):
 * the lane gets `<value>px`, so a positive number or a string of digits is a width; anything
 * else (0, text, `true`, null) leaves the plugin's own 272px. Null means "set but not a width".
 */
export function laneWidthValue(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Parses the Kanban plugin's data.json. A missing, broken or unexpected file means "no
 * defaults" (Obsidian then hides checkboxes); it is never reported, as it is not Obsidian's own.
 */
export function parseKanbanPluginSettings(text: string | undefined): KanbanPluginSettings {
  if (text === undefined) return DEFAULT_KANBAN_PLUGIN_SETTINGS;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return DEFAULT_KANBAN_PLUGIN_SETTINGS;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return DEFAULT_KANBAN_PLUGIN_SETTINGS;
  const show = (data as Record<string, unknown>)['show-checkboxes'];
  const width = (data as Record<string, unknown>)['lane-width'];
  return Object.freeze({
    showCheckboxes: typeof show === 'boolean' ? show : undefined,
    laneWidth: width === undefined ? undefined : laneWidthValue(width),
    defaults: Object.freeze(parseKanbanPluginDefaults(body)),
  });
}

/** Board defaults of the Kanban plugin beyond check boxes, from its data.json (kanban.md 2.9). */
export interface KanbanPluginDefaults {
  readonly dateFormat?: string;
  readonly dateTrigger?: string;
  readonly timeTrigger?: string;
  readonly linkDateToDailyNote?: boolean;
}

/** The files Obsidian Kanban falls back on for its date format, as read (undefined: missing). */
export interface DateFormatSources {
  /** `.obsidian/core-plugins.json`: an object of id -> enabled, or (older) a list of enabled ids. */
  readonly corePlugins?: string;
  readonly dailyNotes?: string;
  readonly templates?: string;
  /** `.obsidian/community-plugins.json`: the list of enabled community plugins. */
  readonly communityPlugins?: string;
  /** `.obsidian/plugins/nldates-obsidian/data.json` (Natural Language Dates). */
  readonly nldates?: string;
}

function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function jsonArray(text: string | undefined): unknown[] | undefined {
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * The date format Obsidian Kanban 2.0.51 uses when neither the board nor the plugin settings
 * set one (its `ja()`, read from the plugin code 2026-10-21): the Daily notes format when that
 * core plugin is on, else the Natural Language Dates format, else the Templates date format
 * when that core plugin is on. Undefined when none applies (then `YYYY-MM-DD`).
 */
export function obsidianDefaultDateFormat(sources: DateFormatSources): string | undefined {
  const core = sources.corePlugins;
  const coreObject = jsonObject(core);
  const coreList = coreObject === undefined ? jsonArray(core) : undefined;
  // Without the file Obsidian's defaults apply; both plugins are on by default.
  const coreOn = (id: string): boolean =>
    coreObject !== undefined ? coreObject[id] === true : coreList !== undefined ? coreList.includes(id) : true;
  const daily = coreOn('daily-notes') ? nonEmpty(jsonObject(sources.dailyNotes)?.['format']) : undefined;
  if (daily !== undefined) return daily;
  const nldatesOn = jsonArray(sources.communityPlugins)?.includes('nldates-obsidian') === true;
  const nldates = nldatesOn ? nonEmpty(jsonObject(sources.nldates)?.['format']) : undefined;
  if (nldates !== undefined) return nldates;
  return coreOn('templates') ? nonEmpty(jsonObject(sources.templates)?.['dateFormat']) : undefined;
}

/** The Kanban plugin's own board defaults from its data.json; keys with another type are ignored. */
export function parseKanbanPluginDefaults(text: string | undefined): KanbanPluginDefaults {
  const data = jsonObject(text);
  if (data === undefined) return {};
  const linkDate = data['link-date-to-daily-note'];
  return {
    ...(nonEmpty(data['date-format']) === undefined ? {} : { dateFormat: data['date-format'] as string }),
    ...(typeof data['date-trigger'] === 'string' ? { dateTrigger: data['date-trigger'] } : {}),
    ...(nonEmpty(data['time-trigger']) === undefined ? {} : { timeTrigger: data['time-trigger'] as string }),
    ...(typeof linkDate === 'boolean' ? { linkDateToDailyNote: linkDate } : {}),
  };
}
