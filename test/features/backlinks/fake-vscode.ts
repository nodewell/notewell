// Minimal stand-in for the `vscode` module, covering src/features/backlinks/index.ts.

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
  readonly scheme = 'file';
  readonly path: string;
  private constructor(path: string) {
    this.path = path;
  }
  static file(path: string): Uri {
    return new Uri(path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.path.replace(/\/$/, ''), ...segments].join('/'));
  }
  toString(): string {
    return `file://${this.path}`;
  }
}

export class Range {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.startLine = startLine;
    this.startCharacter = startCharacter;
    this.endLine = endLine;
    this.endCharacter = endCharacter;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class TreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  tooltip?: string;
  resourceUri?: Uri;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(label: string, state: number) {
    this.label = label;
    this.collapsibleState = state;
  }
}

export const files = new Map<string, string>();
export const settings = new Map<string, unknown>();
export const contextKeys = new Map<string, unknown>();
export const tabs = { active: undefined as Uri | undefined, changed: new EventEmitter<unknown>() };
export const configuration = new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>();

export const l10n = { t: (text: string) => text };

/** Commands run (other than setContext) and information messages shown. */
export const executed: unknown[][] = [];
export const info: string[] = [];

export const commands = {
  async executeCommand(command: string, ...args: unknown[]) {
    if (command === 'setContext') contextKeys.set(args[0] as string, args[1]);
    else executed.push([command, ...args]);
  },
};

export const window = {
  get activeTextEditor() {
    return undefined;
  },
  tabGroups: {
    get activeTabGroup() {
      return { activeTab: tabs.active ? { input: { uri: tabs.active } } : undefined };
    },
    onDidChangeTabs: tabs.changed.event,
  },
  onDidChangeActiveTextEditor: new EventEmitter<unknown>().event,
  async showInformationMessage(message: string) {
    info.push(message);
    return undefined;
  },
  registerTreeDataProvider() {
    return { dispose: () => undefined };
  },
};

export const workspace = {
  textDocuments: [] as { uri: Uri; getText(): string }[],
  fs: {
    async readFile(uri: Uri) {
      const text = files.get(uri.path);
      if (text === undefined) throw new Error('FileNotFound');
      return new TextEncoder().encode(text);
    },
    async stat(uri: Uri) {
      if (!files.has(uri.path)) throw new Error('FileNotFound');
      return { type: 1, size: files.get(uri.path)!.length };
    },
  },
  getConfiguration(section: string) {
    return { get: <T>(name: string, fallback: T): T => (settings.has(`${section}.${name}`) ? (settings.get(`${section}.${name}`) as T) : fallback) };
  },
  onDidChangeConfiguration: configuration.event,
};
