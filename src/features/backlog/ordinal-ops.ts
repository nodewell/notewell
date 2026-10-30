// Order within a board column (backlog.md 4.2, 5.4, 9 #3): only the moved task's `ordinal`
// changes, to a value between its new neighbours. Pure planner like operations.ts.
//
// Backlog.md 1.54.0 (`backlog task edit <id> --ordinal <n>`, checked on CLI-written files):
// - changes the `ordinal:` line only; `updated_date` is NOT touched
// - writes the number plain (`1500`, `1500.5`, `0.000001`); accepts 0, rejects negatives
// - a missing key goes at its serializer position (field-ops insertionFor)
// so this planner does the same. Integers are preferred whenever one fits between the
// neighbours; a decimal is used only when no integer does.
import type { ExpectedLine, LineOperation } from '../../core/patch.ts';
import { insertionFor } from './field-ops.ts';
import { isOneLineScalar, namePrefix, refuse, type OperationPlan } from './operations.ts';
import type { TaskFile } from './task-file.ts';
import { fieldOf, type Field } from './yaml-lite.ts';

/** Step used at the ends of a column (the CLI and the official board use multiples of 1000). */
export const ORDINAL_STEP = 1000;

/**
 * A neighbour of the drop position in board order (ordinal ascending, tasks without ordinal
 * last): its ordinal, or null when it has none. `undefined` for the column's top or bottom.
 */
export type Neighbour = { readonly ordinal: number | null } | undefined;

export interface MoveInColumnRequest {
  /** The task directly above the new position (`afterPath` in the message). */
  readonly above: Neighbour;
  /** The task directly below the new position (`beforePath` in the message). */
  readonly below: Neighbour;
}

/**
 * Plain decimal text as the CLI writes it; undefined for values it would not (negative,
 * exponent) and above 2^53, where neighbouring integers are no longer distinct numbers.
 */
export function formatOrdinal(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return undefined;
  const text = String(value);
  return /^\d+(\.\d+)?$/.test(text) ? text : undefined;
}

/** The value strictly between `low` and `high` (either may be open), preferring integers. */
function between(low: number | undefined, high: number | undefined): number | undefined {
  if (low === undefined && high === undefined) return ORDINAL_STEP;
  if (high === undefined) return Math.floor(low!) + ORDINAL_STEP;
  if (low === undefined) {
    if (high - ORDINAL_STEP >= 0) return Math.ceil(high) - ORDINAL_STEP;
    // Near zero: ordinals cannot be negative, so halve towards it (an integer when one fits).
    for (const candidate of [Math.round(high / 2), Math.floor(high / 2), high / 2]) {
      if (candidate >= 0 && candidate < high && formatOrdinal(candidate) !== undefined) return candidate;
    }
    return undefined;
  }
  if (!(low < high)) return undefined;
  const middle = (low + high) / 2;
  for (const candidate of [Math.round(middle), Math.floor(middle), Math.ceil(middle)]) {
    if (low < candidate && candidate < high) return candidate;
  }
  return low < middle && middle < high && formatOrdinal(middle) !== undefined ? middle : undefined;
}

/**
 * The new ordinal for a task placed between `above` and `below`, or undefined when one file
 * cannot express the position: no value fits between equal or adjacent ordinals, or the
 * position is among tasks without an ordinal (their order comes from their IDs).
 */
export function ordinalBetween(request: MoveInColumnRequest): number | undefined {
  const { above, below } = request;
  if (above !== undefined && above.ordinal === null) return undefined;
  const low = above?.ordinal ?? undefined;
  // A neighbour below without an ordinal sorts after every ordered task: any larger value fits.
  const high = below === undefined || below.ordinal === null ? undefined : below.ordinal;
  return between(low, high);
}

const fieldLines = (texts: readonly string[], field: Field): ExpectedLine[] =>
  texts.slice(field.line, field.end).map((text, i) => ({ line: field.line + i, text }));

/** Sets `ordinal:` to `value` (changing nothing else, as the CLI does). */
export function planSetOrdinal(texts: readonly string[], file: TaskFile, value: number): OperationPlan {
  const text = formatOrdinal(value);
  if (text === undefined) return refuse('invalid');
  if (file.frontmatter === null) return refuse('unsafe');
  const field = fieldOf(file.fields, 'ordinal');
  if (field !== undefined) {
    if (!isOneLineScalar(field)) return refuse('unsafe');
    const original = texts[field.line];
    const line = namePrefix(original) + text;
    const operations: LineOperation[] = line === original ? [] : [{ kind: 'replace', start: field.line, end: field.line + 1, lines: [line] }];
    return { ok: true, expectedLines: [{ line: field.line, text: original }], operations };
  }
  const { at, anchor } = insertionFor(file, 'ordinal');
  return {
    ok: true,
    expectedLines: anchor === undefined ? [] : fieldLines(texts, anchor),
    operations: [{ kind: 'insert', at, lines: [`ordinal: ${text}`] }],
  };
}

/**
 * Moves a task within its column: the moved file's `ordinal` only (backlog.md 9 #3). Nothing
 * changes when the current ordinal already sits between the neighbours. Refused as 'unsafe'
 * when the position needs more than one file changed (see ordinalBetween) or the ordinal
 * field has a shape that is not written.
 */
export function planMoveInColumn(texts: readonly string[], file: TaskFile, request: MoveInColumnRequest): OperationPlan {
  if (file.frontmatter === null) return refuse('unsafe');
  const field = fieldOf(file.fields, 'ordinal');
  if (field !== undefined && !isOneLineScalar(field)) return refuse('unsafe');
  const current = field?.value.kind === 'scalar' && /^\d+(\.\d+)?$/.test(field.value.value) ? Number(field.value.value) : null;

  const { above, below } = request;
  if (current !== null && above?.ordinal !== null && below?.ordinal !== null) {
    const fitsAbove = above === undefined || above.ordinal! < current;
    const fitsBelow = below === undefined || current < below.ordinal!;
    if (fitsAbove && fitsBelow) return { ok: true, expectedLines: [{ line: field!.line, text: texts[field!.line] }], operations: [] };
  }
  const value = ordinalBetween(request);
  if (value === undefined) return refuse('unsafe');
  return planSetOrdinal(texts, file, value);
}
