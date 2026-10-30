// Webview UI state and the task selection it implies (backlog.md 4.2, 4.3). Pure: no DOM, so
// filtering, sorting and the board columns are tested under node:test.
import { compareTaskIds, priorityRank } from '../task-index.ts';
import { DEFAULT_STRINGS, type BacklogView, type TaskSummary, type ViewStrings } from '../view.ts';

export type ViewMode = 'board' | 'list';
export type SortColumn = 'id' | 'title' | 'status' | 'priority' | 'assignee' | 'milestone';
export const SORT_COLUMNS: readonly SortColumn[] = ['id', 'title', 'status', 'priority', 'assignee', 'milestone'];

export interface SortState {
  readonly column: SortColumn;
  readonly descending: boolean;
}

/**
 * Filter values as select option values: `all`, `none` (milestone only) or `=<value>`.
 * The status filter also takes `notDone` (its default) and `archived` (the archived tasks
 * instead of the board's, backlog.md 3.1), and is used by the list only.
 */
export interface UiState {
  readonly mode: ViewMode;
  readonly search: string;
  readonly status: string;
  readonly milestone: string;
  readonly label: string;
  readonly assignee: string;
  /** Null = board order (ordinal, then priority, then ID). */
  readonly sort: SortState | null;
  /** Path of the task shown in the detail pane. */
  readonly selected: string | null;
  /** The detail pane's share of the layout per position, once resized (backlog.md 4.1). */
  readonly paneSizes: { readonly bottom?: number; readonly right?: number };
  /** List column widths in px once resized; empty = automatic layout (backlog.md 4.3). */
  readonly columnWidths: Readonly<Partial<Record<SortColumn, number>>>;
}

export const DEFAULT_UI_STATE: UiState = {
  mode: 'board',
  search: '',
  status: 'notDone',
  milestone: 'all',
  label: 'all',
  assignee: 'all',
  sort: null,
  selected: null,
  paneSizes: {},
  columnWidths: {},
};

export const ALL = 'all';
export const NONE = 'none';
export const NOT_DONE = 'notDone';
export const ARCHIVED = 'archived';
export const valueOption = (value: string): string => `=${value}`;
const optionValue = (option: string): string | undefined => (option.startsWith('=') ? option.slice(1) : undefined);

const MAX_STATE_TEXT = 1000;

/** Persisted state from `getState()`, checked field by field; anything odd falls back. */
export function restoreUiState(raw: unknown): UiState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_UI_STATE;
  const r = raw as Record<string, unknown>;
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.length <= MAX_STATE_TEXT ? value : fallback;
  const sortRaw = r['sort'] as Record<string, unknown> | null | undefined;
  const sort =
    typeof sortRaw === 'object' && sortRaw !== null && SORT_COLUMNS.includes(sortRaw['column'] as SortColumn)
      ? { column: sortRaw['column'] as SortColumn, descending: sortRaw['descending'] === true }
      : null;
  const selected = r['selected'];
  return {
    mode: r['mode'] === 'list' ? 'list' : 'board',
    search: text(r['search'], ''),
    status: text(r['status'], DEFAULT_UI_STATE.status),
    milestone: text(r['milestone'], ALL),
    label: text(r['label'], ALL),
    assignee: text(r['assignee'], ALL),
    sort,
    selected: typeof selected === 'string' && selected.length > 0 && selected.length <= MAX_STATE_TEXT ? selected : null,
    paneSizes: restorePaneSizes(r['paneSizes']),
    columnWidths: restoreColumnWidths(r['columnWidths']),
  };
}

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 2000;

function restoreColumnWidths(raw: unknown): UiState['columnWidths'] {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Record<SortColumn, number>> = {};
  for (const column of SORT_COLUMNS) {
    const width = r[column];
    if (typeof width === 'number' && Number.isFinite(width) && width >= MIN_COLUMN_WIDTH && width <= MAX_COLUMN_WIDTH) out[column] = Math.round(width);
  }
  return out;
}

