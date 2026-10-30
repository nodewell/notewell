// VS Code adapter: reads a vault's appearance.json, theme.css and enabled snippets
// (core.md 3.6) and reports changes. Read-only like the rest of src/vault: only
// workspace.fs.readFile (pinned by test/vault/source-rules.test.ts).
import * as vscode from 'vscode';
import { DEFAULT_APPEARANCE, parseAppearance, type ObsidianAppearance, type ThemeSources } from './appearance.ts';
import { OBSIDIAN_DIR } from './paths.ts';

/** Larger CSS files are ignored (a theme is typically well under this). */
export const MAX_CSS_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;

export interface VaultAppearance extends ThemeSources {
  readonly appearance: ObsidianAppearance;
}

export interface AppearanceStoreOptions {
  /** Called once per vault while its appearance.json cannot be parsed (defaults are used meanwhile). */
  readonly onBrokenAppearance: (root: vscode.Uri, error: string) => void;
}

/** The vault root path of a file inside `<root>/.obsidian/`, or undefined. */
export function vaultRootOfObsidianFile(path: string): string | undefined {
  const at = path.lastIndexOf(`/${OBSIDIAN_DIR}/`);
  return at === -1 ? undefined : path.slice(0, at);
}

async function readText(uri: vscode.Uri, limit: number): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > limit) return undefined;
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

export class AppearanceStore implements vscode.Disposable {
  readonly #options: AppearanceStoreOptions;
  readonly #cache = new Map<string, Promise<VaultAppearance>>();
  readonly #warned = new Set<string>();
  readonly #changed = new vscode.EventEmitter<string>();
  readonly #disposables: vscode.Disposable[] = [];

  /** Fires with the vault root path whose appearance, theme or snippets changed. */
  readonly onDidChange: vscode.Event<string> = this.#changed.event;

  constructor(options: AppearanceStoreOptions) {
    this.#options = options;
    const globs = [`**/${OBSIDIAN_DIR}/appearance.json`, `**/${OBSIDIAN_DIR}/themes/*/theme.css`, `**/${OBSIDIAN_DIR}/snippets/*.css`];
    for (const glob of globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      const changed = (uri: vscode.Uri): void => this.#invalidate(uri.path);
      this.#disposables.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed));
    }
  }

  /** The vault's appearance and readable theme sources; cached until a watched file changes. */
  appearanceFor(root: vscode.Uri): Promise<VaultAppearance> {
    const key = root.path;
    let entry = this.#cache.get(key);
    if (entry === undefined) {
      entry = this.#read(root);
      this.#cache.set(key, entry);
    }
    return entry;
  }

  dispose(): void {
    for (const d of this.#disposables) d.dispose();
    this.#changed.dispose();
    this.#cache.clear();
  }

  #invalidate(path: string): void {
    const root = vaultRootOfObsidianFile(path);
    if (root === undefined) return;
    this.#cache.delete(root);
    this.#changed.fire(root);
  }

  async #read(root: vscode.Uri): Promise<VaultAppearance> {
    const dir = vscode.Uri.joinPath(root, OBSIDIAN_DIR);
    const text = await readText(vscode.Uri.joinPath(dir, 'appearance.json'), MAX_JSON_BYTES);
    const result = parseAppearance(text);
    if (result.error === undefined) {
      this.#warned.delete(root.path);
    } else if (!this.#warned.has(root.path)) {
      this.#warned.add(root.path);
      this.#options.onBrokenAppearance(root, result.error);
    }
    const appearance = result.error === undefined ? result.appearance : DEFAULT_APPEARANCE;
    // Each layer is optional: a missing or unreadable file skips only that layer.
    const themeCss =
      appearance.cssTheme === '' ? undefined : await readText(vscode.Uri.joinPath(dir, 'themes', appearance.cssTheme, 'theme.css'), MAX_CSS_BYTES);
    const snippetCss: string[] = [];
    for (const name of appearance.enabledCssSnippets) {
      const css = await readText(vscode.Uri.joinPath(dir, 'snippets', `${name}.css`), MAX_CSS_BYTES);
      if (css !== undefined) snippetCss.push(css);
    }
    return { appearance, ...(themeCss === undefined ? {} : { themeCss }), snippetCss };
  }
}
