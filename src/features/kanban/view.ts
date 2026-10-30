// View model for the board webview (kanban.md 3). Pure and JSON-serializable: the
// webview renders only what is here, as text, and never sees raw markup semantics.
import { findFences } from '../../core/fences.ts';
import { findTokens } from '../../core/tokens.ts';
import { DEFAULT_DATE_TRIGGER, DEFAULT_TIME_TRIGGER, formatDate, isIsoDate, parseDate, parseTime } from './dates.ts';
import { datePickerEnabled, firstDateToken, hasLinkDate } from './card-dates.ts';
import { cardEditText } from './card-text.ts';
import { cardIdentity, cardTitle, type CardIdentity, type KanbanBoard, type KanbanCard } from './model.ts';
import type { LaneIdentity } from './operations.ts';

export type DateState = 'past' | 'today' | 'future';

type SegmentKind =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'italic'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'wikilink'; readonly target: string; readonly text: string }
  | { readonly kind: 'tag'; readonly text: string }
  /** `pick`: the card's first date token (kanban.md 4.8), which opens the date picker. */
  | { readonly kind: 'date'; readonly text: string; readonly iso: string; readonly state: DateState; readonly pick?: true }
  | { readonly kind: 'time'; readonly text: string }
  | { readonly kind: 'category'; readonly text: string }
  /** `[text](url)`: only the text is kept; links are not clickable (no external opening). */
  | { readonly kind: 'link'; readonly text: string };

/**
 * A display segment. `highlight` marks text inside `==...==` (kanban.md 3): the segment
 * keeps its own kind (bold, tag, ...) and is shown on a highlight background as well.
 */
export type Segment = SegmentKind & { readonly highlight?: true };

export interface BodyLineView {
  /** Nesting level below the card (0 = first level). */
  readonly depth: number;
  /** Line inside an indented code fence (or a fence marker): shown verbatim. */
  readonly code: boolean;
  readonly segments: readonly Segment[];
}

export interface CardView {
  readonly id: CardIdentity;
  readonly checked: boolean;
  /** Title text as written (first line after the check mark). */
  readonly title: string;
  /** Initial text of the multi-line card editor: title + body lines with one indent step removed (kanban.md 4.4). */
  readonly editText: string;
  readonly segments: readonly Segment[];
  /**
   * Body lines with content (blank lines left out), each as display segments. The board draws
   * the body as Markdown from `editText` (kanban.md 3); these give the line count, the fold
   * marker and, with `plainBody`, the line-by-line display.
   */
  readonly body: readonly BodyLineView[];
  /**
   * A body line is over the one-line display limits (kanban.md 2.10): the body is drawn line by
   * line as before, not as Markdown, so the board does not stall.
   */
  readonly plainBody?: true;
  /**
   * The card's first date token (kanban.md 4.8) as written, `@{...}`, and its date when it
   * reads as one; absent when the card has none.
   */
  readonly date?: { readonly token: string; readonly iso?: string };
  /** The card has no `@{...}` date but a daily note link date (`@[[...]]`): no date items (kanban.md 4.8). */
  readonly linkDate?: true;
}

export interface LaneView {
  readonly id: LaneIdentity;
  readonly name: string;
  readonly done: boolean;
  readonly collapsed: boolean;
  readonly cards: readonly CardView[];
}

