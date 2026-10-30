// Stage 2 frontmatter field writes (backlog.md 5.4): set or remove a scalar field, replace
// a list field's items. Pure planners like operations.ts, writing what Backlog.md 1.54.0
// writes for the same edit: CLI quoting, two-space block lists, `[]` for the lists it always
// keeps, and new keys at the CLI's key position. Only the field's own lines and
// `updated_date` change; the CLI's full re-serialization (reordering, dropping unknown keys,
// requoting other fields) is deliberately not copied.
import type { ExpectedLine, LineOperation } from '../../core/patch.ts';
import { DEFAULT_PRIORITIES } from './config.ts';
import { priorityKey } from './task-index.ts';
import { isOneLineScalar, namePrefix, planUpdatedDate, refuse, type OperationPlan } from './operations.ts';
import type { TaskFile } from './task-file.ts';
import { fieldOf, formatScalar, type Field } from './yaml-lite.ts';

/** Key order of the CLI's task serializer (Backlog.md 1.54.0). */
export const KEY_ORDER: readonly string[] = [
  'id', 'title', 'status', 'assignee', 'reporter', 'created_date', 'updated_date', 'due_date', 'labels', 'milestone',
  'dependencies', 'references', 'documentation', 'modified_files', 'parent_task_id', 'subtasks', 'priority', 'type',
  'project', 'ordinal', 'onStatusChange',
];

export type ScalarFieldName = 'title' | 'priority' | 'type' | 'milestone' | 'due_date' | 'project' | 'reporter';
export type ListFieldName = 'assignee' | 'labels' | 'dependencies' | 'references' | 'documentation' | 'modified_files';

const SCALAR_FIELDS: ReadonlySet<string> = new Set<ScalarFieldName>(['title', 'priority', 'type', 'milestone', 'due_date', 'project', 'reporter']);
const LIST_FIELDS: ReadonlySet<string> = new Set<ListFieldName>(['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files']);
/** Lists the CLI always writes, as `[]` when empty; the other lists are removed when empty. */
const KEPT_WHEN_EMPTY: ReadonlySet<string> = new Set(['assignee', 'labels', 'dependencies']);
const DEFAULT_INDENT = '  ';

export interface SetScalarRequest {
  readonly name: ScalarFieldName;
  /** New value; null or '' removes the field (as the CLI's clear options do). */
  readonly value: string | null;
  /** The field's line as the requester saw it, or null when it saw no such field. */
  readonly expected: string | null;
  /** Configured priorities (config.yml `priorities`); the CLI accepts only these. Defaults when absent. */
  readonly priorities?: readonly string[];
}

export interface SetListRequest {
  readonly name: ListFieldName;
  /** All items in order; empty writes `[]` or removes the field, as the CLI does. */
  readonly values: readonly string[];
  /** The field's lines as the requester saw them, or null when it saw no such field. */
  readonly expected: readonly string[] | null;
}

const rank = (name: string): number => KEY_ORDER.indexOf(name);

export interface Insertion {
  readonly at: number;
  /** The field that fixes the position (an expected line), if any. */
  readonly anchor: Field | undefined;
}

/**
 * Where a new key goes: after the known key that comes last before it in KEY_ORDER, else
 * before the first known key after it, else at the end of the frontmatter. In a file the CLI
 * wrote, this is where the CLI puts it.
 */
export function insertionFor(file: TaskFile, name: string): Insertion {
  const own = rank(name);
  let before: Field | undefined;
  let after: Field | undefined;
  for (const field of file.fields) {
    const r = rank(field.name);
    if (r === -1) continue;
    if (r < own && (before === undefined || r > rank(before.name))) before = field;
    if (r > own && (after === undefined || r < rank(after.name))) after = field;
  }
  if (before !== undefined) return { at: before.end, anchor: before };
  if (after !== undefined) return { at: after.line, anchor: after };
  return { at: file.frontmatter!.closeLine, anchor: undefined };
}

interface FieldChange {
  readonly expectedLines: readonly ExpectedLine[];
  /** Replaces or deletes the field's lines. */
  readonly operations: readonly LineOperation[];
  /** New key lines, merged with an updated_date insert at the same line in key order. */
  readonly insert?: { readonly at: number; readonly name: string; readonly lines: readonly string[] };
}

/** Adds the updated_date change; a change without operations plans nothing at all. */
function finish(texts: readonly string[], file: TaskFile, now: Date, change: FieldChange): OperationPlan {
  const updated = planUpdatedDate(texts, file, now);
  if (updated === undefined) return refuse('unsafe');
  const expectedLines = [...change.expectedLines, ...updated.expectedLines];
  if (change.operations.length === 0 && change.insert === undefined) return { ok: true, expectedLines, operations: [] };
  const operations: LineOperation[] = [...change.operations];
  let pending = change.insert;
  for (const op of updated.operations) {
    if (pending !== undefined && op.kind === 'insert' && op.at === pending.at) {
      const lines = rank(pending.name) < rank('updated_date') ? [...pending.lines, ...op.lines] : [...op.lines, ...pending.lines];
      operations.push({ kind: 'insert', at: op.at, lines });
      pending = undefined;
    } else {
      operations.push(op);
    }
  }
  if (pending !== undefined) operations.push({ kind: 'insert', at: pending.at, lines: pending.lines });
  return { ok: true, expectedLines, operations };
}

const fieldLines = (texts: readonly string[], field: Field): ExpectedLine[] =>
  texts.slice(field.line, field.end).map((text, i) => ({ line: field.line + i, text }));

