// Where link-like text is not a link (links.md 2.1): parts of a note that Obsidian does not read
// as Markdown links. A link found there is never indexed, so it is never rewritten. When unsure,
// a span is treated as not a link: leaving a link alone is safe, changing text that is not a
// link is not. Pure: line texts in, character spans per line out.
import { findTokens } from '../core/tokens.ts';

/** A character range in one line; `end` is exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

const WHOLE_LINE: Span = { start: 0, end: Number.MAX_SAFE_INTEGER };
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// An HTML tag with its attributes (`<a title="...">`, `</a>`, `<br/>`).
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]{0,2000})?\/?>/y;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

/** Columns of leading whitespace (a tab advances to the next multiple of 4). */
function indentWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Ranges of inline code spans in `text`. */
function codeSpans(text: string): Span[] {
  return findTokens(text).filter((t) => t.kind === 'code');
}

/**
 * Per line, the spans that are not Markdown: indented code blocks (outside lists), `$$` math
 * blocks and inline `$math$`, `%%` comments and `<!-- -->` comments (also over several lines;
 * unclosed ones run to the end of the note), and HTML tags with their attributes. Lines flagged
 * in `fenced` (code fences) are whole spans. Lines before `bodyStart` (frontmatter) get none.
 */
export function nonLinkSpans(texts: readonly string[], bodyStart: number, fenced: readonly boolean[]): Span[][] {
  const out: Span[][] = texts.map(() => []);
  let open: string | null = null;
  let inList = false;
  let previousBlank = true;
  let previousCode = false;
  for (let i = bodyStart; i < texts.length; i++) {
    const text = texts[i]!;
    const spans = out[i]!;
    if (fenced[i] === true) {
      spans.push(WHOLE_LINE);
      previousBlank = false;
      previousCode = false;
      continue;
    }
    const blank = text.trim() === '';
    if (open === null && !blank) {
      const indent = indentWidth(text);
      if (indent >= 4 && (previousBlank || previousCode) && !inList) {
        spans.push(WHOLE_LINE);
        previousBlank = false;
        previousCode = true;
        continue;
      }
      if (LIST_ITEM.test(text)) inList = true;
      else if (indent === 0 && previousBlank) inList = false;
    }
    previousBlank = blank;
    previousCode = false;
    open = scanLine(text, spans, open);
  }
  return out;
}

/** Adds the non-Markdown spans of one line; returns the construct still open at its end. */
function scanLine(text: string, spans: Span[], open: string | null): string | null {
  let p = 0;
  if (open !== null) {
    const close = text.indexOf(open);
    if (close === -1) {
      spans.push(WHOLE_LINE);
      return open;
    }
    spans.push({ start: 0, end: close + open.length });
    p = close + open.length;
  }
  const code = codeSpans(text);
  let nextCode = 0;
  // Closing `$` candidates do not depend on the opener: once none follows, none will.
  let mathFailedFrom = Number.MAX_SAFE_INTEGER;
  while (p < text.length) {
    while (nextCode < code.length && code[nextCode]!.end <= p) nextCode++;
    const inCode = code[nextCode];
    if (inCode !== undefined && p >= inCode.start) {
      p = inCode.end;
      continue;
    }
    const ch = text[p];
    if (ch === '\\') {
      p += 2;
      continue;
    }
    const opener = text.startsWith('%%', p) ? ['%%', '%%'] : text.startsWith('<!--', p) ? ['<!--', '-->'] : text.startsWith('$$', p) ? ['$$', '$$'] : null;
    if (opener !== null) {
      const [start, end] = opener as [string, string];
      const close = text.indexOf(end, p + start.length);
      if (close === -1) {
        spans.push({ start: p, end: Number.MAX_SAFE_INTEGER });
        return end;
      }
      spans.push({ start: p, end: close + end.length });
      p = close + end.length;
      continue;
    }
    if (ch === '$' && p < mathFailedFrom) {
      const end = inlineMathEnd(text, p);
      if (end === -1 && opensMath(text, p)) mathFailedFrom = p;
      if (end !== -1) {
        spans.push({ start: p, end });
        p = end;
        continue;
      }
    }
    // `<` right after `](` opens an angle-bracket link destination, not a tag.
    if (ch === '<' && !/\]\([ \t]*$/.test(text.slice(Math.max(0, p - 8), p))) {
      HTML_TAG.lastIndex = p;
      const tag = HTML_TAG.exec(text);
      if (tag !== null) {
        spans.push({ start: p, end: p + tag[0].length });
        p += tag[0].length;
        continue;
      }
    }
    p++;
  }
  return null;
}

/**
 * End of inline math opened by `$` at `at` (Obsidian/Pandoc rule: no space after the opening
 * `$`, none before the closing one, and no digit right after it), or -1.
 */
function inlineMathEnd(text: string, at: number): number {
  if (!opensMath(text, at)) return -1;
  for (let q = text.indexOf('$', at + 1); q !== -1; q = text.indexOf('$', q + 1)) {
    if (text[q - 1] === '\\' || SPACE.test(text[q - 1]!)) continue;
    if (text[q + 1] !== undefined && DIGIT.test(text[q + 1]!)) continue;
    return q + 1;
  }
  return -1;
}

function opensMath(text: string, at: number): boolean {
  const first = text[at + 1];
  return first !== undefined && first !== '$' && !SPACE.test(first);
}

/** Whether `[start, end)` overlaps any of `spans`. */
export function overlaps(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}
