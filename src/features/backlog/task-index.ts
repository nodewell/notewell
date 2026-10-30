// Task index of one Backlog.md project (backlog.md 3.1, 4.2-4.4). Pure: file texts in, lookups
// out. Each file is read once by readTask (the adapter caches the result per file); indexTasks
// only links the entries, so a changed file costs one parse plus an O(n) rebuild.
import { findFrontmatter } from '../../core/frontmatter.ts';
import { lineTexts, parseLines } from '../../core/lines.ts';
import type { BacklogConfig } from './config.ts';
import { parseTaskFile, taskData, type TaskData, type TaskFile } from './task-file.ts';
import { parseFields, scalarOf } from './yaml-lite.ts';

export interface SourceFile {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly text: string;
}

export interface IndexedTask {
  readonly path: string;
  /** The frontmatter `id` as written. */
  readonly id: string;
  readonly texts: readonly string[];
  readonly file: TaskFile;
  readonly data: TaskData;
}

export type UnreadableReason = 'noFrontmatter' | 'noId' | 'notUtf8' | 'tooLarge';

/** Task files larger than this are not read (listed as too large); the CLI writes far smaller ones. */
export const MAX_TASK_BYTES = 16 * 1024 * 1024;

export type TaskEntry =
  | ({ readonly kind: 'task' } & IndexedTask)
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: UnreadableReason };

export interface Milestone {
  readonly path: string;
  readonly id: string;
  readonly title: string;
}

export interface TaskIndex {
  readonly config: BacklogConfig;
  /** Readable tasks, by path. */
  readonly tasks: readonly IndexedTask[];
  readonly byPath: ReadonlyMap<string, IndexedTask>;
  /** Tasks by normalized ID (see `idKey`); more than one means a duplicate ID. */
  readonly byId: ReadonlyMap<string, readonly IndexedTask[]>;
  /** Normalized parent ID -> subtasks, by ID. */
  readonly children: ReadonlyMap<string, readonly IndexedTask[]>;
  /** Normalized ID -> tasks that list it in `dependencies`, by ID (Blocks). */
  readonly blocks: ReadonlyMap<string, readonly IndexedTask[]>;
  /** Milestones by ID. */
  readonly milestones: readonly Milestone[];
  /**
   * Archived tasks (`archive/tasks/`, and `completed/` from before CLI 1.54.0) by normalized ID,
   * in path order: not on the board, but a dependency on one in the final status is met, as the
   * CLI's readiness says (backlog.md 3.1). Read-only: shown in the list's archived filter only.
   */
  readonly archived: ReadonlyMap<string, readonly IndexedTask[]>;
  /** Readable archived tasks, by path. */
  readonly archivedByPath: ReadonlyMap<string, IndexedTask>;
  readonly unreadable: readonly { readonly path: string; readonly reason: UnreadableReason }[];
}

/** Parses one task file. */
export function readTask(path: string, text: string): TaskEntry {
  const texts = lineTexts(parseLines(text));
  const file = parseTaskFile(texts);
  if (file.frontmatter === null) return { kind: 'unreadable', path, reason: 'noFrontmatter' };
  const data = taskData(texts, file);
  if (data.id === null) return { kind: 'unreadable', path, reason: 'noId' };
  return { kind: 'task', path, id: data.id, texts, file, data };
}

/** A milestone file's `id` and `title`; null without frontmatter or id. */
export function readMilestone(path: string, text: string): Milestone | null {
  const texts = lineTexts(parseLines(text));
  const frontmatter = findFrontmatter(texts);
  if (frontmatter === null) return null;
  const fields = parseFields(texts, frontmatter.openLine + 1, frontmatter.closeLine);
  const id = scalarOf(fields, 'id');
  if (id === undefined || id === '') return null;
  return { path, id, title: scalarOf(fields, 'title') || id };
}

/**
 * Lookup key for a task ID: case-insensitive, and a bare number (`7`, `1.2`) gets the
 * configured prefix, so `task-7`, `TASK-7` and `7` are the same task.
 */
export function idKey(id: string, taskPrefix: string): string {
  const trimmed = id.trim();
  const full = /^\d+(\.\d+)*$/.test(trimmed) ? `${taskPrefix}-${trimmed}` : trimmed;
  return full.toUpperCase();
}

const ID_PARTS = /^(.*?)(\d+(?:\.\d+)*)$/;

/** ID order: prefix (case-insensitive), then each number part (`TASK-2` < `TASK-10`, `TASK-1.2` < `TASK-1.10`). */
export function compareTaskIds(a: string, b: string): number {
  const ma = ID_PARTS.exec(a.trim());
  const mb = ID_PARTS.exec(b.trim());
  if (ma === null || mb === null) {
    if (ma !== mb) return ma === null ? 1 : -1;
    return a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0;
  }
  const pa = ma[1].toUpperCase();
  const pb = mb[1].toUpperCase();
  if (pa !== pb) return pa < pb ? -1 : 1;
  const na = ma[2].split('.').map(Number);
  const nb = mb[2].split('.').map(Number);
  for (let i = 0; i < Math.min(na.length, nb.length); i++) {
    if (na[i] !== nb[i]) return na[i] - nb[i];
  }
  return na.length - nb.length;
}

