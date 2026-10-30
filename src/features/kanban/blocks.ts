// Markdown block starts the board parser needs (kanban.md 2.4~2.8). Obsidian Kanban 2.x reads a
// board as a CommonMark tree; these classify single lines the same way for the cases a board
// uses: ATX and setext headings, list items, thematic breaks, block quotes and HTML blocks.
// Pure line tests, no state: the parser keeps the context (open paragraph, open list item).

/** Columns of leading whitespace (a tab advances to the next multiple of 4). */
export function indentColumns(text: string): number {
  let col = 0;
  for (const ch of text) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

export const isBlank = (text: string): boolean => /^[ \t]*$/.test(text);

const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;

/** ATX heading: 0-3 spaces, 1-6 `#`, then whitespace or the end of the line. */
export function isAtxHeading(text: string): boolean {
  return ATX.test(text);
}

/**
 * Text of an ATX heading: without the opening `#` run, the surrounding spaces and tabs, and a
 * closing `#` run that follows whitespace (or is the whole text), as in CommonMark.
 */
export function atxHeadingText(text: string): string {
  const match = ATX.exec(text);
  if (match === null) return '';
  let rest = text.slice(match[0].length).replace(/[ \t]+$/, '');
  rest = rest.replace(/(^|[ \t])#+$/, '$1');
  return rest.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Setext heading underline: 0-3 spaces, then only `=` or only `-`, then optional whitespace. */
export function isSetextUnderline(text: string): boolean {
  return /^ {0,3}(=+|-+)[ \t]*$/.test(text);
}

/** Thematic break: 0-3 spaces, three or more `*`, `-` or `_` (same character), spaces and tabs between. */
export function isThematicBreak(text: string): boolean {
  return /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(text);
}

export function isBlockQuote(text: string): boolean {
  return /^ {0,3}>/.test(text);
}

/** List marker kinds: each bullet character and each ordered delimiter is its own list. */
export type MarkerKind = '-' | '*' | '+' | '.' | ')';

export interface ListMarker {
  readonly kind: MarkerKind;
  /** Offset of the marker in the line (after 0-3 spaces). */
  readonly start: number;
  /** Offset just after the marker (`-`, `1.`). */
  readonly end: number;
  /** Ordered list number, or undefined for a bullet. */
  readonly number: number | undefined;
  /** Offset where the item content starts (after the whitespace that follows the marker). */
  readonly contentOffset: number;
  /** Column a continuation line needs to belong to the item (CommonMark content column). */
  readonly contentColumn: number;
  /** No content on the marker line. */
  readonly empty: boolean;
}

const MARKER = /^( {0,3})([-*+]|(\d{1,9})([.)]))(?=[ \t]|$)/;

/** The list item marker that starts `text`, if any (thematic breaks are tested separately). */
export function listMarker(text: string): ListMarker | undefined {
  const match = MARKER.exec(text);
  if (match === null) return undefined;
  const start = match[1]!.length;
  const end = match[0].length;
  const kind = (match[4] ?? match[2]) as MarkerKind;
  const number = match[3] === undefined ? undefined : Number(match[3]);
  const space = /^[ \t]*/.exec(text.slice(end))![0];
  const markerColumn = indentColumns(text.slice(0, start)) + (end - start);
  const empty = isBlank(text.slice(end));
  // Columns of the whitespace after the marker; five or more means the content is indented
  // code, and the item content starts one column after the marker.
  let col = markerColumn;
  for (const ch of space) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  const width = col - markerColumn;
  if (empty || width > 4) {
    return { kind, start, end, number, contentOffset: empty ? text.length : end + 1, contentColumn: markerColumn + 1, empty };
  }
  return { kind, start, end, number, contentOffset: end + space.length, contentColumn: col, empty };
}

/** A list item that may start while a paragraph is open (CommonMark: not empty, ordered only from 1). */
export function canInterruptParagraph(marker: ListMarker): boolean {
  return !marker.empty && (marker.number === undefined || marker.number === 1);
}

const BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt ' +
    'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link ' +
    'main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead ' +
    'title tr track ul'
  ).split(' '),
);

/** How an HTML block ends: on a line containing `close`, or at a blank line. */
export interface HtmlBlockStart {
  /** Text that ends the block (searched from the start line on), or null to end at a blank line. */
  readonly close: string | RegExp | null;
  /** Types 1-6 may interrupt a paragraph; type 7 (any other tag) may not. */
  readonly interrupts: boolean;
}

/** HTML block start (CommonMark types 1-7), if the line opens one. */
export function htmlBlockStart(text: string): HtmlBlockStart | undefined {
  const rest = /^ {0,3}(<.*)$/.exec(text)?.[1];
  if (rest === undefined) return undefined;
  if (/^<(script|pre|style|textarea)([ \t>]|$)/i.test(rest)) return { close: /<\/(script|pre|style|textarea)>/i, interrupts: true };
  if (rest.startsWith('<!--')) return { close: '-->', interrupts: true };
  if (rest.startsWith('<?')) return { close: '?>', interrupts: true };
  if (/^<![A-Za-z]/.test(rest)) return { close: '>', interrupts: true };
  if (rest.startsWith('<![CDATA[')) return { close: ']]>', interrupts: true };
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(rest);
  if (tag !== null && BLOCK_TAGS.has(tag[1]!.toLowerCase())) return { close: null, interrupts: true };
  // Type 7: one complete open or closing tag alone on the line.
  if (/^(<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][\w.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.test(rest)) {
    return { close: null, interrupts: false };
  }
  return undefined;
}

/** Whether `text` (from the given offset) contains the end of an HTML block. */
export function closesHtmlBlock(text: string, close: string | RegExp): boolean {
  return typeof close === 'string' ? text.includes(close) : close.test(text);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The line ends a paragraph inside a list item that is not continued by indentation: a lazy
 * continuation line (kanban.md 2.5) is any other non-blank line.
 */
export function startsBlockInList(text: string): boolean {
  return (
    isBlank(text) ||
    isAtxHeading(text) ||
    isThematicBreak(text) ||
    isBlockQuote(text) ||
    FENCE.test(text) ||
    listMarker(text) !== undefined ||
    htmlBlockStart(text)?.interrupts === true
  );
}

/**
 * The content of a line (indentation removed) is paragraph text a following line can continue
 * lazily: not a heading, break, fence or HTML block, and not an empty list item.
 */
export function isParagraphText(content: string): boolean {
  let text = content.replace(/^[ \t]+/, '');
  // A list item or quote marker: the content after it decides.
  for (;;) {
    if (isThematicBreak(text)) return false;
    const marker = listMarker(text);
    if (marker !== undefined) {
      if (marker.empty) return false;
      text = text.slice(marker.contentOffset).replace(/^[ \t]+/, '');
      continue;
    }
    const quote = /^>[ \t]?/.exec(text);
    if (quote !== null) {
      text = text.slice(quote[0].length).replace(/^[ \t]+/, '');
      continue;
    }
    break;
  }
  if (isBlank(text) || isAtxHeading(text) || isThematicBreak(text) || FENCE.test(text)) return false;
  const html = htmlBlockStart(text);
  return html === undefined || !html.interrupts;
}
