// In-memory stand-in for the parts of `vscode` that src/features/daily-notes uses. Files are
// bytes in a map, folders a set; editors apply edits to their text.

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
  readonly query: string;
  private constructor(scheme: string, path: string, query = '') {
    this.scheme = scheme;
    this.path = path;
    this.query = query;
  }
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static parse(text: string): Uri {
    const colon = text.indexOf(':');
    const rest = text.slice(colon + 1).replace(/^\/\//, '');
    const q = rest.indexOf('?');
    return new Uri(text.slice(0, colon), q === -1 ? rest : rest.slice(0, q), q === -1 ? '' : rest.slice(q + 1));
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/'));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${this.path}${this.query === '' ? '' : `?${this.query}`}`;
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const EndOfLine = { LF: 1, CRLF: 2 } as const;

export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    this.start = typeof a === 'number' ? new Position(a, b as number) : a;
    this.end = typeof a === 'number' ? new Position(c!, d!) : (b as Position);
  }
}

export class Selection extends Range {
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
  }
}

export class DocumentLink {
  readonly range: Range;
  readonly target: Uri;
  tooltip?: string;
  constructor(range: Range, target: Uri) {
    this.range = range;
    this.target = target;
  }
}

export class RelativePattern {
  readonly base: Uri;
  readonly pattern: string;
  constructor(base: Uri, pattern: string) {
    this.base = base;
    this.pattern = pattern;
  }
}

export class WorkspaceEdit {
  readonly creates: { uri: Uri; options: { overwrite: boolean; ignoreIfExists: boolean; contents: Uint8Array } }[] = [];
  createFile(uri: Uri, options: { overwrite: boolean; ignoreIfExists: boolean; contents: Uint8Array }): void {
    this.creates.push({ uri, options });
  }
}

export class TabInputText {
  readonly uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}
export class TabInputCustom extends TabInputText {}

/** path -> bytes; folders separately. Links (symbolic) are paths in `links`. */
export const files = new Map<string, Uint8Array>();
export const folders = new Set<string>();
export const links = new Set<string>();
export const settings = new Map<string, unknown>();
export const messages: { level: string; text: string; items: string[] }[] = [];
export const opened: string[] = [];
export const context = new Map<string, unknown>();
export const registered = new Map<string, (...args: unknown[]) => unknown>();
export const providers: { links?: { provideDocumentLinks: (doc: unknown) => Promise<DocumentLink[]> } } = {};
/** VS Code's language (`vscode.env.language`). */
export const env = { language: 'en' };
/** Line ending of a document without one, as `files.eol: auto` gives on Windows. */
export const DEFAULT_EOL = '\r\n';
/** Answers for the next prompts, in order (undefined = dismissed). */
export const answers: { message: (string | undefined)[]; quickPick: (number | undefined)[]; input: (string | undefined)[] } = { message: [], quickPick: [], input: [] };

export function reset(): void {
  files.clear();
  folders.clear();
  links.clear();
  settings.clear();
  messages.length = 0;
  opened.length = 0;
  answers.message.length = 0;
  answers.quickPick.length = 0;
  answers.input.length = 0;
  window.activeTextEditor = undefined;
  textDocuments.length = 0;
  env.language = 'en';
}

export function writeText(path: string, text: string): void {
  files.set(path, new TextEncoder().encode(text));
  for (let p = path.slice(0, path.lastIndexOf('/')); p !== ''; p = p.slice(0, p.lastIndexOf('/'))) folders.add(p);
}

export function readText(path: string): string | undefined {
  const bytes = files.get(path);
  return bytes === undefined ? undefined : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

class FileSystemError extends Error {}

export class TextDocument {
  readonly uri: Uri;
  readonly languageId: string;
  text: string;
  /** As in VS Code: the document's line ending, which inserted text is converted to. */
  eol: string;
  version = 1;
  constructor(uri: Uri, text: string, languageId = 'markdown') {
    this.uri = uri;
    this.text = text;
    this.languageId = languageId;
    this.eol = text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : DEFAULT_EOL;
  }
  get lines(): string[] {
    return this.text.split(/\r?\n/);
  }
  get lineCount(): number {
    return this.lines.length;
  }
  getText(): string {
    return this.text;
  }
  lineAt(line: number) {
    const text = this.lines[line]!;
    return { text, range: new Range(line, 0, line, text.length) };
  }
  offsetAt(position: Position): number {
    let offset = 0;
    for (let i = 0; i < position.line; i++) offset = this.text.indexOf('\n', offset) + 1;
    return offset + position.character;
  }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset).split('\n');
    return new Position(before.length - 1, before[before.length - 1]!.replace(/\r$/, '').length);
  }
}

