// VS Code adapter for the Backlog panel (backlog.md 4.1, 5.1, 6): one webview panel per
// project, backed by a BacklogSession. Writes go only through WorkspaceEdit (an editor with
// unsaved changes, or saveOnEdit off) or workspace.fs.writeFile of the exact new bytes (no
// document.save, so save participants never run), and only to readable task files of the index.
import * as vscode from 'vscode';
import type { TextEdit } from '../../core/patch.ts';
import { webviewHtml, webviewOptions } from '../../webview/host.ts';
import type { ExtensionMessage } from './messages.ts';
import type { BacklogView } from './view.ts';
import { resolveProjectPath } from './paths.ts';
import { backlogFolder, pathId, projectUri, type BacklogProject, type BacklogProjects } from './project.ts';
import { BacklogSession, type BacklogPorts, type DependencyGraph } from './session.ts';
import { errorStrings, messages, viewStrings } from './strings.ts';
import { trackBusy } from './quiescence.ts';
import { uiText } from './ui-text.ts';
import { idKey, MAX_TASK_BYTES } from './task-index.ts';
import { buildBacklogView, buildTaskDetail } from './view-build.ts';

export const BACKLOG_VIEW_TYPE = 'notewell.backlog';

/** Index and file events are collected this long before the panel is redrawn. */
const RENDER_DELAY_MS = 50;
const WEB_URL = /^https?:\/\//i;

export function backlogSettings(scope?: vscode.Uri): { enabled: boolean; saveOnEdit: boolean; detailPosition: 'bottom' | 'right' } {
  const config = vscode.workspace.getConfiguration('notewell.backlog', scope);
  return {
    enabled: config.get<boolean>('enabled', true),
    saveOnEdit: config.get<boolean>('saveOnEdit', true),
    // Anything but 'right' (including a hand-edited value) means the default.
    detailPosition: config.get<string>('detailPosition', 'bottom') === 'right' ? 'right' : 'bottom',
  };
}

function toWorkspaceEdit(uri: vscode.Uri, edits: readonly TextEdit[]): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const { range, newText } of edits) {
    edit.replace(uri, new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character), newText);
  }
  return edit;
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
}

/** The open document for `uri`, opening it (without showing it) when needed. */
async function documentOf(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return openDocument(uri) ?? (await vscode.workspace.openTextDocument(uri));
}

/** Bytes that are not UTF-8: writing the decoded text back would replace them. */
class NotUtf8Error extends Error {}

/**
 * An editor decoded the file as UTF-8 (with or without BOM). With files.encoding set to a
 * legacy code page, or autoGuessEncoding, a UTF-8 task can be open as mojibake: editing that
 * text and the user's next save would write it in the other encoding.
 */
const isUtf8Document = (document: vscode.TextDocument): boolean => document.encoding === 'utf8' || document.encoding === 'utf8bom';

/**
 * The one place task bytes are written (backlog.md 5.1): the exact UTF-8 of `text`, in place.
 * Like the CLI, a write through a symbolic link, junction or hard link changes the target and
 * leaves the link as it is.
 */
async function writeTaskFile(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/**
 * The file's text exactly as stored: UTF-8 with a BOM kept as U+FEFF and line endings as
 * written, so a direct write changes no other byte (an editor document drops the BOM). Bytes
 * that are not UTF-8 throw NotUtf8Error.
 */
async function readFileText(uri: vscode.Uri): Promise<string> {
  // A task that grew past the limit after it was indexed is not read (it throws like a missing file).
  if ((await vscode.workspace.fs.stat(uri)).size > MAX_TASK_BYTES) throw new Error('too large');
  const bytes = await vscode.workspace.fs.readFile(uri);
  try {
    return new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(bytes);
  } catch {
    throw new NotUtf8Error();
  }
}

const panelTitle = (project: BacklogProject): string => `Backlog — ${uiText(project.name, 80)}`;

/** The Backlog folder (its pathId) a panel's webview saved with its state, if any (backlog.md 4.1). */
export function savedProject(state: unknown): string | undefined {
  const project = typeof state === 'object' && state !== null ? (state as { project?: unknown }).project : undefined;
  return typeof project === 'string' && project.length > 0 && project.length <= 4096 ? project : undefined;
}

type Layout = BacklogView['layout'];
const LAYOUT_COLUMNS = ['id', 'title', 'status', 'priority', 'assignee', 'milestone'];

/** A stored layout, checked value by value; anything odd is dropped. */
export function readLayout(raw: unknown): Layout {
  const columnWidths: Record<string, number> = {};
  const paneSizes: { bottom?: number; right?: number } = {};
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as { columnWidths?: Record<string, unknown>; paneSizes?: Record<string, unknown> };
    const int = (value: unknown, min: number, max: number): number | undefined =>
      typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
    for (const column of LAYOUT_COLUMNS) {
      const width = int(r.columnWidths?.[column], 48, 2000);
      if (width !== undefined) columnWidths[column] = width;
    }
    const bottom = int(r.paneSizes?.['bottom'], 1, 999);
    const right = int(r.paneSizes?.['right'], 1, 999);
    if (bottom !== undefined) paneSizes.bottom = bottom;
    if (right !== undefined) paneSizes.right = right;
  }
  return { columnWidths, paneSizes };
}

