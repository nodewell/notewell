// Pure interaction logic for the board webview: turns user intents into the
// messages defined in ../messages.ts. DOM-free so it can be unit tested.
import type { WebviewMessage } from '../messages.ts';
import type { BoardView } from '../view.ts';

export interface CardRef {
  readonly lane: number;
  readonly card: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

function cardFields(view: BoardView, ref: CardRef) {
  const card = view.lanes[ref.lane]?.cards[ref.card];
  return card === undefined ? undefined : { ...card.id };
}

function laneFields(view: BoardView, lane: number) {
  const l = view.lanes[lane];
  return l === undefined ? undefined : { ...l.id };
}

/** Text the user typed for a title or lane name, or undefined when it cannot be sent. */
export function cleanTitle(text: string): string | undefined {
  const value = text.replace(/[\r\n\u2028\u2029\u0085]+/g, ' ').trim();
  return value === '' ? undefined : value;
}

export function toggleMessage(view: BoardView, version: number, ref: CardRef): WebviewMessage | undefined {
  const card = cardFields(view, ref);
  return card && { type: 'toggleCard', version, ...card };
}

/**
 * Multi-line card text as typed (kanban.md 4.4): CR, CRLF and other line separators become LF,
 * the first line is trimmed and trailing blank lines are dropped. Undefined when the first line
 * is empty. Body lines keep their own indentation.
 */
export function cleanCardText(text: string): string | undefined {
  const lines = text.replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n').split('\n');
  lines[0] = lines[0]!.trim();
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines[0] === '' ? undefined : lines.join('\n');
}

export function editTextMessage(view: BoardView, version: number, ref: CardRef, text: string): WebviewMessage | undefined {
  const card = cardFields(view, ref);
  const cleaned = cleanCardText(text);
  if (card === undefined || cleaned === undefined || cleaned === view.lanes[ref.lane]!.cards[ref.card]!.editText) return undefined;
  return { type: 'editCardText', version, ...card, text: cleaned };
}

export type EditorKeyAction = 'save' | 'newline' | 'cancel' | 'none';

export interface EditorKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  /** 229 while an IME is composing in some browsers. */
  readonly keyCode?: number;
}

/**
 * What a key does in the card editor: Enter saves, Shift+Enter inserts a line break,
 * Escape cancels. Keys pressed while an IME is composing (Korean input) do nothing here,
 * so confirming a syllable with Enter never saves the card.
 */
export function editorKeyAction({ key, shiftKey, isComposing, keyCode }: EditorKey, composing = false): EditorKeyAction {
  if (composing || isComposing || keyCode === 229) return 'none';
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter') return shiftKey ? 'newline' : 'save';
  return 'none';
}

export function renameLaneMessage(view: BoardView, version: number, lane: number, text: string): WebviewMessage | undefined {
  const fields = laneFields(view, lane);
  const name = cleanTitle(text);
  if (fields === undefined || name === undefined || name === view.lanes[lane]!.name.trim()) return undefined;
  return { type: 'renameLane', version, ...fields, name };
}

/** A new card at the end of the lane, or before position `index` (0..cards). */
export function addCardMessage(view: BoardView, version: number, lane: number, text: string, index?: number): WebviewMessage | undefined {
  const fields = laneFields(view, lane);
  const title = cleanTitle(text);
  if (fields === undefined || title === undefined) return undefined;
  return { type: 'addCard', version, ...fields, ...(index === undefined ? {} : { index }), title };
}

/**
 * Final index after moving an item that is currently at `from` so that it lands
 * before the item at `before` (0..count, positions in the current list). Matches
 * the operations' "index in the list without the moved item" convention.
 */
export function finalIndex(from: number | undefined, before: number): number {
  return from !== undefined && before > from ? before - 1 : before;
}

/** Moves a card so it lands before `before` in `toLane` (current positions). Undefined for no-ops. */
export function moveCardMessage(
  view: BoardView,
  version: number,
  ref: CardRef,
  toLane: number,
  before: number,
): WebviewMessage | undefined {
  const card = cardFields(view, ref);
  const target = view.lanes[toLane];
  if (card === undefined || target === undefined) return undefined;
  const toIndex = finalIndex(toLane === ref.lane ? ref.card : undefined, Math.min(Math.max(before, 0), target.cards.length));
  if (toLane === ref.lane && toIndex === ref.card) return undefined;
  return { type: 'moveCard', version, ...card, toLaneIndex: target.id.laneIndex, toHeading: target.id.heading, toIndex };
}

export function moveLaneMessage(view: BoardView, version: number, lane: number, before: number): WebviewMessage | undefined {
  const fields = laneFields(view, lane);
  if (fields === undefined) return undefined;
  const toIndex = finalIndex(lane, Math.min(Math.max(before, 0), view.lanes.length));
  return toIndex === lane ? undefined : { type: 'moveLane', version, ...fields, toIndex };
}

