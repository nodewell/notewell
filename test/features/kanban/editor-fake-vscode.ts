// In-memory stand-in for the parts of `vscode` used by the kanban editor adapter
// (src/features/kanban/editor.ts, index.ts, strings.ts and src/webview/host.ts).
// Loaded in place of `vscode` through a module resolve hook in the editor tests.

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

export class RelativePattern {
  readonly baseUri: Uri;
  readonly pattern: string;
  constructor(base: Uri, pattern: string) {
    this.baseUri = base;
    this.pattern = pattern;
  }
}

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
  static from(parts: { scheme: string; path: string }): Uri {
    return new Uri(parts.scheme, parts.path);
  }
  /** Inverse of toString. */
  static parse(value: string): Uri {
    const at = value.indexOf('://');
    return new Uri(value.slice(0, at), value.slice(at + 3));
  }
  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
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
    return `${this.scheme}://${this.path}`;
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

export class WorkspaceEdit {
  readonly entries: { uri: Uri; range: Range; newText: string }[] = [];
  readonly creates: { uri: Uri; options: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } }[] = [];
  createFile(uri: Uri, options: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } = {}): void {
    this.creates.push({ uri, options });
  }
  replace(uri: Uri, range: Range, newText: string): void {
    this.entries.push({ uri, range, newText });
  }
}

export class TabInputText {
  readonly uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}

export class TabInputCustom {
  readonly uri: Uri;
  readonly viewType: string;
  constructor(uri: Uri, viewType: string) {
    this.uri = uri;
    this.viewType = viewType;
  }
}

// --- recorded state, reset by tests ---

export interface FakeDocument {
  uri: Uri;
  version: number;
  text: string;
  saves: number;
  getText(): string;
  save(): Promise<boolean>;
}

export function makeDocument(path: string, text: string): FakeDocument {
  const doc: FakeDocument = {
    uri: Uri.file(path),
    version: 1,
    text,
    saves: 0,
    getText: () => doc.text,
    save: async () => {
      doc.saves++;
      return true;
    },
  };
  return doc;
}

