// Editing decisions of the canvas webview (canvas.md 4, 5). Pure, so they run under node:test;
// main.ts applies them. Messages carry the document version and the values the view showed.
import type { WebviewMessage } from '../messages.ts';
import type { NodeView } from '../view.ts';
import type { Rect } from './geometry.ts';

type Message<T extends WebviewMessage['type']> = Extract<WebviewMessage, { type: T }>;

/** Screen pixels a pointer must travel before a press becomes a drag (a click selects only). */
export const DRAG_THRESHOLD = 4;
/** Smallest width and height (operations.ts MIN_NODE_SIZE). */
export const MIN_SIZE = 20;
/** Grid of notewell.canvas.snapToGrid, in canvas pixels. */
export const GRID = 20;
export const MOVE_STEP = 10;
export const MOVE_STEP_FAST = 50;
const MAX_COORDINATE = 10_000_000;
const MAX_SIZE = 1_000_000;

export function passedThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Where a card dragged by (dx, dy) screen pixels at zoom `scale` lands: integers, maybe on the grid. */
export function dropPosition(node: Rect, dx: number, dy: number, scale: number, snap: boolean): { x: number; y: number } {
  let x = node.x + dx / scale;
  let y = node.y + dy / scale;
  if (snap) {
    x = Math.round(x / GRID) * GRID;
    y = Math.round(y / GRID) * GRID;
  }
  return { x: clamp(Math.round(x), -MAX_COORDINATE, MAX_COORDINATE) + 0, y: clamp(Math.round(y), -MAX_COORDINATE, MAX_COORDINATE) + 0 };
}

/** The size after dragging the corner by (dx, dy) screen pixels: integers, at least MIN_SIZE. */
export function dropSize(node: Rect, dx: number, dy: number, scale: number, snap: boolean): { width: number; height: number } {
  let width = node.width + dx / scale;
  let height = node.height + dy / scale;
  if (snap) {
    width = Math.round((node.x + width) / GRID) * GRID - node.x;
    height = Math.round((node.y + height) / GRID) * GRID - node.y;
  }
  return { width: clamp(Math.round(width), MIN_SIZE, MAX_SIZE), height: clamp(Math.round(height), MIN_SIZE, MAX_SIZE) };
}

/**
 * Nodes that move with a node: a group carries every node drawn fully inside it (nested groups
 * and their contents included), the same rule as operations.ts. The node itself comes first.
 */
export function movingWith(nodes: readonly NodeView[], node: NodeView): NodeView[] {
  if (node.kind !== 'group') return [node];
  return [
    node,
    ...nodes.filter(
      (n) => n !== node && n.x >= node.x && n.y >= node.y && n.x + n.width <= node.x + node.width && n.y + n.height <= node.y + node.height,
    ),
  ];
}

/** What a card allows (canvas.md 5.1): nothing when locked or the canvas is not editable. */
export function canEdit(node: NodeView | undefined, editable: boolean): { move: boolean; resize: boolean; text: boolean; color: boolean } {
  const any = node !== undefined && editable && node.locked !== true;
  return { move: any, resize: any, text: any && node.kind === 'text', color: any && node.kind !== 'unknown' };
}

const identity = (node: NodeView) => ({ index: node.index, id: node.id });

export function moveMessage(version: number, node: NodeView, x: number, y: number): Message<'move'> | undefined {
  if (x === node.x && y === node.y) return undefined;
  return { type: 'move', version, ...identity(node), x, y, fromX: node.x, fromY: node.y };
}

export function resizeMessage(version: number, node: NodeView, width: number, height: number): Message<'resize'> | undefined {
  if (width === node.width && height === node.height) return undefined;
  return { type: 'resize', version, ...identity(node), width, height, fromWidth: node.width, fromHeight: node.height };
}

/** Textareas give LF line breaks; the text is sent as typed (no trimming: Markdown spacing). */
export function editTextMessage(version: number, node: NodeView, text: string): Message<'editText'> | undefined {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (node.kind !== 'text' || normalized === node.text) return undefined;
  return { type: 'editText', version, ...identity(node), text: normalized };
}

export type ColorChoice = Message<'setColor'>['color'];

export function colorMessage(version: number, node: NodeView, color: ColorChoice): Message<'setColor'> | undefined {
  const from = node.color ?? '';
  if ((color === 'none' && from === '') || color === from) return undefined;
  return { type: 'setColor', version, ...identity(node), color, from };
}

/** Keys in the text editor (Backlog section editor rules): Ctrl/Cmd+Enter saves, Escape cancels; never while composing. */
export function textEditorKey(input: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly isComposing: boolean; readonly keyCode?: number }): 'save' | 'cancel' | 'none' {
  const { key, ctrlKey, metaKey, isComposing, keyCode } = input;
  if (isComposing || keyCode === 229) return 'none';
  if (key === 'Enter' && (ctrlKey || metaKey)) return 'save';
  if (key === 'Escape') return 'cancel';
  return 'none';
}

/** Arrow keys moving (plain, Shift faster) or resizing (Alt, Alt+Shift faster) the selected card. */
export function keyboardEdit(input: { readonly key: string; readonly shiftKey: boolean; readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean }):
  | { readonly kind: 'move' | 'resize'; readonly dx: number; readonly dy: number }
  | undefined {
  const { key, shiftKey, altKey, ctrlKey, metaKey } = input;
  if (ctrlKey || metaKey) return undefined;
  const step = shiftKey ? MOVE_STEP_FAST : MOVE_STEP;
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const arrow = arrows[key];
  if (arrow === undefined) return undefined;
  return { kind: altKey ? 'resize' : 'move', dx: arrow[0] * step, dy: arrow[1] * step };
}

/**
 * Keyboard moves and resizes made while an edit is still on its way: added up and sent as one
 * edit when the view of the previous one arrives (each edit needs the version it was made on).
 */
export class PendingKeyEdits {
  #pending: { kind: 'move' | 'resize'; index: number; dx: number; dy: number } | undefined;

  /** False (nothing added) when a different change of another kind or card is already waiting. */
  add(kind: 'move' | 'resize', index: number, dx: number, dy: number): boolean {
    const pending = this.#pending;
    if (pending === undefined) {
      this.#pending = { kind, index, dx, dy };
      return true;
    }
    if (pending.kind !== kind || pending.index !== index) return false;
    this.#pending = { kind, index, dx: pending.dx + dx, dy: pending.dy + dy };
    return true;
  }

  /** The waiting change, without clearing it. */
  peek(): { kind: 'move' | 'resize'; index: number; dx: number; dy: number } | undefined {
    return this.#pending;
  }

  /** The added-up change, cleared. */
  take(): { kind: 'move' | 'resize'; index: number; dx: number; dy: number } | undefined {
    const pending = this.#pending;
    this.#pending = undefined;
    return pending;
  }

  get size(): number {
    return this.#pending === undefined ? 0 : 1;
  }
}
