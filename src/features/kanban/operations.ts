// Board operations (kanban.md 4) as line operations for the core patch engine. Every
// operation targets cards and lanes by identity (kanban.md 2.5) and refuses when the
// identity no longer matches the document, so the caller can redraw instead of guessing.

import type { Eol } from '../../core/lines.ts';
import type { ExpectedLine, LineOperation, PatchRequest } from '../../core/patch.ts';
import { findFences } from '../../core/fences.ts';
import { computeJsonPatch, parseJson } from '../../core/json-positions.ts';
import {
  datePickerEnabled,
  dateLineOf,
  endsWithTableRow,
  firstDateToken,
  hasLinkDate,
  leavesCommentOpen,
  textStartOf,
  withAddedDate,
  withChangedDate,
  withRemovedDate,
} from './card-dates.ts';
import { indentColumns, isParagraphText, startsBlockInList } from './blocks.ts';
import { cardEditText, decodeBodyLine, encodeBodyLine, indentUnitFor } from './card-text.ts';
import { formatDate, isIsoDate } from './dates.ts';
import { LIMITS } from './messages.ts';
import { findCardByIdentity, type CardIdentity, type KanbanBoard, type KanbanCard, type KanbanLane } from './model.ts';
import { parseBoard } from './parser.ts';

/** What a webview request names to target a lane: index plus the exact heading line. */
export interface LaneIdentity {
  readonly laneIndex: number;
  /** Exact text of the heading line (a setext heading's first text line, kanban.md 2.4). */
  readonly heading: string;
}

/**
 * Board requests as plain values (shared with the webview messages).
 * - `moveCard.toIndex` and `moveLane.toIndex` are final positions: the index the card or
 *   lane has after the move, counted without the moved item.
 * - `addCard.index` defaults to the end of the lane.
 * - `editCardText.text` is the whole card as edit text (kanban.md 4.4, see card-text.ts):
 *   lines separated by LF, first line = title, others = body without one indentation step.
 * - `setCardDate.date` is an ISO date (`YYYY-MM-DD`), written in the board's date format
 *   (kanban.md 4.8). `token` is the card's first date token as the board showed it: given,
 *   that token is changed; absent, the card must have none and the date is added.
 * - `removeCardDate.token` is the first date token as the board showed it.
 * - `setShowCheckboxes.value` is written as the board's `show-checkboxes` in its settings
 *   block (kanban.md 4.9), as Obsidian's "Display card checkbox" switch writes it.
 * - `setLaneWidth.value` is written as the board's `lane-width` (px, an integer in the slider's
 *   range) in its settings block (kanban.md 4.10); absent, the member is removed, as Obsidian's
 *   "List width" reset does.
 */
export type BoardRequest =
  | { readonly kind: 'toggleCard'; readonly card: CardIdentity }
  | { readonly kind: 'editCardText'; readonly card: CardIdentity; readonly text: string }
  | { readonly kind: 'deleteCard'; readonly card: CardIdentity }
  | { readonly kind: 'duplicateCard'; readonly card: CardIdentity }
  | { readonly kind: 'moveCard'; readonly card: CardIdentity; readonly toLane: LaneIdentity; readonly toIndex: number }
  | { readonly kind: 'addCard'; readonly lane: LaneIdentity; readonly index?: number; readonly title: string }
  | { readonly kind: 'moveLane'; readonly lane: LaneIdentity; readonly toIndex: number }
  | { readonly kind: 'renameLane'; readonly lane: LaneIdentity; readonly name: string }
  | { readonly kind: 'setCardDate'; readonly card: CardIdentity; readonly date: string; readonly token?: string }
  | { readonly kind: 'removeCardDate'; readonly card: CardIdentity; readonly token: string }
  | { readonly kind: 'setShowCheckboxes'; readonly value: boolean }
  | { readonly kind: 'setLaneWidth'; readonly value?: number };

/**
 * - `stale`: a card or lane identity no longer matches; redraw from the current document.
 * - `invalid`: the request itself is unusable (bad index, empty title, line break).
 * - `unsafe`: the edit would change the board structure beyond the request, for example
 *   lines inserted after an unclosed code fence would become part of it. Nothing is changed.
 */
export type BoardRequestFailure = 'stale' | 'invalid' | 'unsafe';

export interface PlanOptions {
  /** Vault `useTab` (core.md 3.2): indentation for new body lines when the card has none yet. Default true. */
  readonly useTab?: boolean;
  /** Line ending of each line (same indices as `texts`); lets duplicated lines keep theirs. */
  readonly eols?: readonly Eol[];
}

export type BoardPlan =
  | ({ readonly ok: true } & Omit<PatchRequest, 'expectedVersion'>)
  | { readonly ok: false; readonly reason: BoardRequestFailure; readonly message: string };