/** UI strings, localized by the extension (vscode.l10n.t) and passed in. */
export interface ViewStrings {
  readonly addCard: string;
  readonly addCardPlaceholder: string;
  readonly done: string;
  readonly collapse: string;
  readonly expand: string;
  readonly toggleCard: string;
  /** Label of the multi-line card editor (whole card: title and body). */
  readonly editCard: string;
  readonly renameLane: string;
  readonly noLanes: string;
  readonly notABoard: string;
  readonly keyboardHelp: string;
  /** Accessible name of the "?" help button. */
  readonly keyboardHelpLabel: string;
  /** Card menu (kanban.md 4.6): the ⋯ button name and the items. */
  readonly cardMenu: string;
  /** "Open in text editor" (kanban.md 4.7). */
  readonly openInText: string;
  readonly duplicateCard: string;
  readonly insertCardBefore: string;
  readonly insertCardAfter: string;
  readonly moveToTop: string;
  readonly moveToBottom: string;
  readonly moveToLane: string;
  readonly deleteCard: string;
  /** Shown when the card or lane being edited no longer matches after the board was redrawn. */
  readonly editorTargetChanged: string;
  /** Shown when the extension rejects an edit as invalid (empty title, line break). */
  readonly invalidRequest: string;
  /** Shown when an operation would be unsafe on this file (e.g. an unclosed code fence). */
  readonly unsafeRequest: string;
  /** Card body fold toggle (kanban.md 3.2). */
  readonly collapseBody: string;
  readonly expandBody: string;
  /** Lane fold toggle in the lane header (kanban.md 3.2): names the next action. */
  readonly collapseLaneBodies: string;
  readonly expandLaneBodies: string;
  /** Folded body marker: line count, `{0}` is the number (plural; `bodyLine` for one). */
  readonly bodyLines: string;
  readonly bodyLine: string;
  /** Accessible name of the card preview popup (kanban.md 3.3). */
  readonly cardPreview: string;
  /** Date picker (kanban.md 4.8): menu items and the picker's buttons. */
  readonly addDate: string;
  readonly changeDate: string;
  readonly removeDate: string;
  readonly dateConfirm: string;
  readonly dateCancel: string;
  /** Check box switch in the toolbar (kanban.md 4.9); pressed while check boxes show. */
  readonly showCheckboxes: string;
  /** Width slider in the toolbar (kanban.md 4.10): its name, value text and tooltip (`{0}` is px). */
  readonly laneWidth: string;
  readonly laneWidthValue: string;
  readonly laneWidthTitle: string;
}

export const DEFAULT_STRINGS: ViewStrings = {
  addCard: 'Add card',
  addCardPlaceholder: 'Card title',
  done: 'Done',
  collapse: 'Collapse lane',
  expand: 'Expand lane',
  toggleCard: 'Toggle card',
  editCard: 'Edit card',
  renameLane: 'Rename lane',
  noLanes: 'This board has no lanes (headings).',
  notABoard: 'This file has no kanban-plugin frontmatter key.',
  keyboardHelp: 'Alt+Up/Down moves a card, Alt+Left/Right moves it to another lane, Space toggles, F2 or Enter edits, Ctrl+Enter opens it in the text editor, N adds a card, Shift+F10 opens the card menu, Delete deletes, Ctrl+Shift+[ / ] folds or unfolds the card body, Ctrl+K Ctrl+I shows the card preview.',
  keyboardHelpLabel: 'Keyboard shortcuts',
  cardMenu: 'Card actions',
  openInText: 'Open in text editor',
  duplicateCard: 'Duplicate card',
  insertCardBefore: 'Insert card before',
  insertCardAfter: 'Insert card after',
  moveToTop: 'Move to top',
  moveToBottom: 'Move to bottom',
  moveToLane: 'Move to lane',
  deleteCard: 'Delete card',
  editorTargetChanged: 'This card or lane changed while you were editing. Your text is kept below so you can copy it.',
  invalidRequest: 'The change was not applied: the text is empty or not allowed.',
  unsafeRequest: 'This change cannot be made safely on the board. Please edit the file as text.',
  collapseBody: 'Collapse card body',
  expandBody: 'Expand card body',
  collapseLaneBodies: 'Collapse all card bodies in this lane',
  expandLaneBodies: 'Expand all card bodies in this lane',
  bodyLines: '{0} lines',
  bodyLine: '1 line',
  cardPreview: 'Card preview',
  addDate: 'Add date',
  changeDate: 'Change date',
  removeDate: 'Remove date',
  dateConfirm: 'OK',
  dateCancel: 'Cancel',
  showCheckboxes: 'Show card checkboxes',
  laneWidth: 'Lane width',
  laneWidthValue: '{0} px',
  laneWidthTitle: 'Lane width: {0} px. Double-click for the default width.',
};

/** Default display of card bodies (kanban.md 3.2, setting notewell.kanban.cardBodies). */
export type CardBodies = 'expanded' | 'collapsed';

