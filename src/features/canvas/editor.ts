// VS Code custom text editor for JSON Canvas files (canvas.md 2-5). The document stays the
// source of truth: every edit is one minimal WorkspaceEdit on it (canvas.md 3.1, 3.3), so undo,
// dirty state and saving behave as in the text editor; nothing is saved automatically (9.7).
// The view redraws whenever the document changes (editor typing, undo, disk changes). File card paths are resolved inside the vault (or the canvas's folder outside
// a vault); only local images inside a vault are shown (canvas.md 7).
import * as vscode from 'vscode';
import { openWikilink } from '../../vault/open-link.ts';
import type { VaultRegistry } from '../../vault/registry.ts';
import { vaultRelativePath } from '../../vault/uri-paths.ts';
import { webviewHtml, webviewOptions } from '../../webview/host.ts';
import type { TextEdit } from '../../core/patch.ts';
import { checkEdit, isEditMessage, type EditMessage } from './edit-request.ts';
import { isWebUrl, validateWebviewMessage, type ExtensionMessage } from './messages.ts';
import { readCanvas, type CanvasReadResult } from './model.ts';
import { computeCanvasPatch, type CanvasEditFailureReason } from './operations.ts';
import { messages, viewMessages, viewStrings } from './strings.ts';
import { buildCanvasView, findSubpathLine, isImagePath, resolveInside, resourcePaths, type ResolvedResource } from './view.ts';

export const CANVAS_VIEW_TYPE = 'notewell.canvas';

const RENDER_DELAY_MS = 50;
/** How long a file's existence is trusted before it is checked again. */
const STAT_TTL_MS = 3000;

export interface CanvasDependencies {
  readonly vaults: () => VaultRegistry | undefined;
  /** Fires when vaults become known or change. */
  readonly vaultsChanged?: vscode.Event<void>;
}

export function canvasEnabled(uri: vscode.Uri): boolean {
  return canvasSettings(uri).enabled;
}

/** The feature's settings (canvas.md 6). */
export function canvasSettings(uri: vscode.Uri): { enabled: boolean; editable: boolean; snapToGrid: boolean } {
  const config = vscode.workspace.getConfiguration('notewell.canvas', uri);
  return {
    enabled: config.get<boolean>('enabled', true) !== false,
    editable: config.get<boolean>('editable', true) !== false,
    snapToGrid: config.get<boolean>('snapToGrid', false) === true,
  };
}

/** Whether VS Code decoded a document as UTF-8 (undefined: a host without the encoding API). */
export function isUtf8(encoding: string | undefined): boolean {
  return encoding === undefined || encoding === 'utf8' || encoding === 'utf8bom';
}

function toWorkspaceEdit(uri: vscode.Uri, edits: readonly TextEdit[]): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const { range, newText } of edits) {
    edit.replace(uri, new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character), newText);
  }
  return edit;
}

function refusalText(reason: CanvasEditFailureReason): string {
  switch (reason) {
    case 'read-only':
      return messages.editReadOnly();
    case 'not-found':
      return messages.editStale();
    case 'ambiguous':
      return messages.editAmbiguous();
    case 'unsupported':
      return messages.editUnsupported();
    case 'value':
      return messages.editValue();
    case 'patch':
      return messages.editFailed();
  }
}

/**
 * Where a canvas's file paths are resolved: vault-relative inside a vault; otherwise relative
 * to the canvas file, kept inside its workspace folder (or its own folder).
 */
export interface PathContext {
  readonly root: vscode.Uri;
  /** Folder that relative paths start from, relative to `root` ('' = the root). */
  readonly base: string;
  readonly vault: boolean;
}

export function pathContext(uri: vscode.Uri, vaults: VaultRegistry | undefined): PathContext {
  const vault = vaults?.vaultFor(uri);
  if (vault !== undefined) return { root: vault.root, base: '', vault: true };
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri;
  const relative = folder === undefined ? undefined : vaultRelativePath(folder, uri);
  if (folder !== undefined && relative !== undefined) {
    return { root: folder, base: relative.split('/').slice(0, -1).join('/'), vault: false };
  }
  return { root: vscode.Uri.joinPath(uri, '..'), base: '', vault: false };
}

/** The file a canvas path names, or undefined when it leaves the context's root. */
export function resolveCanvasPath(context: PathContext, path: string): vscode.Uri | undefined {
  const relative = resolveInside(context.base, path);
  return relative === undefined ? undefined : vscode.Uri.joinPath(context.root, ...relative.split('/'));
}

/** Existence checks shared by the renders of one editor, trusted for a few seconds. */
class StatCache {
  readonly #entries = new Map<string, { exists: boolean; at: number }>();

