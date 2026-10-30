// In-memory stand-in for the parts of `vscode` used by the canvas editor (src/features/canvas/
// editor.ts, index.ts, strings.ts and src/webview/host.ts). Loaded in place of `vscode` through a
// module resolve hook in editor.test.ts.

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
  get size(): number {
    return this.#listeners.size;
  }
  dispose(): void {
    this.#listeners.clear();
  }
}

export class Uri {
  readonly scheme: string;
  readonly authority = '';
  readonly path: string;
  readonly #raw: string | undefined;
  private constructor(scheme: string, path: string, raw?: string) {
    this.scheme = scheme;
    this.path = path;
    this.#raw = raw;
  }
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static parse(value: string): Uri {
    const at = value.indexOf(':');
    return new Uri(value.slice(0, at), value.slice(at + 1), value);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const parts = base.path.replace(/\/$/, '').split('/');
    for (const segment of segments) {
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return new Uri(base.scheme, parts.join('/'));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return this.#raw ?? `${this.scheme}://${this.path}`;
  }
}

export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

export const FileType = { File: 1, Directory: 2 } as const;

export class WorkspaceEdit {
  readonly entries: { uri: Uri; range: Range; newText: string }[] = [];
  replace(uri: Uri, range: Range, newText: string): void {
    this.entries.push({ uri, range, newText });
  }
}

export interface FakeDocument {
  uri: Uri;
  version: number;
  text: string;
  isClosed: boolean;
  encoding: string | undefined;
  getText(): string;
}

export function makeDocument(path: string, text: string): FakeDocument {
  const doc: FakeDocument = { uri: Uri.file(path), version: 1, text, isClosed: false, encoding: 'utf8', getText: () => doc.text };
  state.edited.set(path, doc);
  return doc;
}

/** Offset of a line/character position in a text (any line break). */
function offsetAt(text: string, line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const next = text.slice(offset).search(/\r\n|\n|\r/);
    if (next < 0) return text.length;
    offset += next + (text.startsWith('\r\n', offset + next) ? 2 : 1);
  }
  return offset + character;
}

export const state = {
  settings: new Map<string, unknown>(),
  /** Existing files (paths) for workspace.fs.stat. */
  existing: new Set<string>(),
  /** File contents for workspace.fs.readFile (notes shown in file cards), by path. */
  fileTexts: new Map<string, string>(),
  /** Globs of the file watchers created. */
  watchers: [] as string[],
  stats: 0,
  /** Documents for openTextDocument, by path. */
  documents: new Map<string, FakeDocument>(),
  info: [] as string[],
  warnings: [] as string[],
  warningCalls: [] as unknown[][],
  warningAnswer: undefined as string | undefined,
  executed: [] as unknown[][],
  shown: [] as { path: string; options: unknown }[],
  external: [] as string[],
  providers: new Map<string, { provider: unknown; options: unknown }>(),
  workspaceFolders: undefined as { uri: Uri }[] | undefined,
  /** Documents applyEdit changes, by path. */
  edited: new Map<string, FakeDocument>(),
  /** Every applyEdit call, in order. */
  applied: [] as WorkspaceEdit[],
  acceptEdits: true,
  /** Runs inside applyEdit before the edit lands (another change winning a race). */
  beforeApply: undefined as (() => void) | undefined,
};

export function reset(): void {
  state.settings.clear();
  state.existing = new Set();
  state.fileTexts = new Map();
  state.watchers = [];
  state.stats = 0;
  state.documents.clear();
  state.info = [];
  state.warnings = [];
  state.warningCalls = [];
  state.warningAnswer = undefined;
  state.executed = [];
  state.shown = [];
  state.external = [];
  state.providers.clear();
  state.workspaceFolders = undefined;
  state.edited = new Map();
  state.applied = [];
  state.acceptEdits = true;
  state.beforeApply = undefined;
  env.language = 'en';
}