export class BacklogPanels implements vscode.Disposable {
  readonly #extensionUri: vscode.Uri;
  readonly #projects: BacklogProjects;
  /** Open panels by project id, with a way to select a task in each. */
  readonly #panels = new Map<string, { readonly panel: vscode.WebviewPanel; readonly select: (path: string) => void }>();

  /** Per-project layout that survives closing the panel (workspace storage). */
  readonly #memento: vscode.Memento | undefined;

  constructor(extensionUri: vscode.Uri, projects: BacklogProjects, memento?: vscode.Memento) {
    this.#extensionUri = extensionUri;
    this.#projects = projects;
    this.#memento = memento;
  }

  /**
   * Shows the project's panel, creating it on first use. `selectPath` (a task path in the index)
   * opens that task's detail, as from a task file's editor title (backlog.md 4.1).
   */
  open(project: BacklogProject, selectPath?: string): void {
    // One panel per Backlog folder, however the project reached it (detected or registered).
    const id = pathId(backlogFolder(project));
    const existing = this.#panels.get(id);
    if (existing !== undefined) {
      existing.panel.reveal();
      if (selectPath !== undefined) existing.select(selectPath);
      return;
    }
    const panel = vscode.window.createWebviewPanel(BACKLOG_VIEW_TYPE, panelTitle(project), vscode.ViewColumn.Active, webviewOptions(this.#extensionUri));
    const select = this.#adopt(panel, project);
    if (selectPath !== undefined) select(selectPath);
  }

  /**
   * A panel VS Code kept from before a restart (backlog.md 4.1) shows the project its webview
   * saved, in the same place; its view state comes back with the webview. Closed when that
   * project is not here (gone, another workspace) or already has a panel: no empty tab stays.
   */
  restore(panel: vscode.WebviewPanel, state: unknown): void {
    const saved = savedProject(state);
    const found = this.#projects.projects;
    // Saved before panels recorded their project: the only project, if there is just one.
    const project = saved === undefined ? (found.length === 1 ? found[0] : undefined) : found.find((p) => pathId(backlogFolder(p)) === saved);
    if (project === undefined || this.#panels.has(pathId(backlogFolder(project)))) {
      panel.dispose();
      return;
    }
    panel.webview.options = webviewOptions(this.#extensionUri);
    this.#adopt(panel, project);
  }

  dispose(): void {
    for (const { panel } of [...this.#panels.values()]) panel.dispose();
    this.#panels.clear();
  }

  /** Makes `panel` the project's panel: its page (which saves the project with its state) and session. */
  #adopt(panel: vscode.WebviewPanel, project: BacklogProject): (path: string) => void {
    const id = pathId(backlogFolder(project));
    const title = panelTitle(project);
    panel.title = title;
    panel.webview.html = webviewHtml(panel.webview, this.#extensionUri, { title, scripts: ['backlog.js'], styles: ['backlog.css'], data: { project: id } });
    const select = this.#connect(panel, project);
    this.#panels.set(id, { panel, select });
    panel.onDidDispose(() => this.#panels.delete(id));
    return select;
  }

  /** Wires the panel to a session; returns how to select a task (sent once the webview is ready). */
  #connect(panel: vscode.WebviewPanel, project: BacklogProject): (path: string) => void {
    const { folder } = project;
    const folderId = pathId(backlogFolder(project));
    /**
     * The project shown, looked up by its Backlog folder each time: when the same folder is
     * found another way (a registration that detection now also finds), the panel follows it.
     * Task paths are relative to that project's root, never to the one the panel opened with.
     */
    const current = (): BacklogProject | undefined => this.#projects.projects.find((p) => pathId(backlogFolder(p)) === folderId);
    /** URI of a readable task file of the current index; other paths are never written. */
    const taskUri = (path: string): vscode.Uri | undefined => {
      const shown = current();
      return shown?.index.byPath.has(path) === true ? projectUri(shown.folder, path) : undefined;
    };
    /** Whether the task file (or a folder above it) is gone since the index read it. */
    const gone = async (uri: vscode.Uri): Promise<boolean> => {
      try {
        await vscode.workspace.fs.stat(uri);
        return false;
      } catch {
        return true;
      }
    };
    const strings = viewStrings();
    const layoutKey = (): string => `notewell.backlog.layout:${current()?.id ?? project.id}`;
    let disposed = false;
    /** An open editor with unsaved changes, or saveOnEdit off: edit the document, do not save. */
    const viaEditor = (uri: vscode.Uri): boolean => openDocument(uri)?.isDirty === true || !backlogSettings(folder).saveOnEdit;

    /** False on a file system that says it cannot be written: tasks are shown read-only (backlog.md 4.4). */
    const writable = (project: BacklogProject): boolean => vscode.workspace.fs.isWritableFileSystem(project.folder.scheme) !== false;

    const ports: BacklogPorts = {
      view: () => {
        const project = current();
        return (
          project &&
          buildBacklogView(project.index, project.config, project.name, strings, backlogSettings(folder).detailPosition, readLayout(this.#memento?.get(layoutKey())), writable(project))
        );
      },
      detail: (path) => {
        const project = current();
        return project === undefined ? null : buildTaskDetail(project.index, path, writable(project));
      },
      // Edits go through the editor when it has unsaved changes or saveOnEdit is off; otherwise
      // the file bytes are read and written directly (backlog.md 5.1).
      readTask: async (path) => {
        const uri = taskUri(path);
        if (uri === undefined) return undefined;
        try {
          if (viaEditor(uri)) {
            const document = await documentOf(uri);
            if (!isUtf8Document(document)) return 'encoding';
            return { text: document.getText(), version: document.version };
          }
          return { text: await readFileText(uri), version: 0 };
        } catch (error) {
          return error instanceof NotUtf8Error ? 'encoding' : undefined;
        }
      },
      write: async (path, { before, after, edits }) => {
        const uri = taskUri(path);
        if (uri === undefined) return 'stale';
        if (await gone(uri)) return 'stale';
        try {
          if (viaEditor(uri)) {
            const document = await documentOf(uri);
            if (!isUtf8Document(document)) return 'encoding';
            if (document.getText() !== before) return 'stale';
            if (!(await vscode.workspace.applyEdit(toWorkspaceEdit(uri, edits)))) return 'failed';
            this.#projects.refresh(uri);
            return 'written';
          }
          // A virtual or remote file system that says it cannot be written: do not try.
          if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) return 'readOnly';
          // Right before writing: the file must still hold exactly what the change was built on.
          if ((await readFileText(uri)) !== before) return 'stale';
        } catch (error) {
          return error instanceof NotUtf8Error ? 'encoding' : 'failed';
        }
        try {
          await writeTaskFile(uri, after);
        } catch {
          return await afterFailedWrite(uri, before, after);
        }
        // The index re-reads it now: a file watcher may be late or miss our own write.
        this.#projects.refresh(uri);
        return 'written';
      },
      // Unreadable statuses (a broken config.yml) are not replaced by the defaults for writing.
      statuses: () => {
        const shown = current();
        return shown === undefined || shown.unreadable.includes('statuses') ? [] : shown.config.statuses;
      },
      // Likewise unreadable priorities: none can be set until the config is fixed.
      priorities: () => {
        const shown = current();
        return shown === undefined || shown.unreadable.includes('priorities') ? [] : shown.config.priorities;
      },
      post: (message) => {
        if (!disposed) void panel.webview.postMessage(message);
      },
      // Board tasks and archived ones (shown read-only, backlog.md 3.1) open as text.
      openTask: async (path) => {
        const shown = current();
        const uri = taskUri(path) ?? (shown?.index.archivedByPath.has(path) === true ? projectUri(shown.folder, path) : undefined);
        if (uri !== undefined) await vscode.window.showTextDocument(uri, { preview: false });
      },
      openPath: async (path) => openProjectPath(current()?.folder ?? folder, path),
      openUrl: async (url) => {
        if (!WEB_URL.test(url)) {
          void vscode.window.showWarningMessage(messages.openUrlRefused());
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      now: () => new Date(),
      errors: errorStrings(),
      dependencies: () => dependencyGraph(current()),
      saveLayout: async (layout) => {
        await this.#memento?.update(layoutKey(), readLayout(layout));
      },
      // A window-scoped user setting (backlog.md 4.1); onDidChangeConfiguration below redraws.
      setDetailPosition: async (position) => {
        await vscode.workspace.getConfiguration('notewell.backlog').update('detailPosition', position, vscode.ConfigurationTarget.Global);
      },
    };
    const session = new BacklogSession(ports);
    // Busy while messages are handled or a redraw is due (quiescence.ts).
    const untrack = trackBusy(() => !disposed && (session.busy || timer !== undefined));
    // A task to select waits until the webview has said 'ready' (a new panel is still loading).
    let ready = false;
    let pendingSelect: string | undefined;
    const select = (path: string): void => {
      if (!ready) {
        pendingSelect = path;
        return;
      }
      const message: ExtensionMessage = { type: 'select', path };
      if (!disposed) void panel.webview.postMessage(message);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRender = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) session.render();
      }, RENDER_DELAY_MS);
    };
    const subscriptions: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        const isReady = typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready';
        // A (re)loaded webview: catch up with changes whose watcher events never came.
        if (isReady) void this.#projects.rescan();
        void session.handle(message).then(() => {
          if (!isReady || disposed) return;
          ready = true;
          const path = pendingSelect;
          pendingSelect = undefined;
          if (path !== undefined) select(path);
        });
      }),
      // A hidden panel's webview is torn down and loads again when shown: until its next
      // 'ready', a task to select waits instead of going to a page that is not there.
      panel.onDidChangeViewState((event) => {
        if (!event.webviewPanel.visible) ready = false;
        // Shown again: the CLI may have changed files while it was hidden (and events can be lost).
        else void this.#projects.rescan();
      }),
      // Our own edits, CLI and git changes and editor typing all reach the index first.
      this.#projects.onDidChange(scheduleRender),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('notewell.backlog', folder)) scheduleRender();
      }),
    ];
    panel.onDidDispose(() => {
      disposed = true;
      untrack();
      if (timer !== undefined) clearTimeout(timer);
      for (const s of subscriptions) s.dispose();
    });
    return select;
  }
}

