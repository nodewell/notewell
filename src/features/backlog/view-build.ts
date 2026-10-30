// View models for the Backlog webview (view.ts) from the task index. Pure.
import type { BacklogConfig } from './config.ts';
import type { Checklist, TaskData, TaskFile } from './task-file.ts';
import { archivedWithId, compareTaskIds, idKey, milestoneTitle, priorityRank, tasksWithId, type IndexedTask, type TaskIndex } from './task-index.ts';
import type { BacklogView, ChecklistView, ReadOnlyNotice, TaskDetail, TaskRef, TaskSummary, ViewStrings } from './view.ts';
import { frontmatterProblemLine, strayMarkerLine } from './write-guard.ts';
import { fieldOf, type Field } from './yaml-lite.ts';

/** The configured spelling of `status` (case-insensitive match), or undefined when not configured. */
export function configuredStatus(config: BacklogConfig, status: string): string | undefined {
  const wanted = status.trim().toLowerCase();
  return config.statuses.find((s) => s.toLowerCase() === wanted);
}

/** A stored status as shown: configured spelling when known, the default status when missing. */
function displayStatus(config: BacklogConfig, stored: string | null): { status: string; known: boolean } {
  const raw = stored ?? config.defaultStatus;
  const known = configuredStatus(config, raw);
  return known === undefined ? { status: raw, known: false } : { status: known, known: true };
}

/** Whether a stored status is the final configured one (Done). */
function isDone(config: BacklogConfig, stored: string | null): boolean {
  const done = config.statuses[config.statuses.length - 1];
  return done !== undefined && displayStatus(config, stored).status === done;
}

/** A dependency is met when a task with that ID, on the board or archived, is done (backlog.md 3.1). */
function dependencyMet(index: TaskIndex, id: string): boolean {
  const { config } = index;
  return tasksWithId(index, id).some((t) => isDone(config, t.data.status)) || archivedWithId(index, id).some((t) => isDone(config, t.data.status));
}

/** Shape checks per parsed file: an indexed task keeps its object until the file changes. */
const shapeNotices = new WeakMap<IndexedTask, ReadOnlyNotice | null>();

/**
 * Why write-guard would refuse every change to this file (backlog.md 4.4, 5.1, 5.2): the same
 * frontmatter, marker and `updated_date` checks, made once before anything is tried.
 */
function shapeNotice(task: IndexedTask): ReadOnlyNotice | null {
  const known = shapeNotices.get(task);
  if (known !== undefined) return known;
  const { texts, file } = task;
  let notice: ReadOnlyNotice | null = null;
  const frontmatterLine = file.frontmatter === null ? 0 : frontmatterProblemLine(texts, file.frontmatter);
  const markerLine = strayMarkerLine({ texts, file });
  const updated = file.fields.filter((field) => field.name === 'updated_date');
  const datable =
    updated.length === 0 ? fieldOf(file.fields, 'status') !== undefined || fieldOf(file.fields, 'created_date') !== undefined : updated.length === 1 && oneLineScalar(updated[0]);
  if (frontmatterLine !== null) notice = { reason: 'frontmatter', line: frontmatterLine + 1 };
  else if (markerLine !== null) notice = { reason: 'markers', line: markerLine + 1 };
  else if (!datable) notice = { reason: 'updatedDate', line: null };
  shapeNotices.set(task, notice);
  return notice;
}

/** Why the task is shown read-only, or null when it can be edited (backlog.md 4.4). */
function readOnlyNotice(task: IndexedTask, archived: boolean, writable: boolean): ReadOnlyNotice | null {
  if (archived) return { reason: 'archived', line: null };
  if (!writable) return { reason: 'fileSystem', line: null };
  return shapeNotice(task);
}

/**
 * What search looks in (backlog.md 4.3): lower case, one piece per line with its whitespace
 * removed. Search words have no whitespace, so none matches across two pieces.
 */
