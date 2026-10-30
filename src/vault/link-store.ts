// VS Code adapter for the link index (links.md 2.3): one LinkIndex per vault, built in the
// background after activation and kept current from file watchers, renames and editor text
// (also documents VS Code opens in the background to apply edits, such as our own link updates
// on rename, which stay unsaved). Read-only by design: it reads files (workspace.fs.readFile,
// stat, findFiles) and never writes, deletes or renames anything, and keeps nothing on disk.
import * as vscode from 'vscode';
import { LinkIndex } from './link-index.ts';
import { CASE_INSENSITIVE_FS, vaultRelativePath } from './uri-paths.ts';

/** Files read at once while building. */
const READ_BATCH = 64;
const isMarkdown = (path: string): boolean => /\.md$/i.test(path);

interface VaultState {
  readonly root: vscode.Uri;
  index: LinkIndex | undefined;
  readonly ready: Promise<void>;
  readonly disposables: vscode.Disposable[];
  /** Changes that arrived while the index was being built, applied after it. */
  readonly queued: (() => Promise<void>)[];
  disposed: boolean;
}

export interface LinkStoreOptions {
  /** Current vault roots (VaultRegistry.vaults' roots). */
  readonly roots: () => readonly vscode.Uri[];
  /** Fires when vaults appear or go (VaultRegistry.onDidChange). */
  readonly onDidChangeRoots: vscode.Event<void>;
}

export class LinkStore implements vscode.Disposable {
  readonly #options: LinkStoreOptions;
  readonly #vaults = new Map<string, VaultState>();
  readonly #disposables: vscode.Disposable[] = [];
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  /** Fires with a vault root after its index was built or changed. */
  readonly onDidChange: vscode.Event<vscode.Uri> = this.#changed.event;