/**
 * A direct write threw (read-only, permission denied, locked, disk full, connection lost).
 * Usually nothing was written. When the file holds a cut-off copy of the new text, the
 * original bytes are written back once; 'failed' when even that does not restore them.
 */
async function afterFailedWrite(uri: vscode.Uri, before: string, after: string): Promise<'readOnly' | 'written' | 'failed'> {
  let now: string;
  try {
    now = await readFileText(uri);
  } catch {
    return 'failed';
  }
  if (now === before) return 'readOnly';
  if (now === after) return 'written';
  // Anything else than a prefix of our text was written by someone else: leave it alone.
  if (!after.startsWith(now)) return 'failed';
  try {
    await writeTaskFile(uri, before);
    return (await readFileText(uri)) === before ? 'readOnly' : 'failed';
  } catch {
    return 'failed';
  }
}

/** The project's dependency graph by normalized ID; empty without a project. */
export function dependencyGraph(project: BacklogProject | undefined): DependencyGraph {
  const prefix = project?.config.taskPrefix ?? 'task';
  const keyOf = (id: string): string => idKey(id, prefix);
  const tasks = new Map<string, readonly string[]>();
  // Tasks sharing an ID (backlog.md 3.1) contribute all their dependencies, so no edge is lost.
  for (const task of project?.index.tasks ?? []) {
    const id = keyOf(task.id);
    tasks.set(id, [...(tasks.get(id) ?? []), ...task.data.dependencies]);
  }
  return { keyOf, tasks };
}

/**
 * Opens a path named in a task (documentation, modified_files, references) relative to the
 * workspace folder root. Paths outside the root are refused; missing files are reported.
 */
export async function openProjectPath(folder: vscode.Uri, path: string): Promise<void> {
  const relative = resolveProjectPath(path);
  if (relative === undefined) {
    void vscode.window.showWarningMessage(messages.pathOutsideProject());
    return;
  }
  const uri = projectUri(folder, relative);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    void vscode.window.showWarningMessage(messages.fileNotFound(path));
    return;
  }
  await vscode.commands.executeCommand('vscode.open', uri);
}
