// Card menu (kanban.md 4.6): which items a card gets, what each one does, and how the
// menu is driven from the keyboard. DOM-free so it can be unit tested; main.ts draws it
// with render.ts and wires the events.
import type { WebviewMessage } from '../messages.ts';
import type { BoardView, ViewStrings } from '../view.ts';
import { removeDateMessage } from './date-picker.ts';
import { moveCardMessage, type CardRef } from './interactions.ts';

export type CardMenuItemId =
  | 'edit'
  | 'open-text'
  | 'add-date'
  | 'change-date'
  | 'remove-date'
  | 'duplicate'
  | 'insert-before'
  | 'insert-after'
  | 'move-top'
  | 'move-bottom'
  | 'move-to'
  | 'delete';

/** Keys that do the same on a selected card (main.ts): only the ones that exist. */
const KEYBINDINGS: Partial<Record<CardMenuItemId, string>> = { edit: 'F2', 'open-text': 'Ctrl+Enter', delete: 'Delete' };

export type CardMenuEntry =
  | {
      readonly kind: 'item';
      readonly id: CardMenuItemId;
      readonly label: string;
      readonly disabled: boolean;
      /** Opens the lane list. */
      readonly submenu: boolean;
      /** Destructive: drawn in the error color. */
      readonly danger: boolean;
      /** Shortcut shown on the right, for items that have one on a selected card. */
      readonly keybinding?: string;
    }
  | { readonly kind: 'separator' };

export interface LaneChoice {
  readonly lane: number;
  readonly name: string;
  readonly done: boolean;
  /** The card's own lane: listed but disabled. */
  readonly current: boolean;
}

function item(id: CardMenuItemId, label: string, disabled = false, submenu = false, danger = false): CardMenuEntry {
  const keybinding = KEYBINDINGS[id];
  return { kind: 'item', id, label, disabled, submenu, danger, ...(keybinding ? { keybinding } : {}) };
}

/**
 * Menu entries for a card; moves that would change nothing are disabled. Date items (kanban.md
 * 4.8) only when the board's date picker is on: "Add date" for a card without a date token,
 * "Change date" and "Remove date" for one with, none for a card dated by a daily note link.
 */
export function cardMenuEntries(view: BoardView, ref: CardRef, s: ViewStrings): CardMenuEntry[] {
  const count = view.lanes[ref.lane]?.cards.length ?? 0;
  const card = view.lanes[ref.lane]?.cards[ref.card];
  const dates = !view.datePicker || card?.linkDate
    ? []
    : card?.date === undefined
      ? [item('add-date', s.addDate)]
      : [item('change-date', s.changeDate), item('remove-date', s.removeDate)];
  return [
    item('edit', s.editCard),
    item('open-text', s.openInText),
    ...dates,
    item('duplicate', s.duplicateCard),
    item('insert-before', s.insertCardBefore),
    item('insert-after', s.insertCardAfter),
    { kind: 'separator' },
    item('move-top', s.moveToTop, ref.card === 0),
    item('move-bottom', s.moveToBottom, ref.card >= count - 1),
    item('move-to', s.moveToLane, view.lanes.length < 2, true),
    { kind: 'separator' },
    item('delete', s.deleteCard, false, false, true),
  ];
}

/** Lanes for "Move to lane"; the card's own lane is disabled. */
export function laneChoices(view: BoardView, ref: CardRef): LaneChoice[] {
  return view.lanes.map((lane, i) => ({ lane: i, name: lane.name, done: lane.done, current: i === ref.lane }));
}

export type CardMenuAction =
  | { readonly kind: 'edit'; readonly ref: CardRef }
  /** Open the add input (kanban.md 4.4.1) at `index` of `lane`. */
  | { readonly kind: 'add-at'; readonly lane: number; readonly index: number }
  /** Open the date picker on the card (kanban.md 4.8). */
  | { readonly kind: 'pick-date'; readonly ref: CardRef }
  /** Send a message; `focus` is where the card ends up (moves) or what to select next. */
  | { readonly kind: 'message'; readonly message: WebviewMessage; readonly focus: CardRef | { readonly lane: number } }
  /**
   * Send a message that does not change the board (no redraw follows): focus goes back to the
   * card right away instead of waiting for a render.
   */
  | { readonly kind: 'request'; readonly message: WebviewMessage }
  | { readonly kind: 'none' };

/** "Open in Text" for a card (kanban.md 4.7): its identity and the board version. */
export function openInTextMessage(version: number, id: { readonly laneIndex: number; readonly cardIndex: number; readonly firstLine: string }): WebviewMessage {
  return { type: 'openCardInText', version, laneIndex: id.laneIndex, cardIndex: id.cardIndex, firstLine: id.firstLine };
}

function cardFields(view: BoardView, ref: CardRef) {
  const card = view.lanes[ref.lane]?.cards[ref.card];
  return card && { ...card.id };
}