/** A column width kept within the limits. */
export function clampColumnWidth(width: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/** New width for a resize-handle key (Left/Right by 16px, Shift by 64px); undefined for other keys. */
export function columnKeyWidth(width: number, event: { readonly key: string; readonly shiftKey: boolean }): number | undefined {
  const { key, shiftKey } = event;
  const step = shiftKey ? 64 : 16;
  if (key === 'ArrowLeft') return clampColumnWidth(width - step);
  if (key === 'ArrowRight') return clampColumnWidth(width + step);
  return undefined;
}

function restorePaneSizes(raw: unknown): UiState['paneSizes'] {
  if (typeof raw !== 'object' || raw === null) return {};
  const share = (value: unknown): number | undefined => (typeof value === 'number' && value > 0 && value < 1 ? value : undefined);
  const r = raw as Record<string, unknown>;
  const out: { bottom?: number; right?: number } = {};
  const bottom = share(r['bottom']);
  const right = share(r['right']);
  if (bottom !== undefined) out.bottom = bottom;
  if (right !== undefined) out.right = right;
  return out;
}

/** `{0}`, `{1}` ... replaced in order (strings from the extension). Never throws: a missing template gives ''. */
export function format(template: string, ...values: readonly (string | number)[]): string {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\d+)\}/g, (match, n: string) => (Number(n) < values.length ? String(values[Number(n)]) : match));
}

/**
 * The strings a render message carries, over the built-in English ones. An extension host
 * running an older or newer build than this script may lack keys or send other values.
 */
export function withDefaultStrings(raw: unknown): ViewStrings {
  const strings: Record<string, string> = { ...DEFAULT_STRINGS };
  if (typeof raw === 'object' && raw !== null) {
    for (const key of Object.keys(DEFAULT_STRINGS)) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'string') strings[key] = value;
    }
  }
  return strings as ViewStrings;
}

const lower = (s: string): string => s.toLowerCase();

function matchesOption(option: string, values: readonly string[], allowNone: boolean): boolean {
  if (option === ALL) return true;
  if (allowNone && option === NONE) return values.length === 0;
  const wanted = optionValue(option);
  // An unknown option (stale persisted state) filters nothing rather than hiding everything.
  if (wanted === undefined) return true;
  return values.some((v) => lower(v) === lower(wanted));
}

/**
 * Tasks passing search and filters, in view order. The board ignores the status filter; the
 * list's `archived` option lists the archived tasks instead (all their statuses).
 */
export function filterTasks(view: BacklogView, state: UiState, withStatus: boolean): TaskSummary[] {
  // Every word must appear, in any order; the search text has no whitespace (view-build.ts).
  const words = lower(state.search).split(/\s+/).filter((word) => word !== '');
  const archived = withStatus && state.status === ARCHIVED;
  return (archived ? view.archived : view.tasks).filter((task) => {
    if (!words.every((word) => task.searchText.includes(word))) return false;
    if (withStatus && !archived) {
      if (state.status === NOT_DONE) {
        if (view.doneStatus !== null && task.status === view.doneStatus) return false;
      } else if (!matchesOption(state.status, [task.status], false)) return false;
    }
    if (!matchesOption(state.milestone, task.milestone === null ? [] : [task.milestone], true)) return false;
    if (!matchesOption(state.label, task.labels, false)) return false;
    if (!matchesOption(state.assignee, task.assignees, false)) return false;
    return true;
  });
}

