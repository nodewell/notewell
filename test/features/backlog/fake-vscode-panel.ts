// Extends the Backlog fake `vscode` (fake-vscode.ts, used by project.test.ts) with what
// panel.ts and index.ts use: webview panels, commands, messages, configuration, documents
// with versions, WorkspaceEdit and fs.stat. Loaded in place of `vscode` by panel.test.ts.
import { parseLines } from '../../../src/core/lines.ts';
import { applyEdits } from '../../../src/core/patch.ts';
import * as base from './fake-vscode.ts';

export * from './fake-vscode.ts';

const { EventEmitter, Uri, FileSystemError, files, documentEvents, textDocuments } = base;

/** Everything the code under test did that a test may check. */
export const log: string[] = [];

export const l10n = {
  t: (message: string, ...args: unknown[]) => message.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])),
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

export class WorkspaceEdit {
  readonly entries: { uri: base.Uri; range: Range; newText: string }[] = [];
  replace(uri: base.Uri, range: Range, newText: string): void {
    this.entries.push({ uri, range, newText });
  }
}

export interface PanelDocument extends base.FakeDocument {
  version: number;
  isDirty: boolean;
  save(): Promise<boolean>;
}

const BOM_CHAR = String.fromCharCode(0xfeff);
/** As VS Code: a document's text never includes the BOM. */
const withoutBom = (text: string): string => (text.startsWith(BOM_CHAR) ? text.slice(1) : text);

function documentFor(uri: base.Uri): PanelDocument {
  const open = textDocuments.find((d) => d.uri.toString() === uri.toString()) as PanelDocument | undefined;
  if (open !== undefined) {
    open.version ??= 1;
    open.isDirty ??= false;
    open.encoding ??= 'utf8';
    open.save ??= async () => saveDocument(open);
    return open;
  }
  const text = files.get(uri.path);
  if (text === undefined) throw new FileSystemError(uri.path, 'FileNotFound');
  const doc = base.openDocument(uri.path, withoutBom(text)) as PanelDocument;
  doc.version = 1;
  doc.isDirty = false;
  doc.encoding ??= 'utf8';
  doc.save = async () => saveDocument(doc);
  return doc;
}

function saveDocument(doc: PanelDocument): boolean {
  log.push(`save ${doc.uri.path}`);
  files.set(doc.uri.path, doc.text);
  doc.isDirty = false;
  return true;
}

/** Opens a document in an "editor" (optionally with unsaved text), as a user would. */
export function openEditorDocument(path: string, unsaved?: string): PanelDocument {
  const doc = documentFor(Uri.file(path));
  if (unsaved !== undefined) {
    doc.text = unsaved;
    doc.isDirty = true;
    doc.version++;
  }
  return doc;
}

/** Settings by full name, e.g. `notewell.backlog.saveOnEdit`. */
export const settings = new Map<string, unknown>();
export const configurationEvents = new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>();

/** Fires a configuration change for `name`. */
export function changeSetting(name: string, value: unknown): void {
  settings.set(name, value);
  configurationEvents.fire({ affectsConfiguration: (section: string) => name === section || name.startsWith(`${section}.`) });
}

/** `refuse`: applyEdit resolves false. `writeFails`: fs.writeFile throws. */
/**
 * `refuse`: applyEdit resolves false. `writeFails`: fs.writeFile throws with `writeError` (a
 * FileSystemError code). `partialWrite`: it writes the first half of the bytes, then throws.
 * `readOnlySchemes`: isWritableFileSystem answers false for them.
 */
export const editor = {
  refuse: false,
  writeFails: false,
  writeError: 'NoPermissions',
  /** Writes that store only the first half of the bytes, then throw. */
  partialWrite: 0,
  lateReload: false,
  watcherMisses: false,
  readOnlySchemes: new Set<string>(),
};