  constructor(options: LinkStoreOptions) {
    this.#options = options;
    this.#disposables.push(
      options.onDidChangeRoots(() => this.#sync()),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const { oldUri, newUri } of event.files) this.#run(oldUri, () => this.#renamed(oldUri, newUri));
      }),
      // Editor text wins over the disk. A workspace edit to a closed file (link updates on
      // rename) may arrive as the open of an already edited document, with no change event.
      vscode.workspace.onDidOpenTextDocument((document) => this.#document(document)),
      // Every change counts, also one that makes the document clean again (undo, revert).
      vscode.workspace.onDidChangeTextDocument((event) => this.#document(event.document)),
      // An unsaved edit was discarded: read the file again.
      vscode.workspace.onDidCloseTextDocument((document) => this.#run(document.uri, () => this.#reread(document.uri))),
    );
    this.#sync();
  }

  /** The vault's index, or undefined while it is still being built (or outside any vault). */
  indexFor(uri: vscode.Uri): { root: vscode.Uri; index: LinkIndex } | undefined {
    const state = this.#stateFor(uri);
    return state?.index === undefined ? undefined : { root: state.root, index: state.index };
  }

  /** Resolves once every vault's first index is built (tests, first use). */
  async ready(): Promise<void> {
    await Promise.all([...this.#vaults.values()].map((s) => s.ready));
  }

  /** Reads `uri` again (editor text or disk), e.g. after finding it changed unnoticed. */
  refresh(uri: vscode.Uri): void {
    this.#run(uri, () => this.#reread(uri));
  }

  /** The path of `uri` relative to its vault root, if inside one. */
  relativePath(uri: vscode.Uri): string | undefined {
    const state = this.#stateFor(uri);
    return state === undefined ? undefined : vaultRelativePath(state.root, uri);
  }

  dispose(): void {
    for (const state of this.#vaults.values()) this.#disposeVault(state);
    this.#vaults.clear();
    for (const d of this.#disposables) d.dispose();
    this.#changed.dispose();
  }

  #stateFor(uri: vscode.Uri): VaultState | undefined {
    let best: VaultState | undefined;
    for (const state of this.#vaults.values()) {
      if (vaultRelativePath(state.root, uri) !== undefined && (best === undefined || state.root.path.length > best.root.path.length)) best = state;
    }
    return best;
  }

  #sync(): void {
    const roots = this.#options.roots();
    const keep = new Set(roots.map((r) => r.toString()));
    const changed: vscode.Uri[] = [];
    for (const [key, state] of this.#vaults) {
      if (!keep.has(key)) {
        this.#disposeVault(state);
        this.#vaults.delete(key);
        changed.push(state.root);
      }
    }
    for (const root of roots) if (!this.#vaults.has(root.toString())) changed.push(root);
    // A vault that appeared or went inside another changes which files the outer one holds:
    // the outer vault is indexed again.
    for (const [key, state] of this.#vaults) {
      if (changed.some((root) => root.toString() !== key && vaultRelativePath(state.root, root) !== undefined)) {
        this.#disposeVault(state);
        this.#vaults.delete(key);
      }
    }
    for (const root of roots) {
      const key = root.toString();
      if (!this.#vaults.has(key)) this.#vaults.set(key, this.#startVault(root));
    }
  }

  /** Whether `path` (relative to `root`) lies in a vault nested inside `root`: it belongs to that vault. */
  #inNestedVault(root: vscode.Uri, uri: vscode.Uri): boolean {
    return this.#options.roots().some((other) => other.toString() !== root.toString() && vaultRelativePath(root, other) !== undefined && vaultRelativePath(other, uri) !== undefined);
  }

  #startVault(root: vscode.Uri): VaultState {
    const disposables: vscode.Disposable[] = [];
    const state: VaultState = { root, index: undefined, ready: Promise.resolve(), disposables, queued: [], disposed: false };
    const run = (task: () => Promise<void>): void => this.#runIn(state, task);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    disposables.push(
      watcher,
      watcher.onDidCreate((uri) => run(() => this.#reread(uri))),
      watcher.onDidChange((uri) => run(() => this.#reread(uri))),
      // A deleted folder may be reported alone, without the files in it. The delete may also run
      // behind a create of the same path (save by replace, git checkout): read what is there now.
      watcher.onDidDelete((uri) => run(() => this.#reread(uri))),
    );
    // Built after activation returns (never blocks it).
    (state as { ready: Promise<void> }).ready = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'));
      const paths = uris
        .filter((uri) => !this.#inNestedVault(root, uri))
        .map((uri) => vaultRelativePath(root, uri))
        .filter((p): p is string => p !== undefined);
      const texts = new Map<string, string>();
      const markdown = paths.filter(isMarkdown);
      for (let i = 0; i < markdown.length; i += READ_BATCH) {
        if (state.disposed) return;
        await Promise.all(
          markdown.slice(i, i + READ_BATCH).map(async (path) => {
            const text = await readText(vscode.Uri.joinPath(root, ...path.split('/')));
            if (text !== undefined) texts.set(path, text);
          }),
        );
      }
      if (state.disposed) return;
      state.index = LinkIndex.build(paths, (path) => texts.get(path));
      for (const task of state.queued.splice(0)) await task();
      this.#changed.fire(root);
    });
    return state;
  }

  #disposeVault(state: VaultState): void {
    state.disposed = true;
    for (const d of state.disposables) d.dispose();
  }

  /** Runs `task` for the vault holding `uri`: now, or after its index is built. */
  #run(uri: vscode.Uri, task: () => Promise<void>): void {
    const state = this.#stateFor(uri);
    if (state !== undefined) this.#runIn(state, task);
  }

  #runIn(state: VaultState, task: () => Promise<void>): void {
    if (state.disposed) return;
    if (state.index === undefined) state.queued.push(task);
    else void task();
  }

  /** Indexes an editor document's text, read when applied (so always the latest). */
  #document(document: vscode.TextDocument): void {
    const state = this.#stateFor(document.uri);
    const path = state === undefined ? undefined : vaultRelativePath(state.root, document.uri);
    if (state === undefined || path === undefined || !isMarkdown(path)) return;
    this.#runIn(state, async () => {
      // An event that arrives after its editor closed (the file moved or was deleted meanwhile)
      // must not bring the old path back: only open documents count.
      if (document.isClosed === true || !vscode.workspace.textDocuments.includes(document)) return;
      this.#apply(document.uri, (index) => index.setFile(path, document.getText()));
    });
  }

  /** Applies a change to the index of the vault holding `uri`. */
  #apply(uri: vscode.Uri, change: (index: LinkIndex, path: string) => void): void {
    const state = this.#stateFor(uri);
    const path = state === undefined ? undefined : vaultRelativePath(state.root, uri);
    if (state?.index === undefined || path === undefined) return;
    change(state.index, path);
    this.#changed.fire(state.root);
  }