export interface BoardView {
  readonly isBoard: boolean;
  readonly lanes: readonly LaneView[];
  readonly strings: ViewStrings;
  /** Default fold state of card bodies; the webview keeps per-card overrides. */
  readonly cardBodies: CardBodies;
  /** Hover preview of cards with a body (kanban.md 3.3, setting notewell.kanban.cardPreview). */
  readonly cardPreview: boolean;
  /**
   * Board date format and today's date, so the webview can read tokens in the preview text
   * with the same rules as the board (lineSegments).
   */
  readonly dateFormat: string;
  readonly today: string;
  /** Board `date-trigger` and `time-trigger` (kanban.md 3), for the same reason. */
  readonly dateTrigger: string;
  readonly timeTrigger: string;
  /**
   * Date picker on (kanban.md 4.8): off when the board's date-trigger is not `@` or dates
   * are linked to daily notes.
   */
  readonly datePicker: boolean;
  /**
   * Cards show check boxes (kanban.md 2.9): the board's `show-checkboxes`, else the Kanban
   * plugin's default, else off as in Obsidian. Space still toggles a card without one.
   */
  readonly showCheckboxes: boolean;
  /** The board has a readable settings block, so the check box switch can write it (4.9). */
  readonly checkboxSwitch: boolean;
  /**
   * Lane width in px (kanban.md 2.9): the board's `lane-width`, else the Kanban plugin's
   * default, else Obsidian's 272px. Collapsed lanes keep their own width.
   */
  readonly laneWidth: number;
  /**
   * The width slider shows (4.10): a readable settings block to write, and no `lane-width` in
   * the frontmatter (Obsidian would keep using that one).
   */
  readonly laneWidthSlider: boolean;
  /** The settings block has its own `lane-width`, which the slider's reset removes (4.10). */
  readonly laneWidthSet: boolean;
}

/** Obsidian Kanban's own lane width (`--lane-width: 272px` in its styles). */
export const DEFAULT_LANE_WIDTH = 272;

export interface ViewOptions {
  /** Today's local date as `YYYY-MM-DD`, for due-date states. */
  readonly today: string;
  readonly strings?: ViewStrings;
  readonly cardBodies?: CardBodies;
  /** Default true. */
  readonly cardPreview?: boolean;
  /** The Kanban plugin's `show-checkboxes` (data.json), for boards that do not set it. */
  readonly showCheckboxesDefault?: boolean;
  /** The Kanban plugin's `lane-width` (data.json) for boards that do not set it; null: not a width. */
  readonly laneWidthDefault?: number | null;
}

export interface LineContext {
  readonly dateFormat: string;
  readonly today: string;
  /** Prefix of date tokens, `<trigger>{date}` and `<trigger>[[date]]`; default `@` (kanban.md 3). */
  readonly dateTrigger?: string;
  /** Prefix of time tokens, `<trigger>{HH:mm}`; default `@@` (kanban.md 3). */
  readonly timeTrigger?: string;
}

function dateSegment(iso: string, ctx: LineContext): Segment {
  const state: DateState = iso < ctx.today ? 'past' : iso === ctx.today ? 'today' : 'future';
  return { kind: 'date', text: formatDate(iso, ctx.dateFormat), iso, state };
}

interface Matcher {
  readonly pattern: RegExp;
  readonly make: (match: RegExpExecArray, ctx: LineContext) => Segment;
}

