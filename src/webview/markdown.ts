// Markdown display shared by webviews (first used by the Backlog detail view, backlog.md 4.5).
// Pure: text in, a small block and inline tree out, drawn by markdown-render.ts as DOM
// elements. Only the listed
// syntax is recognised; everything else stays literal text, and no input character is
// dropped except markup (markers, delimiters, brackets, escape backslashes).
import { findFences, type FenceBlock } from '../core/fences.ts';

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  /** A source line break inside a paragraph, heading or list item. */
  | { readonly kind: 'break' }
  | { readonly kind: 'code'; readonly text: string }
  /** `highlight`: `==text==`, only when parsed with the `highlight` option. */
  | { readonly kind: 'strong' | 'em' | 'strike' | 'highlight'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly url: string; readonly title: string | null; readonly children: readonly Inline[] }
  /** Never loaded (CSP); shown as its alt text. */
  | { readonly kind: 'image'; readonly src: string; readonly alt: string };

export interface ListItem {
  /** Number written in the source for ordered items, null for bullets. */
  readonly number: number | null;
  /** `[ ]` / `[x]` task box, null when the item has none. */
  readonly checked: boolean | null;
  /** The item's first paragraph. */
  readonly content: readonly Inline[];
  /** Blocks after the first paragraph, including nested lists. */
  readonly blocks: readonly Block[];
}

