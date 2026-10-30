// VS Code adapter: finds vaults in the workspace, reads their app.json (and the Kanban
// plugin's board defaults) and keeps them up to date. Read-only by design: this module never writes, deletes or
// renames anything (pinned by test/vault/source-rules.test.ts).
import * as vscode from 'vscode';
import { createVaultIndex, OBSIDIAN_DIR, vaultRootsFromObsidianPaths, type VaultIndex } from './paths.ts';
import {
  BrokenSettingsWarnings,
  corePluginEnabled,
  DEFAULT_APP_SETTINGS,
  DEFAULT_KANBAN_PLUGIN_SETTINGS,
  parseAppSettings,
  parseDailyNotesSettings,
  parseTemplatesSettings,
  obsidianDefaultDateFormat,
  parseKanbanPluginSettings,
  type DateFormatSources,
  type AppSettingsResult,
  type DailyNotesSettings,
  type KanbanPluginSettings,
  type ObsidianAppSettings,
  type SettingsFileResult,
  type TemplatesSettings,
} from './settings.ts';
import { CASE_INSENSITIVE_FS } from './uri-paths.ts';

export interface Vault {
  readonly root: vscode.Uri;
  readonly settings: ObsidianAppSettings;
  /** Board defaults of the Kanban community plugin (kanban.md 2.9). */
  readonly kanbanPlugin: KanbanPluginSettings;
  /** Daily notes settings (daily-notes.md 2); undefined when `daily-notes.json` does not exist. */
  readonly dailyNotes: DailyNotesSettings | undefined;
  /** Templates settings; undefined when `templates.json` does not exist. */
  readonly templates: TemplatesSettings | undefined;
  /** Whether the core plugins are on (core-plugins.json); undefined when unknown. */
  readonly corePlugins: { readonly dailyNotes: boolean | undefined; readonly templates: boolean | undefined };
}

/** The Kanban plugin's settings file, relative to the `.obsidian` folder. */
const KANBAN_PLUGIN_DATA = 'plugins/obsidian-kanban/data.json';
/** Natural Language Dates settings, one of Obsidian Kanban's date format fallbacks. */
const NLDATES_DATA = 'plugins/nldates-obsidian/data.json';
/** Files in `.obsidian` that the settings here are read from (a change re-reads the vault). */
const SETTINGS_FILES = ['app.json', 'core-plugins.json', 'daily-notes.json', 'templates.json', 'community-plugins.json'];

export interface VaultRegistryOptions {
  /** Called once per vault while its app.json cannot be parsed (defaults are used meanwhile). */
  readonly onBrokenSettings: (root: vscode.Uri, error: string) => void;
}

const RESCAN_DELAY_MS = 300;

export class VaultRegistry implements vscode.Disposable {
  readonly #options: VaultRegistryOptions;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #changed = new vscode.EventEmitter<void>();
  readonly #warnings = new BrokenSettingsWarnings();
  #index: VaultIndex = createVaultIndex([], { caseInsensitive: CASE_INSENSITIVE_FS });
  #vaults = new Map<string, Vault>();
  #rescanTimer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  /** Fires after vaults are added or removed, or a vault's settings change. */
  readonly onDidChange: vscode.Event<void> = this.#changed.event;

  private constructor(options: VaultRegistryOptions) {
    this.#options = options;
  }

  static async create(options: VaultRegistryOptions): Promise<VaultRegistry> {
    const registry = new VaultRegistry(options);
    registry.#watch();
    await registry.#rescan();
    return registry;
  }

  /** The closest enclosing vault of a file, or undefined outside any vault. */
  vaultFor(uri: vscode.Uri): Vault | undefined {
    if (uri.scheme === 'untitled') return undefined;
    const root = this.#index.vaultOf(uri.path);
    return root === undefined ? undefined : this.#vaults.get(root);
  }

  /** Settings for a file: its vault's, or Obsidian defaults outside a vault. */
  settingsFor(uri: vscode.Uri): ObsidianAppSettings {
    return this.vaultFor(uri)?.settings ?? DEFAULT_APP_SETTINGS;
  }

  /** Kanban plugin board defaults for a file: its vault's, or none outside a vault. */
  kanbanPluginFor(uri: vscode.Uri): KanbanPluginSettings {
    return this.vaultFor(uri)?.kanbanPlugin ?? DEFAULT_KANBAN_PLUGIN_SETTINGS;
  }

