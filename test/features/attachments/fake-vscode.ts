// Minimal in-memory stand-in for the `vscode` module, covering what
// src/features/attachments/index.ts uses. Loaded by provider.test.ts through a resolve hook.

export class Uri {
  readonly scheme: string;
  readonly authority = '';
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
  /** `scheme://authority/path` with a percent-decoded path (enough for uri-list entries). */
  static parse(value: string): Uri {
    const match = /^([a-z][\w+.-]*):\/\/[^/]*(\/.*)?$/i.exec(value);
    if (!match) throw new Error(`bad URI ${value}`);
    return new Uri(match[1]!.toLowerCase(), decodeURIComponent(match[2] ?? '/'));
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

export class DocumentDropOrPasteEditKind {
  static readonly Empty = new DocumentDropOrPasteEditKind('');
  readonly value: string;
  private constructor(value: string) {
    this.value = value;
  }
  append(...parts: string[]): DocumentDropOrPasteEditKind {
    return new DocumentDropOrPasteEditKind([this.value, ...parts].filter((p) => p !== '').join('.'));
  }
}

export class WorkspaceEdit {
  readonly creates: { uri: Uri; options: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } }[] = [];
  readonly textEdits: unknown[] = [];
  createFile(uri: Uri, options: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }): void {
    this.creates.push({ uri, options });
  }
  replace(...args: unknown[]): void {
    this.textEdits.push(args);
  }
  insert(...args: unknown[]): void {
    this.textEdits.push(args);
  }
}

export class DocumentPasteEdit {
  insertText: string;
  title: string;
  kind: DocumentDropOrPasteEditKind;
  additionalEdit?: WorkspaceEdit;
  constructor(insertText: string, title: string, kind: DocumentDropOrPasteEditKind) {
    this.insertText = insertText;
    this.title = title;
    this.kind = kind;
  }
}

export class DocumentDropEdit extends DocumentPasteEdit {}

export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 } as const;

/** Files on disk (path -> bytes), folders, and settings (full name -> value). */
export const files = new Map<string, Uint8Array>();
export const folders = new Set<string>();
/** Folders that are symbolic links, and file sizes stat reports (default: the bytes' length). */
export const symlinks = new Set<string>();
export const sizes = new Map<string, number>();
/** Paths read through workspace.fs.readFile. */
export const reads: string[] = [];
export const settings = new Map<string, unknown>();
export const warnings: string[] = [];
/** The modal answer the next large-attachment question gets. */
export const answers: (string | undefined)[] = [];
export const providers: { paste?: unknown; drop?: unknown } = {};

const format = (text: string, args: unknown[]): string => text.replace(/\{(\d+)\}/g, (_, n: string) => String(args[Number(n)]));
export const l10n = { t: (text: string, ...args: unknown[]) => format(text, args) };

export const workspace = {
  fs: {
    async stat(uri: Uri) {
      if (folders.has(uri.path)) return { type: FileType.Directory | (symlinks.has(uri.path) ? FileType.SymbolicLink : 0), size: 0 };
      if (!files.has(uri.path)) throw new Error('FileNotFound');
      return { type: FileType.File, size: sizes.get(uri.path) ?? files.get(uri.path)!.byteLength };
    },
    async readFile(uri: Uri) {
      const data = files.get(uri.path);
      if (data === undefined) throw new Error('FileNotFound');
      reads.push(uri.path);
      return data;
    },
  },
  async findFiles(pattern: RelativePattern) {
    const name = pattern.pattern.replace(/^\*\*\//, '');
    const base = pattern.baseUri.path;
    return [...files.keys()].filter((p) => p.startsWith(`${base}/`) && p.endsWith(`/${name}`)).map((p) => Uri.file(p));
  },
  getConfiguration(section: string) {
    return { get: <T>(name: string, fallback: T): T => (settings.has(`${section}.${name}`) ? (settings.get(`${section}.${name}`) as T) : fallback) };
  },
};

export const window = {
  async showWarningMessage(message: string, ...rest: unknown[]) {
    warnings.push(message);
    return rest.length > 1 ? answers.shift() : undefined;
  },
};

export const languages = {
  registerDocumentPasteEditProvider(_selector: unknown, provider: unknown) {
    providers.paste = provider;
    return { dispose: () => undefined };
  },
  registerDocumentDropEditProvider(_selector: unknown, provider: unknown) {
    providers.drop = provider;
    return { dispose: () => undefined };
  },
};