const FORMAT_MATCHERS: readonly Matcher[] = [
  { pattern: /\*\*(?=\S)(.+?)(?<=\S)\*\*/, make: (m) => ({ kind: 'bold', text: m[1]! }) },
  { pattern: /\*(?=[^*\s])([^*]+?)(?<=\S)\*/, make: (m) => ({ kind: 'italic', text: m[1]! }) },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The board's date trigger for display; an empty one reads as the default `@`. */
function dateTriggerOf(ctx: LineContext): string {
  return ctx.dateTrigger || DEFAULT_DATE_TRIGGER;
}

// A date is `<date-trigger>{…}` (`@{2026-10-20}` by default) and a time `<time-trigger>{HH:mm}`
// (`@@{09:30}`), as Obsidian Kanban reads them; with other triggers `@{…}` stays text, and so
// does a time written with the date trigger (`@{09:30}`). A time that does not read as HH:mm
// stays text too: Obsidian reads `@@{2026-10-22}` loosely as 20:26 (kanban.md 3).
const triggerMatchers = new Map<string, readonly Matcher[]>();

/**
 * Applied to text between core tokens (links, tags, inline code), earliest match first; on a
 * tie the earlier matcher wins, so a date beats a time when both triggers are the same.
 */
function matchersFor(ctx: LineContext): readonly Matcher[] {
  const dateTrigger = dateTriggerOf(ctx);
  const timeTrigger = ctx.timeTrigger || DEFAULT_TIME_TRIGGER;
  const id = JSON.stringify([dateTrigger, timeTrigger]);
  let matchers = triggerMatchers.get(id);
  if (matchers === undefined) {
    const date: Matcher = {
      pattern: new RegExp(`${escapeRegExp(dateTrigger)}\\{([^{}]+)\\}`),
      make: (m, c) => {
        const iso = parseDate(m[1]!, c.dateFormat);
        return iso !== undefined ? dateSegment(iso, c) : { kind: 'text', text: m[0] };
      },
    };
    const time: Matcher = {
      pattern: new RegExp(`${escapeRegExp(timeTrigger)}\\{([^{}]+)\\}`),
      make: (m) => {
        const value = parseTime(m[1]!);
        return value !== undefined ? { kind: 'time', text: value } : { kind: 'text', text: m[0] };
      },
    };
    matchers = [date, time, ...FORMAT_MATCHERS];
    if (triggerMatchers.size < 16) triggerMatchers.set(id, matchers);
  }
  return matchers;
}

/**
 * `base` is the offset of `text` in the line; a date segment that starts at `pickAt` (in the
 * line) is marked as the card's date token.
 */
function inlineSegments(text: string, ctx: LineContext, out: Segment[], base = 0, pickAt?: number): void {
  const matchers = matchersFor(ctx);
  let rest = text;
  while (rest.length > 0) {
    let best: { match: RegExpExecArray; matcher: Matcher } | undefined;
    for (const matcher of matchers) {
      const match = matcher.pattern.exec(rest);
      if (match !== null && (best === undefined || match.index < best.match.index)) best = { match, matcher };
    }
    if (best === undefined) {
      out.push({ kind: 'text', text: rest });
      return;
    }
    if (best.match.index > 0) out.push({ kind: 'text', text: rest.slice(0, best.match.index) });
    const segment = best.matcher.make(best.match, ctx);
    const at = base + text.length - rest.length + best.match.index;
    out.push(segment.kind === 'date' && at === pickAt ? { ...segment, pick: true } : segment);
    rest = rest.slice(best.match.index + best.match[0].length);
  }
}

function mergeText(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const prev = out[out.length - 1];
    if (segment.kind === 'text' && prev?.kind === 'text' && prev.highlight === segment.highlight) {
      out[out.length - 1] = { ...prev, text: prev.text + segment.text };
    } else if (segment.kind !== 'text' || segment.text !== '') {
      out.push(segment);
    }
  }
  return out;
}

/**
 * `==...==` ranges (start of the opening marker, end of the closing one). Markers inside
 * inline code or wikilinks do not count; pairs need non-blank content; an unpaired `==`
 * stays text.
 */
function highlightRanges(text: string): [number, number][] {
  const blocked = findTokens(text).filter((t) => t.kind === 'code' || t.kind === 'wikilink' || t.kind === 'mdlink');
  const markers: number[] = [];
  for (let i = text.indexOf('=='); i !== -1; ) {
    if (blocked.some((t) => i < t.end && i + 2 > t.start)) {
      i = text.indexOf('==', i + 1);
    } else {
      markers.push(i);
      i = text.indexOf('==', i + 2);
    }
  }
  const ranges: [number, number][] = [];
  for (let k = 0; k + 1 < markers.length; ) {
    const open = markers[k]!;
    const close = markers[k + 1]!;
    if (text.slice(open + 2, close).trim() === '') {
      k += 1;
      continue;
    }
    ranges.push([open, close + 2]);
    k += 2;
  }
  return ranges;
}