Object.assign(base.workspace, {
  getConfiguration(section: string) {
    return {
      get: <T>(name: string, fallback: T): T => (settings.has(`${section}.${name}`) ? (settings.get(`${section}.${name}`) as T) : fallback),
      /** One value for every target (the fake has no scopes). */
      inspect: (name: string) => {
        const value = settings.get(`${section}.${name}`);
        return { globalValue: value, workspaceValue: value, workspaceFolderValue: value };
      },
      async update(name: string, value: unknown, target: number): Promise<void> {
        log.push(`config ${section}.${name}=${Array.isArray(value) ? JSON.stringify(value) : String(value)} target=${target}`);
        changeSetting(`${section}.${name}`, value);
      },
    };
  },
  onDidChangeConfiguration: configurationEvents.event,
  async openTextDocument(uri: base.Uri) {
    return documentFor(uri);
  },
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    log.push(`applyEdit ${[...new Set(edit.entries.map((e) => e.uri.path))].join(',')}`);
    if (editor.refuse) return false;
    for (const uri of new Set(edit.entries.map((e) => e.uri))) {
      const doc = documentFor(uri);
      const edits = edit.entries.filter((e) => e.uri === uri).map(({ range, newText }) => ({ range, newText }));
      doc.text = applyEdits(parseLines(doc.text), edits);
      doc.version++;
      doc.isDirty = true;
      documentEvents.changed.fire({ document: doc });
    }
    return true;
  },
});
const fs = base.workspace.fs as typeof base.workspace.fs & {
  writeFile?: (uri: base.Uri, bytes: Uint8Array) => Promise<void>;
};
(base.workspace.fs as unknown as { isWritableFileSystem: (scheme: string) => boolean | undefined }).isWritableFileSystem = (scheme) =>
  !editor.readOnlySchemes.has(scheme);
/** Bytes written by fs.writeFile, by path (the BOM is visible here). */
export const written = new Map<string, Uint8Array>();
fs.writeFile = async (uri: base.Uri, bytes: Uint8Array) => {
  log.push(`writeFile ${uri.path}`);
  if (editor.writeFails) throw new FileSystemError(uri.path, editor.writeError);
  if (editor.partialWrite > 0) {
    editor.partialWrite--;
    files.set(uri.path, new TextDecoder().decode(bytes.slice(0, Math.floor(bytes.length / 2))));
    throw new FileSystemError(uri.path, 'Unavailable');
  }
  written.set(uri.path, bytes);
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  files.set(uri.path, text);
  // As VS Code: a clean open document reloads from disk, and file watchers fire. With
  // `lateReload` the reload comes after the watcher (as for a hidden document); with
  // `watcherMisses` no watcher event arrives at all.
  const open = textDocuments.find((d) => d.uri.toString() === uri.toString()) as PanelDocument | undefined;
  const reload = (): void => {
    if (open !== undefined && !open.isDirty) {
      open.text = withoutBom(text);
      open.version = (open.version ?? 1) + 1;
    }
  };
  if (!editor.lateReload) reload();
  if (!editor.watcherMisses) base.fireWatcher('change', uri.path);
  if (editor.lateReload) setTimeout(reload, 300);
};

export interface FakePanel {
  readonly viewType: string;
  readonly title: string;
  readonly column: number;
  readonly posted: unknown[];
  html: string;
  disposed: boolean;
  revealed: number;
  /** Delivers a message from the webview. */
  receive(message: unknown): void;
  /** The user closes the panel. */
  close(): void;
  /** The panel is hidden (its webview is torn down) or shown again (reloaded). */
  setVisible(visible: boolean): void;
}

export const panels: FakePanel[] = [];

type Serializer = { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> };
const serializers = new Map<string, Serializer>();

