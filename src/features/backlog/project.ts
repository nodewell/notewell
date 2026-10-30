// VS Code adapter: finds Backlog.md projects at workspace folder roots and in registered
// Backlog folders (backlog.md 2.1), reads their config, tasks and milestones, and follows
// changes. Read-only by design: it never writes, deletes or renames anything (workspace.fs:
// readFile and readDirectory only).
import * as vscode from 'vscode';
import { CONFIG_FILES, detectProject, parseConfig, type BacklogConfig, type DetectedProject } from './config.ts';
import { trackBusy } from './quiescence.ts';
import { indexTasks, MAX_TASK_BYTES, readMilestone, readTask, type Milestone, type TaskEntry, type TaskIndex } from './task-index.ts';

export interface BacklogProject {
  /** Identifies the project (panels, stored layout): the workspace folder, or the registered Backlog folder. */
  readonly id: string;
  /**
   * Project root; task and document paths are relative to it. The workspace folder, or the
   * parent of a registered Backlog folder.
   */
  readonly folder: vscode.Uri;
  /** Root folder name, shown as the project name. */
  readonly name: string;
  /** Task folder relative to the root (POSIX), '' for the root itself. */
  readonly directory: string;
  readonly configFile: string;
  readonly config: BacklogConfig;
  /** Config keys that could not be read (their defaults are in `config`). */
  readonly unreadable: readonly string[];
  readonly index: TaskIndex;
}

/** One `notewell.backlog.projects` entry: the folders it may name (one per workspace folder for a relative path). */
export interface RegisteredFolder {
  readonly entry: string;
  readonly candidates: readonly vscode.Uri[];
}

export interface BacklogProjectsOptions {
  /** Called once per project while its config has unreadable keys (defaults are used meanwhile). */
  readonly onBrokenConfig: (folder: vscode.Uri, configFile: string, error: string) => void;
  /** Registered Backlog folders (backlog.md 2.1); read again when onDidChangeRegistered fires. */
  readonly registered?: () => readonly RegisteredFolder[];
  readonly onDidChangeRegistered?: vscode.Event<void>;
  /** Called once per registered entry while none of its candidates holds a `config.yml`. */
  readonly onMissingRegistered?: (entry: string) => void;
}

/** Paths compare as Windows does: case-insensitive there, exact elsewhere. */
export function pathId(uri: vscode.Uri): string {
  const path = `${uri.scheme}:${uri.path.replace(/\/+$/, '')}`;
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** The Backlog folder (where config.yml is) of a project. */
export function backlogFolder(project: Pick<BacklogProject, 'folder' | 'directory'>): vscode.Uri {
  return project.directory === '' ? project.folder : projectUri(project.folder, project.directory);
}

/** Root and folder name of a registered Backlog folder; undefined for a filesystem root. */
function splitFolder(uri: vscode.Uri): { root: vscode.Uri; name: string } | undefined {
  const path = uri.path.replace(/\/+$/, '');
  const cut = path.lastIndexOf('/');
  const name = path.slice(cut + 1);
  if (cut < 0 || name === '' || /^[A-Za-z]:$/.test(name)) return undefined;
  return { root: uri.with({ path: cut === 0 ? '/' : path.slice(0, cut) }), name };
}

/** File events are collected this long before the changed files are read. */
const DEBOUNCE_MS = 50;

/** A file's text, undefined when it cannot be read, or why a task file is not read. */
type ReadResult = string | undefined | { readonly unreadable: 'notUtf8' | 'tooLarge' };

/** Reads at most this many files at once: thousands at once run out of file handles. */
const READ_CONCURRENCY = 32;

/** Runs `run` for every item, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>, limit = READ_CONCURRENCY): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * A file's text; undefined when it cannot be read. With `strict` (task files): a file larger
 * than MAX_TASK_BYTES is not read at all (a stray dump could exhaust memory), and bytes that are
 * not UTF-8 are reported instead of decoded (they would show and later write replacement
 * characters).
 */
async function readText(uri: vscode.Uri, strict = false): Promise<ReadResult> {
  const id = uri.toString();
  // Only unsaved editor text wins (backlog.md 4.1). A clean document may not have reloaded yet
  // after a write to disk (ours included); reading it would cache the old text. An editor that
  // decoded the file with another encoding than UTF-8 shows mojibake: the disk is read instead.
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === id);
  if (open?.isDirty === true && (open.encoding === 'utf8' || open.encoding === 'utf8bom')) return open.getText();
  let bytes: Uint8Array;
  try {
    if (strict && (await vscode.workspace.fs.stat(uri)).size > MAX_TASK_BYTES) return { unreadable: 'tooLarge' };
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: strict }).decode(bytes);
  } catch {
    return { unreadable: 'notUtf8' };
  }
}

