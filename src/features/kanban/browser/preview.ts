// Card preview (kanban.md 3.3): the whole card drawn as Markdown in a popup beside the card.
// DOM-free like render.ts. The body goes through the shared Markdown display (no HTML is ever
// interpreted); plain text in it is read with the board's own token rules, so wikilinks,
// tags, dates, times and ==highlights== look and behave as on the board. Plain links stay
// text only, checkboxes are drawn disabled, and nothing in the popup takes keyboard focus.
import { createElementFactory, type DomDocument, type DomElement } from '../../../webview/dom.ts';
import type { BoardView, CardView } from '../view.ts';
import { bodyMarkdown, renderBodyMarkdown, renderSegments } from './render.ts';

/** Pointer rest before the popup opens, and the grace after leaving card and popup. */
export const PREVIEW_DELAY_MS = 500;
export const PREVIEW_CLOSE_MS = 150;

/** Only cards with a body: a title-only card already shows everything. */
export function canPreview(view: BoardView, card: CardView | undefined): card is CardView {
  return view.cardPreview && card !== undefined && card.body.length > 0;
}

/**
 * The pointer opens the preview only over a folded card: an unfolded body is already drawn
 * as Markdown on the card (kanban.md 3.3). The keyboard route (Ctrl+K Ctrl+I) opens it on
 * any card with a body, for a wider look.
 */
export function previewOnHover(folded: boolean, byKeyboard: boolean): boolean {
  return byKeyboard || folded;
}

/** The card's body as Markdown: the edit text (kanban.md 4.4) after the title line. */
export const previewBody = bodyMarkdown;

export function renderCardPreview<E extends DomElement<E>>(doc: DomDocument<E>, view: BoardView, card: CardView, id: string): E {
  const el = createElementFactory(doc);
  const title = el(
    'div',
    { className: `card-preview-title${card.checked ? ' checked' : ''}` },
    el('input', { className: 'md-checkbox', attrs: { type: 'checkbox', disabled: '', tabindex: '-1', ...(card.checked ? { checked: '' } : {}) } }),
    el('span', { className: 'card-preview-title-text', attrs: { dir: 'auto' } }, ...renderSegments(doc, card.segments, false)),
  );
  // The same Markdown as the card body (kanban.md 3), extra table cells kept; no date picker here.
  const body = renderBodyMarkdown(doc, view, card, false);
  return el(
    'div',
    { className: 'card-preview', attrs: { id, role: 'tooltip', 'aria-label': view.strings.cardPreview } },
    title,
    el('div', { className: 'card-preview-body' }, body),
  );
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Space between card and popup, and kept free at the window edges. */
const GAP = 8;
const MARGIN = 8;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Where the popup goes: right of the card, else left, else below, else above; never outside
 * the window (the stylesheet caps the size at 480px x 60% of the window height).
 */
export function placePreview(card: Rect, popup: Size, viewport: Size): { x: number; y: number; side: 'right' | 'left' | 'below' | 'above' } {
  const alongY = clamp(card.top, MARGIN, viewport.height - MARGIN - popup.height);
  const alongX = clamp(card.left, MARGIN, viewport.width - MARGIN - popup.width);
  if (card.right + GAP + popup.width <= viewport.width - MARGIN) return { x: card.right + GAP, y: alongY, side: 'right' };
  if (card.left - GAP - popup.width >= MARGIN) return { x: card.left - GAP - popup.width, y: alongY, side: 'left' };
  if (card.bottom + GAP + popup.height <= viewport.height - MARGIN) return { x: alongX, y: card.bottom + GAP, side: 'below' };
  if (card.top - GAP - popup.height >= MARGIN) return { x: alongX, y: card.top - GAP - popup.height, side: 'above' };
  // No free side (a very small window): below, kept inside the window.
  return { x: alongX, y: clamp(card.bottom + GAP, MARGIN, viewport.height - MARGIN - popup.height), side: 'below' };
}

export interface ChordKey {
  /** KeyboardEvent key value. */
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

const ctrlOnly = (event: ChordKey, code: string): boolean =>
  (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === code;

/**
 * Ctrl+K Ctrl+I on a selected card opens the preview (VS Code's "Show Hover" keys).
 * 'start': Ctrl+K on a card, held back from VS Code until the next key. With a chord
 * pending: 'open' for Ctrl+I, 'wait' for a lone modifier, otherwise 'replay' (VS Code gets
 * the held Ctrl+K and then this key, so its own Ctrl+K chords still work from a card).
 */
export function chordStep(pending: boolean, event: ChordKey, onCard: boolean): 'start' | 'open' | 'wait' | 'replay' | 'none' {
  const { key } = event;
  if (pending) {
    if (MODIFIERS.has(key)) return 'wait';
    return ctrlOnly(event, 'KeyI') ? 'open' : 'replay';
  }
  return onCard && ctrlOnly(event, 'KeyK') ? 'start' : 'none';
}