class RequestError extends Error {
  readonly reason: BoardRequestFailure;
  constructor(reason: BoardRequestFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Line operations and expected lines for one request. Pass them with the document version
 * to `computePatch`. Lines the request does not target are never part of an operation.
 */
export function planBoardRequest(
  texts: readonly string[],
  board: KanbanBoard,
  request: BoardRequest,
  options: PlanOptions = {},
): BoardPlan {
  try {
    const plan = planOrThrow(texts, board, request, options);
    checkStructure(texts, board, request, plan.operations);
    return { ok: true, ...plan };
  } catch (error) {
    if (error instanceof RequestError) return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
}

interface Plan {
  operations: LineOperation[];
  expectedLines: ExpectedLine[];
}

function planOrThrow(texts: readonly string[], board: KanbanBoard, request: BoardRequest, options: PlanOptions): Plan {
  switch (request.kind) {
    case 'toggleCard':
      return toggleCard(texts, board, request.card);
    case 'editCardText':
      return editCardText(texts, board, request.card, request.text, options.useTab ?? true);
    case 'deleteCard':
      return deleteCard(texts, board, request.card);
    case 'duplicateCard':
      return duplicateCard(texts, board, request.card, options.eols);
    case 'moveCard':
      return moveCard(texts, board, request.card, request.toLane, request.toIndex);
    case 'addCard':
      return addCard(texts, board, request.lane, request.index, request.title);
    case 'moveLane':
      return moveLane(texts, board, request.lane, request.toIndex);
    case 'renameLane':
      return renameLane(texts, board, request.lane, request.name);
    case 'setCardDate':
      return setCardDate(texts, board, request.card, request.date, request.token, options.useTab ?? true);
    case 'removeCardDate':
      return removeCardDate(texts, board, request.card, request.token);
    case 'setShowCheckboxes':
      return setSetting(texts, board, 'show-checkboxes', request.value);
    case 'setLaneWidth':
      return setLaneWidth(texts, board, request.value);
  }
}

// --- lookups and checks ---

function findCard(texts: readonly string[], board: KanbanBoard, id: CardIdentity): KanbanCard {
  const card = findCardByIdentity(board, texts, id);
  if (card === undefined) throw new RequestError('stale', `card ${id.laneIndex}/${id.cardIndex} changed`);
  return card;
}

function findLane(texts: readonly string[], board: KanbanBoard, id: LaneIdentity): KanbanLane {
  const lane = board.lanes[id.laneIndex];
  if (lane === undefined || texts[lane.headingLine] !== id.heading) {
    throw new RequestError('stale', `lane ${id.laneIndex} changed`);
  }
  return lane;
}

function checkIndex(index: number, max: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new RequestError('invalid', `${what} ${index} is outside 0..${max}`);
  }
}

// Never written from the board: control characters other than tab (some tools read them as
// binary or as line breaks), and line separators.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * A typed line must not change the board around it: no control characters, and no comment
 * left open (Obsidian reads an unclosed `%%` or `<!--` as a comment up to the end of the
 * file, which would hide the lanes and the settings after it).
 */
function checkTypedLine(line: string, what: string): void {
  if (CONTROL.test(line)) throw new RequestError('invalid', `${what} must not contain control characters`);
  const percent = line.match(/%%/g)?.length ?? 0;
  if (percent % 2 === 1 || line.lastIndexOf('<!--') > line.lastIndexOf('-->')) {
    throw new RequestError('invalid', `${what} must not open a comment it does not close`);
  }
}

/** Titles and lane names: one line, trimmed, not empty. */
function cleanText(value: string, what: string): string {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new RequestError('invalid', `${what} must be a single line`);
  }
  checkTypedLine(value, what);
  const trimmed = value.trim();
  if (trimmed === '') throw new RequestError('invalid', `${what} must not be empty`);
  return trimmed;
}

function rangeLines(texts: readonly string[], start: number, end: number): ExpectedLine[] {
  const out: ExpectedLine[] = [];
  for (let line = start; line < end; line++) out.push({ line, text: texts[line] });
  return out;
}

/**
 * The first line with the check character set (kanban.md 2.7). A card without a check box gets
 * `[x] ` after the marker when checked and stays as it is when unchecked; an empty card has no
 * text a check box could go before, so it is left unchanged.
 */
function withCheck(firstLine: string, card: KanbanCard, check: ' ' | 'x'): string {
  const at = card.checkOffset;
  if (at !== null) return firstLine.slice(0, at) + check + firstLine.slice(at + 1);
  if (check === ' ' || firstLine.slice(card.titleOffset).trim() === '') return firstLine;
  return `${firstLine.slice(0, card.titleOffset)}[x] ${firstLine.slice(card.titleOffset)}`;
}

/**
 * The marker the card gets as card `index` of `cards` (kanban.md 4.1 "marker matching"): its own
 * when the lane's list has the same kind, else the lane's bullet, or for an ordered list the
 * card before it plus one (the card after it at the front), with that list's delimiter. A lane
 * without cards gets `-`.
 */
function matchedMarker(texts: readonly string[], cards: readonly KanbanCard[], index: number, own?: KanbanCard): string {
  const before = cards[index - 1];
  const after = cards[index];
  const near = before ?? after;
  if (near === undefined) return '-';
  if (own !== undefined && own.marker.kind === near.marker.kind) return markerText(texts, own);
  const { kind } = near.marker;
  if (kind !== '.' && kind !== ')') return kind;
  const number = before !== undefined ? (before.marker.number ?? 0) + 1 : (after!.marker.number ?? 1);
  return `${number > 999999999 ? 1 : number}${kind}`;
}

function markerText(texts: readonly string[], card: KanbanCard): string {
  return texts[card.range.start].slice(card.marker.start, card.marker.end);
}

/** Leading spaces for a new card line: those of the card it goes before, else the card before it. */
function markerIndent(texts: readonly string[], cards: readonly KanbanCard[], index: number): string {
  const near = cards[index] ?? cards[index - 1];
  return near === undefined ? '' : texts[near.range.start].slice(0, near.marker.start);
}

// --- card operations ---

function toggleCard(texts: readonly string[], board: KanbanBoard, id: CardIdentity): Plan {
  const card = findCard(texts, board, id);
  const line = card.range.start;
  const next = withCheck(texts[line], card, card.checked ? ' ' : 'x');
  if (next === texts[line]) throw new RequestError('invalid', 'an empty card has no check box to toggle');
  return {
    operations: [{ kind: 'replace', start: line, end: line + 1, lines: [next] }],
    expectedLines: [{ line, text: texts[line] }],
  };
}

/** Edit text split into lines: no CR, trailing blank lines dropped, first line not blank. */
function editLines(text: string): string[] {
  if (typeof text !== 'string' || text.includes('\r')) throw new RequestError('invalid', 'card text must not contain CR');
  const lines = text.split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines[0].trim() === '') throw new RequestError('invalid', 'card title must not be empty');
  return lines;
}