  async exists(uri: vscode.Uri): Promise<boolean> {
    const id = uri.toString();
    const now = Date.now();
    const entry = this.#entries.get(id);
    if (entry !== undefined && now - entry.at < STAT_TTL_MS) return entry.exists;
    let exists: boolean;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      exists = (stat.type & vscode.FileType.File) !== 0;
    } catch {
      exists = false;
    }
    this.#entries.set(id, { exists, at: now });
    return exists;
  }
}

/** Notes larger than this are not shown in file cards (the card shows the name only). */
const MAX_NOTE_BYTES = 256 * 1024;

/** A note's text for its file card: the open document, else the file as strict UTF-8. */
async function readNote(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open !== undefined) return open.getText().length > MAX_NOTE_BYTES ? undefined : open.getText();
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_NOTE_BYTES) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function resolveResources(
  result: CanvasReadResult,
  context: PathContext,
  webview: vscode.Webview,
  stats: StatCache,
): Promise<Map<string, ResolvedResource>> {
  const { files, backgrounds } = resourcePaths(result);
  const resources = new Map<string, ResolvedResource>();
  const resolve = async (path: string): Promise<void> => {
    const uri = resolveCanvasPath(context, path);
    if (uri === undefined) {
      resources.set(path, { exists: false, inside: false });
      return;
    }
    const exists = await stats.exists(uri);
    // Images only from inside a vault (canvas.md 7); the vault root is a resource root.
    const preview = exists && context.vault && isImagePath(path);
    if (preview) {
      resources.set(path, { exists, inside: true, image: webview.asWebviewUri(uri).toString() });
      return;
    }
    // A note's text for its file cards (canvas.md 4); shown through the Markdown renderer only.
    const note = exists && /\.md$/i.test(path) ? await readNote(uri) : undefined;
    resources.set(path, note === undefined ? { exists, inside: true } : { exists, inside: true, note });
  };
  await Promise.all([...new Set([...files, ...backgrounds])].map(resolve));
  return resources;
}

export class CanvasEditorProvider implements vscode.CustomTextEditorProvider {
  readonly #extensionUri: vscode.Uri;
  readonly #vaults: () => VaultRegistry | undefined;
  readonly #vaultsChanged: vscode.Event<void> | undefined;

  constructor(extensionUri: vscode.Uri, deps: CanvasDependencies) {
    this.#extensionUri = extensionUri;
    this.#vaults = deps.vaults;
    this.#vaultsChanged = deps.vaultsChanged;
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (!canvasEnabled(document.uri)) {
      // The feature is off: show the file as text instead (canvas.md 2, like kanban).
      panel.dispose();
      void vscode.window.showInformationMessage(messages.disabled());
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }
    const webview = panel.webview;
    let context = pathContext(document.uri, this.#vaults());
    const setOptions = (): void => {
      webview.options = webviewOptions(this.#extensionUri, context.vault ? [context.root] : []);
    };
    setOptions();
    webview.html = webviewHtml(webview, this.#extensionUri, {
      title: document.uri.path.split('/').pop() ?? 'Canvas',
      scripts: ['canvas.js'],
      styles: ['canvas.css'],
      images: true,
    });

    let disposed = false;
    let ready = false;
    let latest: CanvasReadResult | undefined;
    /** Notes shown in file cards (URIs as strings): a change to one redraws the canvas. */
    let notes = new Set<string>();
    let request = 0;
    const stats = new StatCache();
    const post = (message: ExtensionMessage): void => {
      if (disposed) return;
      void Promise.resolve()
        .then(() => webview.postMessage(message))
        .catch(() => undefined);
    };

    const render = async (): Promise<void> => {
      if (!ready || disposed) return;
      const mine = ++request;
      const version = document.version;
      const result = readCanvas(document.getText());
      latest = result;
      const resources = await resolveResources(result, context, webview, stats);
      notes = new Set([...resources].filter(([, r]) => r.note !== undefined).map(([path]) => resolveCanvasPath(context, path)?.toString() ?? ''));
      // A newer render (document change, vaults found) supersedes this one.
      if (mine !== request || disposed) return;
      const { editable, snapToGrid } = canvasSettings(document.uri);
      post({ type: 'render', version, view: buildCanvasView(result, { strings: viewStrings(), messages: viewMessages(), resources, editable, snapToGrid }) });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRender = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void render();
      }, RENDER_DELAY_MS);
    };