/**
 * Priority rank as the CLI 1.54.0 orders tasks: the configured priorities in order
 * (case-insensitive), then everything else; no priority and one not configured rank the same.
 */
export function priorityRank(priorities: readonly string[], priority: string | null): number {
  const wanted = priorityKey(priority ?? '');
  const i = wanted === '' ? -1 : priorities.findIndex((p) => priorityKey(p) === wanted);
  return i === -1 ? priorities.length : i;
}

/**
 * A priority as the CLI 1.54.0 compares and writes it: trimmed, runs of white space as one
 * space, lower case (`--priority 'VERY  High '` sets `very high`).
 */
export function priorityKey(priority: string): string {
  return priority.trim().replace(/\s+/g, ' ').toLowerCase();
}

const byIdThenPath = (x: IndexedTask, y: IndexedTask): number => compareTaskIds(x.id, y.id) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** Links already read entries. */
export function indexTasks(
  entries: Iterable<TaskEntry>,
  milestones: Iterable<Milestone>,
  config: BacklogConfig,
  archivedEntries: Iterable<TaskEntry> = [],
): TaskIndex {
  const key = (id: string): string => idKey(id, config.taskPrefix);
  const archived = new Map<string, IndexedTask[]>();
  const archivedByPath = new Map<string, IndexedTask>();
  for (const entry of archivedEntries) {
    if (entry.kind !== 'task') continue;
    push(archived, key(entry.id), entry);
    archivedByPath.set(entry.path, entry);
  }
  for (const list of archived.values()) list.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const tasks: IndexedTask[] = [];
  const unreadable: { path: string; reason: UnreadableReason }[] = [];
  for (const entry of entries) {
    if (entry.kind === 'task') tasks.push(entry);
    else unreadable.push({ path: entry.path, reason: entry.reason });
  }
  tasks.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  unreadable.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  const byPath = new Map<string, IndexedTask>();
  const byId = new Map<string, IndexedTask[]>();
  const children = new Map<string, IndexedTask[]>();
  const blocks = new Map<string, IndexedTask[]>();
  for (const task of tasks) {
    byPath.set(task.path, task);
    push(byId, key(task.id), task);
    if (task.data.parent !== null) push(children, key(task.data.parent), task);
    const seen = new Set<string>();
    for (const dep of task.data.dependencies) {
      const k = key(dep);
      if (seen.has(k)) continue;
      seen.add(k);
      push(blocks, k, task);
    }
  }
  for (const list of children.values()) list.sort(byIdThenPath);
  for (const list of blocks.values()) list.sort(byIdThenPath);

  // Two milestone files with one ID (a copy, an unfinished rename): the first by path stands for
  // both, so the milestone choices never list one ID twice.
  const seenMilestones = new Set<string>();
  const milestoneList = [...milestones]
    .sort((x, y) => compareTaskIds(x.id, y.id) || (x.path < y.path ? -1 : 1))
    .filter((m) => {
      const id = m.id.toLowerCase();
      if (seenMilestones.has(id)) return false;
      seenMilestones.add(id);
      return true;
    });
  return { config, tasks, byPath, byId, children, blocks, milestones: milestoneList, unreadable, archived, archivedByPath };
}

/** Reads and links all files at once. */
export function buildIndex(files: readonly SourceFile[], milestones: readonly SourceFile[], config: BacklogConfig, archived: readonly SourceFile[] = []): TaskIndex {
  const read = milestones.map((m) => readMilestone(m.path, m.text)).filter((m): m is Milestone => m !== null);
  return indexTasks(
    files.map((f) => readTask(f.path, f.text)),
    read,
    config,
    archived.map((f) => readTask(f.path, f.text)),
  );
}

/** Tasks with this ID (more than one when duplicated). */
export function tasksWithId(index: TaskIndex, id: string): readonly IndexedTask[] {
  return index.byId.get(idKey(id, index.config.taskPrefix)) ?? [];
}

/** Archived tasks with this ID, in path order. */
export function archivedWithId(index: TaskIndex, id: string): readonly IndexedTask[] {
  return index.archived.get(idKey(id, index.config.taskPrefix)) ?? [];
}

/** Title of a task's `milestone:` value: by milestone ID, then by title; null when not found. */
export function milestoneTitle(index: TaskIndex, milestone: string | null): string | null {
  if (milestone === null) return null;
  const wanted = milestone.trim().toLowerCase();
  const found =
    index.milestones.find((m) => m.id.toLowerCase() === wanted) ?? index.milestones.find((m) => m.title.toLowerCase() === wanted);
  return found?.title ?? null;
}