export const events = {
  changeTextDocument: new EventEmitter<{ document: unknown; contentChanges: unknown[] }>(),
  changeConfiguration: new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>(),
};

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(name: string, fallback: T): T {
        const full = [section, name].join('.');
        return state.settings.has(full) ? (state.settings.get(full) as T) : fallback;
      },
    };
  },
  getWorkspaceFolder(uri: Uri) {
    return state.workspaceFolders?.find((f) => uri.path.startsWith(`${f.uri.path.replace(/\/$/, '')}/`));
  },
  async openTextDocument(uri: Uri): Promise<FakeDocument> {
    const doc = state.documents.get(uri.path);
    if (doc === undefined) throw new Error(`fake vscode: no document ${uri.path}`);
    return doc;
  },
  onDidChangeTextDocument: events.changeTextDocument.event,
  onDidChangeConfiguration: events.changeConfiguration.event,
  /** Open documents other than the canvas (notes shown in file cards). */
  textDocuments: [] as { uri: Uri; getText(): string }[],
  createFileSystemWatcher(glob: string) {
    state.watchers.push(glob);
    const none = () => ({ dispose() {} });
    return { onDidChange: none, onDidCreate: none, onDidDelete: none, dispose() {} };
  },
  /** Applies the edit to the documents it names (one version step each), then fires the change event. */
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    state.applied.push(edit);
    state.beforeApply?.();
    if (!state.acceptEdits) return false;
    const byDoc = new Map<FakeDocument, { start: number; end: number; newText: string }[]>();
    for (const { uri, range, newText } of edit.entries) {
      const doc = state.edited.get(uri.path);
      if (doc === undefined) return false;
      const list = byDoc.get(doc) ?? [];
      list.push({ start: offsetAt(doc.text, range.start.line, range.start.character), end: offsetAt(doc.text, range.end.line, range.end.character), newText });
      byDoc.set(doc, list);
    }
    for (const [doc, list] of byDoc) {
      for (const change of list.sort((a, b) => b.start - a.start)) doc.text = doc.text.slice(0, change.start) + change.newText + doc.text.slice(change.end);
      doc.version++;
      events.changeTextDocument.fire({ document: doc, contentChanges: list });
    }
    return true;
  },
  fs: {
    async stat(uri: Uri) {
      state.stats++;
      if (!state.existing.has(uri.path)) throw new Error(`fake vscode: no file ${uri.path}`);
      return { type: FileType.File, size: state.fileTexts.get(uri.path)?.length ?? 0 };
    },
    async readFile(uri: Uri) {
      const text = state.fileTexts.get(uri.path);
      if (text === undefined) throw new Error(`fake vscode: cannot read ${uri.path}`);
      return new TextEncoder().encode(text);
    },
  },
};

export const window = {
  async showInformationMessage(message: string) {
    state.info.push(message);
    return undefined;
  },
  async showWarningMessage(message: string, ...rest: unknown[]) {
    state.warnings.push(message);
    state.warningCalls.push(rest);
    return state.warningAnswer;
  },
  async showTextDocument(doc: FakeDocument, options: unknown) {
    state.shown.push({ path: doc.uri.path, options });
    return undefined;
  },
  registerCustomEditorProvider(viewType: string, provider: unknown, options: unknown) {
    state.providers.set(viewType, { provider, options });
    return { dispose: () => void state.providers.delete(viewType) };
  },
};

export const commands = {
  async executeCommand(...args: unknown[]) {
    state.executed.push(args);
    return undefined;
  },
};

export const env = {
  language: 'en',
  async openExternal(uri: Uri) {
    state.external.push(uri.toString());
    return true;
  },
};

export const l10n = {
  t(message: string, ...args: unknown[]): string {
    return message.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));
  },
};

/** A webview panel whose posted messages and handlers are visible to tests. */
export function makePanel() {
  const received = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const panel = {
    posted: [] as unknown[],
    disposedByProvider: false,
    viewColumn: 2,
    webview: {
      options: {} as unknown,
      html: '',
      cspSource: "'self' https://*.vscode-cdn.net",
      asWebviewUri: (uri: Uri) => Uri.parse(`https://webview.test${uri.path}`),
      postMessage: async (message: unknown) => {
        panel.posted.push(message);
        return true;
      },
      onDidReceiveMessage: received.event,
    },
    onDidDispose: disposed.event,
    dispose: () => {
      panel.disposedByProvider = true;
      disposed.fire();
    },
    send: (message: unknown) => received.fire(message),
    close: () => disposed.fire(),
    listeners: () => received.size,
  };
  return panel;
}
