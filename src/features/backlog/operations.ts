// Stage 1 write operations on a task file (backlog.md 5.1-5.3): status change and AC/DoD
// check toggle. Pure planners: line texts and the parsed file in, a line patch request out,
// which the caller hands to core computePatch. Each also updates `updated_date` (5.2).
import type { ExpectedLine, LineOperation } from '../../core/patch.ts';
import { parseChecklist, type TaskFile } from './task-file.ts';
import { fieldOf, formatScalar, type Field } from './yaml-lite.ts';

/**
 * Why a plan was refused.
 * - `stale`: the request's expected text is not what the file holds (redraw and retry)
 * - `unsafe`: the file has a shape this operation does not write (unknown field, read-only list)
 * - `invalid`: the request itself is wrong (status not in the configuration)
 */
export type OperationFailure = 'stale' | 'unsafe' | 'invalid';

export type OperationPlan =
  | { readonly ok: true; readonly expectedLines: readonly ExpectedLine[]; readonly operations: readonly LineOperation[] }
  | { readonly ok: false; readonly reason: OperationFailure };

export interface SetStatusRequest {
  readonly status: string;
  /** The `status:` line as the requester saw it. */
  readonly statusLine: string;
  /** Configured statuses (config.yml `statuses`), in their spelling. */
  readonly statuses: readonly string[];
}

export interface ToggleCheckRequest {
  readonly list: 'ac' | 'dod';
  /** Line index of the check item. */
  readonly line: number;
  /** The check line as the requester saw it. */
  readonly source: string;
  readonly checked: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `'YYYY-MM-DD HH:mm'` in UTC, quotes included, as the CLI writes `updated_date`. */
export function formatUpdatedDate(now: Date): string {
  const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  return `'${date} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}'`;
}

export const refuse = (reason: OperationFailure): OperationPlan => ({ ok: false, reason });

/** A one-line scalar field the operations may rewrite. */
export function isOneLineScalar(field: Field): boolean {
  return field.value.kind === 'scalar' && field.end === field.line + 1;
}

/** `name:` plus the spacing after it as written; at least one space before the value. */
export function namePrefix(text: string): string {
  const prefix = /^[^:]*:[ \t]*/.exec(text)?.[0] ?? '';
  return /[ \t]$/.test(prefix) ? prefix : `${prefix} `;
}

/**
 * The `updated_date` change (5.2): replace the value when the line exists, otherwise insert
 * after `created_date` (after `status` when there is none). Undefined when it cannot be done.
 */
export function planUpdatedDate(
  texts: readonly string[],
  file: TaskFile,
  now: Date,
): { expectedLines: ExpectedLine[]; operations: LineOperation[] } | undefined {
  if (file.frontmatter === null) return undefined;
  const value = formatUpdatedDate(now);
  const updated = fieldOf(file.fields, 'updated_date');
  if (updated !== undefined) {
    if (!isOneLineScalar(updated)) return undefined;
    const original = texts[updated.line];
    const text = namePrefix(original) + value;
    return {
      expectedLines: [{ line: updated.line, text: original }],
      operations: text === original ? [] : [{ kind: 'replace', start: updated.line, end: updated.line + 1, lines: [text] }],
    };
  }
  const anchor = fieldOf(file.fields, 'created_date') ?? fieldOf(file.fields, 'status');
  if (anchor === undefined) return undefined;
  return {
    expectedLines: [{ line: anchor.line, text: texts[anchor.line] }],
    operations: [{ kind: 'insert', at: anchor.end, lines: [`updated_date: ${value}`] }],
  };
}

/** Joins the target change with the `updated_date` change; no change means no operations at all. */
function withUpdatedDate(
  texts: readonly string[],
  file: TaskFile,
  now: Date,
  target: ExpectedLine,
  replacement: string,
): OperationPlan {
  const updated = planUpdatedDate(texts, file, now);
  if (updated === undefined) return refuse('unsafe');
  const expectedLines = [target, ...updated.expectedLines];
  if (replacement === target.text) return { ok: true, expectedLines, operations: [] };
  const change: LineOperation = { kind: 'replace', start: target.line, end: target.line + 1, lines: [replacement] };
  return { ok: true, expectedLines, operations: [change, ...updated.operations] };
}

/**
 * Status change: the `status:` line in the configured spelling and the original quote style,
 * plus `updated_date`. Setting the current status plans no operations.
 */
export function planSetStatus(texts: readonly string[], file: TaskFile, request: SetStatusRequest, now: Date): OperationPlan {
  const wanted = request.status.toLowerCase();
  const status = request.statuses.find((name) => name.toLowerCase() === wanted);
  if (status === undefined) return refuse('invalid');
  const field = fieldOf(file.fields, 'status');
  if (file.frontmatter === null || field === undefined) return refuse('unsafe');
  const original = texts[field.line];
  if (original !== request.statusLine) return refuse('stale');
  if (field.value.kind !== 'scalar' || !isOneLineScalar(field)) return refuse('unsafe');
  const replacement = field.value.value === status ? original : namePrefix(original) + formatScalar(status, field.value.style);
  return withUpdatedDate(texts, file, now, { line: field.line, text: original }, replacement);
}

/**
 * Check toggle: only the mark between `[` and `]` of one AC/DoD item, plus `updated_date`.
 * Item numbers and order never change; a read-only list (3.4) is refused.
 */
export function planToggleCheck(texts: readonly string[], file: TaskFile, request: ToggleCheckRequest, now: Date): OperationPlan {
  const original = texts[request.line];
  if (original === undefined || original !== request.source) return refuse('stale');
  const checklist = parseChecklist(texts, file.sections[request.list]);
  if (checklist?.readOnly === true) return refuse('unsafe');
  const item = checklist?.items.find((candidate) => candidate.line === request.line);
  if (item === undefined) return refuse('stale');
  const replacement = item.checked === request.checked ? original : `- [${request.checked ? 'x' : ' '}]${original.slice(5)}`;
  return withUpdatedDate(texts, file, now, { line: request.line, text: original }, replacement);
}
