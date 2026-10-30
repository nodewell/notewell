// Card date tokens for the date picker (kanban.md 4.8). Obsidian Kanban 2.x finds a card's
// date with `(^|\s)@{[^}]+}` over the whole card text and changes only the first match; the
// same token is found here over the card's lines (first line from the title on, then the
// body lines), so the board and Obsidian change the same characters.
import type { KanbanCard, KanbanSettings } from './model.ts';

/** The first `@{...}` of a card that starts a line or follows whitespace. */
export interface DateToken {
  /** Line index of the token. */
  readonly line: number;
  /** Offset of `@` in that line. */
  readonly start: number;
  /** Offset just after the closing `}`. */
  readonly end: number;
  /** Text between the braces (a date in the board format, or anything else). */
  readonly value: string;
  /** The whole token, `@{value}`. */
  readonly text: string;
}

const DATE_TOKEN = /(^|\s)@\{([^}]+)\}/;

/**
 * The date picker writes `@{date}` only; a board with another trigger, or with dates written
 * as daily note links, keeps its dates as they are (kanban.md 4.8).
 */
export function datePickerEnabled(settings: KanbanSettings): boolean {
  return settings.dateTrigger === '@' && !settings.linkDateToDailyNote;
}

function tokenIn(texts: readonly string[], line: number, from: number): DateToken | undefined {
  const text = texts[line] ?? '';
  const match = DATE_TOKEN.exec(text.slice(from));
  if (match === null) return undefined;
  const start = from + match.index + match[1]!.length;
  const end = from + match.index + match[0].length;
  return { line, start, end, value: match[2]!, text: text.slice(start, end) };
}

/** The card's first date token: in the title (after the check mark), else in the body lines. */
export function firstDateToken(texts: readonly string[], card: KanbanCard): DateToken | undefined {
  const inTitle = tokenIn(texts, card.range.start, card.titleOffset);
  if (inTitle !== undefined) return inTitle;
  for (let line = card.body.start; line < card.body.end; line++) {
    const token = tokenIn(texts, line, 0);
    if (token !== undefined) return token;
  }
  return undefined;
}

/**
 * The line "Add date" appends to: the last line of the card with content (blank indented
 * lines at the end of the card range are skipped), else the first line. When that last line
 * is a table row (its trimmed text starts with `|`) the first line is used instead: a date at
 * the end of a row would be a cell beyond the header and vanish from the rendered table. This
 * differs from Obsidian on purpose (kanban.md 4.8 "add").
 */
export function dateLineOf(texts: readonly string[], card: KanbanCard): number {
  for (let line = card.range.end - 1; line > card.range.start; line--) {
    if ((texts[line] ?? '').trim() !== '') return line;
  }
  return card.range.start;
}

/**
 * The card text ends in a table row. A date appended to it would be a cell beyond the table's
 * width, so "Add date" puts it on a new body line after a blank one instead (kanban.md 4.8):
 * without the blank line Markdown would read the date line as another table row.
 */
export function endsWithTableRow(texts: readonly string[], card: KanbanCard): boolean {
  const line = dateLineOf(texts, card);
  return line !== card.range.start && (texts[line] ?? '').trim().startsWith('|');
}

/**
 * The line leaves a comment open (an odd number of `%%`, or `<!--` after the last `-->`): a date
 * added at its end would be inside the comment. After a closed comment the date shows as one in
 * Obsidian, so that is allowed.
 */
export function leavesCommentOpen(text: string): boolean {
  const marks = text.split('%%').length - 1;
  return marks % 2 === 1 || text.lastIndexOf('<!--') > text.lastIndexOf('-->');
}

/**
 * `line` with ` @{value}` appended (kanban.md 4.8 "add"). Whitespace already at the end of the
 * line is replaced, so one space stays before the date, as Obsidian's trimmed card text gives.
 */
export function withAddedDate(line: string, value: string): string {
  return `${line.trimEnd()} @{${value}}`;
}

const LINK_DATE = /(^|\s)@\[\[[^\]]+\]\]/;

/**
 * The card has a date written as a daily note link (`@[[...]]`). Obsidian then shows "Edit
 * date" but cannot change it, so the board offers no date items for it (kanban.md 4.8).
 */
export function hasLinkDate(texts: readonly string[], card: KanbanCard): boolean {
  if (LINK_DATE.test((texts[card.range.start] ?? '').slice(card.titleOffset))) return true;
  for (let line = card.body.start; line < card.body.end; line++) {
    if (LINK_DATE.test(texts[line] ?? '')) return true;
  }
  return false;
}

/** `line` with the token's text between the braces replaced (kanban.md 4.8 "change"). */
export function withChangedDate(line: string, token: DateToken, value: string): string {
  return line.slice(0, token.start + 2) + value + line.slice(token.end - 1);
}

/**
 * `line` without the token and one whitespace character before it, and without the whitespace
 * this leaves at the end of the line (kanban.md 4.8 "remove"). A token that starts the text
 * (`textStart`: the title start on the first line, the end of the indentation on a body line)
 * has no whitespace before it to take, so the one after it goes instead. Obsidian trims the
 * title; on a body line it joins the rest onto the line above, which the board does not copy.
 */
export function withRemovedDate(line: string, token: DateToken, textStart: number): string {
  let from = token.start;
  let to = token.end;
  if (from > textStart && /\s/.test(line[from - 1] ?? '')) from--;
  else if (from === textStart && /\s/.test(line[to] ?? '')) to++;
  return (line.slice(0, from) + line.slice(to)).trimEnd();
}

/** Where the text of a line starts: after the check mark on the first line, after the indentation on a body line. */
export function textStartOf(texts: readonly string[], card: KanbanCard, line: number): number {
  if (line === card.range.start) return card.titleOffset;
  const text = texts[line] ?? '';
  return text.length - text.trimStart().length;
}