const anchorLines = (texts: readonly string[], insertion: Insertion): ExpectedLine[] =>
  insertion.anchor === undefined ? [] : fieldLines(texts, insertion.anchor);

/** A value the CLI accepts for the field, normalized; undefined when it does not. */
function scalarValue(name: ScalarFieldName, value: string, priorities: readonly string[]): string | undefined {
  if (/[\r\n]/.test(value)) return undefined;
  if (value === '') return name === 'title' ? undefined : '';
  // As CLI 1.54.0 `--priority`: a configured priority in any case and spacing, written normalized.
  if (name === 'priority') {
    const key = priorityKey(value);
    return key !== '' && priorities.some((p) => priorityKey(p) === key) ? key : undefined;
  }
  if (name === 'due_date') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  return value;
}

/**
 * Sets or removes a scalar field. An existing line keeps its key spelling; the value is
 * written as the CLI would, except that a double-quoted value (not a CLI shape) stays
 * double-quoted. A new key is inserted at the CLI's position.
 */
export function planSetScalar(texts: readonly string[], file: TaskFile, request: SetScalarRequest, now: Date): OperationPlan {
  if (!SCALAR_FIELDS.has(request.name)) return refuse('invalid');
  const value = scalarValue(request.name, request.value ?? '', request.priorities ?? DEFAULT_PRIORITIES);
  if (value === undefined) return refuse('invalid');
  if (file.frontmatter === null) return refuse('unsafe');
  const field = fieldOf(file.fields, request.name);
  // A field's source is all its lines: a long value the CLI folded (`>-`) spans several.
  if ((field === undefined ? null : texts.slice(field.line, field.end).join('\n')) !== request.expected) return refuse('stale');
  if (field === undefined) {
    if (value === '') return finish(texts, file, now, { expectedLines: [], operations: [] });
    const insertion = insertionFor(file, request.name);
    return finish(texts, file, now, {
      expectedLines: anchorLines(texts, insertion),
      operations: [],
      insert: { at: insertion.at, name: request.name, lines: [`${request.name}: ${formatScalar(value, 'plain')}`] },
    });
  }
  // Folded or literal blocks are rewritten as one line (valid YAML the CLI reads the same).
  if (field.value.kind !== 'scalar') return refuse('unsafe');
  const expectedLines = fieldLines(texts, field);
  if (value === '') return finish(texts, file, now, { expectedLines, operations: [{ kind: 'delete', start: field.line, end: field.end }] });
  if (field.value.value === value) return finish(texts, file, now, { expectedLines, operations: [] });
  const style = field.value.style === 'double' ? 'double' : 'plain';
  const line = namePrefix(texts[field.line]) + formatScalar(value, style);
  return finish(texts, file, now, { expectedLines, operations: [{ kind: 'replace', start: field.line, end: field.end, lines: [line] }] });
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Replaces a list field's items. Unchanged items keep their lines; new ones are written as
 * the CLI writes them. Empty: `name: []` for assignee, labels and dependencies, otherwise the
 * field is removed. Flow lists (`[a, b]`) and other shapes are refused.
 */
export function planSetList(texts: readonly string[], file: TaskFile, request: SetListRequest, now: Date): OperationPlan {
  if (!LIST_FIELDS.has(request.name)) return refuse('invalid');
  if (request.values.some((v) => v === '' || /[\r\n]/.test(v))) return refuse('invalid');
  if (file.frontmatter === null) return refuse('unsafe');
  const field = fieldOf(file.fields, request.name);
  const seen = field === undefined ? null : texts.slice(field.line, field.end);
  if (seen === null || request.expected === null ? seen !== request.expected : !sameList(seen, request.expected)) return refuse('stale');

  const emptyLines = KEPT_WHEN_EMPTY.has(request.name) ? [`${request.name}: []`] : [];
  if (field === undefined) {
    if (request.values.length === 0) return finish(texts, file, now, { expectedLines: [], operations: [] });
    const insertion = insertionFor(file, request.name);
    const lines = [`${request.name}:`, ...request.values.map((v) => `${DEFAULT_INDENT}- ${formatScalar(v, 'plain')}`)];
    return finish(texts, file, now, { expectedLines: anchorLines(texts, insertion), operations: [], insert: { at: insertion.at, name: request.name, lines } });
  }
  if (field.value.kind !== 'list' || field.value.flow) return refuse('unsafe');
  const expectedLines = fieldLines(texts, field);
  const items = field.value.items;
  if (sameList(items.map((item) => item.value), request.values)) return finish(texts, file, now, { expectedLines, operations: [] });

  let lines: string[];
  if (request.values.length === 0) {
    lines = emptyLines;
  } else {
    const indent = items.length > 0 ? /^ */.exec(texts[items[0].line])![0] : DEFAULT_INDENT;
    const unused = [...items];
    const itemLine = (value: string): string => {
      const reuse = unused.findIndex((item) => item.value === value);
      if (reuse === -1) return `${indent}- ${formatScalar(value, 'plain')}`;
      const [item] = unused.splice(reuse, 1);
      return texts[item.line];
    };
    const head = items.length > 0 ? texts[field.line] : `${request.name}:`;
    lines = [head, ...request.values.map(itemLine)];
  }
  const operation: LineOperation =
    lines.length === 0 ? { kind: 'delete', start: field.line, end: field.end } : { kind: 'replace', start: field.line, end: field.end, lines };
  return finish(texts, file, now, { expectedLines, operations: [operation] });
}