/** VS Code after a restart: a kept panel of `viewType` with the state its webview saved. */
export async function restorePanel(viewType: string, title: string, state: unknown): Promise<FakePanel> {
  const serializer = serializers.get(viewType);
  if (serializer === undefined) throw new Error(`no serializer for ${viewType}`);
  const panel = window.createWebviewPanel(viewType, title, ViewColumn.Active);
  await serializer.deserializeWebviewPanel(panel, state);
  return panels.at(-1)!;
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export interface FakeStatusItem {
  readonly id: string;
  readonly alignment: number;
  readonly priority: number;
  name: string;
  text: string;
  tooltip: string;
  command: string;
  visible: boolean;
  disposed: boolean;
}

export const statusItems: FakeStatusItem[] = [];

/** Fire `{ focused: true }` when the window regains focus. */
export const windowStateEvents = new EventEmitter<{ focused: boolean }>();

export const window = {
  onDidChangeWindowState: windowStateEvents.event,
  registerWebviewPanelSerializer(viewType: string, serializer: Serializer) {
    serializers.set(viewType, serializer);
    return { dispose: () => void serializers.delete(viewType) };
  },
  createStatusBarItem(id: string, alignment: number, priority: number) {
    const item: FakeStatusItem & { show(): void; hide(): void; dispose(): void } = {
      id,
      alignment,
      priority,
      name: '',
      text: '',
      tooltip: '',
      command: '',
      visible: false,
      disposed: false,
      show: () => void (item.visible = true),
      hide: () => void (item.visible = false),
      dispose: () => {
        item.visible = false;
        item.disposed = true;
      },
    };
    statusItems.push(item);
    return item;
  },
  createWebviewPanel(viewType: string, title: string, column: number) {
    const received = new EventEmitter<unknown>();
    const disposedEvent = new EventEmitter<void>();
    const viewState = new EventEmitter<{ webviewPanel: { visible: boolean } }>();
    let visible = true;
    const fake: FakePanel = {
      viewType,
      title,
      column,
      posted: [],
      html: '',
      disposed: false,
      revealed: 0,
      receive: (message) => received.fire(message),
      close: () => panel.dispose(),
      setVisible: (next) => {
        visible = next;
        viewState.fire({ webviewPanel: { visible } });
      },
    };
    panels.push(fake);
    const panel = {
      set title(value: string) {
        (fake as { title: string }).title = value;
      },
      webview: {
        options: {} as unknown,
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: base.Uri) => uri,
        get html() {
          return fake.html;
        },
        set html(value: string) {
          fake.html = value;
        },
        postMessage: async (message: unknown) => {
          fake.posted.push(message);
          return true;
        },
        onDidReceiveMessage: received.event,
      },
      reveal: () => void fake.revealed++,
      get visible() {
        return visible;
      },
      onDidChangeViewState: viewState.event,
      onDidDispose: disposedEvent.event,
      dispose: () => {
        if (fake.disposed) return;
        fake.disposed = true;
        disposedEvent.fire();
      },
    };
    return panel;
  },
  async showInformationMessage(message: string) {
    log.push(`info ${message}`);
  },
  async showWarningMessage(message: string) {
    log.push(`warning ${message}`);
  },
  /** Picks the item whose label is `pick.label` (undefined cancels). */
  async showQuickPick<T extends { label: string }>(items: readonly T[], options: { placeHolder?: string }) {
    log.push(`pick ${options.placeHolder}: ${items.map((i) => i.label).join(',')}`);
    quickPick.items = items;
    return items.find((item) => item.label === quickPick.label);
  },
  async showTextDocument(uri: base.Uri, options: { preview?: boolean }) {
    log.push(`showTextDocument ${uri.path} preview=${options.preview}`);
  },
  /** Answers with `openDialog.folder` (undefined cancels). */
  async showOpenDialog(options: { canSelectFolders?: boolean; canSelectFiles?: boolean; title?: string }) {
    log.push(`dialog folders=${options.canSelectFolders} files=${options.canSelectFiles} ${options.title}`);
    return openDialog.folder === undefined ? undefined : [Uri.file(openDialog.folder)];
  },
};

export const quickPick: { label: string | undefined; items: readonly { label: string; description?: string }[] } = { label: undefined, items: [] };
export const openDialog: { folder: string | undefined } = { folder: undefined };

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand(name: string, handler: (...args: unknown[]) => unknown) {
    commandHandlers.set(name, handler);
    return { dispose: () => void commandHandlers.delete(name) };
  },
  async executeCommand(name: string, ...args: unknown[]) {
    const handler = commandHandlers.get(name);
    if (handler !== undefined) return handler(...args);
    log.push(`command ${name} ${args.map((a) => (a instanceof Uri ? a.path : JSON.stringify(a))).join(' ')}`);
    return undefined;
  },
};

export const env = {
  language: 'en',
  async openExternal(uri: { toString(): string }) {
    log.push(`openExternal ${uri.toString()}`);
    return true;
  },
};

// Uri.parse for openExternal; fsPath for messages.
Object.assign(Uri, {
  parse: (value: string) => ({ toString: () => value }),
});
Object.defineProperty(Uri.prototype, 'fsPath', { get(this: base.Uri) { return this.path; } });
