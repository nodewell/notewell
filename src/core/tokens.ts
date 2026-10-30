// Inline token positions: wikilinks, Markdown links and embeds, tags and inline code
// (core.md 3.3). Offsets are UTF-16 indices into the line text; `end` is exclusive. Tokens
// never overlap.

export interface CodeToken {
  readonly kind: 'code';
  readonly start: number;
  readonly end: number;
  /** Text between the backtick runs, unchanged. */
  readonly content: string;
}

export interface WikilinkToken {
  readonly kind: 'wikilink';
  readonly start: number;
  readonly end: number;
  /** Text before the first `|`, unchanged (may include `#heading` or `^block`). */
  readonly target: string;
  /** Text after the first `|`, or `null` when there is none. */
  readonly alias: string | null;
  /** `![[...]]`; `start` then points at the `!`. */
  readonly embed: boolean;
}

export interface TagToken {
  readonly kind: 'tag';
  readonly start: number;
  readonly end: number;
  /** Tag name without the leading `#`. */
  readonly name: string;
}

/** `[text](destination)` or, with `embed`, `![text](destination)` (links.md 2.1). */
export interface MarkdownLinkToken {
  readonly kind: 'mdlink';
  readonly start: number;
  readonly end: number;
  /** `![...](...)`; `start` then points at the `!`. */
  readonly embed: boolean;
  /** Text between the brackets, unchanged. */
  readonly text: string;
  /** The destination as written: without `<>` and without a title, not decoded. */
  readonly destination: string;
  /** Offsets of `destination` in the line (inside the angle brackets when `angle`). */
  readonly destStart: number;
  readonly destEnd: number;
  /** Written as `<destination>`. */
  readonly angle: boolean;
  /** The quoted title after the destination, or `null`. */
  readonly title: string | null;
  /** The part before the first `#`, percent-decoded (as written when it does not decode). */
  readonly path: string;
  /** The part after the first `#` (`heading`, `heading#sub`, `^block`), or `null`. */
  readonly subpath: string | null;
  /** The destination has a URL scheme (`https:`, `mailto:`, ...): not a vault link. */
  readonly external: boolean;
}

export type Token = CodeToken | WikilinkToken | MarkdownLinkToken | TagToken;

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
// Obsidian tag characters: letters, digits, `_`, `-`, `/` (Unicode letters included).
const TAG_BODY = /[\p{L}\p{M}\p{N}_\-/]+/uy;
// A tag needs at least one non-digit, as in Obsidian: `#123` is not a tag, `#v2` is.
const NON_DIGIT = /[^\p{N}]/u;
const WHITESPACE = /\s/;

function runLength(text: string, at: number, ch: string): number {
  let i = at;
  while (text[i] === ch) i++;
  return i - at;
}

// Backtick runs of the last line looked at: run length -> run starts, in order. Looking up a
// closing run is then a binary search, so many unmatched runs on a long line stay linear.
let runsText: string | undefined;
let runsByLength = new Map<number, number[]>();

function backtickRuns(text: string): Map<number, number[]> {
  if (text === runsText) return runsByLength;
  runsByLength = new Map();
  for (let i = text.indexOf('`'); i !== -1; ) {
    const run = runLength(text, i, '`');
    const starts = runsByLength.get(run);
    if (starts === undefined) runsByLength.set(run, [i]);
    else starts.push(i);
    i = text.indexOf('`', i + run);
  }
  runsText = text;
  return runsByLength;
}

/** Start of a backtick run of exactly `length` at or after `from` (a run boundary), or -1. */
function findClosingRun(text: string, from: number, length: number): number {
  const starts = backtickRuns(text).get(length);
  if (starts === undefined) return -1;
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! < from) low = mid + 1;
    else high = mid;
  }
  return low < starts.length ? starts[low]! : -1;
}

function readWikilink(text: string, at: number): WikilinkToken | null {
  const embed = text[at] === '!';
  const open = embed ? at + 1 : at;
  if (!text.startsWith('[[', open)) return null;
  // The first bracket after `[[` must start `]]` (scanning stops there: linear on long lines).
  let close = open + 2;
  while (close < text.length && text[close] !== '[' && text[close] !== ']') close++;
  if (!text.startsWith(']]', close)) return null;
  const inner = text.slice(open + 2, close);
  // Code spans bind tighter than links: a span opening inside and closing past `]]` wins.
  for (let j = open + 2; j < close; ) {
    if (text[j] !== '`') {
      j++;
      continue;
    }
    const run = runLength(text, j, '`');
    const end = findClosingRun(text, j + run, run);
    if (end === -1) {
      j += run;
      continue;
    }
    if (end + run > close) return null;
    j = end + run;
  }
  const bar = inner.indexOf('|');
  const target = bar === -1 ? inner : inner.slice(0, bar);
  if (target.trim() === '') return null;
  const alias = bar === -1 ? null : inner.slice(bar + 1);
  return { kind: 'wikilink', start: at, end: close + 2, target, alias, embed };
}

/** Index after a code span starting at `at` (a backtick run), or `at + run` when unmatched. */
function skipCodeSpan(text: string, at: number): number {
  const run = runLength(text, at, '`');
  const close = findClosingRun(text, at + run, run);
  return close === -1 ? at + run : close + run;
}

/** Longest link text or destination looked at; longer is not a link (bounds work on long lines). */
const MAX_LINK_PART = 4096;
/** Deepest bracket or parenthesis nesting in a link (as cmark limits destinations to 32). */
const MAX_NESTING = 32;

