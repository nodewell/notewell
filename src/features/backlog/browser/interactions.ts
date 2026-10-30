// Keyboard and drag decisions for the Backlog webview (backlog.md 4.2, 4.3). Pure: positions
// and view data in, a target or a message out; main.ts applies them to the DOM.
import type { WebviewMessage } from '../messages.ts';
import type { TaskSummary } from '../view.ts';
import type { BoardColumn } from './filters.ts';

type SetStatus = Extract<WebviewMessage, { type: 'setStatus' }>;

/**
 * A board status change. The board has no `status:` line, so it sends an empty `statusLine`
 * and the status it saw: the extension refuses the change as stale when the file's status
 * differs (contract: messages.ts setStatus `fromStatus`).
 */
export type BoardSetStatus = SetStatus & { readonly fromStatus: string };

export type OutgoingMessage = WebviewMessage | BoardSetStatus;

export type Direction = 'up' | 'down' | 'left' | 'right';

export const ARROWS: Readonly<Record<string, Direction>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export interface CardPosition {
  readonly column: number;
  readonly card: number;
}

/** Where an arrow key moves the board focus; left/right skip empty columns. */
export function navigateBoard(columns: readonly BoardColumn[], from: CardPosition, direction: Direction): CardPosition | undefined {
  const count = (column: number): number => columns[column]?.tasks.length ?? 0;
  if (direction === 'up') return from.card > 0 ? { column: from.column, card: from.card - 1 } : undefined;
  if (direction === 'down') return from.card + 1 < count(from.column) ? { column: from.column, card: from.card + 1 } : undefined;
  const step = direction === 'left' ? -1 : 1;
  for (let column = from.column + step; column >= 0 && column < columns.length; column += step) {
    if (count(column) > 0) return { column, card: Math.min(from.card, count(column) - 1) };
  }
  return undefined;
}

/** Position of the task at `path` on the board. */
export function findCard(columns: readonly BoardColumn[], path: string): CardPosition | undefined {
  for (let column = 0; column < columns.length; column++) {
    const card = columns[column]!.tasks.findIndex((t) => t.path === path);
    if (card !== -1) return { column, card };
  }
  return undefined;
}

export function setStatusMessage(task: TaskSummary, status: string): BoardSetStatus | undefined {
  if (status === task.status) return undefined;
  return { type: 'setStatus', path: task.path, statusLine: '', status, fromStatus: task.status };
}

/**
 * Alt+Left/Right: the neighbouring configured status. A task in "Other status" goes to the
 * last configured status with Alt+Left; nothing moves past either end.
 */
export function neighbourStatus(statuses: readonly string[], task: TaskSummary, direction: 'left' | 'right'): string | undefined {
  const index = task.statusKnown ? statuses.indexOf(task.status) : statuses.length;
  if (index === -1) return undefined;
  const next = index + (direction === 'left' ? -1 : 1);
  return next >= 0 && next < statuses.length ? statuses[next] : undefined;
}

/** Drop of a dragged card onto a column; the "Other status" column takes no drops. */
export function dropStatus(column: BoardColumn, task: TaskSummary): string | undefined {
  if (!column.known || column.status === task.status) return undefined;
  return column.status;
}

type MoveInColumn = Extract<WebviewMessage, { type: 'moveInColumn' }>;

/**
 * Reorder within a column (backlog.md 5.4): `index` is the new position counted without the
 * moved card. The message names the cards that will be directly above (`afterPath`) and
 * below (`beforePath`) it; the extension derives the ordinal from them. Undefined when the
 * position does not change or the column is "Other status" (mixed statuses, no order).
 */
export function moveInColumnMessage(column: BoardColumn, task: TaskSummary, index: number): MoveInColumn | undefined {
  if (!column.known) return undefined;
  const current = column.tasks.findIndex((t) => t.path === task.path);
  const others = column.tasks.filter((t) => t.path !== task.path);
  if (current === -1 || index < 0 || index > others.length || index === current) return undefined;
  const message: { type: 'moveInColumn'; path: string; fromStatus: string; afterPath?: string; beforePath?: string } = {
    type: 'moveInColumn',
    path: task.path,
    fromStatus: task.status,
  };
  const above = others[index - 1];
  const below = others[index];
  if (above !== undefined) message.afterPath = above.path;
  if (below !== undefined) message.beforePath = below.path;
  return message;
}