export type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly content: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly ListItem[] }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | { readonly kind: 'rule' }
  /** Fenced code. `lang` is the first word of `info`; no highlighting (mermaid included). */
  | { readonly kind: 'code'; readonly lang: string; readonly info: string; readonly text: string }
  /**
   * GFM pipe table; every row has exactly one cell per column, unless parsed with
   * `extraCells`: then a row keeps the cells beyond the header's width.
   */
  | {
      readonly kind: 'table';
      readonly align: readonly TableAlign[];
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

/** Column alignment from the delimiter row (`:--`, `:-:`, `--:`); null when unmarked. */
export type TableAlign = 'left' | 'center' | 'right' | null;

/** Quote and list nesting beyond this is shown as plain text (bounds recursion). */
const MAX_DEPTH = 16;

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const DELIMITER_CELL = /^:?-+:?$/;
const ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const FENCE_INFO = /^[ \t]*(?:`{3,}|~{3,})(.*)$/;

export interface MarkdownParseOptions {
  /**
   * Table rows keep cells beyond the header's width instead of dropping them as GFM does
   * (the kanban board, where a date appended to a table row would otherwise vanish).
   * Default false.
   */
  readonly extraCells?: boolean;
  /**
   * Obsidian's `==text==` is a highlight (it may hold other emphasis, as `==**x**==`), and a
   * `[[wikilink]]` is kept whole as text, so no emphasis marker inside it pairs with one
   * outside (the kanban board, whose text hook reads the wikilinks). Default false.
   */
  readonly highlight?: boolean;
}

export function parseMarkdown(text: string, options: MarkdownParseOptions = {}): Block[] {
  try {
    return parseBlocks(text.split(/\r\n|\r|\n/), 0, options);
  } catch {
    // Safety net for a viewer: never lose content to a parser bug.
    return [{ kind: 'paragraph', content: plainInlines(text.split(/\r\n|\r|\n/)) }];
  }
}

function plainInlines(lines: readonly string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ kind: 'break' });
    if (line !== '') out.push({ kind: 'text', text: line });
  });
  return out;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Leading whitespace width in columns, tabs to the next multiple of 4. */
function indentOf(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Removes up to `cols` columns of leading whitespace; a tab crossing the limit leaves spaces. */
function dedent(line: string, cols: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') {
      const next = col + 4 - (col % 4);
      if (next > cols) return ' '.repeat(next - cols) + line.slice(i + 1);
      col = next;
    } else break;
    i++;
  }
  return line.slice(i);
}

function isRule(line: string): boolean {
  return RULE.test(line);
}

function isFenceOpener(line: string): boolean {
  return findFences([line]).length > 0;
}

/**
 * A line that starts another block, ending a paragraph. Inside a paragraph only an ordered
 * item numbered 1 interrupts (as in CommonMark), so "2026. was ..." stays text.
 */
function isBlockStart(line: string, inParagraph: boolean): boolean {
  if (isBlank(line) || HEADING.test(line) || isRule(line) || QUOTE.test(line) || isFenceOpener(line)) {
    return true;
  }
  const item = ITEM.exec(line);
  if (item === null) return false;
  if (!inParagraph) return true;
  const content = item[4] ?? '';
  if (content.trim() === '') return false;
  return /^[-+*]$/.test(item[2]) || /^1[.)]$/.test(item[2]);
}

function parseBlocks(lines: readonly string[], depth: number, options: MarkdownParseOptions): Block[] {
  if (depth > MAX_DEPTH) {
    return lines.every(isBlank) ? [] : [{ kind: 'paragraph', content: plainInlines(lines) }];
  }
  const fences = new Map<number, FenceBlock>(findFences(lines).map((f) => [f.open, f]));
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = fences.get(i);
    if (fence !== undefined) {
      blocks.push(codeBlock(lines, fence));
      i = fence.last + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const content = (heading[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, content: parseInline(content, options.highlight === true) });
      i++;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (QUOTE.test(l)) inner.push(l.replace(QUOTE, ''));
        // Lazy continuation of a quoted paragraph.
        else if (inner.length > 0 && !isBlank(inner[inner.length - 1]) && !isBlockStart(l, true)) inner.push(l);
        else break;
        i++;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner, depth + 1, options) });
      continue;
    }

    if (ITEM.test(line)) {
      i = parseList(lines, i, fences, depth, blocks, options);
      continue;
    }

    const table = tableAt(lines, i, options);
    if (table !== null) {
      blocks.push(table.block);
      i = table.end;
      continue;
    }

    const start = i;
    i++;
    while (i < lines.length && !isBlockStart(lines[i], true) && tableAt(lines, i) === null) i++;
    blocks.push({ kind: 'paragraph', content: parseInline(lines.slice(start, i).map((l) => l.trim()).join('\n'), options.highlight === true) });
  }
  return blocks;
}

/**
 * Cells of a table row: split on unescaped pipes, with an optional leading and trailing pipe.
 * `\|` becomes a literal pipe (inside code spans too, as in GFM); other escapes are left for
 * the inline parser. Null for a line without a pipe.
 */
function tableCells(line: string): string[] | null {
  let row = line.trim();
  if (!row.includes('|')) return null;
  if (row.startsWith('|')) row = row.slice(1);
  const cells: string[] = [];
  let cell = '';
  let closed = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      cell += row[i + 1] === '|' ? '|' : ch + row[i + 1];
      i++;
      closed = false;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
      closed = true;
    } else {
      cell += ch;
      if (ch !== ' ' && ch !== '\t') closed = false;
    }
  }
  // A trailing pipe closes the last cell rather than opening an empty one.
  if (!closed || cells.length === 0) cells.push(cell);
  return cells.map((c) => c.trim());
}

/**
 * A GFM table starting at `start`: a header row, then a delimiter row with as many cells, then
 * body rows up to a blank line, another block or a line without a pipe. Rows are padded or cut
 * to the header's width, as GFM does; with `extraCells` they are only padded. Null when
 * `start` does not begin a table.
 */
function tableAt(lines: readonly string[], start: number, options: MarkdownParseOptions = {}): { block: Block; end: number } | null {
  if (start + 1 >= lines.length || indentOf(lines[start]) > 3 || indentOf(lines[start + 1]) > 3) return null;
  const header = tableCells(lines[start]);
  const delimiter = tableCells(lines[start + 1]);
  if (header === null || delimiter === null || header.length !== delimiter.length) return null;
  if (!delimiter.every((cell) => DELIMITER_CELL.test(cell))) return null;
  const align = delimiter.map((cell): TableAlign => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const highlight = options.highlight === true;
  const row = (cells: readonly string[]): Inline[][] => header.map((_, k) => parseInline(cells[k] ?? '', highlight));
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && !isBlockStart(lines[i], false)) {
    const cells = tableCells(lines[i]);
    if (cells === null) break;
    const extra = options.extraCells === true ? cells.slice(header.length).map((cell) => parseInline(cell, highlight)) : [];
    rows.push([...row(cells), ...extra]);
    i++;
  }
  return { block: { kind: 'table', align, header: row(header), rows }, end: i };
}

function codeBlock(lines: readonly string[], fence: FenceBlock): Block {
  const info = (FENCE_INFO.exec(lines[fence.open])?.[1] ?? '').trim();
  const end = fence.close ?? fence.last + 1;
  const indent = indentOf(fence.indent);
  const text = lines.slice(fence.open + 1, end).map((l) => dedent(l, indent)).join('\n');
  return { kind: 'code', lang: info.split(/\s+/)[0] ?? '', info, text };
}

/**
 * One list starting at `start`; returns the index after it. A line indented further than an
 * item's marker belongs to that item and is parsed as blocks after removing the item's
 * content indent, so nesting depth follows indentation.
 */
function parseList(
  lines: readonly string[],
  start: number,
  fences: ReadonlyMap<number, FenceBlock>,
  depth: number,
  out: Block[],
  options: MarkdownParseOptions,
): number {
  const first = ITEM.exec(lines[start])!;
  const ordered = !/^[-+*]$/.test(first[2]);
  const items: ListItem[] = [];
  let i = start;
  for (;;) {
    const match = ITEM.exec(lines[i])!;
    const itemIndent = indentOf(match[1]);
    const contentIndent = itemIndent + match[2].length + 1;
    const body: string[] = [(match[4] ?? '').trim()];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlank(l)) {
        let k = j;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]) > itemIndent) {
          for (; j < k; j++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) > itemIndent) {
        const fence = fences.get(j);
        const last = fence?.last ?? j;
        for (; j <= last; j++) body.push(dedent(lines[j], contentIndent));
        continue;
      }
      // Lazy continuation of the item's paragraph.
      if (!isBlank(body[body.length - 1]) && !isBlockStart(l, false) && !isFenceOpener(body[body.length - 1])) {
        body.push(l.trim());
        j++;
        continue;
      }
      break;
    }

    let checked: boolean | null = null;
    const task = TASK.exec(body[0]);
    if (task !== null) {
      checked = task[1] !== ' ';
      body[0] = body[0].slice(task[0].length);
    }
    const blocks = parseBlocks(body, depth + 1, options);
    const lead = blocks[0];
    const leadIsText = lead !== undefined && lead.kind === 'paragraph' && body[0].trim() !== '';
    items.push({
      number: ordered ? Number(match[2].slice(0, -1)) : null,
      checked,
      content: leadIsText ? lead.content : [],
      blocks: leadIsText ? blocks.slice(1) : blocks,
    });

    let k = j;
    while (k < lines.length && isBlank(lines[k])) k++;
    const next = k < lines.length && !isRule(lines[k]) ? ITEM.exec(lines[k]) : null;
    if (next === null || /^[-+*]$/.test(next[2]) === ordered) {
      out.push({ kind: 'list', ordered, start: items[0].number ?? 1, items });
      return j;
    }
    i = k;
  }
}

// ---- Inline ----

const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const UNICODE_SPACE = /\s/u;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
/** A link's label and destination are searched this far; longer stays literal (bounds time). */
const LINK_SCAN = 2000;

interface Delim {
  readonly char: '*' | '_' | '~' | '=';
  count: number;
  readonly orig: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}

interface Node {
  item: Inline | Delim;
  prev: Node | null;
  next: Node | null;
}

function isDelim(item: Inline | Delim): item is Delim {
  return 'char' in item;
}

/**
 * Emphasis and link openers in one run of inline text beyond which it is shown as plain text:
 * thousands of them only come from hostile or broken input, and would nest without bound.
 */
const MAX_INLINE_MARKUP = 2000;

/** `highlight`: see MarkdownParseOptions. */
export function parseInline(text: string, highlight = false): Inline[] {
  let markup = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const marker = ch === '*' || ch === '_' || ch === '~' || ch === '[' || (highlight && ch === '=');
    if (marker && ++markup > MAX_INLINE_MARKUP) return plainInlines(text.split('\n'));
  }
  return parseInlineIn(text, false, highlight);
}

function unescape(text: string): string {
  return text.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
}

/** End index (exclusive) of a code span opening at `i` with a run of `n` backticks, or -1. */
function codeSpanEnd(s: string, i: number, n: number): number {
  let j = i + n;
  while (j < s.length) {
    if (s[j] !== '`') {
      j++;
      continue;
    }
    let k = j;
    while (k < s.length && s[k] === '`') k++;
    if (k - j === n) return k;
    j = k;
  }
  return -1;
}