const textOf = (result: ReadResult): string | undefined => (typeof result === 'string' ? result : undefined);

/** `mtime:size` of a file, or undefined when it cannot be stat'ed (gone). */
async function stampOf(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const { mtime, size } = await vscode.workspace.fs.stat(uri);
    return `${mtime}:${size}`;
  } catch {
    return undefined;
  }
}

/**
 * Folders read under the Backlog folder and what their `.md` files are (backlog.md 3.1): archived
 * tasks (`archive/tasks/`, and `completed/` from before CLI 1.54.0) only for dependencies.
 */
const TASK_DIRS: ReadonlyMap<string, 'task' | 'milestone' | 'archived'> = new Map([
  ['tasks', 'task'],
  ['milestones', 'milestone'],
  ['archive/tasks', 'archived'],
  ['completed', 'archived'],
]);

/** The key under which the config file's stamp is kept (not a project-relative path). */
const CONFIG_STAMP = '#config';

/** A task file's index entry; a file not read (too large, not UTF-8) is unreadable with that reason. */
function taskEntry(path: string, result: Exclude<ReadResult, undefined>): TaskEntry {
  return typeof result === 'string' ? readTask(path, result) : { kind: 'unreadable', path, reason: result.unreadable };
}

async function markdownFiles(dir: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    // A symbolic link to a file is read like the file (backlog.md 3.1); one to a folder, or a broken one, is not.
    return entries.filter(([name, type]) => (type & ~vscode.FileType.SymbolicLink) === vscode.FileType.File && /\.md$/i.test(name)).map(([name]) => name);
  } catch {
    return [];
  }
}

/** URI of a project-relative POSIX path. */
export function projectUri(folder: vscode.Uri, path: string): vscode.Uri {
  return vscode.Uri.joinPath(folder, ...path.split('/'));
}

/** Project-relative POSIX path of a URI inside the folder, or undefined outside it. */
export function projectPath(folder: vscode.Uri, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== folder.scheme) return undefined;
  const root = folder.path.replace(/\/$/, '');
  return uri.path.startsWith(`${root}/`) ? uri.path.slice(root.length + 1) : undefined;
}

function detect(folder: vscode.Uri): Promise<DetectedProject | null> {
  return detectProject(async (path) => textOf(await readText(projectUri(folder, path))));
}

/** A registered Backlog folder `<root>/<name>`: its `config.yml`, tasks in `<name>/tasks`. */
async function detectRegistered(root: vscode.Uri, name: string): Promise<DetectedProject | null> {
  const configFile = `${name}/config.yml`;
  const text = textOf(await readText(projectUri(root, configFile)));
  return text === undefined ? null : { configFile, directory: name, ...parseConfig(text) };
}

/** Glob metacharacters cannot be escaped in a RelativePattern: such names are not watched. */
const GLOB_SAFE = /^[^{}[\]*?,!]+$/;

/** Projects of the current workspace folders, detection only (for the context key). */
export async function detectedProjects(): Promise<{ folder: vscode.Uri; name: string; project: DetectedProject }[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = await Promise.all(folders.map(async (f) => ({ folder: f.uri, name: f.name, project: await detect(f.uri) })));
  return found.filter((f): f is { folder: vscode.Uri; name: string; project: DetectedProject } => f.project !== null);
}