// `[category]` at the start of a title; not a link `[x](...)`, wikilink or Dataview field.
const CATEGORY = /^\[([^[\]]+)\](?=\s|$)/;

/**
 * Beyond these a line is shown as plain text: formatting a very long line, or drawing tens of
 * thousands of badges, would stall the board (and the DOM takes children as call arguments).
 */
export const MAX_FORMATTED_LINE = 10_000;
export const MAX_SEGMENTS = 2_000;

/**
 * Splits one line of card text into display segments (kanban.md 3). `pickAt`: offset in
 * `text` of the card's first date token, whose badge opens the date picker (4.8).
 */
export function lineSegments(text: string, ctx: LineContext, category = false, pickAt?: number): Segment[] {
  if (text.length > MAX_FORMATTED_LINE) return [{ kind: 'text', text }];
  const segments = formattedSegments(text, ctx, category, pickAt);
  return segments.length > MAX_SEGMENTS ? [{ kind: 'text', text }] : segments;
}

function formattedSegments(text: string, ctx: LineContext, category: boolean, pickAt: number | undefined): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  let base = 0;
  if (category) {
    const match = CATEGORY.exec(text);
    if (match !== null && !match[1]!.includes('::')) {
      out.push({ kind: 'category', text: match[1]! });
      rest = text.slice(match[0].length);
      base = match[0].length;
    }
  }
  // Highlighted parts are segmented on their own and flagged; markers are not shown.
  let from = 0;
  for (const [start, end] of highlightRanges(rest)) {
    plainSegments(rest.slice(from, start), ctx, out, base + from, pickAt);
    const inner: Segment[] = [];
    plainSegments(rest.slice(start + 2, end - 2), ctx, inner, base + start + 2, pickAt);
    for (const segment of inner) out.push({ ...segment, highlight: true });
    from = end;
  }
  plainSegments(rest.slice(from), ctx, out, base + from, pickAt);
  return mergeText(out);
}

/** Tokens and inline formatting of a text without highlight markers, appended to `out`. */
function plainSegments(text: string, ctx: LineContext, out: Segment[], base = 0, pickAt?: number): void {
  let from = 0;
  const tokens = findTokens(text);
  for (const token of tokens) {
    let gapEnd = token.start;
    let segment: Segment;
    if (token.kind === 'code') {
      segment = { kind: 'code', text: token.content };
    } else if (token.kind === 'tag') {
      segment = { kind: 'tag', text: `#${token.name}` };
    } else if (token.kind === 'mdlink') {
      // Only the text is shown; an embed keeps its `!` as text, as before.
      if (token.embed) {
        inlineSegments(text.slice(from, gapEnd), ctx, out, base + from, pickAt);
        out.push({ kind: 'text', text: '!' });
        from = token.start + 1;
      }
      segment = { kind: 'link', text: token.text };
    } else {
      // A daily note link date: the date trigger right before `[[…]]` (`@[[2026-10-20]]`).
      const trigger = dateTriggerOf(ctx);
      const iso = !token.embed && text.startsWith(trigger, token.start - trigger.length) && token.start - trigger.length >= from
        ? parseDate(token.target, ctx.dateFormat)
        : undefined;
      if (iso !== undefined) {
        gapEnd = token.start - trigger.length;
        segment = dateSegment(iso, ctx);
      } else {
        segment = { kind: 'wikilink', target: token.target, text: token.alias ?? token.target };
      }
    }
    inlineSegments(text.slice(from, gapEnd), ctx, out, base + from, pickAt);
    out.push(segment);
    from = token.end;
  }
  inlineSegments(text.slice(from), ctx, out, base + from, pickAt);
}

function indentWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === '\t') width += 4;
    else if (ch === ' ') width += 1;
    else break;
  }
  return width;
}

/**
 * `pick`: line and offset of the card's first date token, when its badge opens the picker.
 * `plain`: a line is over the one-line display limits (kanban.md 2.10).
 */