function searchText(id: string, d: TaskData): string {
  const items = (list: Checklist | null): string[] => list?.items.map((item) => item.text) ?? [];
  const pieces = [
    id,
    d.title,
    d.description ?? '',
    ...items(d.ac),
    ...items(d.dod),
    d.plan ?? '',
    d.notes ?? '',
    d.finalSummary ?? '',
    ...(d.comments ?? []).map((c) => c.body),
    d.commentsRaw ?? '',
    d.otherBody,
    ...d.labels,
    ...d.assignees,
  ];
  return pieces.map((piece) => piece.toLowerCase().replace(/\s+/g, '')).join('\n');
}

function summary(index: TaskIndex, task: IndexedTask, readOnly: ReadOnlyNotice | null): TaskSummary {
  const { config } = index;
  const d = task.data;
  const { status, known } = displayStatus(config, d.status);
  const items = d.ac?.items ?? [];
  return {
    path: task.path,
    id: task.id,
    title: d.title,
    status,
    statusKnown: known,
    priority: d.priority,
    labels: d.labels,
    assignees: d.assignees,
    milestone: d.milestone,
    milestoneTitle: milestoneTitle(index, d.milestone),
    parent: d.parent,
    subtaskCount: index.children.get(idKey(task.id, config.taskPrefix))?.length ?? 0,
    ordinal: d.ordinal,
    ac: items.length === 0 ? null : { done: items.filter((i) => i.checked).length, total: items.length },
    blockedBy: d.dependencies.filter((dep) => !dependencyMet(index, dep)),
    duplicateId: tasksWithId(index, task.id).length > 1,
    searchText: searchText(task.id, d),
    created: d.created,
    updated: d.updated,
    readOnly,
  };
}

/**
 * Display order (backlog.md 4.2), as the CLI 1.54.0 lists tasks: ordinal ascending with missing
 * ones last, then priority (priorityRank), then ID, then path.
 */
export function compareSummaries(priorities: readonly string[]): (a: TaskSummary, b: TaskSummary) => number {
  return (a, b) => {
    if (a.ordinal !== b.ordinal) {
      if (a.ordinal === null) return 1;
      if (b.ordinal === null) return -1;
      return a.ordinal - b.ordinal;
    }
    return (
      priorityRank(priorities, a.priority) - priorityRank(priorities, b.priority) ||
      compareTaskIds(a.id, b.id) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    );
  };
}

export function buildBacklogView(
  index: TaskIndex,
  config: BacklogConfig,
  project: string,
  strings: ViewStrings,
  detailPosition: BacklogView['detailPosition'] = 'bottom',
  layout: BacklogView['layout'] = { columnWidths: {}, paneSizes: {} },
  writable = true,
): BacklogView {
  const viewIndex = index.config === config ? index : { ...index, config };
  return {
    project,
    statuses: config.statuses,
    doneStatus: config.statuses[config.statuses.length - 1] ?? null,
    tasks: index.tasks.map((task) => summary(viewIndex, task, readOnlyNotice(task, false, writable))).sort(compareSummaries(config.priorities)),
    archived: [...index.archivedByPath.values()].map((task) => summary(viewIndex, task, readOnlyNotice(task, true, writable))).sort(compareSummaries(config.priorities)),
    unreadable: index.unreadable,
    milestones: index.milestones.map((m) => ({ id: m.id, title: m.title })),
    taskTypes: config.types,
    priorities: config.priorities,
    detailPosition,
    layout,
    strings,
  };
}

/** A link to a task: the board's task with that ID, else an archived one (read-only), else none. */
function ref(index: TaskIndex, id: string): TaskRef {
  const task = tasksWithId(index, id)[0];
  // The ID as the dependency spells it (`task-9`, `7`), not as the target's file does.
  if (task !== undefined) return { ...asRef(index, task, false), id };
  const archived = archivedWithId(index, id)[0];
  return archived === undefined ? { id, path: null, title: null, status: null, archived: false } : { ...asRef(index, archived, true), id };
}

function asRef(index: TaskIndex, task: IndexedTask, archived: boolean): TaskRef {
  return { id: task.id, path: task.path, title: task.data.title, status: displayStatus(index.config, task.data.status).status, archived };
}

function oneLineScalar(field: Field | undefined): boolean {
  return field !== undefined && field.value.kind === 'scalar' && field.end === field.line + 1;
}