    const openFile = async (index: number, id: string): Promise<void> => {
      const node = latest?.ok === true ? latest.canvas.nodes.find((n) => n.index === index) : undefined;
      if (node === undefined || node.kind !== 'file' || node.id !== id) return;
      const uri = resolveCanvasPath(context, node.file);
      if (uri === undefined) {
        void vscode.window.showWarningMessage(messages.fileOutside(node.file));
        return;
      }
      if (!(await stats.exists(uri))) {
        void vscode.window.showInformationMessage(messages.fileNotFound(node.file));
        return;
      }
      if (node.subpath !== undefined && /\.md$/i.test(uri.path)) {
        const target = await vscode.workspace.openTextDocument(uri);
        const line = findSubpathLine(target.getText(), node.subpath);
        const options: vscode.TextDocumentShowOptions =
          line === undefined ? { preview: false } : { preview: false, selection: new vscode.Range(line, 0, line, 0) };
        await vscode.window.showTextDocument(target, options);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', uri);
    };

    const openUrl = async (url: string): Promise<void> => {
      if (!isWebUrl(url)) {
        void vscode.window.showWarningMessage(messages.openUrlRefused());
        return;
      }
      const button = messages.openUrlButton();
      const answer = await vscode.window.showWarningMessage(messages.openUrlQuestion(), { modal: true, detail: url }, button);
      if (answer === button && !disposed) await vscode.env.openExternal(vscode.Uri.parse(url));
    };

    const openAsText = async (): Promise<void> => {
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', { viewColumn: panel.viewColumn, preview: false });
      panel.dispose();
    };

    /** Why the document must not be changed now, or undefined (core.md 3.4). */
    const documentProblem = async (): Promise<string | undefined> => {
      if (document.isClosed) return messages.editGone();
      if (!isUtf8(document.encoding)) return messages.editEncoding();
      if (document.uri.scheme === 'untitled') return undefined;
      try {
        await vscode.workspace.fs.stat(document.uri);
        return undefined;
      } catch {
        return messages.editGone();
      }
    };

    const applyCanvasEdit = async (message: EditMessage): Promise<void> => {
      // Every refusal redraws, so the card the webview moved ahead returns to its place.
      const refuse = (text: string): void => {
        post({ type: 'refused', message: text });
        void render();
      };
      const settings = canvasSettings(document.uri);
      // Turning the feature or editing off stops an open canvas from writing at once.
      if (!settings.enabled) return refuse(messages.disabled());
      if (!settings.editable) return refuse(messages.editOff());
      const problem = await documentProblem();
      if (problem !== undefined) return refuse(problem);
      if (message.version !== document.version) return refuse(messages.editStale());
      const result = readCanvas(document.getText());
      if (!result.ok) return refuse(messages.editStale());
      if (result.canvas.readOnly) return refuse(messages.editReadOnly());
      const check = checkEdit(result.canvas, message);
      if (!check.ok) return refuse(messages.editStale());
      const patch = computeCanvasPatch(result.doc, result.canvas, [check.edit]);
      if (!patch.ok) return refuse(refusalText(patch.reason));
      if (patch.edits.length === 0) {
        void render();
        return;
      }
      // Checked right before sending: an edit computed for an older version is never applied.
      if (disposed || document.isClosed || document.version !== message.version) return refuse(messages.editStale());
      // One WorkspaceEdit per user action: one undo step (a group move included).
      const applied = await vscode.workspace.applyEdit(toWorkspaceEdit(document.uri, patch.edits));
      if (!applied) refuse(messages.editFailed());
    };

    // Edits run one after another, each against the document the previous one left.
    let queue: Promise<void> = Promise.resolve();

    const handle = async (raw: unknown): Promise<void> => {
      const checked = validateWebviewMessage(raw);
      if (!checked.ok || disposed) return;
      const message = checked.message;
      if (isEditMessage(message)) {
        const run = queue.then(() => (disposed ? undefined : applyCanvasEdit(message)));
        queue = run.catch(() => undefined);
        await run;
        return;
      }
      switch (message.type) {
        case 'ready':
          ready = true;
          await render();
          return;
        case 'openUrl':
          await openUrl(message.url);
          return;
        case 'openFile':
          await openFile(message.index, message.id);
          return;
        case 'openLink':
          await openWikilink(message.target, document.uri, this.#vaults());
          return;
        case 'openAsText':
          await openAsText();
          return;
      }
    };

    const noteWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    const subscriptions: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: unknown) => void handle(message).catch(() => undefined)),
      // Editor typing, undo/redo and disk changes all arrive here.
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) return;
        if (event.document === document || (notes.size > 0 && notes.has(event.document.uri.toString()))) scheduleRender();
      }),
      noteWatcher,
      noteWatcher.onDidChange((uri) => void (notes.has(uri.toString()) && scheduleRender())),
      noteWatcher.onDidCreate(() => scheduleRender()),
      noteWatcher.onDidDelete((uri) => void (notes.has(uri.toString()) && scheduleRender())),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('notewell.canvas', document.uri)) scheduleRender();
      }),
    ];
    if (this.#vaultsChanged !== undefined) {
      subscriptions.push(
        this.#vaultsChanged(() => {
          const next = pathContext(document.uri, this.#vaults());
          if (next.root.toString() === context.root.toString() && next.vault === context.vault && next.base === context.base) return;
          context = next;
          setOptions();
          scheduleRender();
        }),
      );
    }
    panel.onDidDispose(() => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const s of subscriptions) s.dispose();
    });
  }
}