export class TextEditor {
  readonly document: TextDocument;
  selections: Selection[];
  constructor(document: TextDocument, selections: Selection[] = [new Selection(new Position(0, 0), new Position(0, 0))]) {
    this.document = document;
    this.selections = selections;
  }
  get selection(): Selection {
    return this.selections[0]!;
  }
  set selection(value: Selection) {
    this.selections = [value];
  }
  async edit(callback: (builder: { replace: (range: Range, text: string) => void; setEndOfLine: (eol: number) => void }) => void): Promise<boolean> {
    const edits: { start: number; end: number; text: string }[] = [];
    let eol: string | undefined;
    callback({
      replace: (range, text) => edits.push({ start: this.document.offsetAt(range.start), end: this.document.offsetAt(range.end), text }),
      setEndOfLine: (value) => (eol = value === EndOfLine.LF ? '\n' : '\r\n'),
    });
    edits.sort((a, b) => b.start - a.start);
    if (eol !== undefined) this.document.eol = eol;
    for (const e of edits) {
      const text = e.text.replace(/\r?\n/g, this.document.eol);
      this.document.text = this.document.text.slice(0, e.start) + text + this.document.text.slice(e.end);
    }
    if (eol !== undefined) this.document.text = this.document.text.replace(/\r?\n/g, eol);
    this.document.version++;
    return true;
  }
  revealRange(): void {}
}

export const textDocuments: TextDocument[] = [];

function stat(uri: Uri) {
  if (links.has(uri.path)) return { type: FileType.SymbolicLink | FileType.Directory, ctime: 0, mtime: 0, size: 0 };
  if (folders.has(uri.path)) return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
  const bytes = files.get(uri.path);
  if (bytes === undefined) throw new FileSystemError(`not found: ${uri.path}`);
  return { type: FileType.File, ctime: 0, mtime: 0, size: bytes.length };
}

const configurationChanged = new EventEmitter<unknown>();

export const workspace = {
  textDocuments,
  fs: {
    async stat(uri: Uri) {
      return stat(uri);
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      const bytes = files.get(uri.path);
      if (bytes === undefined) throw new FileSystemError(`not found: ${uri.path}`);
      return bytes;
    },
    async createDirectory(uri: Uri): Promise<void> {
      for (let p = uri.path; p !== ''; p = p.slice(0, p.lastIndexOf('/'))) folders.add(p);
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      if (!folders.has(uri.path.slice(0, uri.path.lastIndexOf('/')))) throw new FileSystemError(`fake: parent folder missing for ${uri.path}`);
      files.set(uri.path, content);
    },
  },
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    for (const { uri, options } of edit.creates) {
      if (files.has(uri.path) && !options.overwrite) return false;
      if (!folders.has(uri.path.slice(0, uri.path.lastIndexOf('/')))) throw new Error(`fake: parent folder missing for ${uri.path}`);
    }
    for (const { uri, options } of edit.creates) files.set(uri.path, options.contents);
    return true;
  },
  async findFiles(pattern: RelativePattern, exclude: unknown): Promise<Uri[]> {
    if (exclude !== null || pattern.pattern !== '**/*.md') throw new Error('fake: unexpected findFiles');
    return [...files.keys()].filter((p) => p.startsWith(`${pattern.base.path}/`) && p.endsWith('.md')).map((p) => Uri.file(p));
  },
  getConfiguration(section: string) {
    return { get: <T>(name: string, fallback: T): T => (settings.has(`${section}.${name}`) ? (settings.get(`${section}.${name}`) as T) : fallback) };
  },
  onDidChangeConfiguration: configurationChanged.event,
  asRelativePath(uri: Uri): string {
    return uri.path;
  },
};

async function message(level: string, text: string, ...items: unknown[]): Promise<string | undefined> {
  const strings = items.filter((i): i is string => typeof i === 'string');
  messages.push({ level, text, items: strings });
  return strings.length > 0 ? answers.message.shift() : undefined;
}

export const window = {
  activeTextEditor: undefined as TextEditor | undefined,
  tabGroups: { activeTabGroup: { activeTab: undefined as { input: unknown } | undefined } },
  showInformationMessage: (text: string, ...items: unknown[]) => message('info', text, ...items),
  showWarningMessage: (text: string, ...items: unknown[]) => message('warning', text, ...items),
  showErrorMessage: (text: string, ...items: unknown[]) => message('error', text, ...items),
  async showQuickPick<T>(items: T[]): Promise<T | undefined> {
    const index = answers.quickPick.shift();
    return index === undefined ? undefined : items[index];
  },
  async showInputBox(options: { validateInput?: (text: string) => string | undefined }): Promise<string | undefined> {
    const text = answers.input.shift();
    if (text !== undefined && options.validateInput?.(text) !== undefined) throw new Error(`fake: invalid input ${text}`);
    return text;
  },
  async showTextDocument(uri: Uri): Promise<TextEditor> {
    opened.push(uri.path);
    const editor = new TextEditor(new TextDocument(uri, readText(uri.path) ?? ''));
    window.activeTextEditor = editor;
    return editor;
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    registered.set(id, handler);
    return { dispose: () => void registered.delete(id) };
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    if (id === 'setContext') {
      context.set(args[0] as string, args[1]);
      return undefined;
    }
    return registered.get(id)?.(...args);
  },
};

export const languages = {
  registerDocumentLinkProvider(_selector: unknown, provider: { provideDocumentLinks: (doc: unknown) => Promise<DocumentLink[]> }) {
    providers.links = provider;
    return { dispose: () => undefined };
  },
};

export const l10n = {
  t(message: string, ...args: unknown[]): string {
    return message.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));
  },
};
