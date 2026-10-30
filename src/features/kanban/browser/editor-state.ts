// Keeps an open inline editor across board redraws. A redraw (another tool saved the
// file, saveOnEdit, a stale refusal) replaces the DOM; the editor is reopened on the same
// card or lane only when its identity (index + exact source line) still matches, so a
// draft is never applied to a different card. DOM-free so it can be unit tested.
import type { CardIdentity } from '../model.ts';
import type { LaneIdentity } from '../operations.ts';
import type { BoardView } from '../view.ts';
import type { CardRef } from './interactions.ts';

export type EditorTarget =
  | { readonly kind: 'card'; readonly id: CardIdentity }
  | { readonly kind: 'lane'; readonly id: LaneIdentity }
  | { readonly kind: 'add'; readonly id: LaneIdentity };

export interface EditorSnapshot {
  readonly target: EditorTarget;
  readonly draft: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export type EditorLocation =
  | { readonly kind: 'card'; readonly ref: CardRef }
  | { readonly kind: 'lane' | 'add'; readonly lane: number };

/** Where to reopen the editor in `view`, or undefined when its card or lane no longer matches. */
export function locateEditor(view: BoardView, target: EditorTarget): EditorLocation | undefined {
  if (target.kind === 'card') {
    const { laneIndex, cardIndex, firstLine } = target.id;
    const card = view.lanes[laneIndex]?.cards[cardIndex];
    return card !== undefined && card.id.firstLine === firstLine ? { kind: 'card', ref: { lane: laneIndex, card: cardIndex } } : undefined;
  }
  const lane = view.lanes[target.id.laneIndex];
  return lane !== undefined && lane.id.heading === target.id.heading ? { kind: target.kind, lane: target.id.laneIndex } : undefined;
}

export function cardTarget(view: BoardView, ref: CardRef): EditorTarget | undefined {
  const card = view.lanes[ref.lane]?.cards[ref.card];
  return card && { kind: 'card', id: card.id };
}

export function laneTarget(view: BoardView, kind: 'lane' | 'add', lane: number): EditorTarget | undefined {
  const l = view.lanes[lane];
  return l && { kind, id: l.id };
}

// --- Add-card input (kanban.md 4.4.1) ---------------------------------------
// The input stays open after Enter so several cards can be added in a row. Its state
// survives redraws like an editor's; the card just added is found again in the new view
// and shown as selected.

/** A card add that was sent and not yet seen in a render. */
export interface PendingAdd {
  /** Title as sent (cleaned). */
  readonly text: string;
  /** Index the card was expected at (end of the lane when sent). */
  readonly index: number;
}

export interface AdderSnapshot {
  readonly lane: LaneIdentity;
  /** Insert position (kanban.md 4.6 insert before/after); undefined = end of the lane. */
  readonly index?: number;
  readonly draft: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly pending?: PendingAdd;
  /** The last card added in this run of input, by identity. */
  readonly lastAdded?: CardIdentity;
}

export interface AdderRestore {
  readonly lane: number;
  readonly index?: number;
  readonly draft: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** Still not seen in the view (e.g. the render came before a 'stale' refusal). */
  readonly pending?: PendingAdd;
  readonly lastAdded?: CardIdentity;
  /** Card to show as selected: the one just added. */
  readonly selected?: CardRef;
}

/**
 * The card a pending add produced: at the expected index with the sent title, or else
 * the last card in the lane with that title. Undefined when it is not in the view.
 */
export function findAddedCard(view: BoardView, lane: number, pending: PendingAdd): CardRef | undefined {
  const cards = view.lanes[lane]?.cards ?? [];
  if (cards[pending.index]?.title.trim() === pending.text) return { lane, card: pending.index };
  for (let i = cards.length - 1; i >= 0; i--) {
    if (cards[i]!.title.trim() === pending.text) return { lane, card: i };
  }
  return undefined;
}

/** Where to reopen the add input after a redraw, or undefined when its lane is gone. */
export function restoreAdder(view: BoardView, snap: AdderSnapshot): AdderRestore | undefined {
  const location = locateEditor(view, { kind: 'add', id: snap.lane });
  if (location === undefined || location.kind !== 'add') return undefined;
  const lane = location.lane;
  const base = {
    lane,
    draft: snap.draft,
    selectionStart: snap.selectionStart,
    selectionEnd: snap.selectionEnd,
    ...(snap.index === undefined ? {} : { index: Math.min(snap.index, view.lanes[lane]!.cards.length) }),
  };
  if (snap.pending) {
    const added = findAddedCard(view, lane, snap.pending);
    if (added) return { ...base, lastAdded: view.lanes[lane]!.cards[added.card]!.id, selected: added };
    return { ...base, pending: snap.pending, ...(snap.lastAdded ? { lastAdded: snap.lastAdded } : {}) };
  }
  if (snap.lastAdded) {
    const again = locateEditor(view, { kind: 'card', id: snap.lastAdded });
    if (again?.kind === 'card') return { ...base, lastAdded: snap.lastAdded, selected: again.ref };
  }
  return base;
}