interface ProjectState {
  readonly detected: DetectedProject;
  readonly tasks: Map<string, TaskEntry>;
  readonly milestones: Map<string, Milestone | null>;
  /** Tasks in `archive/tasks/` and `completed/` (before CLI 1.54.0): read for dependencies only, never written. */
  readonly archived: Map<string, TaskEntry>;
  /**
   * `mtime:size` of every file read (and of the config under CONFIG_STAMP), taken before the read:
   * a rescan re-reads only files whose stamp differs, so it also catches changes made while reading.
   */
  readonly stamps: Map<string, string>;
  readonly watchers: vscode.Disposable[];
  /** Null until the first read finishes. */
  snapshot: BacklogProject | null;
}

interface FolderState {
  readonly id: string;
  readonly folder: vscode.Uri;
  readonly name: string;
  /** The registered Backlog folder's name under `folder`; undefined for a workspace folder. */
  readonly registered: string | undefined;
  readonly watcher: vscode.Disposable;
  project: ProjectState | null;
  /** Project-relative paths changed since the last read. */
  readonly pending: Set<string>;
  redetect: boolean;
  reload: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Reads run one after another per folder, so an older read never overwrites a newer one. */
  queue: Promise<void>;
  disposed: boolean;
}

export class BacklogProjects implements vscode.Disposable {
  readonly #options: BacklogProjectsOptions;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #changed = new vscode.EventEmitter<void>();
  readonly #folders = new Map<string, FolderState>();
  /** Folders whose broken config was already reported. */
  readonly #warned = new Set<string>();
  /** Registered entries reported as missing a config.yml. */
  readonly #missing = new Set<string>();
  #syncing: Promise<void> = Promise.resolve();

  /** Fires after a project is found or lost, or its config, tasks or milestones change. */
  readonly onDidChange: vscode.Event<void> = this.#changed.event;

  /** Queued reads, syncs and rescans in progress (quiescence.ts); debounce timers count too. */
  #running = 0;
  readonly #untrack: () => void;

  private constructor(options: BacklogProjectsOptions) {
    this.#options = options;
    this.#untrack = trackBusy(() => this.#running > 0 || [...this.#folders.values()].some((s) => s.timer !== undefined));
  }

  static async create(options: BacklogProjectsOptions): Promise<BacklogProjects> {
    const projects = new BacklogProjects(options);
    projects.#watch();
    await projects.#syncFolders();
    return projects;
  }