function runLength(s: string, i: number, ch: string): number {
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  return j - i;
}

interface LinkMatch {
  readonly label: string;
  readonly url: string;
  readonly title: string | null;
  readonly end: number;
}

/** `[label](dest "title")` at `i` (s[i] === '['). */
function matchLink(s: string, i: number): LinkMatch | null {
  const labelLimit = Math.min(s.length, i + LINK_SCAN);
  let depth = 1;
  let j = i + 1;
  while (j < labelLimit) {
    const ch = s[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '`') {
      const n = runLength(s, j, '`');
      const end = codeSpanEnd(s, j, n);
      j = end === -1 ? j + n : end;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
    j++;
  }
  if (j >= labelLimit || s[j + 1] !== '(') return null;
  const label = s.slice(i + 1, j);
  const limit = Math.min(s.length, j + LINK_SCAN);

  let k = j + 2;
  const skipSpace = (): boolean => {
    const from = k;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (s[k] === '\n') k++;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    return k > from;
  };
  skipSpace();

  let dest = '';
  if (s[k] === '<') {
    const from = k + 1;
    k = from;
    while (k < limit && s[k] !== '>' && s[k] !== '\n' && s[k] !== '<') k += s[k] === '\\' ? 2 : 1;
    if (s[k] !== '>') return null;
    dest = s.slice(from, k);
    k++;
  } else {
    const from = k;
    let parens = 0;
    while (k < limit) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < s.length) {
        k += 2;
        continue;
      }
      if (/\s/.test(ch) || ch < ' ') break;
      if (ch === '(') parens++;
      else if (ch === ')') {
        if (parens === 0) break;
        parens--;
      }
      k++;
    }
    if (parens !== 0 || k >= limit) return null;
    dest = s.slice(from, k);
  }

  let title: string | null = null;
  const spaced = skipSpace();
  const open = s[k];
  if (spaced && (open === '"' || open === "'" || open === '(')) {
    const close = open === '(' ? ')' : open;
    const from = k + 1;
    k = from;
    while (k < limit && s[k] !== close) k += s[k] === '\\' ? 2 : 1;
    if (k >= limit) return null;
    title = unescape(s.slice(from, k));
    k++;
    skipSpace();
  }
  if (s[k] !== ')') return null;
  return { label, url: unescape(dest), title, end: k + 1 };
}