/** Sorted copy; ties keep view order. Empty values sort last in both directions. */
export function sortTasks(tasks: readonly TaskSummary[], sort: SortState | null, view: BacklogView): TaskSummary[] {
  if (sort === null) return [...tasks];
  const text = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const statusRank = (status: string): number => {
    const i = view.statuses.indexOf(status);
    return i === -1 ? view.statuses.length : i;
  };
  /** The value compared, or null when the task has none (sorted last). */
  const value = (t: TaskSummary): string | null => {
    switch (sort.column) {
      case 'id':
        return t.id;
      case 'title':
        return t.title === '' ? null : t.title;
      case 'status':
        return t.status;
      case 'priority':
        return t.priority;
      case 'assignee':
        return t.assignees[0] ?? null;
      case 'milestone':
        return t.milestoneTitle ?? t.milestone;
    }
  };
  const compare = (a: string, b: string): number => {
    switch (sort.column) {
      case 'id':
        return compareTaskIds(a, b);
      case 'status':
        return statusRank(a) - statusRank(b) || text(a, b);
      case 'priority':
        return priorityRank(view.priorities, a) - priorityRank(view.priorities, b) || text(a, b);
      default:
        return text(a, b);
    }
  };
  const order = new Map(tasks.map((t, i) => [t, i]));
  return [...tasks].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) return va === vb ? order.get(a)! - order.get(b)! : va === null ? 1 : -1;
    const c = compare(va, vb);
    return (sort.descending ? -c : c) || order.get(a)! - order.get(b)!;
  });
}

/** Header click: ascending, then descending, then back to board order. */
export function nextSort(sort: SortState | null, column: SortColumn): SortState | null {
  if (sort === null || sort.column !== column) return { column, descending: false };
  return sort.descending ? null : { column, descending: true };
}

export interface BoardColumn {
  readonly status: string;
  /** False for the "Other status" column, which cannot take drops. */
  readonly known: boolean;
  readonly tasks: readonly TaskSummary[];
}

/** Configured statuses in order, plus "Other status" at the end when any task needs it. */
export function boardColumns(view: BacklogView, tasks: readonly TaskSummary[]): BoardColumn[] {
  const columns: BoardColumn[] = view.statuses.map((status) => ({ status, known: true, tasks: tasks.filter((t) => t.statusKnown && t.status === status) }));
  const other = tasks.filter((t) => !t.statusKnown);
  // Kept while any task has an unknown status, so filtering does not shift the columns.
  if (view.tasks.some((t) => !t.statusKnown)) columns.push({ status: '', known: false, tasks: other });
  return columns;
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const v of values) if (!seen.has(lower(v))) seen.set(lower(v), v);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

export interface FilterOptions {
  readonly status: readonly FilterOption[];
  readonly milestone: readonly FilterOption[];
  readonly label: readonly FilterOption[];
  readonly assignee: readonly FilterOption[];
}

/** Choices for the filter selects, from the configuration and the tasks. */
export function filterOptions(view: BacklogView, strings: ViewStrings): FilterOptions {
  const otherStatuses = uniqueSorted(view.tasks.filter((t) => !view.statuses.includes(t.status)).map((t) => t.status));
  const milestones = new Map<string, FilterOption>();
  for (const m of view.milestones) milestones.set(lower(m.id), { value: valueOption(m.id), label: m.title });
  for (const t of view.tasks) {
    if (t.milestone !== null && !milestones.has(lower(t.milestone))) {
      milestones.set(lower(t.milestone), { value: valueOption(t.milestone), label: t.milestoneTitle ?? t.milestone });
    }
  }
  const list = (all: string, values: readonly string[]): FilterOption[] => [
    { value: ALL, label: all },
    ...values.map((v) => ({ value: valueOption(v), label: v })),
  ];
  return {
    status: [
      { value: NOT_DONE, label: strings.notDone },
      { value: ALL, label: strings.allStatuses },
      ...[...view.statuses, ...otherStatuses].map((s) => ({ value: valueOption(s), label: s })),
      // Offered only when there are archived tasks.
      ...(view.archived.length > 0 ? [{ value: ARCHIVED, label: strings.archivedTasks }] : []),
    ],
    milestone: [{ value: ALL, label: strings.allMilestones }, { value: NONE, label: strings.noMilestone }, ...milestones.values()],
    label: list(strings.allLabels, uniqueSorted(view.tasks.flatMap((t) => t.labels))),
    assignee: list(strings.allAssignees, uniqueSorted(view.tasks.flatMap((t) => t.assignees))),
  };
}