  get vaults(): readonly Vault[] {
    return [...this.#vaults.values()];
  }

  dispose(): void {
    if (this.#rescanTimer !== undefined) clearTimeout(this.#rescanTimer);
    this.#generation++;
    for (const d of this.#disposables) d.dispose();
    this.#changed.dispose();
  }

  #watch(): void {
    const folderWatcher = vscode.workspace.createFileSystemWatcher(`**/${OBSIDIAN_DIR}`);
    const fileWatcher = vscode.workspace.createFileSystemWatcher(`**/${OBSIDIAN_DIR}/*`);
    const pluginWatchers = [KANBAN_PLUGIN_DATA, NLDATES_DATA].map((file) => vscode.workspace.createFileSystemWatcher(`**/${OBSIDIAN_DIR}/${file}`));
    const reloadPlugin = (uri: vscode.Uri): void => {
      const root = this.#knownRootOf(uri, KANBAN_PLUGIN_DATA) ?? this.#knownRootOf(uri, NLDATES_DATA);
      if (root !== undefined) void this.#reloadSettings(root);
    };
    const settingsRoot = (uri: vscode.Uri): string | undefined => {
      for (const file of SETTINGS_FILES) {
        const root = this.#knownRootOf(uri, file);
        if (root !== undefined) return root;
      }
      return undefined;
    };
    const rescan = (): void => this.#scheduleRescan();
    const onFileEvent = (uri: vscode.Uri): void => {
      const root = settingsRoot(uri);
      if (root !== undefined) void this.#reloadSettings(root);
      else rescan();
    };
    this.#disposables.push(
      folderWatcher,
      fileWatcher,
      ...pluginWatchers,
      ...pluginWatchers.flatMap((w) => [w.onDidCreate(reloadPlugin), w.onDidChange(reloadPlugin), w.onDidDelete(reloadPlugin)]),
      folderWatcher.onDidCreate(rescan),
      folderWatcher.onDidDelete(rescan),
      fileWatcher.onDidCreate(onFileEvent),
      fileWatcher.onDidDelete(onFileEvent),
      fileWatcher.onDidChange((uri) => {
        const root = settingsRoot(uri);
        if (root !== undefined) void this.#reloadSettings(root);
      }),
      // Renames/deletes of parent folders made inside VS Code.
      vscode.workspace.onDidRenameFiles(rescan),
      vscode.workspace.onDidDeleteFiles(rescan),
      vscode.workspace.onDidChangeWorkspaceFolders(rescan),
    );
  }

  /** Key of the known vault whose `.obsidian/<file>` this is, if any. */
  #knownRootOf(uri: vscode.Uri, file: string): string | undefined {
    const suffix = `/${OBSIDIAN_DIR}/${file}`;
    if (!uri.path.endsWith(suffix)) return undefined;
    // `<root>/.obsidian` itself, so files below plugin folders map to their vault too.
    const root = vaultRootsFromObsidianPaths([uri.path.slice(0, uri.path.length - file.length - 1)])[0];
    if (root === undefined) return undefined;
    const known = this.#index.vaultOf(root);
    // vaultOf returns an ancestor or the same path; same length means the same root.
    return known !== undefined && known.length === root.length ? known : undefined;
  }