/** Index pairs of a longest common subsequence of two line lists, in order. */
function commonLines(a: readonly string[], b: readonly string[]): [number, number][] {
  const cols = b.length + 1;
  const table = new Array<number>((a.length + 1) * cols).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * kanban.md 4.4: the title changes after the check mark only; body lines the user did not
 * change keep their original bytes (matched by a line diff of the decoded text), and only
 * changed or new lines are written, with the card's indentation step.
 */
function editCardText(texts: readonly string[], board: KanbanBoard, id: CardIdentity, text: string, useTab: boolean): Plan {
  const card = findCard(texts, board, id);
  const current = cardEditText(texts, card);
  if (text === current) return { operations: [], expectedLines: [] };
  const lines = editLines(text);
  // Lines the card already had are kept as they are; new or changed lines are checked.
  const existing = new Set(current.split('\n'));
  for (const line of lines) if (!existing.has(line)) checkTypedLine(line, 'card text');
  const operations: LineOperation[] = [];
  const first = card.range.start;
  if (lines[0] !== texts[first].slice(card.titleOffset)) {
    // An empty card (`- [ ]`, `-`) has no space before its title yet.
    const prefix = texts[first].slice(0, card.titleOffset);
    const title = (/[ \t]$/.test(prefix) ? prefix : `${prefix} `) + lines[0].trim();
    operations.push({ kind: 'replace', start: first, end: first + 1, lines: [title] });
  }
  const oldBody = texts.slice(card.body.start, card.body.end).map(decodeBodyLine);
  const newBody = lines.slice(1);
  const unit = indentUnitFor(texts, card, useTab);
  // A lazy continuation line (kanban.md 2.5) stays in the card only right after paragraph
  // text; one that would not is written again with the indentation step.
  const lazyKept = ([oldIndex, newIndex]: [number, number]): boolean => {
    const raw = texts[card.body.start + oldIndex];
    if (raw.trim() === '' || indentColumns(raw) >= card.marker.contentColumn) return true;
    const before = newIndex === 0 ? lines[0] : newBody[newIndex - 1];
    return before.trim() !== '' && isParagraphText(before);
  };
  // Unchanged lines are anchors; each gap between anchors becomes one operation.
  const anchors: [number, number][] = [...commonLines(oldBody, newBody).filter(lazyKept), [oldBody.length, newBody.length]];
  let oldAt = 0;
  let newAt = 0;
  for (const [oldIndex, newIndex] of anchors) {
    const start = card.body.start + oldAt;
    const end = card.body.start + oldIndex;
    const added = newBody.slice(newAt, newIndex).map((line) => encodeBodyLine(line, unit));
    if (start < end) operations.push({ kind: 'replace', start, end, lines: added });
    else if (added.length > 0) operations.push({ kind: 'insert', at: start, lines: added });
    oldAt = oldIndex + 1;
    newAt = newIndex + 1;
  }
  return { operations, expectedLines: rangeLines(texts, card.range.start, card.range.end) };
}

/** kanban.md 4: the card range (body included) is removed; lines around it stay as they are (4.1). */
function deleteCard(texts: readonly string[], board: KanbanBoard, id: CardIdentity): Plan {
  const card = findCard(texts, board, id);
  return {
    operations: [{ kind: 'delete', start: card.range.start, end: card.range.end }],
    expectedLines: rangeLines(texts, card.range.start, card.range.end),
  };
}

/**
 * kanban.md 4: an exact copy of the card range (check state, body, indentation, and each
 * line's own line ending when known) right after the card.
 */
function duplicateCard(texts: readonly string[], board: KanbanBoard, id: CardIdentity, eols?: readonly Eol[]): Plan {
  const card = findCard(texts, board, id);
  const lines = texts.slice(card.range.start, card.range.end);
  const copyEols = eols?.slice(card.range.start, card.range.end);
  return {
    operations: [
      {
        kind: 'insert',
        at: card.range.end,
        lines,
        ...(copyEols !== undefined && copyEols.length === lines.length ? { eols: copyEols } : {}),
      },
    ],
    expectedLines: rangeLines(texts, card.range.start, card.range.end),
  };
}

/**
 * Where a card goes when it becomes card `index` of `cards` (kanban.md 4.1): before that
 * card's first line, after the last card's range, or, in a lane without cards, after the
 * blank line that follows the heading (adding that blank line when there is none). In a lane
 * without cards that has a `**Complete**` line, right after that line: the marker must stay
 * before the lane's first list (2.7), which is also where Obsidian writes it.
 */
function cardSlot(texts: readonly string[], lane: KanbanLane, cards: readonly KanbanCard[], index: number) {
  const before = cards[index];
  if (before !== undefined) return { at: before.range.start, prefix: [] as string[], anchor: before.range.start };
  const last = cards[cards.length - 1];
  if (last !== undefined) return { at: last.range.end, prefix: [] as string[], anchor: last.range.end - 1 };
  const marker = lane.completeMarkerLines[lane.completeMarkerLines.length - 1];
  if (marker !== undefined) return { at: marker + 1, prefix: [] as string[], anchor: marker };
  const afterHeading = lane.heading.end;
  if (afterHeading < lane.range.end && texts[afterHeading].trim() === '') {
    return { at: afterHeading + 1, prefix: [] as string[], anchor: afterHeading };
  }
  return { at: afterHeading, prefix: [''], anchor: lane.headingLine };
}

/**
 * A blank line to put after an inserted card when the line that would follow it in the lane
 * would otherwise be read as a lazy continuation of the card (kanban.md 4.1, 2.5).
 */
function separator(texts: readonly string[], lane: KanbanLane, next: number): string[] {
  if (next >= lane.range.end || next >= texts.length) return [];
  const text = texts[next];
  return startsBlockInList(text) ? [] : [''];
}

function moveCard(
  texts: readonly string[],
  board: KanbanBoard,
  id: CardIdentity,
  toLaneId: LaneIdentity,
  toIndex: number,
): Plan {
  const card = findCard(texts, board, id);
  const from = board.lanes[card.laneIndex];
  const to = findLane(texts, board, toLaneId);
  const remaining = to.cards.filter((c) => c !== card);
  checkIndex(toIndex, remaining.length, 'card index');
  if (to === from && toIndex === card.index) return { operations: [], expectedLines: [] };

  const lines = texts.slice(card.range.start, card.range.end);
  // kanban.md 2.7: entering a done lane checks the card, leaving one unchecks it.
  if (to.done && !from.done && !card.checked) lines[0] = withCheck(lines[0], card, 'x');
  if (from.done && !to.done && card.checked) lines[0] = withCheck(lines[0], card, ' ');
  // kanban.md 4.1: the marker of the lane's list (only the marker; the check box comes after it).
  const marker = matchedMarker(texts, remaining, toIndex, card);
  lines[0] = lines[0].slice(0, card.marker.start) + marker + lines[0].slice(card.marker.end);

  const slot = cardSlot(texts, to, remaining, toIndex);
  const next = slot.at >= card.range.start && slot.at < card.range.end ? card.range.end : slot.at;
  const suffix = separator(texts, to, next);
  return {
    operations: [
      { kind: 'delete', start: card.range.start, end: card.range.end },
      { kind: 'insert', at: slot.at, lines: [...slot.prefix, ...lines, ...suffix] },
    ],
    expectedLines: dedupe([
      ...rangeLines(texts, card.range.start, card.range.end),
      { line: to.headingLine, text: texts[to.headingLine] },
      { line: slot.anchor, text: texts[slot.anchor] },
      ...(next < texts.length ? [{ line: next, text: texts[next] }] : []),
    ]),
  };
}

function addCard(
  texts: readonly string[],
  board: KanbanBoard,
  laneId: LaneIdentity,
  index: number | undefined,
  title: string,
): Plan {
  const lane = findLane(texts, board, laneId);
  const clean = cleanText(title, 'card title');
  const at = index ?? lane.cards.length;
  checkIndex(at, lane.cards.length, 'card index');
  const slot = cardSlot(texts, lane, lane.cards, at);
  const marker = markerIndent(texts, lane.cards, at) + matchedMarker(texts, lane.cards, at);
  return {
    // kanban.md 4: a card added to a done lane starts checked, as when moved there (2.7).
    operations: [
      {
        kind: 'insert',
        at: slot.at,
        lines: [...slot.prefix, `${marker} [${lane.done ? 'x' : ' '}] ${clean}`, ...separator(texts, lane, slot.at)],
      },
    ],
    expectedLines: dedupe([
      { line: lane.headingLine, text: texts[lane.headingLine] },
      { line: slot.anchor, text: texts[slot.anchor] },
      ...(slot.at < texts.length ? [{ line: slot.at, text: texts[slot.at] }] : []),
    ]),
  };
}

// --- dates (kanban.md 4.8) ---

/** The date as the board writes it between the braces, or invalid. */
function dateValue(board: KanbanBoard, iso: string): string {
  if (typeof iso !== 'string' || !isIsoDate(iso)) throw new RequestError('invalid', 'date must be YYYY-MM-DD');
  const value = formatDate(iso, board.settings.dateFormat);
  // Braces would end the token early; the rest as for typed text.
  if (value.trim() === '' || /[{}]/.test(value)) throw new RequestError('invalid', 'the date format makes an unusable date');
  checkTypedLine(value, 'date');
  return value;
}

function checkDatePicker(board: KanbanBoard): void {
  if (!datePickerEnabled(board.settings)) {
    throw new RequestError('invalid', 'the date picker is off on this board (date-trigger or link-date-to-daily-note)');
  }
}

/** Adds ` @{date}` at the end of the card text, or changes the first date token. */
function setCardDate(texts: readonly string[], board: KanbanBoard, id: CardIdentity, iso: string, expected: string | undefined, useTab: boolean): Plan {
  checkDatePicker(board);
  const card = findCard(texts, board, id);
  const value = dateValue(board, iso);
  const token = firstDateToken(texts, card);
  if (token?.text !== expected) throw new RequestError('stale', 'the card date changed');
  const expectedLines = rangeLines(texts, card.range.start, card.range.end);
  if (token !== undefined) {
    const next = withChangedDate(texts[token.line], token, value);
    if (next === texts[token.line]) return { operations: [], expectedLines: [] };
    return { operations: [{ kind: 'replace', start: token.line, end: token.line + 1, lines: [next] }], expectedLines };
  }
  // A daily note link date (`@[[...]]`) is the card's date in Obsidian; a second date would not replace it.
  if (hasLinkDate(texts, card)) throw new RequestError('unsafe', 'the card has a linked date');
  const line = dateLineOf(texts, card);
  // A date inside an open comment or a code fence would not be card text.
  const fenced = findFences(texts, card.body.start, card.body.end).some((block) => line >= block.open && line <= block.last);
  if (fenced || leavesCommentOpen(texts[line])) throw new RequestError('unsafe', 'the date cannot be added after this line');
  if (endsWithTableRow(texts, card)) {
    // After a table: a blank body line, then the date on its own body line (kanban.md 4.8).
    const unit = indentUnitFor(texts, card, useTab);
    return {
      operations: [{ kind: 'replace', start: line, end: line + 1, lines: [texts[line], unit, `${unit}@{${value}}`] }],
      expectedLines,
    };
  }
  return {
    operations: [{ kind: 'replace', start: line, end: line + 1, lines: [withAddedDate(texts[line], value)] }],
    expectedLines,
  };
}

/**
 * Removes the first date token and one whitespace character next to it (kanban.md 4.8). A body
 * line that held only the token goes with its line break, as in Obsidian.
 */
function removeCardDate(texts: readonly string[], board: KanbanBoard, id: CardIdentity, expected: string): Plan {
  checkDatePicker(board);
  const card = findCard(texts, board, id);
  const token = firstDateToken(texts, card);
  if (token === undefined || token.text !== expected) throw new RequestError('stale', 'the card date changed');
  const title = token.line === card.range.start;
  const next = withRemovedDate(texts[token.line], token, textStartOf(texts, card, token.line));
  const expectedLines = rangeLines(texts, card.range.start, card.range.end);
  if (!title && next.trim() === '') {
    // The reverse of "Add date" on a card ending in a table row (kanban.md 4.8): the blank body
    // line put between the table and the date goes with the date line.
    const blank = token.line - 1;
    const addedPair =
      blank - 1 > card.range.start &&
      (texts[blank] ?? '').trim() === '' &&
      (texts[blank - 1] ?? '').trim().startsWith('|') &&
      texts.slice(token.line + 1, card.range.end).every((text) => text.trim() === '');
    return { operations: [{ kind: 'delete', start: addedPair ? blank : token.line, end: token.line + 1 }], expectedLines };
  }
  return { operations: [{ kind: 'replace', start: token.line, end: token.line + 1, lines: [next] }], expectedLines };
}

// --- lane operations ---

function moveLane(texts: readonly string[], board: KanbanBoard, id: LaneIdentity, toIndex: number): Plan {
  const lane = findLane(texts, board, id);
  const remaining = board.lanes.filter((l) => l !== lane);
  checkIndex(toIndex, remaining.length, 'lane index');
  if (toIndex === lane.index) return { operations: [], expectedLines: [] };
  const before = remaining[toIndex];
  const at = before !== undefined ? before.range.start : remaining[remaining.length - 1].range.end;
  return {
    operations: [
      { kind: 'delete', start: lane.range.start, end: lane.range.end },
      { kind: 'insert', at, lines: texts.slice(lane.range.start, lane.range.end) },
    ],
    expectedLines: [
      ...rangeLines(texts, lane.range.start, lane.range.end),
      ...(before !== undefined ? [{ line: before.headingLine, text: texts[before.headingLine] }] : []),
    ],
  };
}

const ATX_PREFIX = /^ {0,3}#{1,6}[ \t]*/;

/**
 * kanban.md 4: an ATX heading keeps its level (the `#` run and the spaces after it) and loses
 * a closing `#` run; a setext heading gets the name on its text line(s) and keeps its underline.
 */
function renameLane(texts: readonly string[], board: KanbanBoard, id: LaneIdentity, name: string): Plan {
  const lane = findLane(texts, board, id);
  const clean = cleanText(name, 'lane name');
  const line = lane.headingLine;
  if (lane.headingKind === 'setext') {
    const end = lane.heading.end - 1;
    const indent = /^ */.exec(texts[line])![0];
    return {
      operations: [{ kind: 'replace', start: line, end, lines: [indent + clean] }],
      expectedLines: rangeLines(texts, line, end + 1),
    };
  }
  const prefix = ATX_PREFIX.exec(texts[line])?.[0] ?? '## ';
  const spaced = /[ \t]$/.test(prefix) ? prefix : `${prefix} `;
  return {
    operations: [{ kind: 'replace', start: line, end: line + 1, lines: [spaced + clean] }],
    expectedLines: [{ line, text: texts[line] }],
  };
}

function dedupe(lines: readonly ExpectedLine[]): ExpectedLine[] {
  const seen = new Set<number>();
  return lines.filter(({ line }) => !seen.has(line) && (seen.add(line), true));
}

// --- board settings (kanban.md 4.9, 4.10) ---

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * The width slider's value (4.10): an integer in its range, written as the board's own
 * `lane-width`; none removes the member so the default width applies. While the frontmatter
 * sets `lane-width`, Obsidian keeps using that one, so nothing is written.
 */
function setLaneWidth(texts: readonly string[], board: KanbanBoard, value: number | undefined): Plan {
  if (value !== undefined && (!Number.isInteger(value) || value < LIMITS.laneWidthMin || value > LIMITS.laneWidthMax)) {
    throw new RequestError('invalid', `lane width ${value} is outside the slider range`);
  }
  if (board.settings.laneWidthIn.frontmatter) throw new RequestError('unsafe', 'the frontmatter sets lane-width');
  if (value === undefined && !board.settings.laneWidthIn.block) return { operations: [], expectedLines: [] };
  return setSetting(texts, board, 'lane-width', value);
}

/**
 * Sets (or with `undefined` removes) one member of the settings block's JSON: only that member's
 * value changes, or the member is added after the last one in the object's own style, or removed
 * with its separator. Without a settings block, or with JSON the board cannot read, nothing is
 * written (Obsidian writes the block on save).
 */
function setSetting(texts: readonly string[], board: KanbanBoard, name: string, value: boolean | number | undefined): Plan {
  const block = board.settingsBlock;
  if (block === null) throw new RequestError('unsafe', 'the board has no settings block');
  if (!block.valid) throw new RequestError('unsafe', 'the settings block is not valid JSON');
  // The JSON lines: everything between the markers except fence lines, in one run.
  const inner: number[] = [];
  for (let line = block.range.start + 1; line < block.range.end - 1; line++) {
    if (!FENCE_LINE.test(texts[line] ?? '')) inner.push(line);
  }
  const first = inner[0];
  const last = inner[inner.length - 1];
  if (first === undefined || last === undefined || last - first + 1 !== inner.length) {
    throw new RequestError('unsafe', 'the settings block JSON is not one run of lines');
  }
  const source = texts.slice(first, last + 1).join('\n');
  const parsed = parseJson(source);
  if (!parsed.ok || parsed.doc.root.kind !== 'object') throw new RequestError('unsafe', 'the settings block is not a JSON object');
  const patch = computeJsonPatch(parsed.doc, [value === undefined ? { kind: 'remove', path: [name] } : { kind: 'set', path: [name], value }]);
  if (!patch.ok) throw new RequestError('unsafe', patch.message);
  if (patch.edits.length === 0) return { operations: [], expectedLines: [] };
  const lines = source.split('\n');
  const offsets: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i]!.length + 1, i++) offsets.push(at);
  const offsetOf = (p: { line: number; character: number }): number => offsets[p.line]! + p.character;
  let next = source;
  for (const edit of [...patch.edits].sort((a, b) => offsetOf(b.range.start) - offsetOf(a.range.start))) {
    next = next.slice(0, offsetOf(edit.range.start)) + edit.newText + next.slice(offsetOf(edit.range.end));
  }
  return {
    operations: [{ kind: 'replace', start: first, end: last + 1, lines: next.split('\n') }],
    expectedLines: rangeLines(texts, first, last + 1),
  };
}

