// Registers the Backlog feature (backlog.md 2.1, 4.1, 6): project detection, context keys, the
// open command and its entry points (command palette, status bar, Explorer context menu on a
// project's task folder, editor title of a task file), and registering Backlog folders by hand.
import * as vscode from 'vscode';
import { BACKLOG_VIEW_TYPE, BacklogPanels, backlogSettings } from './panel.ts';
import { backlogFolder, BacklogProjects, pathId, projectUri, type BacklogProject, type RegisteredFolder } from './project.ts';
import { messages } from './strings.ts';
import { uiLabel } from './ui-text.ts';

export const COMMANDS = {
  open: 'notewell.backlog.open',
  /** Folder picker, then registration (backlog.md 2.1). */
  addFolder: 'notewell.backlog.addFolder',
  /** Explorer context menu on a folder. */
  registerFolder: 'notewell.backlog.registerFolder',
} as const;

/** The setting that lists registered Backlog folders (backlog.md 2.1). */
export const PROJECTS_SETTING = 'projects';

const ABSOLUTE = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;

/** `relative` inside `base` with `.` and `..` resolved (it may leave `base`). */
function resolveIn(base: vscode.Uri, relative: string): vscode.Uri {
  const segments = base.path.split('/').filter((s) => s !== '');
  for (const part of relative.split(/[\\/]/)) {
    if (part === '' || part === '.') continue;
    // A drive (`/c:`) is never left.
    if (part === '..') {
      if (!(segments.length === 1 && /^[A-Za-z]:$/.test(segments[0]))) segments.pop();
    } else segments.push(part);
  }
  return base.with({ path: `/${segments.join('/')}` });
}

/**
 * `notewell.backlog.projects` as folders: an absolute path as it is, a relative one inside each
 * workspace folder (whose own value may differ in a multi-root workspace).
 */
export function registeredFolders(): RegisteredFolder[] {
  const byEntry = new Map<string, Map<string, vscode.Uri>>();
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const scope of folders.length === 0 ? [undefined] : folders.map((f) => f.uri)) {
    const entries = vscode.workspace.getConfiguration('notewell.backlog', scope).get<unknown>(PROJECTS_SETTING, []);
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0')) continue;
      const entry = raw.trim();
      const uri = ABSOLUTE.test(entry) ? vscode.Uri.file(entry) : scope === undefined ? undefined : resolveIn(scope, entry);
      if (uri === undefined) continue;
      const candidates = byEntry.get(entry) ?? new Map<string, vscode.Uri>();
      candidates.set(pathId(uri), uri);
      byEntry.set(entry, candidates);
    }
  }
  return [...byEntry].map(([entry, candidates]) => ({ entry, candidates: [...candidates.values()] }));
}

/** POSIX path of `uri` relative to `base`, '.' for `base` itself; undefined outside it. */
function relativeTo(base: vscode.Uri, uri: vscode.Uri): string | undefined {
  const root = pathId(base);
  const target = pathId(uri);
  if (target === root) return '.';
  return target.startsWith(`${root}/`) ? uri.path.replace(/\/+$/, '').slice(base.path.replace(/\/+$/, '').length + 1) : undefined;
}

/**
 * Adds a Backlog folder to the workspace setting: relative to its workspace folder (that
 * folder's setting in a multi-root workspace), absolute when outside every workspace folder.
 */
async function writeRegistration(uri: vscode.Uri): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders.find((f) => relativeTo(f.uri, uri) !== undefined);
  const target =
    folder !== undefined && folders.length > 1 ? vscode.ConfigurationTarget.WorkspaceFolder
    : folders.length > 0 ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const value = folder === undefined ? uri.fsPath : relativeTo(folder.uri, uri)!;
  const config = vscode.workspace.getConfiguration('notewell.backlog', folder?.uri);
  const inspected = config.inspect<unknown>(PROJECTS_SETTING);
  const current =
    target === vscode.ConfigurationTarget.WorkspaceFolder ? inspected?.workspaceFolderValue
    : target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue
    : inspected?.globalValue;
  const list = Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string') : [];
  if (list.includes(value)) return;
  await config.update(PROJECTS_SETTING, [...list, value], target);
}