function plainText(inlines: readonly Inline[]): string {
  return inlines
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.text;
        case 'break':
          return '\n';
        case 'image':
          return n.alt;
        default:
          return plainText(n.children);
      }
    })
    .join('');
}

function parseInlineIn(s: string, noLinks: boolean, highlight = false): Inline[] {
  // Sentinel first node, so a match never has to replace the list head.
  const head: Node = { item: { kind: 'text', text: '' }, prev: null, next: null };
  let tail = head;
  const push = (item: Inline | Delim): void => {
    const node: Node = { item, prev: tail, next: null };
    tail.next = node;
    tail = node;
  };
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') push({ kind: 'text', text: buffer });
    buffer = '';
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) {
      buffer += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      push({ kind: 'break' });
      i++;
      continue;
    }
    if (ch === '`') {
      const n = runLength(s, i, '`');
      const end = codeSpanEnd(s, i, n);
      if (end === -1) {
        buffer += s.slice(i, i + n);
        i += n;
        continue;
      }
      let code = s.slice(i + n, end - n).replace(/\n/g, ' ');
      if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      flush();
      push({ kind: 'code', text: code });
      i = end;
      continue;
    }
    if (highlight && ch === '[' && s[i + 1] === '[') {
      // A wikilink stays whole: no delimiter inside it pairs with one outside.
      const close = s.indexOf(']]', i + 2);
      if (close !== -1 && !s.slice(i + 2, close).includes('\n')) {
        buffer += s.slice(i, close + 2);
        i = close + 2;
        continue;
      }
    }
    if (ch === '*' || ch === '_' || ch === '~' || (highlight && ch === '=')) {
      const n = runLength(s, i, ch);
      const before = i === 0 ? ' ' : s[i - 1];
      const after = i + n >= s.length ? ' ' : s[i + n];
      const spaceBefore = UNICODE_SPACE.test(before);
      const spaceAfter = UNICODE_SPACE.test(after);
      const punctBefore = UNICODE_PUNCT.test(before);
      const punctAfter = UNICODE_PUNCT.test(after);
      const left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore);
      const right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter);
      const canOpen = ch === '_' ? left && (!right || punctBefore) : left;
      const canClose = ch === '_' ? right && (!left || punctAfter) : right;
      flush();
      push({ char: ch, count: n, orig: n, canOpen, canClose });
      i += n;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const link = matchLink(s, i + 1);
      if (link !== null) {
        flush();
        push({ kind: 'image', src: link.url, alt: plainText(parseInlineIn(link.label, true, highlight)) });
        i = link.end;
        continue;
      }
    }
    if (ch === '[' && !noLinks) {
      const link = matchLink(s, i);
      if (link !== null) {
        flush();
        push({ kind: 'link', url: link.url, title: link.title, children: parseInlineIn(link.label, true, highlight) });
        i = link.end;
        continue;
      }
    }
    if (ch === '<') {
      AUTOLINK.lastIndex = i;
      const auto = AUTOLINK.exec(s);
      if (auto !== null) {
        flush();
        push({ kind: 'link', url: auto[1], title: null, children: [{ kind: 'text', text: auto[1] }] });
        i += auto[0].length;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  processEmphasis(head.next);
  return collect(head.next, null);
}

/** Inlines from `from` up to (not including) `to`; unmatched delimiters become text. */
function collect(from: Node | null, to: Node | null): Inline[] {
  const out: Inline[] = [];
  for (let n = from; n !== null && n !== to; n = n.next) {
    const item = isDelim(n.item) ? (n.item.count > 0 ? { kind: 'text' as const, text: n.item.char.repeat(n.item.count) } : null) : n.item;
    if (item === null) continue;
    const last = out[out.length - 1];
    if (item.kind === 'text' && last !== undefined && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + item.text };
    else out.push(item);
  }
  return out;
}

/** CommonMark's "process emphasis", over a linked list; `~~` pairs only with `~~`, `==` only with `==`. */
function processEmphasis(head: Node | null): void {
  const bottoms = new Map<string, Node | null>();
  let closer = head;
  while (closer !== null) {
    const c = closer.item;
    if (!isDelim(c) || !c.canClose || c.count === 0) {
      closer = closer.next;
      continue;
    }
    const key = `${c.char}${c.canOpen ? 1 : 0}${c.orig % 3}`;
    const bottom = bottoms.get(key) ?? null;
    let opener: Node | null = closer.prev;
    let found: Node | null = null;
    while (opener !== null && opener !== bottom) {
      const o = opener.item;
      if (isDelim(o) && o.char === c.char && o.canOpen && o.count > 0 && pairs(o, c)) {
        found = opener;
        break;
      }
      opener = opener.prev;
    }
    if (found === null) {
      bottoms.set(key, closer.prev);
      closer = closer.next;
      continue;
    }
    const o = found.item as Delim;
    const use = c.char === '~' || c.char === '=' ? 2 : o.count >= 2 && c.count >= 2 ? 2 : 1;
    const kind = c.char === '~' ? 'strike' : c.char === '=' ? 'highlight' : use === 2 ? 'strong' : 'em';
    const wrapped: Node = { item: { kind, children: collect(found.next, closer) }, prev: found, next: closer };
    found.next = wrapped;
    closer.prev = wrapped;
    o.count -= use;
    c.count -= use;
    if (o.count === 0) unlink(found);
    if (c.count === 0) {
      const next = closer.next;
      unlink(closer);
      closer = next;
    }
  }
}

function pairs(o: Delim, c: Delim): boolean {
  if (c.char === '~' || c.char === '=') return o.orig === 2 && c.orig === 2;
  if ((o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) return false;
  return true;
}

function unlink(node: Node): void {
  if (node.prev !== null) node.prev.next = node.next;
  if (node.next !== null) node.next.prev = node.prev;
}
