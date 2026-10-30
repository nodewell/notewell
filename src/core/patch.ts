// Line patch engine (core.md 3.4): line operations in, minimal text edits out, with an
// optimistic concurrency check. Edits use the VS Code Position/Range shape without
// depending on VS Code; positions exclude the BOM, as VS Code documents do.

import { BOM, dominantEol, type Eol, type Line, type LineDocument } from './lines.ts';

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

/**
 * Line operations, all in the coordinates of the original document. Ranges are
 * `start .. end - 1` (end exclusive). Line texts must not contain `\r` or `\n`.
 */
export type LineOperation =
  | { readonly kind: 'delete'; readonly start: number; readonly end: number }
  /**
   * Inserts before line `at`; `at === lines.length` appends. `eols` (optional, one per line)
   * keeps given line endings, e.g. for copied lines; `''` or no `eols` uses the dominant EOL.
   */
  | { readonly kind: 'insert'; readonly at: number; readonly lines: readonly string[]; readonly eols?: readonly Eol[] }
  | { readonly kind: 'replace'; readonly start: number; readonly end: number; readonly lines: readonly string[] };

export interface ExpectedLine {
  readonly line: number;
  readonly text: string;
}

export interface PatchRequest {
  /** Document version the request was built from. */
  readonly expectedVersion: number;
  /** Original line texts the request relies on (for example the target card's lines). */
  readonly expectedLines: readonly ExpectedLine[];
  readonly operations: readonly LineOperation[];
}

/**
 * Why a request was refused. Checked in this order: version, then each operation in turn
 * (range / invalid), then expected lines, then overlaps.
 * - `version`: the document changed since the request was built
 * - `range`: a line index is outside the document
 * - `invalid`: malformed operation (non-integer index, empty range, line break in text)
 * - `content`: an expected line is missing or has different text
 * - `overlap`: two operations touch the same lines, or insert at the same line
 */
export type PatchFailureReason = 'version' | 'range' | 'invalid' | 'content' | 'overlap';

export type PatchResult =
  | { readonly ok: true; readonly edits: readonly TextEdit[] }
  | { readonly ok: false; readonly reason: PatchFailureReason; readonly message: string };

interface MutableLine {
  text: string;
  eol: Eol;
}

/** Replaces original lines `start .. end - 1` with `lines`. */
interface Region {
  readonly start: number;
  readonly end: number;
  readonly lines: MutableLine[];
}