export const state = {
  /** Full setting name -> value; read by getConfiguration. */
  settings: new Map<string, unknown>(),
  documents: new Map<string, FakeDocument>(),
  files: [] as Uri[],
  applied: [] as WorkspaceEdit[],
  acceptEdits: true,
  info: [] as string[],
  warnings: [] as string[],
  executed: [] as unknown[][],
  closed: [] as unknown[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  providers: new Map<string, unknown>(),
  groups: [] as { viewColumn: number; tabs: unknown[] }[],
  /** Existing files (paths) for workspace.fs.stat. */
  existing: new Set<string>(),
  /** openTextDocument calls with the encoding asked for. */
  openedDocuments: [] as { path: string; encoding: string | undefined }[],
  /** workspace.fs.writeFile calls, in order. */
  written: [] as { path: string; text: string }[],
  workspaceFolders: undefined as { uri: Uri }[] | undefined,
  /** showQuickPick calls and the item to answer with. */
  picks: [] as { items: string[]; placeHolder?: string }[],
  pick: undefined as string | undefined,
  /** Answers for showInputBox, in order; each records the validation message it got. */
  inputs: [] as (string | undefined)[],
  validations: [] as (string | undefined)[],
  workspaceTrusted: true,
  /** Runs just before a WorkspaceEdit creates a file (another program winning a race). */
  beforeCreate: undefined as ((path: string) => void) | undefined,
  /** Extra arguments of each showWarningMessage call (options, buttons). */
  warningCalls: [] as unknown[][],
  /** What showWarningMessage resolves to (e.g. the button the user picked). */
  warningAnswer: undefined as string | undefined,
  /** User-level (global) setting values: full name -> value; read by inspect, written by update. */
  globalSettings: new Map<string, unknown>(),
  /** config.update calls: full name, value, target. */
  updates: [] as { name: string; value: unknown; target: unknown }[],
  /** Makes config.update fail (e.g. an unwritable settings file). */
  failUpdates: false,
  /** window.showTextDocument calls with the options passed. */
  shownDocuments: [] as { document: unknown; options: { viewColumn?: number; selection?: Range; preserveFocus?: boolean } }[],
  /** Runs inside showTextDocument before it resolves (e.g. to fire tab events meanwhile). */
  onShowTextDocument: undefined as ((editor: FakeTextEditor) => void) | undefined,
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

/** In-memory Memento (context.globalState). */
export class Memento {
  readonly values = new Map<string, unknown>();
  get<T>(id: string, fallback: T): T {
    return this.values.has(id) ? (structuredClone(this.values.get(id)) as T) : fallback;
  }
  async update(id: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(id);
    else this.values.set(id, structuredClone(value));
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 } as const;

/** A text editor shown by window.showTextDocument. */
export interface FakeTextEditor {
  document: unknown;
  viewColumn: number;
  selection: Range | undefined;
  revealed: { range: Range; type: unknown }[];
  revealRange(range: Range, type: unknown): void;
}

export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 } as const;

export const events = {
  changeColorTheme: new EventEmitter<unknown>(),
  changeTextDocument: new EventEmitter<{ document: unknown; contentChanges: unknown[] }>(),
  changeConfiguration: new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>(),
  changeTabs: new EventEmitter<{ opened: unknown[]; changed: unknown[]; closed: unknown[] }>(),
  renameFiles: new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>(),
  deleteFiles: new EventEmitter<{ files: Uri[] }>(),
};

export function reset(): void {
  state.settings.clear();
  state.documents.clear();
  state.files = [];
  state.applied = [];
  state.acceptEdits = true;
  state.info = [];
  state.warnings = [];
  state.executed = [];
  state.closed = [];
  state.commands.clear();
  state.providers.clear();
  state.groups = [];
  state.existing = new Set();
  state.written = [];
  state.openedDocuments = [];
  state.workspaceFolders = undefined;
  state.picks = [];
  state.pick = undefined;
  state.inputs = [];
  state.validations = [];
  state.workspaceTrusted = true;
  state.beforeCreate = undefined;
  state.warningCalls = [];
  state.warningAnswer = undefined;
  state.globalSettings = new Map();
  state.updates = [];
  state.failUpdates = false;
  state.shownDocuments = [];
  state.onShowTextDocument = undefined;
  window.visibleTextEditors = [];
  window.activeColorTheme = { kind: ColorThemeKind.Dark };
  env.language = 'en';
}

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(name: string, fallback: T): T {
        const full = [section, name].join('.');
        return state.settings.has(full) ? (state.settings.get(full) as T) : fallback;
      },
      inspect<T>(name: string): { globalValue?: T } {
        const full = [section, name].join('.');
        return state.globalSettings.has(full) ? { globalValue: structuredClone(state.globalSettings.get(full)) as T } : {};
      },
      async update(name: string, value: unknown, target: unknown): Promise<void> {
        if (state.failUpdates) throw new Error('fake vscode: settings not writable');
        const full = [section, name].join('.');
        state.updates.push({ name: full, value: structuredClone(value), target });
        if (value === undefined) state.globalSettings.delete(full);
        else state.globalSettings.set(full, structuredClone(value));
      },
    };
  },
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    state.applied.push(edit);
    if (!state.acceptEdits) return false;
    // File creations are all or nothing: an existing file fails the edit unless overwrite is set.
    for (const { uri } of edit.creates) state.beforeCreate?.(uri.path);
    if (edit.creates.some(({ uri, options }) => state.existing.has(uri.path) && options.overwrite !== true)) return false;
    for (const { uri, options } of edit.creates) {
      state.existing.add(uri.path);
      state.written.push({ path: uri.path, text: new TextDecoder().decode(options.contents ?? new Uint8Array()) });
    }
    return true;
  },
  async findFiles(include: string | RelativePattern): Promise<Uri[]> {
    if (include instanceof RelativePattern) {
      if (include.pattern !== '**/*') throw new Error(`fake vscode: unexpected glob ${include.pattern}`);
      const base = include.baseUri.path.replace(/\/$/, '');
      return state.files.filter((uri) => uri.path.startsWith(`${base}/`));
    }
    if (include !== '**/*.md') throw new Error(`fake vscode: unexpected glob ${include}`);
    return state.files;
  },
  getWorkspaceFolder(uri: Uri) {
    return state.workspaceFolders?.find((f) => uri.path.startsWith(`${f.uri.path.replace(/\/$/, '')}/`));
  },
  async openTextDocument(uri: Uri, options?: { encoding?: string }): Promise<FakeDocument> {
    state.openedDocuments.push({ path: uri.path, encoding: options?.encoding });
    const doc = state.documents.get(uri.toString());
    if (doc !== undefined) return doc;
    // A file written through workspace.fs (e.g. a new board) opens as a document.
    const written = state.written.find((w) => w.path === uri.path);
    if (written === undefined) throw new Error(`fake vscode: no document ${uri.toString()}`);
    return makeDocument(uri.path, written.text);
  },
  onDidChangeTextDocument: events.changeTextDocument.event,
  onDidChangeConfiguration: events.changeConfiguration.event,
  onDidRenameFiles: events.renameFiles.event,
  onDidDeleteFiles: events.deleteFiles.event,
  get workspaceFolders() {
    return state.workspaceFolders;
  },
  get isTrusted() {
    return state.workspaceTrusted;
  },
  fs: {
    async stat(uri: Uri) {
      if (!state.existing.has(uri.path)) throw new Error(`fake vscode: no file ${uri.path}`);
      return { type: 1 };
    },
    async writeFile(uri: Uri, bytes: Uint8Array) {
      state.written.push({ path: uri.path, text: new TextDecoder().decode(bytes) });
      state.existing.add(uri.path);
    },
  },
};

