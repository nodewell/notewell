// Minimal in-memory stand-in for the `vscode` module, covering what src/features/backlog/project.ts
// uses. Loaded in place of `vscode` by project.test.ts through a module resolve hook.
// Based on test/vault/fake-vscode.ts, extended with relative patterns, directories,
// workspace folders and text documents.

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
  /** As VS Code on this platform would give it to Node: the path as written. */
  get fsPath(): string {
    return this.path;
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

export class RelativePattern {
  readonly baseUri: Uri;
  readonly pattern: string;
  constructor(base: Uri, pattern: string) {
    this.baseUri = base;
    this.pattern = pattern;
  }
}

export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 } as const;

export class FileSystemError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** In-memory files: path -> content. Directories are implied by file paths. */
export const files = new Map<string, string>();

/** Paths that are symbolic links (or junctions); listings and stat report SymbolicLink with the target's type. */
export const links = new Set<string>();

/** FNV-1a of the text: a stand-in modification time that changes with the content. */
function contentStamp(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** File sizes stat reports instead of the stored text's (a huge file without its bytes). */
export const sizes = new Map<string, number>();

/** Counts reads per path, so tests can check that only changed files are read again. */
export const reads = new Map<string, number>();

/** Glob subset: `*`, `**`, `{a,b}`. */
function globRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      // `**/` matches zero or more folders, as in VS Code (`**/*` includes root files).
      out += '(?:.*/)?';
      i += 2;
    } else if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '{') out += '(?:';
    else if (ch === '}') out += ')';
    else if (ch === ',') out += '|';
    else out += ch.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

type WatchKind = 'create' | 'change' | 'delete';
const watchers: { base: string; regex: RegExp; emitters: Record<WatchKind, EventEmitter<Uri>> }[] = [];

/** Simulates a file system event as VS Code's watcher would report it. */
export function fireWatcher(kind: WatchKind, path: string): void {
  for (const w of [...watchers]) {
    if (path.startsWith(`${w.base}/`) && w.regex.test(path.slice(w.base.length + 1))) w.emitters[kind].fire(Uri.file(path));
  }
}

export function watcherCount(): number {
  return watchers.length;
}

export interface FakeDocument {
  readonly uri: Uri;
  text: string;
  /** True after editDocument (unsaved changes), as in VS Code. */
  isDirty?: boolean;
  /** The encoding VS Code decoded the file with ('utf8' unless a test says otherwise). */
  encoding?: string;
  getText(): string;
}

export const textDocuments: FakeDocument[] = [];
export const documentEvents = { changed: new EventEmitter<{ document: FakeDocument }>(), closed: new EventEmitter<FakeDocument>() };

export function openDocument(path: string, text: string): FakeDocument {
  const doc: FakeDocument = { uri: Uri.file(path), text, encoding: 'utf8', getText: () => doc.text };
  textDocuments.push(doc);
  return doc;
}

export function editDocument(doc: FakeDocument, text: string): void {
  doc.text = text;
  doc.isDirty = true;
  documentEvents.changed.fire({ document: doc });
}

export function closeDocument(doc: FakeDocument): void {
  textDocuments.splice(textDocuments.indexOf(doc), 1);
  documentEvents.closed.fire(doc);
}

export const folderEvents = new EventEmitter<unknown>();

export const workspace = {
  workspaceFolders: [] as { uri: Uri; name: string; index: number }[],
  textDocuments,
  createFileSystemWatcher(pattern: RelativePattern) {
    if (!(pattern instanceof RelativePattern)) throw new Error('fake vscode: project.ts watches relative patterns only');
    const emitters = { create: new EventEmitter<Uri>(), change: new EventEmitter<Uri>(), delete: new EventEmitter<Uri>() };
    const entry = { base: pattern.baseUri.path, regex: globRegex(pattern.pattern), emitters };
    watchers.push(entry);
    return {
      onDidCreate: emitters.create.event,
      onDidChange: emitters.change.event,
      onDidDelete: emitters.delete.event,
      dispose: () => void watchers.splice(watchers.indexOf(entry), 1),
    };
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      reads.set(uri.path, (reads.get(uri.path) ?? 0) + 1);
      const text = files.get(uri.path);
      if (text === undefined) throw new FileSystemError(uri.path, 'FileNotFound');
      return new TextEncoder().encode(text);
    },
    /** Type (with SymbolicLink for `links`) and size (`sizes` overrides the text's UTF-8 length). */
    /** `mtime` is derived from the text: it changes whenever the content does. */
    async stat(uri: Uri): Promise<{ type: number; size: number; mtime: number }> {
      const link = links.has(uri.path) ? FileType.SymbolicLink : 0;
      const text = files.get(uri.path);
      if (text !== undefined) return { type: FileType.File | link, size: sizes.get(uri.path) ?? new TextEncoder().encode(text).length, mtime: contentStamp(text) };
      // Folders are implied by the files in them.
      if ([...files.keys()].some((path) => path.startsWith(`${uri.path}/`))) return { type: FileType.Directory | link, size: 0, mtime: 0 };
      throw new FileSystemError(uri.path, 'FileNotFound');
    },
    async readDirectory(uri: Uri): Promise<[string, number][]> {
      const prefix = `${uri.path}/`;
      const entries = new Map<string, number>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length).split('/');
        const link = links.has(`${prefix}${rest[0]}`) ? FileType.SymbolicLink : 0;
        entries.set(rest[0], (rest.length === 1 ? FileType.File : FileType.Directory) | link);
      }
      if (entries.size === 0) throw new FileSystemError(uri.path, 'FileNotFound');
      return [...entries];
    },
  },
  onDidChangeWorkspaceFolders: folderEvents.event,
  onDidChangeTextDocument: documentEvents.changed.event,
  onDidCloseTextDocument: documentEvents.closed.event,
};