// --- structure check ---

/** Line texts after applying non-overlapping line operations (original coordinates). */
function applyToTexts(texts: readonly string[], operations: readonly LineOperation[]): string[] {
  const spans = operations
    .map((op) =>
      op.kind === 'insert'
        ? { start: op.at, end: op.at, lines: op.lines }
        : { start: op.start, end: op.end, lines: op.kind === 'replace' ? op.lines : [] },
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let next = 0;
  for (const span of spans) {
    out.push(...texts.slice(next, span.start), ...span.lines);
    next = Math.max(next, span.end);
  }
  out.push(...texts.slice(next));
  return out;
}

/** Lane names, card counts and `**Complete**` marks, the board shape a request may change only as intended. */
function shape(board: KanbanBoard): { name: string; cards: number; marked: boolean }[] {
  return board.lanes.map((lane) => ({ name: lane.name, cards: lane.cards.length, marked: lane.completeMarkerLines.length > 0 }));
}

/**
 * The cards a request does not target, as first line plus body length, sorted. They must read
 * back the same: for example a paragraph after an inserted card must not become its lazy
 * continuation (kanban.md 2.5), and a card must not swallow the lines after a deleted one.
 */
function untouchedCards(texts: readonly string[], board: KanbanBoard, skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const lane of board.lanes) {
    for (const card of lane.cards) {
      if (!skip.has(`${lane.index}/${card.index}`)) out.push(`${card.body.end - card.body.start} ${texts[card.range.start]}`);
    }
  }
  return out.sort();
}