/** What choosing `id` does. `toLane` is the lane picked in the "Move to lane" list. */
export function cardMenuAction(view: BoardView, version: number, ref: CardRef, id: CardMenuItemId, toLane?: number): CardMenuAction {
  const fields = cardFields(view, ref);
  if (fields === undefined) return { kind: 'none' };
  const count = view.lanes[ref.lane]!.cards.length;
  const move = (lane: number, before: number, focusIndex: number): CardMenuAction => {
    const message = moveCardMessage(view, version, ref, lane, before);
    return message ? { kind: 'message', message, focus: { lane, card: focusIndex } } : { kind: 'none' };
  };
  switch (id) {
    case 'edit':
      return { kind: 'edit', ref };
    case 'open-text':
      return { kind: 'request', message: openInTextMessage(version, fields) };
    case 'add-date':
    case 'change-date':
      return view.datePicker ? { kind: 'pick-date', ref } : { kind: 'none' };
    case 'remove-date': {
      const message = removeDateMessage(view, version, ref);
      return message ? { kind: 'message', message, focus: ref } : { kind: 'none' };
    }
    case 'insert-before':
      return { kind: 'add-at', lane: ref.lane, index: ref.card };
    case 'insert-after':
      return { kind: 'add-at', lane: ref.lane, index: ref.card + 1 };
    case 'duplicate':
      // The copy goes right after the card (operations.ts); select the copy.
      return { kind: 'message', message: { type: 'duplicateCard', version, ...fields }, focus: { lane: ref.lane, card: ref.card + 1 } };
    case 'delete': {
      // Select what takes the card's place: the next card, else the previous one, else the lane.
      const focus = count > 1 ? { lane: ref.lane, card: Math.min(ref.card, count - 2) } : { lane: ref.lane };
      return { kind: 'message', message: { type: 'deleteCard', version, ...fields }, focus };
    }
    case 'move-top':
      return move(ref.lane, 0, 0);
    case 'move-bottom':
      return move(ref.lane, count, count - 1);
    case 'move-to': {
      if (toLane === undefined || toLane === ref.lane || !view.lanes[toLane]) return { kind: 'none' };
      const end = view.lanes[toLane]!.cards.length;
      return move(toLane, end, end);
    }
  }
}

// --- Keyboard ------------------------------------------------------------------

export type MenuKeyAction = 'next' | 'prev' | 'first' | 'last' | 'activate' | 'close' | 'open-submenu' | 'close-submenu' | 'none';

export function menuKeyAction({ key }: { readonly key: string }): MenuKeyAction {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'Enter':
    case ' ':
      return 'activate';
    case 'Escape':
    case 'Tab':
      return 'close';
    case 'ArrowRight':
      return 'open-submenu';
    case 'ArrowLeft':
      return 'close-submenu';
    default:
      return 'none';
  }
}

/** Next enabled item index from `from` in direction `step` (wrapping); -1 when none. */
export function moveSelection(enabled: readonly boolean[], from: number, step: 1 | -1): number {
  const n = enabled.length;
  for (let i = 1; i <= n; i++) {
    const at = (((from + step * i) % n) + n) % n;
    if (enabled[at]) return at;
  }
  return -1;
}

export function firstEnabled(enabled: readonly boolean[]): number {
  return enabled.indexOf(true);
}

export function lastEnabled(enabled: readonly boolean[]): number {
  return enabled.lastIndexOf(true);
}

export interface KeyWithModifiers {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** Shift+F10 or the context menu key opens the selected card's menu. */
export function isCardMenuShortcut({ key, shiftKey, altKey, ctrlKey, metaKey }: KeyWithModifiers): boolean {
  if (altKey || ctrlKey || metaKey) return false;
  return key === 'ContextMenu' || (key === 'F10' && shiftKey);
}

/**
 * Ctrl+Enter (Cmd+Enter on macOS) opens the selected card in a text editor beside the board
 * (kanban.md 4.7). Plain Enter and F2 edit the card on the board.
 */
export function isOpenInTextShortcut({ key, shiftKey, altKey, ctrlKey, metaKey }: KeyWithModifiers): boolean {
  return key === 'Enter' && (ctrlKey || metaKey) && !(ctrlKey && metaKey) && !shiftKey && !altKey;
}

/** Delete (no modifiers) asks to delete the selected card. */
export function isDeleteShortcut({ key, shiftKey, altKey, ctrlKey, metaKey }: KeyWithModifiers): boolean {
  return key === 'Delete' && !shiftKey && !altKey && !ctrlKey && !metaKey;
}

// --- Placement -----------------------------------------------------------------

/**
 * Top-left of a menu of `size` opened at `anchor`, flipped to the other side when it would
 * leave the viewport, and kept `margin` px inside it.
 */
export function placeMenu(
  anchor: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  margin = 4,
): { x: number; y: number } {
  let x = anchor.x;
  let y = anchor.y;
  if (x + size.width > viewport.width - margin) x = anchor.x - size.width;
  if (y + size.height > viewport.height - margin) y = anchor.y - size.height;
  x = Math.max(margin, Math.min(x, viewport.width - size.width - margin));
  y = Math.max(margin, Math.min(y, viewport.height - size.height - margin));
  return { x, y };
}
