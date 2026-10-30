// Keyboard and wheel decisions for the canvas (canvas.md 4). Pure, so they run under node:test;
// main.ts applies the result.

export interface KeyInput {
  readonly key: string;
  readonly code?: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

export type KeyAction =
  /** Moves the view by screen pixels (positive dx shows more of the right side). */
  | { readonly kind: 'pan'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'zoom'; readonly factor: number }
  | { readonly kind: 'zoomReset' }
  | { readonly kind: 'fit' }
  /** Opens the selected file or link card. */
  | { readonly kind: 'open' }
  | { readonly kind: 'clear' };

export const PAN_STEP = 50;
export const PAN_STEP_FAST = 200;
export const ZOOM_STEP = 1.25;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * What a key does. `cardSelected`: a card has focus (arrows are kept for moving cards in a later
 * version and for scrolling inside the card, so they do not pan then).
 */
export function keyAction(input: KeyInput, cardSelected: boolean): KeyAction | undefined {
  const { key, code, shiftKey, altKey, ctrlKey, metaKey } = input;
  if (altKey || ctrlKey || metaKey) return undefined;
  const arrow = ARROWS[key];
  if (arrow !== undefined) {
    if (cardSelected) return undefined;
    const step = shiftKey ? PAN_STEP_FAST : PAN_STEP;
    return { kind: 'pan', dx: arrow[0] * step, dy: arrow[1] * step };
  }
  switch (key) {
    case '+':
    case '=':
      return { kind: 'zoom', factor: ZOOM_STEP };
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1 / ZOOM_STEP };
    case '0':
      return shiftKey ? undefined : { kind: 'zoomReset' };
    case '!':
      return { kind: 'fit' };
    case 'Enter':
      return cardSelected ? { kind: 'open' } : undefined;
    case 'Escape':
      return { kind: 'clear' };
  }
  // Shift+1 on layouts where that key is not '!'.
  if (shiftKey && code === 'Digit1') return { kind: 'fit' };
  return undefined;
}

export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

const LINE_PIXELS = 16;
const PAGE_PIXELS = 400;

/** Ctrl (or Cmd) + wheel zooms (pinch gestures arrive this way too); the plain wheel pans. */
export function wheelAction(input: WheelInput): { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number } {
  const unit = input.deltaMode === 1 ? LINE_PIXELS : input.deltaMode === 2 ? PAGE_PIXELS : 1;
  const dx = input.deltaX * unit;
  const dy = input.deltaY * unit;
  if (input.ctrlKey || input.metaKey) return { kind: 'zoom', factor: Math.exp(-Math.max(-100, Math.min(100, dy)) * 0.002) };
  // Shift turns a vertical wheel into horizontal panning.
  if (input.shiftKey && dx === 0) return { kind: 'pan', dx: dy, dy: 0 };
  return { kind: 'pan', dx, dy };
}