/**
 * Reparses the result and refuses when the board shape is not what the request intends.
 * This catches cases the line rules cannot see, such as code fences left open.
 */
function checkStructure(
  texts: readonly string[],
  board: KanbanBoard,
  request: BoardRequest,
  operations: readonly LineOperation[],
): void {
  if (operations.length === 0) return;
  const nextTexts = applyToTexts(texts, operations);
  const next = parseBoard(nextTexts);
  const expected = shape(board);
  let landed: { lane: number; index: number; firstLine: string; bodyLines?: number } | null = null;
  // Cards the request targets, before (`lane/index`) and after.
  const skipBefore = new Set<string>();
  const skipAfter = new Set<string>();
  if ('card' in request) skipBefore.add(`${request.card.laneIndex}/${request.card.cardIndex}`);
  switch (request.kind) {
    case 'toggleCard': {
      const card = board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
      landed = { lane: card.laneIndex, index: card.index, firstLine: nextTexts[card.range.start] };
      break;
    }
    case 'editCardText': {
      // Still one card at the same place, with exactly the edited body lines.
      const card = board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
      const bodyLines = editLines(request.text).length - 1;
      landed = { lane: card.laneIndex, index: card.index, firstLine: nextTexts[card.range.start], bodyLines };
      break;
    }
    case 'moveCard': {
      expected[request.card.laneIndex].cards--;
      expected[request.toLane.laneIndex].cards++;
      const insert = operations.find((op) => op.kind === 'insert');
      // Skip the blank line added for an empty lane; a card line is never blank.
      const firstLine = insert?.kind === 'insert' ? (insert.lines.find((line) => line !== '') ?? '') : '';
      const card = board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
      landed = { lane: request.toLane.laneIndex, index: request.toIndex, firstLine, bodyLines: card.body.end - card.body.start };
      break;
    }
    case 'addCard': {
      const lane = expected[request.lane.laneIndex];
      const insert = operations.find((op) => op.kind === 'insert');
      const firstLine = insert?.kind === 'insert' ? (insert.lines.find((line) => line !== '') ?? '') : '';
      landed = { lane: request.lane.laneIndex, index: request.index ?? lane.cards, firstLine, bodyLines: 0 };
      lane.cards++;
      break;
    }
    case 'deleteCard':
      expected[request.card.laneIndex].cards--;
      break;
    case 'duplicateCard': {
      // The copy must read back as one card right after the original, with the same body length.
      const card = board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
      expected[request.card.laneIndex].cards++;
      skipAfter.add(`${card.laneIndex}/${card.index}`);
      landed = {
        lane: card.laneIndex,
        index: card.index + 1,
        firstLine: texts[card.range.start],
        bodyLines: card.body.end - card.body.start,
      };
      break;
    }
    case 'moveLane': {
      const [moved] = expected.splice(request.lane.laneIndex, 1);
      expected.splice(request.toIndex, 0, moved);
      break;
    }
    case 'renameLane':
      expected[request.lane.laneIndex].name = request.name.trim();
      break;
    case 'setCardDate':
    case 'removeCardDate': {
      // The same card in the same place. Adding or changing a date only changes characters
      // inside one line, so the body keeps its length; removing one may delete a body line.
      const card = board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
      landed = {
        lane: card.laneIndex,
        index: card.index,
        firstLine: nextTexts[card.range.start],
        ...(request.kind === 'setCardDate'
          ? { bodyLines: card.body.end - card.body.start + (request.token === undefined && endsWithTableRow(texts, card) ? 2 : 0) }
          : {}),
      };
      break;
    }
  }
  if (landed !== null) skipAfter.add(`${landed.lane}/${landed.index}`);
  const actual = shape(next);
  const sameShape =
    actual.length === expected.length &&
    actual.every((lane, i) => lane.name === expected[i].name && lane.cards === expected[i].cards && lane.marked === expected[i].marked) &&
    untouchedCards(texts, board, skipBefore).join('\n') === untouchedCards(nextTexts, next, skipAfter).join('\n');
  const card = landed === null ? undefined : next.lanes[landed.lane]?.cards[landed.index];
  const sameCard =
    landed === null ||
    (card !== undefined &&
      (landed.firstLine === '' || nextTexts[card.range.start] === landed.firstLine) &&
      (landed.bodyLines === undefined || card.body.end - card.body.start === landed.bodyLines));
  // A date the board wrote must read back as the card's first date token.
  if (sameCard && card !== undefined && request.kind === 'setCardDate') {
    const written = `@{${formatDate(request.date, board.settings.dateFormat)}}`;
    if (firstDateToken(nextTexts, card)?.text !== written) {
      throw new RequestError('unsafe', 'the date would not read back as the card date');
    }
  }
  // Edited text must read back as typed: for example a title starting with `[x] ` on a card
  // without a check box would become one (kanban.md 4.4).
  if (sameCard && card !== undefined && request.kind === 'editCardText') {
    const old = board.lanes[request.card.laneIndex].cards[request.card.cardIndex];
    const lines = editLines(request.text);
    const oldTitle = texts[old.range.start].slice(old.titleOffset);
    const typed = [lines[0] === oldTitle ? oldTitle : lines[0].trim(), ...lines.slice(1).map((line) => (line.trim() === '' ? '' : line))];
    if (cardEditText(nextTexts, card) !== typed.join('\n')) throw new RequestError('unsafe', 'the card text would not read back as typed');
  }
  // The switch must read back as the board's own value, with the settings block still valid.
  if (request.kind === 'setShowCheckboxes' && (next.settings.showCheckboxes !== request.value || next.settingsBlock?.valid !== true)) {
    throw new RequestError('unsafe', 'the setting would not read back');
  }
  // The width reads back from the block, or after a reset the block no longer sets one.
  if (
    request.kind === 'setLaneWidth' &&
    (next.settingsBlock?.valid !== true ||
      (request.value === undefined ? next.settings.laneWidthIn.block : next.settings.laneWidth !== request.value || !next.settings.laneWidthIn.block))
  ) {
    throw new RequestError('unsafe', 'the setting would not read back');
  }
  if (!sameShape || !sameCard) {
    throw new RequestError('unsafe', 'the edit would change the board structure (for example an unclosed code fence)');
  }
}