export const DETECTED_CONTEXT = 'notewell.backlog.detected';
/** Task folders of the detected projects (fsPath, as `resourcePath` in when clauses). */
export const PROJECT_DIRS_CONTEXT = 'notewell.backlog.projectDirs';
/** `<task folder>/tasks` of the detected projects (fsPath, as `resourceDirname`). */
export const TASK_DIRS_CONTEXT = 'notewell.backlog.taskDirs';

/** The project's task folder (`backlog`, `.backlog`, the configured or the registered one). */
const projectDir = backlogFolder;

/** Paths compare as Windows does: case-insensitive there, exact elsewhere. */
const pathKey = (fsPath: string): string => (process.platform === 'win32' ? fsPath.toLowerCase() : fsPath);

function contains(dir: vscode.Uri, uri: vscode.Uri): boolean {
  const base = pathKey(dir.fsPath).replace(/[\\/]+$/, '');
  const target = pathKey(uri.fsPath);
  return target === base || target.startsWith(`${base}\\`) || target.startsWith(`${base}/`);
}

/**
 * The project an entry point names, and the task to select: a task file opens its project with
 * that task selected; a folder opens the project whose task folder is or contains it.
 */
function target(found: readonly BacklogProject[], uri: vscode.Uri): { project: BacklogProject; select?: string } | undefined {
  for (const project of found) {
    const tasks = projectUri(project.folder, `${project.directory === '' ? '' : `${project.directory}/`}tasks`);
    const name = uri.path.split('/').pop() ?? '';
    if (/\.md$/i.test(name) && contains(tasks, uri) && pathKey(vscode.Uri.joinPath(tasks, name).fsPath) === pathKey(uri.fsPath)) {
      const path = `${project.directory === '' ? '' : `${project.directory}/`}tasks/${name}`;
      return project.index.byPath.has(path) ? { project, select: path } : { project };
    }
  }
  const owner = found.find((project) => contains(projectDir(project), uri));
  return owner === undefined ? undefined : { project: owner };
}