function checklistView(texts: readonly string[], list: Checklist | null): ChecklistView | null {
  if (list === null) return null;
  return {
    readOnly: list.readOnly,
    items: list.items.map((item) => ({ line: item.line, source: texts[item.line], number: item.number, text: item.text, checked: item.checked })),
  };
}

const SCALAR_EDIT_FIELDS = ['title', 'priority', 'type', 'milestone', 'due_date', 'project', 'reporter'];
const LIST_EDIT_FIELDS = ['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files'];
const EDIT_SECTIONS = ['description', 'plan', 'notes', 'finalSummary'] as const;

/**
 * Stage 2 sources (backlog.md 5.4): each editable field's lines joined with LF (null when
 * absent), or its name in `locked` when field-ops would refuse its shape.
 */
function editSources(texts: readonly string[], file: TaskFile): Pick<TaskDetail, 'fieldSources' | 'lockedFields' | 'sectionSources'> {
  const fieldSources: Record<string, string | null> = {};
  const lockedFields: string[] = [];
  const add = (name: string, writable: (field: Field) => boolean): void => {
    const field = fieldOf(file.fields, name);
    if (field === undefined) fieldSources[name] = null;
    else if (writable(field)) fieldSources[name] = texts.slice(field.line, field.end).join('\n');
    else lockedFields.push(name);
  };
  // Any scalar, also a long value the CLI folded over several lines (rewritten as one line).
  for (const name of SCALAR_EDIT_FIELDS) add(name, (field) => field.value.kind === 'scalar');
  for (const name of LIST_EDIT_FIELDS) add(name, (field) => field.value.kind === 'list' && !field.value.flow);
  const sectionSources: Record<string, string | null> = {};
  for (const name of EDIT_SECTIONS) {
    const section = file.sections[name];
    sectionSources[name] = section === undefined ? null : texts.slice(section.begin + 1, section.end).join('\n');
  }
  return { fieldSources, lockedFields, sectionSources };
}

/**
 * Everything the detail view shows for the task at `path`, or null when there is no such
 * readable task. Operations are offered only when no write would be refused for the whole
 * file (4.4); `writable` is false when the project's file system cannot be written.
 */
export function buildTaskDetail(index: TaskIndex, path: string, writable = true): TaskDetail | null {
  const board = index.byPath.get(path);
  const task = board ?? index.archivedByPath.get(path);
  if (task === undefined) return null;
  const archived = board === undefined;
  const { texts, file, data: d } = task;
  const statusField = fieldOf(file.fields, 'status');
  const readOnly = readOnlyNotice(task, archived, writable);
  const editable = readOnly === null;
  const key = idKey(task.id, index.config.taskPrefix);
  const boardRef = (t: IndexedTask): TaskRef => asRef(index, t, false);

  return {
    path: task.path,
    id: task.id,
    title: d.title,
    status: displayStatus(index.config, task.data.status).status,
    statusLine: editable && oneLineScalar(statusField) ? texts[statusField!.line] : null,
    priority: d.priority,
    type: d.type,
    project: d.project,
    reporter: d.reporter,
    assignees: d.assignees,
    labels: d.labels,
    milestone: d.milestone,
    milestoneTitle: milestoneTitle(index, d.milestone),
    due: d.due,
    created: d.created,
    updated: d.updated,
    parent: d.parent === null ? null : ref(index, d.parent),
    subtasks: (index.children.get(key) ?? []).map(boardRef),
    dependencies: d.dependencies.map((dep) => ref(index, dep)),
    blocks: (index.blocks.get(key) ?? []).map(boardRef),
    references: d.references,
    documentation: d.documentation,
    modifiedFiles: d.modifiedFiles,
    description: d.description,
    plan: d.plan,
    notes: d.notes,
    finalSummary: d.finalSummary,
    ac: checklistView(texts, d.ac),
    dod: checklistView(texts, d.dod),
    comments: d.comments,
    commentsRaw: d.commentsRaw,
    otherBody: d.otherBody,
    otherFields: d.otherFields,
    editable,
    readOnly,
    archived,
    ...editSources(texts, file),
  };
}