  #scheduleRescan(): void {
    if (this.#rescanTimer !== undefined) clearTimeout(this.#rescanTimer);
    this.#rescanTimer = setTimeout(() => {
      this.#rescanTimer = undefined;
      void this.#rescan();
    }, RESCAN_DELAY_MS);
  }

  async #rescan(): Promise<void> {
    const generation = ++this.#generation;
    // Exclude `null`: find `.obsidian` even when the user hides it with files.exclude.
    const found = await vscode.workspace.findFiles(`**/${OBSIDIAN_DIR}/*`, null);
    if (generation !== this.#generation) return;

    const index = createVaultIndex(vaultRootsFromObsidianPaths(found.map((uri) => uri.path)), {
      caseInsensitive: CASE_INSENSITIVE_FS,
    });
    // Keep scheme and authority of the workspace (local or remote) for each root.
    const rootUris = new Map<string, vscode.Uri>();
    for (const uri of found) {
      const root = index.vaultOf(uri.path);
      if (root !== undefined && !rootUris.has(root)) rootUris.set(root, uri.with({ path: root }));
    }

    const next = new Map<string, Vault>();
    await Promise.all(
      [...rootUris].map(async ([root, rootUri]) => {
        next.set(root, await this.#readVault(root, rootUri));
      }),
    );
    if (generation !== this.#generation) return;

    for (const old of this.#vaults.keys()) {
      if (next.has(old)) continue;
      for (const id of [old, `${old}/${OBSIDIAN_DIR}/daily-notes.json`, `${old}/${OBSIDIAN_DIR}/templates.json`]) this.#warnings.forget(id);
    }
    this.#index = index;
    this.#vaults = next;
    this.#changed.fire();
  }

  async #reloadSettings(root: string): Promise<void> {
    const vault = this.#vaults.get(root);
    if (vault === undefined) return;
    const next = await this.#readVault(root, vault.root);
    if (this.#vaults.get(root) !== vault) return;
    this.#vaults.set(root, next);
    this.#changed.fire();
  }

  async #readVault(root: string, rootUri: vscode.Uri): Promise<Vault> {
    const [settings, kanbanPlugin, plugins] = await Promise.all([
      this.#readSettings(root, rootUri),
      this.#readKanbanPlugin(rootUri),
      this.#readCorePluginSettings(root, rootUri),
    ]);
    return { root: rootUri, settings, kanbanPlugin, ...plugins };
  }

  /**
   * Daily notes and Templates settings (daily-notes.md 2): a missing file stays undefined, a
   * broken one gives the defaults and warns once per file until it reads again.
   */
  async #readCorePluginSettings(root: string, rootUri: vscode.Uri): Promise<Pick<Vault, 'dailyNotes' | 'templates' | 'corePlugins'>> {
    const read = async (file: string): Promise<string | undefined> => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, OBSIDIAN_DIR, file)));
      } catch {
        return undefined;
      }
    };
    const [daily, templates, core] = await Promise.all(['daily-notes.json', 'templates.json', 'core-plugins.json'].map(read));
    const checked = <T>(file: string, result: SettingsFileResult<T>): T => {
      if (this.#warnings.record(`${root}/${OBSIDIAN_DIR}/${file}`, result)) this.#options.onBrokenSettings(rootUri, `${file}: ${result.error}`);
      return result.settings;
    };
    // A removed file re-arms its warning, like a good read.
    if (daily === undefined) this.#warnings.forget(`${root}/${OBSIDIAN_DIR}/daily-notes.json`);
    if (templates === undefined) this.#warnings.forget(`${root}/${OBSIDIAN_DIR}/templates.json`);
    return {
      dailyNotes: daily === undefined ? undefined : checked('daily-notes.json', parseDailyNotesSettings(daily)),
      templates: templates === undefined ? undefined : checked('templates.json', parseTemplatesSettings(templates)),
      corePlugins: { dailyNotes: corePluginEnabled(core, 'daily-notes'), templates: corePluginEnabled(core, 'templates') },
    };
  }

  /**
   * The Kanban plugin's board defaults (kanban.md 2.9), with Obsidian's date format fallback when
   * the plugin sets none. A file that cannot be read counts as missing.
   */
  async #readKanbanPlugin(rootUri: vscode.Uri): Promise<KanbanPluginSettings> {
    const read = async (file: string): Promise<string | undefined> => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, OBSIDIAN_DIR, ...file.split('/'))));
      } catch {
        return undefined;
      }
    };
    const [data, corePlugins, dailyNotes, templates, communityPlugins, nldates] = await Promise.all(
      [KANBAN_PLUGIN_DATA, 'core-plugins.json', 'daily-notes.json', 'templates.json', 'community-plugins.json', NLDATES_DATA].map(read),
    );
    const plugin = parseKanbanPluginSettings(data);
    if (plugin.defaults.dateFormat !== undefined) return plugin;
    const sources: DateFormatSources = { corePlugins, dailyNotes, templates, communityPlugins, nldates };
    const fallback = obsidianDefaultDateFormat(sources);
    return fallback === undefined ? plugin : Object.freeze({ ...plugin, defaults: Object.freeze({ ...plugin.defaults, dateFormat: fallback }) });
  }

  async #readSettings(root: string, rootUri: vscode.Uri): Promise<ObsidianAppSettings> {
    const appJson = vscode.Uri.joinPath(rootUri, OBSIDIAN_DIR, 'app.json');
    let result: AppSettingsResult;
    try {
      result = parseAppSettings(new TextDecoder().decode(await vscode.workspace.fs.readFile(appJson)));
    } catch (err) {
      result =
        err instanceof vscode.FileSystemError && err.code === 'FileNotFound'
          ? parseAppSettings(undefined)
          : { settings: DEFAULT_APP_SETTINGS, error: String(err) };
    }
    if (result.error !== undefined && this.#warnings.record(root, result)) {
      this.#options.onBrokenSettings(rootUri, result.error);
    } else if (result.error === undefined) {
      this.#warnings.record(root, result);
    }
    return result.settings;
  }
}