  /** Workspace folder projects first; a registered folder that one of them already is counts once. */
  get projects(): readonly BacklogProject[] {
    const out: BacklogProject[] = [];
    const seen = new Set<string>();
    const states = [...this.#folders.values()];
    for (const state of [...states.filter((s) => s.registered === undefined), ...states.filter((s) => s.registered !== undefined)]) {
      const snapshot = state.project?.snapshot;
      if (!snapshot) continue;
      const id = pathId(backlogFolder(snapshot));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(snapshot);
    }
    return out;
  }

  /** The project whose workspace folder contains `uri`. */
  projectOf(uri: vscode.Uri): BacklogProject | undefined {
    return this.projects.find((p) => projectPath(p.folder, uri) !== undefined);
  }

  /** Reads a file again soon, without waiting for a file watcher (after our own writes). */
  refresh(uri: vscode.Uri): void {
    for (const state of this.#folders.values()) {
      const path = projectPath(state.folder, uri);
      if (path !== undefined && state.project !== null && this.#kindOf(state.project, path) !== undefined) {
        this.#schedule(state, (s) => s.pending.add(path));
      }
    }
  }

  /** Resolves when every queued read has finished (tests, first render). */
  async idle(): Promise<void> {
    await this.#syncing;
    for (const state of this.#folders.values()) await state.queue;
  }

  dispose(): void {
    this.#untrack();
    for (const state of this.#folders.values()) this.#disposeFolder(state);
    this.#folders.clear();
    for (const d of this.#disposables) d.dispose();
    this.#changed.dispose();
  }

  #watch(): void {
    const onDocument = (uri: vscode.Uri): void => {
      for (const state of this.#folders.values()) {
        const path = projectPath(state.folder, uri);
        if (path !== undefined && state.project !== null && this.#kindOf(state.project, path) !== undefined) {
          this.#schedule(state, (s) => s.pending.add(path));
        }
      }
    };
    const sync = (): void => void this.#syncFolders();
    if (this.#options.onDidChangeRegistered !== undefined) this.#disposables.push(this.#options.onDidChangeRegistered(sync));
    this.#disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(sync),
      vscode.workspace.onDidChangeTextDocument((e) => onDocument(e.document.uri)),
      // An unsaved edit was discarded: read the file again.
      vscode.workspace.onDidCloseTextDocument((doc) => onDocument(doc.uri)),
    );
  }

  /** Runs one sync at a time, so a later settings change never races an earlier one. */
  #syncFolders(): Promise<void> {
    this.#running++;
    const run = this.#syncing.then(() => this.#sync()).finally(() => void this.#running--);
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  async #sync(): Promise<void> {
    // Workspace folders by URI; registered folders by their normalized path (one state each).
    const wanted = new Map<string, { folder: vscode.Uri; name: string; registered?: string }>();
    for (const f of vscode.workspace.workspaceFolders ?? []) wanted.set(f.uri.toString(), { folder: f.uri, name: f.name });
    const registered = this.#options.registered?.() ?? [];
    for (const { candidates } of registered) {
      for (const candidate of candidates) {
        const split = splitFolder(candidate);
        const id = `registered:${pathId(candidate)}`;
        if (split === undefined || wanted.has(id)) continue;
        wanted.set(id, { folder: split.root, name: splitFolder(split.root)?.name ?? split.root.path, registered: split.name });
      }
    }
    let removed = false;
    for (const [id, state] of this.#folders) {
      if (wanted.has(id)) continue;
      removed ||= state.project !== null;
      this.#disposeFolder(state);
      this.#folders.delete(id);
      this.#warned.delete(id);
    }
    const added: FolderState[] = [];
    for (const [id, f] of wanted) {
      if (this.#folders.has(id)) continue;
      const state = this.#createFolder(id, f.folder, f.name, f.registered);
      this.#folders.set(id, state);
      added.push(state);
    }
    for (const state of added) this.#enqueue(state, () => this.#redetect(state));
    await Promise.all(added.map((s) => s.queue));
    this.#reportMissing(registered);
    if (removed) this.#changed.fire();
  }

  /** Warns once per registered entry none of whose folders has a config.yml (until one has). */
  #reportMissing(registered: readonly RegisteredFolder[]): void {
    const entries = new Set(registered.map((r) => r.entry));
    for (const entry of this.#missing) if (!entries.has(entry)) this.#missing.delete(entry);
    for (const { entry, candidates } of registered) {
      const found = candidates.some((c) => (this.#folders.get(`registered:${pathId(c)}`)?.project ?? null) !== null);
      if (found) this.#missing.delete(entry);
      else if (!this.#missing.has(entry)) {
        this.#missing.add(entry);
        this.#options.onMissingRegistered?.(entry);
      }
    }
  }

  #createFolder(id: string, folder: vscode.Uri, name: string, registered: string | undefined): FolderState {
    // Config files and the default task folders (their deletion removes the config with them);
    // for a registered folder its config.yml and the folder itself.
    const pattern =
      registered === undefined ? `{${[...CONFIG_FILES, 'backlog', '.backlog'].join(',')}}`
      : GLOB_SAFE.test(registered) ? `{${registered}/config.yml,${registered}}`
      : undefined;
    const watcher = pattern === undefined ? undefined : vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
    const state: FolderState = {
      id,
      folder,
      name,
      registered,
      watcher: watcher ?? { dispose: () => undefined },
      project: null,
      pending: new Set(),
      redetect: false,
      reload: false,
      timer: undefined,
      queue: Promise.resolve(),
      disposed: false,
    };
    const onConfig = (): void => this.#schedule(state, (s) => void (s.redetect = true));
    watcher?.onDidCreate(onConfig);
    watcher?.onDidChange(onConfig);
    watcher?.onDidDelete(onConfig);
    return state;
  }

  #disposeFolder(state: FolderState): void {
    state.disposed = true;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.watcher.dispose();
    if (state.project !== null) for (const d of state.project.watchers) d.dispose();
  }

  #schedule(state: FolderState, mark: (state: FolderState) => void): void {
    if (state.disposed) return;
    mark(state);
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.#enqueue(state, () => this.#flush(state));
    }, DEBOUNCE_MS);
  }