export const window = {
  activeTextEditor: undefined as { document: { uri: Uri } } | undefined,
  visibleTextEditors: [] as FakeTextEditor[],
  /**
   * Records the call; `Beside` goes to the group after the highest one (column 1 is active in
   * these tests). The editor becomes visible.
   */
  async showTextDocument(document: { uri: Uri }, options: { viewColumn?: number; selection?: Range; preserveFocus?: boolean } = {}) {
    state.shownDocuments.push({ document, options });
    const highest = Math.max(1, ...state.groups.map((g) => g.viewColumn));
    const viewColumn = options.viewColumn === ViewColumn.Beside ? highest + 1 : (options.viewColumn ?? 1);
    const editor: FakeTextEditor = {
      document,
      viewColumn,
      selection: options.selection,
      revealed: [],
      revealRange(range, type) {
        editor.revealed.push({ range, type });
      },
    };
    state.onShowTextDocument?.(editor);
    if (!window.visibleTextEditors.some((e) => e.document === document && e.viewColumn === viewColumn)) window.visibleTextEditors.push(editor);
    return editor;
  },
  activeColorTheme: { kind: ColorThemeKind.Dark as number },
  onDidChangeActiveColorTheme: events.changeColorTheme.event,
  async showInformationMessage(message: string) {
    state.info.push(message);
    return undefined;
  },
  /** Records the items and picks `state.pick` (undefined cancels). */
  async showQuickPick(items: readonly string[], options: { placeHolder?: string }) {
    state.picks.push({ items: [...items], placeHolder: options.placeHolder });
    return items.find((item) => item === state.pick);
  },
  async showWarningMessage(message: string, ...rest: unknown[]) {
    state.warnings.push(message);
    state.warningCalls.push(rest);
    return state.warningAnswer;
  },
  async showInputBox(options: { value?: string; validateInput?: (value: string) => Promise<string | undefined> | string | undefined }) {
    const answer = state.inputs.shift();
    if (answer !== undefined && options.validateInput) state.validations.push(await options.validateInput(answer));
    return answer;
  },
  registerCustomEditorProvider(viewType: string, provider: unknown) {
    state.providers.set(viewType, provider);
    return { dispose: () => void state.providers.delete(viewType) };
  },
  tabGroups: {
    get all() {
      return state.groups;
    },
    get activeTabGroup() {
      return { activeTab: state.groups[0]?.tabs.find((t) => (t as { isActive?: boolean }).isActive) };
    },
    onDidChangeTabs: events.changeTabs.event,
    async close(tab: unknown) {
      state.closed.push(tab);
      for (const group of state.groups) group.tabs = group.tabs.filter((t) => t !== tab);
      return true;
    },
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    state.commands.set(id, handler);
    return { dispose: () => void state.commands.delete(id) };
  },
  async executeCommand(...args: unknown[]) {
    state.executed.push(args);
    return undefined;
  },
};

export const env = { language: 'en' };

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
    /** WebviewPanel.active: the board is the active editor. */
    active: false,
    webview: {
      options: {} as unknown,
      html: '',
      // Real VS Code form: quoted keyword plus host source, space separated.
      cspSource: "'self' https://*.vscode-cdn.net",
      asWebviewUri: (uri: Uri) => uri,
      postMessage: async (message: unknown) => {
        panel.posted.push(message);
        return true;
      },
      onDidReceiveMessage: received.event,
    },
    onDidDispose: disposed.event,
    dispose: () => {
      panel.disposedByProvider = true;
    },
    /** Test helpers. */
    send: (message: unknown) => received.fire(message),
    close: () => disposed.fire(),
    listeners: () => received.size,
  };
  return panel;
}