/** Keyboard move (Alt+arrow) of a card; also returns where focus should go afterwards. */
export function keyboardMoveCard(
  view: BoardView,
  version: number,
  ref: CardRef,
  direction: Direction,
): { message: WebviewMessage; focus: CardRef } | undefined {
  const count = view.lanes[ref.lane]?.cards.length ?? 0;
  if (ref.card >= count) return undefined;
  let toLane = ref.lane;
  let before: number;
  let focus: CardRef;
  switch (direction) {
    case 'up':
      if (ref.card === 0) return undefined;
      before = ref.card - 1;
      focus = { lane: toLane, card: ref.card - 1 };
      break;
    case 'down':
      if (ref.card >= count - 1) return undefined;
      before = ref.card + 2;
      focus = { lane: toLane, card: ref.card + 1 };
      break;
    case 'left':
    case 'right': {
      toLane = ref.lane + (direction === 'left' ? -1 : 1);
      const target = view.lanes[toLane];
      if (target === undefined) return undefined;
      before = Math.min(ref.card, target.cards.length);
      focus = { lane: toLane, card: before };
      break;
    }
  }
  const message = moveCardMessage(view, version, ref, toLane, before);
  return message && { message, focus };
}

/** Keyboard move (Alt+Left/Right) of a lane. */
export function keyboardMoveLane(view: BoardView, version: number, lane: number, direction: 'left' | 'right') {
  const before = direction === 'left' ? lane - 1 : lane + 2;
  if (before < 0 || before > view.lanes.length) return undefined;
  const message = moveLaneMessage(view, version, lane, before);
  return message && { message, focus: direction === 'left' ? lane - 1 : lane + 1 };
}

/** Focus target for plain arrow navigation between cards. */
export function navigate(view: BoardView, ref: CardRef, direction: Direction): CardRef | undefined {
  if (direction === 'up') return ref.card > 0 ? { lane: ref.lane, card: ref.card - 1 } : undefined;
  if (direction === 'down') {
    return ref.card + 1 < (view.lanes[ref.lane]?.cards.length ?? 0) ? { lane: ref.lane, card: ref.card + 1 } : undefined;
  }
  const step = direction === 'left' ? -1 : 1;
  for (let lane = ref.lane + step; lane >= 0 && lane < view.lanes.length; lane += step) {
    const cards = view.lanes[lane]!.cards.length;
    if (cards > 0) return { lane, card: Math.min(ref.card, cards - 1) };
  }
  return undefined;
}

/**
 * A drag in progress, with the view and document version it started from. The drop
 * message is built from these, never from a view that arrived during the drag: if the
 * board changed meanwhile, the extension refuses the old version as stale instead of
 * moving whatever card now sits at the same index.
 */
export type DragSession =
  | { readonly kind: 'card'; readonly ref: CardRef; readonly view: BoardView; readonly version: number }
  | { readonly kind: 'lane'; readonly lane: number; readonly view: BoardView; readonly version: number };

/** The message for dropping `drag` before position `before` of `toLane` (positions in the drag's view). */
export function dropMessage(drag: DragSession, toLane: number, before: number): WebviewMessage | undefined {
  return drag.kind === 'card'
    ? moveCardMessage(drag.view, drag.version, drag.ref, toLane, before)
    : moveLaneMessage(drag.view, drag.version, drag.lane, before);
}

// --- Add-card input (kanban.md 4.4.1) ---------------------------------------

export type AdderAction = 'add' | 'close' | 'none';

/**
 * Enter adds the typed card and keeps the input open; Enter on an empty input or Escape
 * closes it. Keys during IME composition do nothing (Enter only confirms the syllable).
 */
export function adderKeyAction(key: EditorKey, text: string, composing = false): AdderAction {
  const action = editorKeyAction(key, composing);
  if (action === 'cancel') return 'close';
  if (action === 'save' || action === 'newline') return cleanTitle(text) === undefined ? 'close' : 'add';
  return 'none';
}

export interface ShortcutKey {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** N (no Ctrl/Alt/Meta) on a selected card or lane opens that lane's add input. */
export function isAddCardShortcut({ key, altKey, ctrlKey, metaKey }: ShortcutKey): boolean {
  return (key === 'n' || key === 'N') && !altKey && !ctrlKey && !metaKey;
}

/** After the add input closes: the last card added in this run, else the lane title. */
export function closeFocus(lane: number, lastAdded?: CardRef): { kind: 'card'; ref: CardRef } | { kind: 'lane'; lane: number } {
  return lastAdded ? { kind: 'card', ref: lastAdded } : { kind: 'lane', lane };
}

// --- Enter that only confirms an IME composition -----------------------------
// A Korean IME does not consume Enter: Chromium ends the composition (compositionend)
// and then delivers the same Enter as an ordinary keydown with isComposing false and a
// real key code, so isComposing / keyCode 229 checks cannot see it. That Enter must only
// confirm the syllable (kanban.md 4.4, 4.4.1), so it is swallowed when it follows a
// compositionend within the same key press: before any keyup, and within a short window
// (so a composition ended by a click is not mistaken for one ended by Enter).

export const COMPOSITION_ENTER_WINDOW_MS = 200;

export class CompositionEnterGuard {
  #endedAt: number | undefined;

  compositionEnd(now: number): void {
    this.#endedAt = now;
  }

  /** Any keyup ends the key press that could have ended the composition. */
  keyUp(): void {
    this.#endedAt = undefined;
  }

  /**
   * True when this keydown is a plain Enter that only confirmed the composition and must be
   * ignored. Shift+Enter still inserts its line break in the card editor.
   */
  swallow({ key, shiftKey }: { readonly key: string; readonly shiftKey: boolean }, now: number): boolean {
    if (key !== 'Enter' || this.#endedAt === undefined) return false;
    if (shiftKey) {
      this.#endedAt = undefined;
      return false;
    }
    const recent = now - this.#endedAt <= COMPOSITION_ENTER_WINDOW_MS;
    this.#endedAt = undefined;
    return recent;
  }
}