  #enqueue(state: FolderState, run: () => Promise<void>): void {
    this.#running++;
    state.queue = state.queue.then(run).catch(() => undefined).finally(() => void this.#running--);
  }

  /** The kind of a file this project reads (by its folder, TASK_DIRS); undefined otherwise. */
  #kindOf(project: ProjectState, path: string): 'task' | 'milestone' | 'archived' | undefined {
    const base = project.detected.directory === '' ? '' : `${project.detected.directory}/`;
    if (!path.startsWith(base) || !/\.md$/i.test(path)) return undefined;
    const rest = path.slice(base.length);
    const slash = rest.lastIndexOf('/');
    return slash < 0 ? undefined : TASK_DIRS.get(rest.slice(0, slash));
  }

  async #flush(state: FolderState): Promise<void> {
    if (state.disposed) return;
    if (state.redetect) {
      state.redetect = false;
      state.pending.clear();
      await this.#redetect(state);
      return;
    }
    const project = state.project;
    if (project === null) return;
    if (state.reload) {
      state.reload = false;
      state.pending.clear();
      await this.#loadAll(state, project);
      this.#publish(state, project);
      return;
    }
    const paths = [...state.pending];
    state.pending.clear();
    await eachLimited(paths, (path) => this.#readOne(state, project, path));
    if (state.disposed || state.project !== project) return;
    this.#publish(state, project);
  }

  /** Reads one task, milestone or archived file into the project (or drops it when gone). */
  async #readOne(state: FolderState, project: ProjectState, path: string): Promise<void> {
    const kind = this.#kindOf(project, path);
    if (kind === undefined) return;
    const uri = projectUri(state.folder, path);
    const stamp = await stampOf(uri);
    const result = await readText(uri, kind !== 'milestone');
    if (result === undefined || stamp === undefined) project.stamps.delete(path);
    else project.stamps.set(path, stamp);
    if (kind === 'task' || kind === 'archived') {
      const map = kind === 'task' ? project.tasks : project.archived;
      if (result === undefined) map.delete(path);
      else map.set(path, taskEntry(path, result));
    } else {
      const text = textOf(result);
      if (text === undefined) project.milestones.delete(path);
      else project.milestones.set(path, readMilestone(path, text));
    }
  }

  /** The task, milestone and archived files on disk now (project-relative paths). */
  async #listFiles(state: FolderState, project: ProjectState): Promise<string[]> {
    const base = project.detected.directory === '' ? '' : `${project.detected.directory}/`;
    const dirs = [...TASK_DIRS.keys()];
    const names = await Promise.all(dirs.map((dir) => markdownFiles(projectUri(state.folder, `${base}${dir}`))));
    return dirs.flatMap((dir, i) => names[i].map((name) => `${base}${dir}/${name}`));
  }

  /**
   * Brings every project in line with the disk without relying on watcher events, which can be
   * dropped (a burst of CLI commands, a git checkout): new, changed (by mtime and size) and
   * vanished files are read again, and the config when it changed. Unchanged files are not read.
   */
  async rescan(): Promise<void> {
    this.#running++;
    try {
      await this.#syncing;
      for (const state of this.#folders.values()) this.#enqueue(state, () => this.#rescan(state));
      await this.idle();
    } finally {
      this.#running--;
    }
  }

  async #rescan(state: FolderState): Promise<void> {
    if (state.disposed) return;
    const before = state.project;
    if (before === null || (await stampOf(projectUri(state.folder, before.detected.configFile))) !== before.stamps.get(CONFIG_STAMP)) {
      await this.#redetect(state);
    }
    const project = state.project;
    // No project, or a different one that was just read in full.
    if (project === null || before === null || project.tasks !== before.tasks) return;
    const present = await this.#listFiles(state, project);
    const known = new Set([...project.tasks.keys(), ...project.milestones.keys(), ...project.archived.keys()]);
    const changed: string[] = [];
    await eachLimited(present, async (path) => {
      if (!known.has(path) || (await stampOf(projectUri(state.folder, path))) !== project.stamps.get(path)) changed.push(path);
    });
    const listed = new Set(present);
    for (const path of known) if (!listed.has(path)) changed.push(path);
    if (changed.length === 0 || state.disposed) return;
    for (const path of changed) state.pending.add(path);
    await this.#flush(state);
  }

  async #redetect(state: FolderState): Promise<void> {
    const configStamps = await Promise.all(
      (state.registered === undefined ? CONFIG_FILES : [`${state.registered}/config.yml`]).map(async (file) => [file, await stampOf(projectUri(state.folder, file))] as const),
    );
    const detected = state.registered === undefined ? await detect(state.folder) : await detectRegistered(state.folder, state.registered);
    if (state.disposed) return;
    this.#reportConfig(state, detected);
    const old = state.project;
    if (detected === null) {
      if (old === null) return;
      for (const d of old.watchers) d.dispose();
      state.project = null;
      this.#changed.fire();
      return;
    }
    const configStamp = configStamps.find(([file]) => file === detected.configFile)?.[1];
    if (old !== null && old.detected.directory === detected.directory && old.detected.configFile === detected.configFile) {
      const project: ProjectState = { ...old, detected };
      if (configStamp !== undefined) project.stamps.set(CONFIG_STAMP, configStamp);
      state.project = project;
      this.#publish(state, project);
      return;
    }
    if (old !== null) for (const d of old.watchers) d.dispose();
    const project: ProjectState = {
      detected,
      tasks: new Map(),
      milestones: new Map(),
      archived: new Map(),
      stamps: new Map(configStamp === undefined ? [] : [[CONFIG_STAMP, configStamp]]),
      watchers: [],
      snapshot: null,
    };
    state.project = project;
    this.#watchProject(state, project);
    await this.#loadAll(state, project);
    if (state.disposed || state.project !== project) return;
    this.#publish(state, project);
  }

  #reportConfig(state: FolderState, detected: DetectedProject | null): void {
    const key = state.id;
    if (detected?.error === undefined) {
      this.#warned.delete(key);
      return;
    }
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#options.onBrokenConfig(state.folder, detected.configFile, detected.error);
  }

  #watchProject(state: FolderState, project: ProjectState): void {
    const base = project.detected.directory === '' ? '' : `${project.detected.directory}/`;
    if (state.registered !== undefined && !GLOB_SAFE.test(state.registered)) return;
    const files = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(state.folder, `${base}{${[...TASK_DIRS.keys()].join(',')}}/*.md`));
    // `archive` too: removing it removes `archive/tasks` with it.
    const folders = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(state.folder, `${base}{${[...TASK_DIRS.keys()].join(',')},archive}`));
    const onFile = (uri: vscode.Uri): void => {
      const path = projectPath(state.folder, uri);
      if (path !== undefined) this.#schedule(state, (s) => s.pending.add(path));
    };
    const onFolder = (): void => this.#schedule(state, (s) => void (s.reload = true));
    project.watchers.push(
      files,
      folders,
      files.onDidCreate(onFile),
      files.onDidChange(onFile),
      files.onDidDelete(onFile),
      folders.onDidCreate(onFolder),
      folders.onDidDelete(onFolder),
    );
  }

  async #loadAll(state: FolderState, project: ProjectState): Promise<void> {
    const paths = await this.#listFiles(state, project);
    const config = project.stamps.get(CONFIG_STAMP);
    project.tasks.clear();
    project.milestones.clear();
    project.archived.clear();
    project.stamps.clear();
    if (config !== undefined) project.stamps.set(CONFIG_STAMP, config);
    await eachLimited(paths, (path) => this.#readOne(state, project, path));
  }

  #publish(state: FolderState, project: ProjectState): void {
    const { config } = project.detected;
    const milestones = [...project.milestones.values()].filter((m): m is Milestone => m !== null);
    project.snapshot = {
      id: state.registered === undefined ? state.id : backlogFolder({ folder: state.folder, directory: project.detected.directory }).toString(),
      folder: state.folder,
      name: state.name,
      directory: project.detected.directory,
      configFile: project.detected.configFile,
      config,
      unreadable: project.detected.unreadable ?? [],
      index: indexTasks(project.tasks.values(), milestones, config, project.archived.values()),
    };
    this.#changed.fire();
  }
}