/** A drop "before position `before`" in the column as shown, as an index without the moved card. */
export function dropIndex(column: BoardColumn, task: TaskSummary, before: number): number {
  const current = column.tasks.findIndex((t) => t.path === task.path);
  return current !== -1 && before > current ? before - 1 : before;
}

/** Alt+Up/Down: one step up or down within the column. */
export function stepIndex(column: BoardColumn, task: TaskSummary, direction: 'up' | 'down'): number | undefined {
  const current = column.tasks.findIndex((t) => t.path === task.path);
  if (current === -1) return undefined;
  const next = current + (direction === 'up' ? -1 : 1);
  return next >= 0 && next < column.tasks.length ? next : undefined;
}

/** Alt+Up/Down only. */
export function altVerticalArrow({ key, ctrlKey, metaKey, altKey, shiftKey }: KeyLike): 'up' | 'down' | undefined {
  if (!altKey || ctrlKey || metaKey || shiftKey) return undefined;
  return key === 'ArrowUp' ? 'up' : key === 'ArrowDown' ? 'down' : undefined;
}

/** Row index after a navigation key in the list, or undefined when the key is not one. */
export function navigateList(count: number, from: number, key: string, pageSize = 10): number | undefined {
  if (count === 0) return undefined;
  const clamp = (n: number): number => Math.max(0, Math.min(count - 1, n));
  switch (key) {
    case 'ArrowUp':
      return clamp(from - 1);
    case 'ArrowDown':
      return clamp(from + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageUp':
      return clamp(from - pageSize);
    case 'PageDown':
      return clamp(from + pageSize);
    default:
      return undefined;
  }
}

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Ctrl+Z (Cmd+Z on macOS): undo the last change made from this panel. */
export function isUndoShortcut({ key, ctrlKey, metaKey, altKey, shiftKey }: KeyLike): boolean {
  return (key === 'z' || key === 'Z') && (ctrlKey || metaKey) && !altKey && !shiftKey;
}

/** Enter or Space without modifiers: open the focused task. */
export function isOpenShortcut({ key, ctrlKey, metaKey, altKey, shiftKey }: KeyLike): boolean {
  return (key === 'Enter' || key === ' ') && !ctrlKey && !metaKey && !altKey && !shiftKey;
}

/** Plain arrows navigate; arrows with Ctrl/Meta/Alt/Shift are left alone. */
export function plainArrow({ key, ctrlKey, metaKey, altKey, shiftKey }: KeyLike): Direction | undefined {
  return ctrlKey || metaKey || altKey || shiftKey ? undefined : ARROWS[key];
}

/** Alt+Left/Right only. */
export function altSideArrow({ key, ctrlKey, metaKey, altKey, shiftKey }: KeyLike): 'left' | 'right' | undefined {
  if (!altKey || ctrlKey || metaKey || shiftKey) return undefined;
  return key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : undefined;
}

/** Window after compositionend in which an Enter only confirmed the IME text (Safari order). */
const COMPOSITION_ENTER_WINDOW_MS = 100;

/**
 * IME guard for the search box: an Enter that confirms a composition must not act. Chromium
 * reports it with isComposing (keyCode 229); some engines send compositionend first, then Enter.
 */
export class CompositionGuard {
  #composing = false;
  #endedAt: number | undefined;

  start(): void {
    this.#composing = true;
  }

  end(now: number): void {
    this.#composing = false;
    this.#endedAt = now;
  }

  /** True when this Enter keydown belongs to the composition. */
  swallowEnter({ key, isComposing, keyCode }: { readonly key: string; readonly isComposing: boolean; readonly keyCode: number }, now: number): boolean {
    if (key !== 'Enter') return false;
    if (this.#composing || isComposing || keyCode === 229) return true;
    const recent = this.#endedAt !== undefined && now - this.#endedAt <= COMPOSITION_ENTER_WINDOW_MS;
    this.#endedAt = undefined;
    return recent;
  }
}
