// Card body folding (kanban.md 3.2): which card bodies are folded. View state only: it is
// kept in the webview state (vscode.setState), never in the file or the original tool's
// settings. Cards are remembered by their first line after the check mark, so a fold follows
// a moved card and a changed first line falls back to the board default. Pure, for node:test.
import type { BoardView, CardView, LaneView } from '../view.ts';

export interface BodyFolds {
  /** Board default set by "Collapse/Expand All Card Bodies"; undefined = the setting. */
  readonly defaultFolded?: boolean;
  /** Per-card overrides of the default, by first line. */
  readonly cards: ReadonlyMap<string, boolean>;
}

/** JSON form kept in the webview state. */
export interface StoredBodyFolds {
  readonly defaultFolded?: boolean;
  readonly cards: readonly (readonly [string, boolean])[];
}

export const NO_FOLDS: BodyFolds = { cards: new Map() };

/** Overrides kept at most (oldest dropped first); a board shows far fewer cards. */
const MAX_ENTRIES = 5_000;

export function foldKey(card: CardView): string {
  return card.title;
}

function boardDefault(folds: BodyFolds, view: BoardView): boolean {
  return folds.defaultFolded ?? view.cardBodies === 'collapsed';
}

/** Whether the card's body is folded. Cards without a body are never folded. */
export function isFolded(folds: BodyFolds, view: BoardView, card: CardView): boolean {
  if (card.body.length === 0) return false;
  return folds.cards.get(foldKey(card)) ?? boardDefault(folds, view);
}

/** Folds or unfolds one card; an override equal to the default is dropped. */
export function setFolded(folds: BodyFolds, view: BoardView, card: CardView, folded: boolean): BodyFolds {
  const cards = new Map(folds.cards);
  const key = foldKey(card);
  cards.delete(key);
  if (folded !== boardDefault(folds, view)) cards.set(key, folded);
  while (cards.size > MAX_ENTRIES) cards.delete(cards.keys().next().value!);
  return { ...folds, cards };
}

/** The lane has a card with a body: only then does its header show the lane fold toggle. */
export function laneHasBodies(lane: LaneView): boolean {
  return lane.cards.some((card) => card.body.length > 0);
}

/**
 * What the lane fold toggle does next (kanban.md 3.2 "lane fold"): fold every body when any
 * body in the lane is expanded, else unfold them all.
 */
export function laneFoldAction(folds: BodyFolds, view: BoardView, lane: LaneView): 'fold' | 'unfold' {
  return lane.cards.some((card) => card.body.length > 0 && !isFolded(folds, view, card)) ? 'fold' : 'unfold';
}

/** Folds or unfolds every card body in the lane; the result is kept per card. */
export function setLaneFolded(folds: BodyFolds, view: BoardView, lane: LaneView, folded: boolean): BodyFolds {
  let next = folds;
  for (const card of lane.cards) {
    if (card.body.length > 0) next = setFolded(next, view, card, folded);
  }
  return next;
}

/** "Collapse/Expand All": per-card states are forgotten and the board default changes. */
export function foldAll(folded: boolean): BodyFolds {
  return { defaultFolded: folded, cards: new Map() };
}

/** Drops overrides of cards no longer on the board (an edited first line starts over). */
export function pruneFolds(folds: BodyFolds, view: BoardView): BodyFolds {
  const present = new Set(view.lanes.flatMap((lane) => lane.cards.map(foldKey)));
  const cards = new Map([...folds.cards].filter(([key]) => present.has(key)));
  return cards.size === folds.cards.size ? folds : { ...folds, cards };
}

export function storeFolds(folds: BodyFolds): StoredBodyFolds {
  return { ...(folds.defaultFolded === undefined ? {} : { defaultFolded: folds.defaultFolded }), cards: [...folds.cards] };
}

/** Reads the stored form back; anything malformed is ignored. */
export function restoreFolds(raw: unknown): BodyFolds {
  if (typeof raw !== 'object' || raw === null) return NO_FOLDS;
  const { defaultFolded, cards } = raw as { defaultFolded?: unknown; cards?: unknown };
  const map = new Map<string, boolean>();
  if (Array.isArray(cards)) {
    for (const entry of cards.slice(-MAX_ENTRIES)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') map.set(entry[0], entry[1]);
    }
  }
  return { ...(typeof defaultFolded === 'boolean' ? { defaultFolded } : {}), cards: map };
}

/**
 * Ctrl+Shift+[ folds and Ctrl+Shift+] unfolds the selected card's body, as VS Code folds
 * code (kanban.md 3.2). By physical key, so keyboard layouts and Shift do not matter.
 */
export function bodyFoldShortcut(event: {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): 'fold' | 'unfold' | undefined {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return undefined;
  if (event.code === 'BracketLeft') return 'fold';
  if (event.code === 'BracketRight') return 'unfold';
  return undefined;
}

/** "⋯ 3 lines" marker text of a folded body. */
export function foldedLabel(count: number, plural: string, one: string): string {
  return count === 1 ? one : plural.replace('{0}', String(count));
}
