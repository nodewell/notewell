// Kanban board model (kanban.md section 2). Structure is described only by line
// indices into the source line texts (`lineTexts(doc)` from src/core/lines.ts);
// the model never holds rewritten text, so parsing alone cannot change the file.

import type { MarkerKind } from './blocks.ts';

/** Half-open line range: lines `start .. end - 1`. Empty when `start === end`. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The list marker of a card's first line (kanban.md 2.5). */
export interface CardMarker {
  /** `-`, `*`, `+`, or the ordered delimiter `.` / `)`. Each kind is its own list. */
  readonly kind: MarkerKind;
  /** Offset of the marker in the first line. */
  readonly start: number;
  /** Offset just after the marker. */
  readonly end: number;
  /** Ordered list number, or undefined for a bullet. */
  readonly number: number | undefined;
  /** Column a body line needs to be part of the card by indentation (CommonMark content column). */
  readonly contentColumn: number;
}

export interface KanbanCard {
  /** Index of the lane in `KanbanBoard.lanes`. */
  readonly laneIndex: number;
  /** Order of the card within its lane, from 0. */
  readonly index: number;
  /** First line through the last body line. The first line is `range.start`. */
  readonly range: LineRange;
  /**
   * Body lines (indented lines, lazy continuation lines and the blank lines between them):
   * `range.start + 1 .. range.end - 1`.
   */
  readonly body: LineRange;
  /** The check character between `[` and `]`, or null when the item has no check box. */
  readonly check: string | null;
  /** Checked: a check box whose character is not a space. */
  readonly checked: boolean;
  /** Offset of the check character in the first line (`- [x]` -> 3), or null without a check box. */
  readonly checkOffset: number | null;
  /** Offset in the first line where the title starts (after the marker, the check box and the spaces after them). */
  readonly titleOffset: number;
  readonly marker: CardMarker;
}

export interface KanbanLane {
  /** Index in `KanbanBoard.lanes`. Lanes are identified by index, never by name. */
  readonly index: number;
  /** First line of the heading (the ATX line, or a setext heading's first text line); equals `range.start`. */
  readonly headingLine: number;
  /** The heading lines: the ATX line, or a setext heading's text lines and underline. */
  readonly heading: LineRange;
  readonly headingKind: 'atx' | 'setext';
  /** Heading text (kanban.md 2.4): trimmed, without closing `#`s; setext lines joined by a space. Duplicates are allowed. */
  readonly name: string;
  /** Heading line up to the next lane, the archive, the settings block or the end. */
  readonly range: LineRange;
  /** One-line `**Complete**` paragraphs between the heading and the first list (kanban.md 2.7). */
  readonly completeMarkerLines: readonly number[];
  /** Whether the lane name is listed in `ParseOptions.doneLanes`. */
  readonly doneByName: boolean;
  /** Done lane: has a `**Complete**` line or is named in doneLanes (kanban.md 2.7). */
  readonly done: boolean;
  readonly cards: readonly KanbanCard[];
}

export interface KanbanSettingsBlock {
  /** `%% kanban:settings` line through the closing `%%` line. */
  readonly range: LineRange;
  /** Whether the JSON inside parsed to an object. Invalid JSON means "no settings". */
  readonly valid: boolean;
}

/** Settings values the board reads (read-only; the block is only preserved). */
export interface KanbanSettings {
  /** `list-collapse` from the settings block; [] when absent. Index = lane index. */
  readonly listCollapse: readonly boolean[];
  /** `date-format`: settings block, else frontmatter, else `YYYY-MM-DD`. */
  readonly dateFormat: string;
  /** `date-trigger`: settings block, else frontmatter, else `@` (date picker, kanban.md 4.8). */
  readonly dateTrigger: string;
  /** `time-trigger`: settings block, else frontmatter, else `@@` (time badges, kanban.md 3). */
  readonly timeTrigger: string;
  /** `link-date-to-daily-note`: dates written as links; the date picker is off then (4.8). */
  readonly linkDateToDailyNote: boolean;
  /**
   * `show-checkboxes` of this board (settings block, else frontmatter); undefined when the
   * board does not say, so the Kanban plugin's default applies (kanban.md 2.9).
   */
  readonly showCheckboxes: boolean | undefined;
  /**
   * `lane-width` of this board (settings block, else frontmatter) as `laneWidthValue` reads it:
   * px, null when set to something that is not a width, undefined when the board does not set
   * it, so the Kanban plugin's default applies (kanban.md 2.9).
   */
  readonly laneWidth: number | null | undefined;
  /** Where the board sets `lane-width`: the width slider writes and resets the block's member (4.10). */
  readonly laneWidthIn: { readonly block: boolean; readonly frontmatter: boolean };
}

export interface KanbanBoard {
  /** Frontmatter has a `kanban-plugin:` key (kanban.md 2.2). */
  readonly isBoard: boolean;
  readonly lineCount: number;
  /** `---` .. `---` lines, or null. */
  readonly frontmatter: LineRange | null;
  /** Lines before the first lane (after the frontmatter). May be empty. */
  readonly preamble: LineRange;
  readonly lanes: readonly KanbanLane[];
  /** Thematic break before the `Archive` heading .. before the settings block, or null. Preserved, not shown. */
  readonly archive: LineRange | null;
  readonly settingsBlock: KanbanSettingsBlock | null;
  /** Lines after the settings block (or empty at the end of the file). */
  readonly tail: LineRange;
  readonly settings: KanbanSettings;
}

/** What a webview request names to target a card (kanban.md 2.5). */
export interface CardIdentity {
  readonly laneIndex: number;
  readonly cardIndex: number;
  /** Exact text of the card's first line. */
  readonly firstLine: string;
}

export function cardTitle(texts: readonly string[], card: KanbanCard): string {
  return (texts[card.range.start] ?? '').slice(card.titleOffset);
}

export function cardIdentity(texts: readonly string[], card: KanbanCard): CardIdentity {
  return { laneIndex: card.laneIndex, cardIndex: card.index, firstLine: texts[card.range.start] ?? '' };
}

/** The card named by `id` if lane index, order and first line all still match; otherwise undefined. */
export function findCardByIdentity(
  board: KanbanBoard,
  texts: readonly string[],
  id: CardIdentity,
): KanbanCard | undefined {
  const card = board.lanes[id.laneIndex]?.cards[id.cardIndex];
  return card !== undefined && texts[card.range.start] === id.firstLine ? card : undefined;
}

export type SegmentKind = 'frontmatter' | 'preamble' | 'lane' | 'archive' | 'settings' | 'tail';

/** Top-level segments in file order, skipping absent/empty ones. They tile `0 .. lineCount`. */
export function boardSegments(board: KanbanBoard): { kind: SegmentKind; range: LineRange }[] {
  const out: { kind: SegmentKind; range: LineRange }[] = [];
  const push = (kind: SegmentKind, range: LineRange | null): void => {
    if (range !== null && range.end > range.start) out.push({ kind, range });
  };
  push('frontmatter', board.frontmatter);
  push('preamble', board.preamble);
  for (const lane of board.lanes) push('lane', lane.range);
  push('archive', board.archive);
  push('settings', board.settingsBlock?.range ?? null);
  push('tail', board.tail);
  return out;
}
