// Detail pane placement and the splitter between the board/list and the detail (backlog.md
// 4.1). Pure: lengths in, lengths out; main.ts measures the layout and applies them.

export type DetailPosition = 'bottom' | 'right';

/** Neither pane may become smaller than this (px), so neither disappears. */
export const MIN_CONTENT = 120;
export const MIN_DETAIL = 160;
/** Splitter keyboard steps (px): arrows, Shift+arrows. */
export const STEP = 16;
export const BIG_STEP = 64;

/** Detail size when the user has not resized: 45% of the height below, as before on the right. */
export function defaultDetailSize(position: DetailPosition, total: number): number {
  return Math.round(position === 'bottom' ? total * 0.45 : Math.min(560, total * 0.48));
}

/**
 * The detail size kept inside the minimums. When the layout is too small for both minimums,
 * the space is split in half rather than letting either pane vanish.
 */
export function clampDetail(size: number, total: number): number {
  if (!(total > 0)) return 0;
  const max = total - MIN_CONTENT;
  if (max < MIN_DETAIL) return Math.round(total / 2);
  return Math.round(Math.min(Math.max(size, MIN_DETAIL), max));
}

/** The detail size to show: the remembered share of `total`, else the default; always clamped. */
export function detailSize(position: DetailPosition, total: number, stored: number | undefined): number {
  return clampDetail(stored === undefined ? defaultDetailSize(position, total) : stored * total, total);
}

/** What is remembered (per position, in the panel state): the detail's share of the layout. */
export function storedShare(size: number, total: number): number | undefined {
  return total > 0 ? Math.round((size / total) * 10000) / 10000 : undefined;
}

/**
 * ARIA values of the separator: the position of the splitter as the board/list pane's share in
 * percent, so Home/End and the arrows move it the way it moves on screen.
 */
export function splitterValues(size: number, total: number): { now: number; min: number; max: number } {
  if (!(total > 0)) return { now: 0, min: 0, max: 100 };
  const percent = (px: number): number => Math.round((px / total) * 100);
  const max = total - MIN_CONTENT < MIN_DETAIL ? percent(total / 2) : percent(total - MIN_DETAIL);
  const min = total - MIN_CONTENT < MIN_DETAIL ? max : percent(MIN_CONTENT);
  return { now: percent(total - size), min, max };
}

interface SplitterKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * The detail size after a key on the focused splitter, or undefined when the key is not one the
 * splitter handles. Below: Up grows the detail, Down shrinks it. On the right: Left grows it,
 * Right shrinks it. Home moves the splitter to its start (largest detail), End to its end.
 */
export function splitterKey(position: DetailPosition, { key, shiftKey, ctrlKey, metaKey, altKey }: SplitterKey, size: number, total: number): number | undefined {
  if (ctrlKey || metaKey || altKey) return undefined;
  const grow = position === 'bottom' ? 'ArrowUp' : 'ArrowLeft';
  const shrink = position === 'bottom' ? 'ArrowDown' : 'ArrowRight';
  const step = shiftKey ? BIG_STEP : STEP;
  if (key === grow) return clampDetail(size + step, total);
  if (key === shrink) return clampDetail(size - step, total);
  if (key === 'Home') return clampDetail(Number.POSITIVE_INFINITY, total);
  if (key === 'End') return clampDetail(0, total);
  return undefined;
}

/** Detail size from the pointer while dragging: the distance from the pointer to the far edge. */
export function dragDetailSize(pointer: number, layoutEnd: number, splitter: number, total: number): number {
  return clampDetail(layoutEnd - pointer - splitter / 2, total);
}