/** The `]` closing the bracket opened at `open`; nested brackets must balance. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  const limit = Math.min(text.length, open + 1 + MAX_LINK_PART);
  for (let j = open + 1; j < limit; ) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length && ASCII_PUNCTUATION.test(text[j + 1])) {
      j += 2;
    } else if (ch === '`') {
      // Code spans bind tighter: a `]` inside one does not close the text.
      j = skipCodeSpan(text, j);
    } else {
      if (ch === '[') {
        if (++depth > MAX_NESTING) return -1;
      } else if (ch === ']') {
        if (depth === 0) return j;
        depth--;
      }
      j++;
    }
  }
  return -1;
}

// A scheme needs two or more characters, so a Windows drive (`C:`) is not one.
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** `[text](dest "title")` / `![text](<dest>)` at `at`, CommonMark-shaped, on one line. */
function readMarkdownLink(text: string, at: number): MarkdownLinkToken | null {
  const embed = text[at] === '!';
  const open = embed ? at + 1 : at;
  if (text[open] !== '[') return null;
  const close = closingBracket(text, open);
  if (close === -1 || text[close + 1] !== '(') return null;
  let p = close + 2;
  while (text[p] === ' ' || text[p] === '\t') p++;
  let destStart: number;
  let destEnd: number;
  let angle = false;
  if (text[p] === '<') {
    angle = true;
    destStart = p + 1;
    let j = destStart;
    for (; j < Math.min(text.length, destStart + MAX_LINK_PART) && text[j] !== '>'; j++) {
      if (text[j] === '<') return null;
      if (text[j] === '\\' && j + 1 < text.length) j++;
    }
    if (text[j] !== '>') return null;
    destEnd = j;
    p = j + 1;
  } else {
    destStart = p;
    let depth = 0;
    const limit = Math.min(text.length, p + MAX_LINK_PART);
    for (; p < limit; p++) {
      const ch = text[p];
      if (ch === '\\' && p + 1 < text.length && ASCII_PUNCTUATION.test(text[p + 1])) {
        p++;
      } else if (ch === ' ' || ch === '\t') {
        break;
      } else if (ch === '(') {
        if (++depth > MAX_NESTING) return null;
      } else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (depth !== 0) return null;
    destEnd = p;
  }
  let title: string | null = null;
  const spaced = text[p] === ' ' || text[p] === '\t';
  while (text[p] === ' ' || text[p] === '\t') p++;
  const quote = text[p];
  if (spaced && (quote === '"' || quote === "'" || quote === '(')) {
    const closer = quote === '(' ? ')' : quote;
    let j = p + 1;
    for (; j < Math.min(text.length, p + 1 + MAX_LINK_PART) && text[j] !== closer; j++) if (text[j] === '\\') j++;
    if (text[j] !== closer) return null;
    title = text.slice(p + 1, j);
    p = j + 1;
    while (text[p] === ' ' || text[p] === '\t') p++;
  }
  if (text[p] !== ')') return null;
  const destination = text.slice(destStart, destEnd);
  const hash = destination.indexOf('#');
  const rawPath = hash === -1 ? destination : destination.slice(0, hash);
  return {
    kind: 'mdlink',
    start: at,
    end: p + 1,
    embed,
    text: text.slice(open + 1, close),
    destination,
    destStart,
    destEnd,
    angle,
    title,
    path: decodePath(rawPath),
    subpath: hash === -1 ? null : destination.slice(hash + 1),
    external: SCHEME.test(destination),
  };
}

function readTag(text: string, at: number): TagToken | null {
  if (at > 0 && !WHITESPACE.test(text[at - 1])) return null;
  TAG_BODY.lastIndex = at + 1;
  const match = TAG_BODY.exec(text);
  if (match === null || !NON_DIGIT.test(match[0])) return null;
  return { kind: 'tag', start: at, end: at + 1 + match[0].length, name: match[0] };
}

/**
 * Tokens in one line, left to right. Inline code is matched as in CommonMark (a run of
 * N backticks closed by a run of exactly N; an unmatched run is literal), and nothing
 * inside it is a token. A backslash before ASCII punctuation makes that character literal.
 * At `[`, a wikilink is tried before a Markdown link. Tags start at the line start or after
 * whitespace.
 */
export function findTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && ASCII_PUNCTUATION.test(text[i + 1])) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = runLength(text, i, '`');
      const close = findClosingRun(text, i + run, run);
      if (close === -1) {
        i += run;
        continue;
      }
      tokens.push({ kind: 'code', start: i, end: close + run, content: text.slice(i + run, close) });
      i = close + run;
      continue;
    }
    if (ch === '[' || ch === '!') {
      const link = readWikilink(text, i) ?? readMarkdownLink(text, i);
      if (link !== null) {
        tokens.push(link);
        i = link.end;
        continue;
      }
    }
    if (ch === '#') {
      const tag = readTag(text, i);
      if (tag !== null) {
        tokens.push(tag);
        i = tag.end;
        continue;
      }
    }
    i++;
  }
  return tokens;
}

/**
 * Tokens for each line; lines flagged in `skip` (for example by `fenceMask`) get none.
 * Tokens do not span lines.
 */
export function findTokensByLine(texts: readonly string[], skip: readonly boolean[] = []): Token[][] {
  return texts.map((text, i) => (skip[i] === true ? [] : findTokens(text)));
}