export function registerBacklog(context: vscode.ExtensionContext): void {
  let projects: BacklogProjects | undefined;
  let panels: BacklogPanels | undefined;
  let starting: Promise<void> | undefined;
  let shown: string | undefined;

  const status = vscode.window.createStatusBarItem('notewell.backlog', vscode.StatusBarAlignment.Left, -100);
  status.name = messages.statusBarName();
  status.text = '$(checklist) Backlog';
  status.command = COMMANDS.open;
  context.subscriptions.push(status);

  // Context keys and the status bar follow the detected projects; turned off, nothing shows.
  const sync = (): void => {
    const found = backlogSettings().enabled ? (projects?.projects ?? []) : [];
    const dirs = found.map((p) => projectDir(p).fsPath);
    const taskDirs = found.map((p) => vscode.Uri.joinPath(projectDir(p), 'tasks').fsPath);
    const tooltip = found.length === 1 ? messages.statusBarTooltipProject(found[0].name) : messages.statusBarTooltip();
    const state = JSON.stringify([dirs, taskDirs, tooltip]);
    if (state === shown) return;
    shown = state;
    void vscode.commands.executeCommand('setContext', DETECTED_CONTEXT, found.length > 0);
    void vscode.commands.executeCommand('setContext', PROJECT_DIRS_CONTEXT, dirs);
    void vscode.commands.executeCommand('setContext', TASK_DIRS_CONTEXT, taskDirs);
    status.tooltip = tooltip;
    if (found.length > 0) status.show();
    else status.hide();
  };

  const registeredChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(registeredChanged);

  // Detection starts only while the feature is enabled.
  const start = (): Promise<void> => {
    starting ??= BacklogProjects.create({
      onBrokenConfig: (folder, configFile, error) =>
        void vscode.window.showWarningMessage(messages.brokenConfig(vscode.Uri.joinPath(folder, configFile).fsPath, error)),
      registered: registeredFolders,
      onDidChangeRegistered: registeredChanged.event,
      onMissingRegistered: (entry) => void vscode.window.showWarningMessage(messages.registeredWithoutConfig(entry)),
    }).then((created) => {
      // Turned off while the first scan ran: nothing stays running.
      if (!backlogSettings().enabled) {
        created.dispose();
        starting = undefined;
        return;
      }
      projects = created;
      panels = new BacklogPanels(context.extensionUri, created, context.workspaceState);
      context.subscriptions.push(created, panels, created.onDidChange(sync));
      sync();
    });
    return starting;
  };

  /**
   * Turned off (backlog.md 6): open panels close and the project watchers stop, so nothing reads
   * or writes task files while the feature is off. Turning it on again starts afresh.
   */
  const stop = (): void => {
    panels?.dispose();
    projects?.dispose();
    panels = undefined;
    projects = undefined;
    starting = undefined;
  };

  /** From the palette or status bar without an argument; from the Explorer or an editor title with a Uri. */
  const open = async (arg?: unknown): Promise<void> => {
    if (!backlogSettings().enabled) {
      void vscode.window.showInformationMessage(messages.disabled());
      return;
    }
    await start();
    await projects?.idle();
    const found = projects?.projects ?? [];
    if (found.length === 0) {
      void vscode.window.showInformationMessage(messages.noProject());
      return;
    }
    const named = arg instanceof vscode.Uri ? target(found, arg) : undefined;
    if (named !== undefined) {
      panels?.open(named.project, named.select);
      return;
    }
    let project: BacklogProject | undefined = found[0];
    if (found.length > 1) {
      const picked = await vscode.window.showQuickPick(
        found.map((p) => ({ label: uiLabel(p.name), description: uiLabel(p.folder.fsPath, 200), project: p })),
        { placeHolder: messages.pickProject() },
      );
      if (picked === undefined) return;
      project = picked.project;
    }
    if (project !== undefined) panels?.open(project);
  };

  /** The project whose Backlog folder `uri` is (a workspace folder's or a registered one). */
  const projectAt = (uri: vscode.Uri): BacklogProject | undefined => projects?.projects.find((p) => pathId(projectDir(p)) === pathId(uri));

  /** Registers a Backlog folder (picked in a dialog without `arg`) and opens its board. */
  const register = async (arg?: unknown): Promise<void> => {
    if (!backlogSettings().enabled) {
      void vscode.window.showInformationMessage(messages.disabled());
      return;
    }
    let uri = arg instanceof vscode.Uri ? arg : undefined;
    if (uri === undefined) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: messages.addFolderLabel(),
        title: messages.addFolderTitle(),
      });
      uri = picked?.[0];
      if (uri === undefined) return;
    }
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, 'config.yml'));
    } catch {
      void vscode.window.showWarningMessage(messages.notBacklogFolder(uri.fsPath));
      return;
    }
    await start();
    await projects?.idle();
    // Already a project (found in a workspace folder or registered before): just open it.
    if (projectAt(uri) === undefined) {
      await writeRegistration(uri);
      registeredChanged.fire();
      await projects?.idle();
    }
    const project = projectAt(uri);
    if (project !== undefined) panels?.open(project);
  };

  context.subscriptions.push(
    // After a restart VS Code hands back the panels it kept (backlog.md 4.1); once projects are
    // found each shows its own again, or closes (turned off, project gone).
    vscode.window.registerWebviewPanelSerializer(BACKLOG_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        if (backlogSettings().enabled) {
          await start();
          await projects?.idle();
        }
        if (panels === undefined) panel.dispose();
        else panels.restore(panel, state);
      },
    }),
    vscode.commands.registerCommand(COMMANDS.open, open),
    // Back from a terminal or another app: files changed meanwhile are read even if their watcher
    // events were lost (backlog.md 4.1). Only changed files are read again.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void projects?.rescan();
    }),
    vscode.commands.registerCommand(COMMANDS.addFolder, () => register()),
    vscode.commands.registerCommand(COMMANDS.registerFolder, register),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`notewell.backlog.${PROJECTS_SETTING}`)) registeredChanged.fire();
      if (!event.affectsConfiguration('notewell.backlog.enabled')) return;
      if (backlogSettings().enabled) void start();
      else stop();
      sync();
    }),
  );
  // While disabled nothing runs: unset context keys already hide every entry point.
  if (backlogSettings().enabled) void start();
}
