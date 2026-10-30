// Minimal in-memory stand-in for the `vscode` module, covering what src/vault/registry.ts uses.
// Loaded in place of `vscode` by registry.test.ts through a module resolve hook.

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  #listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>) => {
    this.#listeners.add(listener);
    return { dispose: () => void this.#listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const l of [...this.#listeners]) l(value);
  }
  dispose(): void {
    this.#listeners.clear();
  }
}

export class Uri {
  readonly authority = '';
  readonly scheme: string;
  readonly path: string;
  private constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/'));
  }
  with(change: { path?: string }): Uri {
    return new Uri(this.scheme, change.path ?? this.path);
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class FileSystemError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** In-memory files: path -> content. Tests mutate this and fire watcher events. */
export const files = new Map<string, string>();

type WatchKind = 'create' | 'change' | 'delete';
const watchers: { glob: string; emitters: Record<WatchKind, EventEmitter<Uri>> }[] = [];

function globMatches(glob: string, path: string): boolean {
  if (glob === '**/.obsidian') return path.endsWith('/.obsidian');
  if (glob === '**/.obsidian/*') return /\/\.obsidian\/[^/]+$/.test(path);
  // Appearance watchers (src/vault/appearance-store.ts).
  if (glob === '**/.obsidian/appearance.json') return path.endsWith('/.obsidian/appearance.json');
  // Kanban plugin board defaults (src/vault/registry.ts).
  if (glob === '**/.obsidian/plugins/obsidian-kanban/data.json') return path.endsWith('/.obsidian/plugins/obsidian-kanban/data.json');
  if (glob === '**/.obsidian/plugins/nldates-obsidian/data.json') return path.endsWith('/.obsidian/plugins/nldates-obsidian/data.json');
  if (glob === '**/.obsidian/themes/*/theme.css') return /\/\.obsidian\/themes\/[^/]+\/theme\.css$/.test(path);
  if (glob === '**/.obsidian/snippets/*.css') return /\/\.obsidian\/snippets\/[^/]+\.css$/.test(path);
  throw new Error(`fake vscode: unsupported glob ${glob}`);
}

/** Simulates a file system event as VS Code's watcher would report it. */
export function fireWatcher(kind: WatchKind, path: string): void {
  for (const w of watchers) if (globMatches(w.glob, path)) w.emitters[kind].fire(Uri.file(path));
}

export const fileOps = { renamed: new EventEmitter<unknown>(), deleted: new EventEmitter<unknown>() };
export const workspaceFolders = new EventEmitter<unknown>();

export const workspace = {
  createFileSystemWatcher(glob: string) {
    const emitters = { create: new EventEmitter<Uri>(), change: new EventEmitter<Uri>(), delete: new EventEmitter<Uri>() };
    watchers.push({ glob, emitters });
    return {
      onDidCreate: emitters.create.event,
      onDidChange: emitters.change.event,
      onDidDelete: emitters.delete.event,
      dispose: () => void watchers.splice(watchers.findIndex((w) => w.emitters === emitters), 1),
    };
  },
  async findFiles(include: string, exclude: unknown): Promise<Uri[]> {
    if (exclude !== null) throw new Error('fake vscode: registry must bypass files.exclude');
    return [...files.keys()].filter((p) => globMatches(include, p)).map((p) => Uri.file(p));
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const text = files.get(uri.path);
      if (text === undefined) throw new FileSystemError(uri.path, 'FileNotFound');
      return new TextEncoder().encode(text);
    },
  },
  onDidRenameFiles: fileOps.renamed.event,
  onDidDeleteFiles: fileOps.deleted.event,
  onDidChangeWorkspaceFolders: workspaceFolders.event,
};

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