function bodyLines(
  texts: readonly string[],
  card: KanbanCard,
  ctx: LineContext,
  pick?: { line: number; start: number },
): { lines: BodyLineView[]; plain: boolean } {
  const fenced = new Set<number>();
  for (const block of findFences(texts, card.body.start, card.body.end)) {
    for (let i = block.open; i <= block.last; i++) fenced.add(i);
  }
  const lines: BodyLineView[] = [];
  let plain = false;
  for (let i = card.body.start; i < card.body.end; i++) {
    const text = texts[i]!;
    const depth = Math.min(3, Math.max(0, Math.ceil(indentWidth(text) / 4) - 1));
    if (text.length > MAX_FORMATTED_LINE) plain = true;
    if (fenced.has(i)) {
      lines.push({ depth, code: true, segments: [{ kind: 'text', text: text.trimStart() }] });
    } else if (text.trim() !== '') {
      const indent = text.length - text.trimStart().length;
      const pickAt = pick?.line === i ? pick.start - indent : undefined;
      const trimmed = text.trim();
      const formatted = trimmed.length > MAX_FORMATTED_LINE ? undefined : formattedSegments(trimmed, ctx, false, pickAt);
      if (formatted === undefined || formatted.length > MAX_SEGMENTS) plain = true;
      const segments = formatted === undefined || formatted.length > MAX_SEGMENTS ? [{ kind: 'text' as const, text: trimmed }] : formatted;
      lines.push({ depth, code: false, segments });
    }
  }
  return { lines, plain };
}

export function buildBoardView(texts: readonly string[], board: KanbanBoard, options: ViewOptions): BoardView {
  if (!isIsoDate(options.today)) throw new Error('today must be YYYY-MM-DD');
  const ctx: LineContext = {
    dateFormat: board.settings.dateFormat,
    today: options.today,
    dateTrigger: board.settings.dateTrigger,
    timeTrigger: board.settings.timeTrigger,
  };
  const datePicker = datePickerEnabled(board.settings);
  return {
    datePicker,
    showCheckboxes: board.settings.showCheckboxes ?? options.showCheckboxesDefault ?? false,
    checkboxSwitch: board.settingsBlock?.valid === true,
    laneWidth: (board.settings.laneWidth === undefined ? options.laneWidthDefault : board.settings.laneWidth) ?? DEFAULT_LANE_WIDTH,
    laneWidthSlider: board.settingsBlock?.valid === true && !board.settings.laneWidthIn.frontmatter,
    laneWidthSet: board.settings.laneWidthIn.block,
    isBoard: board.isBoard,
    strings: options.strings ?? DEFAULT_STRINGS,
    cardBodies: options.cardBodies === 'collapsed' ? 'collapsed' : 'expanded',
    cardPreview: options.cardPreview !== false,
    dateFormat: ctx.dateFormat,
    today: ctx.today,
    dateTrigger: board.settings.dateTrigger,
    timeTrigger: board.settings.timeTrigger,
    lanes: board.lanes.map((lane) => ({
      id: { laneIndex: lane.index, heading: texts[lane.headingLine] ?? '' },
      name: lane.name,
      done: lane.done,
      collapsed: board.settings.listCollapse[lane.index] === true,
      cards: lane.cards.map((card) => {
        const title = cardTitle(texts, card);
        const token = firstDateToken(texts, card);
        const iso = token && parseDate(token.value, ctx.dateFormat);
        // Only the first token's badge opens the picker (kanban.md 4.8).
        const pick = datePicker ? token : undefined;
        const titlePick = pick?.line === card.range.start ? pick.start - card.titleOffset : undefined;
        const body = bodyLines(texts, card, ctx, pick);
        return {
          id: cardIdentity(texts, card),
          checked: card.checked,
          title,
          editText: cardEditText(texts, card),
          segments: lineSegments(title, ctx, true, titlePick),
          body: body.lines,
          ...(body.plain ? { plainBody: true as const } : {}),
          ...(token === undefined ? {} : { date: { token: token.text, ...(iso === undefined ? {} : { iso }) } }),
          ...(token === undefined && hasLinkDate(texts, card) ? { linkDate: true as const } : {}),
        };
      }),
    })),
  };
}
