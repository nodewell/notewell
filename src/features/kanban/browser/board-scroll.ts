// Where the board is scrolled. View state only: redraws replace the scrolling element and
// hiding the tab replaces the page, so it is kept in the webview state (vscode.setState).
// Pure, for node:test.

export interface BoardScroll {
  readonly left: number;
  readonly top: number;
}

export const SCROLL_ORIGIN: BoardScroll = { left: 0, top: 0 };

const offset = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Reads the stored position; anything unusable counts as the start of the board. */
export function restoreScroll(stored: unknown): BoardScroll {
  if (typeof stored !== 'object' || stored === null) return SCROLL_ORIGIN;
  const { left, top } = stored as { left?: unknown; top?: unknown };
  return { left: offset(left), top: offset(top) };
}

export function sameScroll(a: BoardScroll, b: BoardScroll): boolean {
  return a.left === b.left && a.top === b.top;
}