  /** Reads `uri` again: a file, a folder (every file under it) or nothing (removed). */
  async #reread(uri: vscode.Uri): Promise<void> {
    const state = this.#stateFor(uri);
    const path = state === undefined ? undefined : vaultRelativePath(state.root, uri);
    if (state === undefined || path === undefined) return;
    const type = await fileType(uri);
    if (type === undefined) {
      this.#apply(uri, (index) => removeTree(index, path));
      return;
    }
    if ((type & vscode.FileType.Directory) !== 0) {
      for (const file of await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'))) await this.#reread(file);
      return;
    }
    if (!isMarkdown(path)) {
      this.#apply(uri, (index) => index.setFile(path));
      return;
    }
    const text = await readText(uri);
    if (text === undefined) this.#apply(uri, (index) => index.removeFile(path));
    else this.#apply(uri, (index) => index.setFile(path, text));
  }

  async #renamed(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const state = this.#stateFor(oldUri) ?? this.#stateFor(newUri);
    if (state?.index === undefined) return;
    const index = state.index;
    const oldPath = vaultRelativePath(state.root, oldUri);
    // Moved into another (for example a nested) vault: it leaves this index and joins that one.
    const newPath = this.#stateFor(newUri) === state ? vaultRelativePath(state.root, newUri) : undefined;
    if (newPath === undefined && this.#stateFor(newUri) !== undefined) {
      if (oldPath !== undefined) this.#apply(oldUri, (i) => removeTree(i, oldPath));
      await this.#reread(newUri);
      return;
    }
    // A folder rename moves every file under it.
    const moved = oldPath === undefined ? [] : [...index.files()].filter((p) => p === oldPath || p.startsWith(`${oldPath}/`));
    if (moved.length === 0) {
      // Watcher or document events got there first and dropped the old entries.
      if (newPath !== undefined) await this.#reread(newUri);
      return;
    }
    for (const path of moved) {
      const target = newPath === undefined ? undefined : `${newPath}${path.slice(oldPath!.length)}`;
      if (target === undefined) {
        index.removeFile(path);
        continue;
      }
      // Watcher events may run behind: a file deleted before the move is not at the new place
      // either, and must not come back there.
      const targetUri = vscode.Uri.joinPath(state.root, ...target.split('/'));
      const targetType = await fileType(targetUri);
      const text = targetType !== undefined && isMarkdown(target) ? await readText(targetUri) : undefined;
      // Other events ran during the awaits: a file created again at the old path stays.
      const oldThere = (await fileType(vscode.Uri.joinPath(state.root, ...path.split('/')))) !== undefined;
      if (!oldThere) index.removeFile(path);
      if (targetType !== undefined) index.setFile(target, text);
    }
    this.#changed.fire(state.root);
  }
}

/** Removes `path` and, when it was a folder, every file under it. */
function removeTree(index: LinkIndex, path: string): void {
  const key = (p: string): string => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
  const gone = key(path);
  for (const file of [...index.files()]) {
    const k = key(file);
    if (k === gone || k.startsWith(`${gone}/`)) index.removeFile(file);
  }
}

/** The file type, or undefined when nothing is there. */
async function fileType(uri: vscode.Uri): Promise<vscode.FileType | undefined> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type;
  } catch {
    return undefined;
  }
}

/** Unsaved editor text wins (as everywhere); otherwise the file on disk. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
  if (open?.isDirty === true) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}