class PatchError extends Error {
  readonly reason: PatchFailureReason;
  constructor(reason: PatchFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Turns line operations into minimal edits. Edits are sorted, never overlap, and refer to
 * the original document, so they can be applied together (one WorkspaceEdit).
 *
 * Line endings: inserted lines use the document's dominant EOL; a replaced line keeps the
 * EOL of the original line at the same position. Whether the file ends with a line break
 * is preserved (an empty document counts as ending with one).
 */
export function computePatch(doc: LineDocument, currentVersion: number, request: PatchRequest): PatchResult {
  try {
    if (request.expectedVersion !== currentVersion) {
      throw new PatchError('version', `expected version ${request.expectedVersion}, document is ${currentVersion}`);
    }
    const regions = request.operations.map((op) => toRegion(doc, op));
    checkExpectedLines(doc, request.expectedLines);
    regions.sort((a, b) => a.start - b.start || a.end - b.end);
    checkOverlaps(regions);
    return { ok: true, edits: toEdits(doc, fixEndOfFile(doc, regions)) };
  } catch (error) {
    if (error instanceof PatchError) return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
}

/** Applies edits from `computePatch` to the document and returns the new source (BOM kept). */
export function applyEdits(doc: LineDocument, edits: readonly TextEdit[]): string {
  const { body: original, starts } = layout(doc);
  const offset = (p: Position): number => (p.line < starts.length ? starts[p.line] + p.character : original.length);
  let body = original;
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  for (const edit of sorted) {
    body = body.slice(0, offset(edit.range.start)) + edit.newText + body.slice(offset(edit.range.end));
  }
  return (doc.bom ? BOM : '') + body;
}

function isIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function checkBounds(value: number, max: number, what: string): void {
  if (!isIndex(value)) throw new PatchError('invalid', `${what} must be a non-negative integer, got ${value}`);
  if (value > max) throw new PatchError('range', `${what} ${value} is past the document end (${max})`);
}

function checkTexts(lines: readonly string[]): void {
  for (const text of lines) {
    if (typeof text !== 'string' || /[\r\n]/.test(text)) {
      throw new PatchError('invalid', 'line text must be a string without line breaks');
    }
  }
}

function toRegion(doc: LineDocument, op: LineOperation): Region {
  const count = doc.lines.length;
  const eol = dominantEol(doc);
  if (op.kind === 'insert') {
    checkBounds(op.at, count, 'insert position');
    checkTexts(op.lines);
    const eols = op.eols;
    if (eols !== undefined && (eols.length !== op.lines.length || eols.some((e) => e !== '' && e !== '\n' && e !== '\r\n'))) {
      throw new PatchError('invalid', 'insert eols must have one LF, CRLF or empty entry per line');
    }
    // An empty entry (e.g. a copied last line without a line break) takes the dominant EOL.
    return { start: op.at, end: op.at, lines: op.lines.map((text, i) => ({ text, eol: eols?.[i] || eol })) };
  }
  checkBounds(op.start, count, `${op.kind} start`);
  checkBounds(op.end, count, `${op.kind} end`);
  if (op.end <= op.start) throw new PatchError('invalid', `${op.kind} range ${op.start}..${op.end} is empty`);
  if (op.kind === 'delete') return { start: op.start, end: op.end, lines: [] };
  checkTexts(op.lines);
  const lines = op.lines.map((text, i) => {
    const original = op.start + i < op.end ? doc.lines[op.start + i] : undefined;
    return { text, eol: original === undefined ? eol : original.eol };
  });
  return { start: op.start, end: op.end, lines };
}

function checkExpectedLines(doc: LineDocument, expected: readonly ExpectedLine[]): void {
  for (const { line, text } of expected) {
    const actual = isIndex(line) ? doc.lines[line] : undefined;
    if (actual === undefined) throw new PatchError('content', `expected line ${line} does not exist`);
    if (actual.text !== text) throw new PatchError('content', `line ${line} changed`);
  }
}

/** Regions must be sorted. Touching is fine, except two inserts at the same line. */
function checkOverlaps(regions: readonly Region[]): void {
  for (let i = 1; i < regions.length; i++) {
    const a = regions[i - 1];
    const b = regions[i];
    const sameInsert = a.start === a.end && b.start === b.end && a.start === b.start;
    if (b.start < a.end || sameInsert) {
      throw new PatchError('overlap', `operations at lines ${a.start}..${a.end} and ${b.start}..${b.end} overlap`);
    }
  }
}

/**
 * Keeps the end-of-file state: a line that is no longer last gets a line break, and if the
 * file had no trailing newline the new last line loses its line break. When that touches a
 * line outside every region, a one-line region is added for it. Exception: an empty last
 * line keeps its line break (an empty line without one has no bytes and would be lost), so
 * such a file then ends with a newline.
 */
function fixEndOfFile(doc: LineDocument, regions: Region[]): Region[] {
  const count = doc.lines.length;
  const keepNoNewline = count > 0 && doc.lines[count - 1].eol === '';
  const eol = dominantEol(doc);
  // The new document as a sequence of lines, remembering which ones are untouched originals.
  const output: { line: MutableLine; origin: number | null }[] = [];
  let next = 0;
  const copyUntil = (end: number): void => {
    for (; next < end; next++) output.push({ line: { ...doc.lines[next] }, origin: next });
  };
  for (const region of regions) {
    copyUntil(region.start);
    for (const line of region.lines) output.push({ line, origin: null });
    next = region.end;
  }
  copyUntil(count);

  const added: Region[] = [];
  output.forEach(({ line, origin }, i) => {
    const last = i === output.length - 1;
    // An empty last line keeps its line break: without it the line would have no bytes and
    // vanish, so here keeping the line wins over keeping "no trailing newline".
    const wanted: Eol = last && keepNoNewline && line.text !== '' ? '' : line.eol === '' ? eol : line.eol;
    if (wanted === line.eol) return;
    line.eol = wanted;
    if (origin !== null) added.push({ start: origin, end: origin + 1, lines: [line] });
  });
  if (added.length === 0) return regions;
  return [...regions, ...added].sort((a, b) => a.start - b.start || a.end - b.end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** A cut at `i` would split a CRLF or a surrogate pair. */
function splitsUnit(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const before = text.charCodeAt(i - 1);
  const after = text.charCodeAt(i);
  return (before === 13 && after === 10) || (isHighSurrogate(before) && isLowSurrogate(after));
}

/** Document body (no BOM) and the offset where each line starts. */
function layout(doc: LineDocument): { body: string; starts: number[] } {
  const starts: number[] = [];
  let body = '';
  for (const line of doc.lines) {
    starts.push(body.length);
    body += line.text + line.eol;
  }
  return { body, starts };
}

interface Span {
  start: number;
  end: number;
  text: string;
}

/** Shrinks a span to the characters that differ from `body`, never splitting a CRLF or surrogate pair. */
function trim(body: string, span: Span): Span | null {
  const before = body.slice(span.start, span.end);
  const after = span.text;
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  while (splitsUnit(before, prefix) || splitsUnit(after, prefix)) prefix--;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  while (splitsUnit(before, before.length - suffix) || splitsUnit(after, after.length - suffix)) suffix--;
  return { start: span.start + prefix, end: span.end - suffix, text: after.slice(prefix, after.length - suffix) };
}

function toEdits(doc: LineDocument, regions: readonly Region[]): TextEdit[] {
  const { body, starts } = layout(doc);
  const lineOffset = (line: number): number => (line < starts.length ? starts[line] : body.length);
  // Trim each region first so untouched text between regions stays out of the edits, then
  // join edits that meet at an offset (no two edits may share a position) and trim again.
  const spans: Span[] = [];
  for (const region of regions) {
    let text = '';
    for (const line of region.lines) text += line.text + line.eol;
    const span = trim(body, { start: lineOffset(region.start), end: lineOffset(region.end), text });
    if (span === null) continue;
    const prev = spans[spans.length - 1];
    if (prev !== undefined && prev.end === span.start) {
      prev.end = span.end;
      prev.text += span.text;
    } else {
      spans.push(span);
    }
  }
  const edits: TextEdit[] = [];
  for (const joined of spans) {
    const span = trim(body, joined);
    if (span === null) continue;
    edits.push({
      range: { start: positionAt(doc, starts, span.start), end: positionAt(doc, starts, span.end) },
      newText: span.text,
    });
  }
  return edits;
}

/** Position of a body offset. The end of a file without trailing newline is on its last line. */
function positionAt(doc: LineDocument, starts: readonly number[], offset: number): Position {
  let line = starts.length - 1;
  while (line > 0 && starts[line] > offset) line--;
  if (line < 0) return { line: 0, character: 0 };
  const { text, eol } = doc.lines[line];
  const character = offset - starts[line];
  if (character > text.length && eol !== '') return { line: line + 1, character: 0 };
  return { line, character };
}
