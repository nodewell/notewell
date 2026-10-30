// JSON with positions (canvas.md 3): a strict JSON parser that remembers where every value,
// member name and member starts and ends, and value-level operations that turn into minimal
// text edits. Bytes outside the changed values stay as they are: indentation, member order,
// unknown members, number spelling, line endings, BOM and the final newline.
//
// Offsets are UTF-16 indices into the text without its BOM; edits use the TextEdit shape of
// the line patch engine (patch.ts), so `applyEdits(parseLines(source), edits)` and the
// WorkspaceEdit conversion work the same for both.

import { BOM, dominantEol, parseLines } from './lines.ts';
import type { Position, TextEdit } from './patch.ts';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [name: string]: JsonValue };

/** Offsets of one value: `start .. end - 1` in the text without BOM. */
interface Span {
  readonly start: number;
  readonly end: number;
}

export interface JsonString extends Span {
  readonly kind: 'string';
  readonly value: string;
}

export interface JsonNumber extends Span {
  readonly kind: 'number';
  readonly value: number;
}

export interface JsonLiteral extends Span {
  readonly kind: 'literal';
  readonly value: boolean | null;
}

export interface JsonMember extends Span {
  /** The member name as a string token (quotes included in its span). */
  readonly name: JsonString;
  readonly value: JsonNode;
  /** `start` is the name's start, `end` the value's end; the separating comma is outside. */
}

export interface JsonObject extends Span {
  readonly kind: 'object';
  /** In source order; duplicate names are kept (lookups use the last, like JSON.parse). */
  readonly members: readonly JsonMember[];
}

export interface JsonArray extends Span {
  readonly kind: 'array';
  readonly items: readonly JsonNode[];
}

export type JsonNode = JsonObject | JsonArray | JsonString | JsonNumber | JsonLiteral;

export interface JsonDocument {
  /** True when the source started with U+FEFF. Offsets do not count it. */
  readonly bom: boolean;
  /** The source without BOM. */
  readonly text: string;
  readonly root: JsonNode;
  /** Offset where each line starts (lines end at LF, as in lines.ts). */
  readonly lineStarts: readonly number[];
}

export interface JsonSyntaxError {
  readonly message: string;
  /** Offset in the text without BOM. */
  readonly offset: number;
  /** Zero-based line and character of `offset`. */
  readonly position: Position;
}

export type JsonParseResult =
  | { readonly ok: true; readonly doc: JsonDocument }
  | { readonly ok: false; readonly error: JsonSyntaxError };

/** Deeper nesting is rejected instead of risking a stack overflow. */
export const MAX_JSON_DEPTH = 512;

class SyntaxFailure extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

/** Parses strict JSON (RFC 8259). A leading BOM is allowed and not part of any offset. */
export function parseJson(source: string): JsonParseResult {
  const bom = source.startsWith(BOM);
  const text = bom ? source.slice(BOM.length) : source;
  const lineStarts = computeLineStarts(text);
  try {
    const parser = new Parser(text);
    parser.skipSpace();
    if (parser.pos >= text.length) throw new SyntaxFailure('empty document', parser.pos);
    const root = parser.value(0);
    parser.skipSpace();
    if (parser.pos < text.length) throw new SyntaxFailure('unexpected content after the JSON value', parser.pos);
    return { ok: true, doc: { bom, text, root, lineStarts } };
  } catch (error) {
    if (!(error instanceof SyntaxFailure)) throw error;
    const offset = Math.min(error.offset, text.length);
    return { ok: false, error: { message: error.message, offset, position: positionIn(lineStarts, offset) } };
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function positionIn(lineStarts: readonly number[], offset: number): Position {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - lineStarts[low] };
}

/** Line and character of an offset in the text without BOM (the TextEdit coordinates). */
export function positionAt(doc: JsonDocument, offset: number): Position {
  return positionIn(doc.lineStarts, offset);
}

/** The source text of a node, for optimistic concurrency checks. */
export function nodeText(doc: JsonDocument, node: Span): string {
  return doc.text.slice(node.start, node.end);
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class Parser {
  readonly text: string;
  pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  skipSpace(): void {
    const { text } = this;
    while (this.pos < text.length) {
      const c = text.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      this.pos++;
    }
  }

  value(depth: number): JsonNode {
    if (depth >= MAX_JSON_DEPTH) throw new SyntaxFailure('nesting too deep', this.pos);
    const c = this.text[this.pos];
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === '"') return this.string();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(word, this.pos)) {
        const start = this.pos;
        this.pos += word.length;
        return { kind: 'literal', value, start, end: this.pos };
      }
    }
    throw new SyntaxFailure(c === undefined ? 'unexpected end of document' : `unexpected character ${describe(c)}`, this.pos);
  }

  object(depth: number): JsonObject {
    const start = this.pos++;
    const members: JsonMember[] = [];
    this.skipSpace();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { kind: 'object', members, start, end: this.pos };
    }
    for (;;) {
      if (this.text[this.pos] !== '"') throw this.expected('a member name');
      const name = this.string();
      this.skipSpace();
      if (this.text[this.pos] !== ':') throw this.expected("':'");
      this.pos++;
      this.skipSpace();
      const value = this.value(depth + 1);
      members.push({ name, value, start: name.start, end: value.end });
      this.skipSpace();
      const c = this.text[this.pos];
      this.pos++;
      if (c === '}') return { kind: 'object', members, start, end: this.pos };
      if (c !== ',') {
        this.pos--;
        throw this.expected("',' or '}'");
      }
      this.skipSpace();
    }
  }

  array(depth: number): JsonArray {
    const start = this.pos++;
    const items: JsonNode[] = [];
    this.skipSpace();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return { kind: 'array', items, start, end: this.pos };
    }
    for (;;) {
      items.push(this.value(depth + 1));
      this.skipSpace();
      const c = this.text[this.pos];
      this.pos++;
      if (c === ']') return { kind: 'array', items, start, end: this.pos };
      if (c !== ',') {
        this.pos--;
        throw this.expected("',' or ']'");
      }
      this.skipSpace();
    }
  }

  string(): JsonString {
    const { text } = this;
    const start = this.pos++;
    let value = '';
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= text.length) throw new SyntaxFailure('unterminated string', start);
      const c = text.charCodeAt(this.pos);
      if (c === 0x22) {
        value += text.slice(chunk, this.pos);
        this.pos++;
        return { kind: 'string', value, start, end: this.pos };
      }
      if (c < 0x20) throw new SyntaxFailure('control character in string', this.pos);
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      value += text.slice(chunk, this.pos);
      const escape = text[this.pos + 1];
      if (escape === 'u') {
        const hex = text.slice(this.pos + 2, this.pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxFailure('invalid \\u escape', this.pos);
        value += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
      } else if (escape !== undefined && Object.hasOwn(SIMPLE_ESCAPES, escape)) {
        value += SIMPLE_ESCAPES[escape];
        this.pos += 2;
      } else {
        throw new SyntaxFailure('invalid escape', this.pos);
      }
      chunk = this.pos;
    }
  }

  number(): JsonNumber {
    const start = this.pos;
    NUMBER.lastIndex = start;
    const match = NUMBER.exec(this.text);
    if (match === null) throw new SyntaxFailure('invalid number', start);
    this.pos += match[0].length;
    const next = this.text[this.pos];
    if (next !== undefined && /[0-9.eE+-]/.test(next)) throw new SyntaxFailure('invalid number', start);
    return { kind: 'number', value: Number(match[0]), start, end: this.pos };
  }

  expected(what: string): SyntaxFailure {
    const c = this.text[this.pos];
    return new SyntaxFailure(`expected ${what}, found ${c === undefined ? 'end of document' : describe(c)}`, this.pos);
  }
}

function describe(c: string): string {
  return /^[\x21-\x7e]$/.test(c) ? `'${c}'` : `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

// --- reading ---

/** Object member names (strings) and array indices (numbers), from the root. */
export type JsonPath = readonly (string | number)[];

/** The last member with this name (JSON.parse semantics for duplicates). */
export function findMember(object: JsonObject, name: string): JsonMember | undefined {
  for (let i = object.members.length - 1; i >= 0; i--) {
    if (object.members[i].name.value === name) return object.members[i];
  }
  return undefined;
}

/** The node at `path`, or undefined when a step is missing or has the wrong container type. */
export function findNode(root: JsonNode, path: JsonPath): JsonNode | undefined {
  let node: JsonNode | undefined = root;
  for (const step of path) {
    if (node === undefined) return undefined;
    if (typeof step === 'number') node = node.kind === 'array' ? node.items[step] : undefined;
    else node = node.kind === 'object' ? findMember(node, step)?.value : undefined;
  }
  return node;
}

/** The plain value of a node (same result as JSON.parse on its text). */
export function toValue(node: JsonNode): JsonValue {
  switch (node.kind) {
    case 'object': {
      const out: Record<string, JsonValue> = {};
      for (const member of node.members) {
        // defineProperty keeps a member named "__proto__" as plain data, like JSON.parse.
        Object.defineProperty(out, member.name.value, { value: toValue(member.value), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case 'array':
      return node.items.map(toValue);
    default:
      return node.value;
  }
}

// --- operations ---

/**
 * Value-level operations, all against the parsed document.
 * - `replace`: the value at `path` must exist
 * - `insert`: adds a member named by the last path step to the object at the rest of the
 *   path; the member must not exist yet
 * - `set`: `replace` when the value exists, otherwise `insert`
 * - `remove`: removes the object member at `path` together with one separating comma
 */
export type JsonOperation =
  | { readonly kind: 'replace' | 'insert' | 'set'; readonly path: JsonPath; readonly value: JsonValue }
  | { readonly kind: 'remove'; readonly path: JsonPath };

/**
 * - `path`: a path step is missing, has the wrong container type, or does not end in a member
 *   name where one is needed (insert, remove)
 * - `exists`: `insert` of a member that is already there
 * - `value`: the new value is not JSON (NaN, Infinity, undefined, functions, cycles)
 * - `overlap`: two operations touch the same value
 */
export type JsonPatchFailureReason = 'path' | 'exists' | 'value' | 'overlap';

export type JsonPatchResult =
  | { readonly ok: true; readonly edits: readonly TextEdit[] }
  | { readonly ok: false; readonly reason: JsonPatchFailureReason; readonly message: string };

class PatchFailure extends Error {
  readonly reason: JsonPatchFailureReason;
  constructor(reason: JsonPatchFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

interface RawEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Turns operations into minimal edits: only the changed value's range, or the inserted /
 * removed member with its separator. Edits are sorted, never overlap and refer to the
 * original document, so they can be applied together (one WorkspaceEdit). A replacement
 * with an equal value produces no edit, so the original spelling (`1.0`, `é`) stays.
 * Several inserts into one object are added in operation order as one edit.
 */
export function computeJsonPatch(doc: JsonDocument, operations: readonly JsonOperation[]): JsonPatchResult {
  try {
    const raw: RawEdit[] = [];
    const inserts = new Map<JsonObject, { name: string; value: JsonValue }[]>();
    const removals = new Map<JsonObject, Set<number>>();
    for (const op of operations) {
      if (op.kind === 'remove') {
        const { object, name } = parentObject(doc, op.path, op.kind);
        const member = findMember(object, name);
        if (member === undefined) throw new PatchFailure('path', `remove: no member ${quote(name)}`);
        const indices = removals.get(object) ?? new Set<number>();
        const index = object.members.indexOf(member);
        if (indices.has(index)) throw new PatchFailure('overlap', `member ${quote(name)} is removed twice`);
        removals.set(object, indices.add(index));
        continue;
      }
      const text = serialize(op.value);
      const existing = findNode(doc.root, op.path);
      if (existing !== undefined && op.kind !== 'insert') {
        if (!sameValue(toValue(existing), op.value)) raw.push({ start: existing.start, end: existing.end, text });
        continue;
      }
      if (op.kind === 'replace') throw new PatchFailure('path', `replace: no value at ${JSON.stringify(op.path)}`);
      const { object, name } = parentObject(doc, op.path, op.kind);
      if (findMember(object, name) !== undefined) throw new PatchFailure('exists', `member ${quote(name)} already exists`);
      const list = inserts.get(object) ?? [];
      if (list.some((entry) => entry.name === name)) throw new PatchFailure('overlap', `member ${quote(name)} is inserted twice`);
      list.push({ name, value: op.value });
      inserts.set(object, list);
    }
    for (const [object, indices] of removals) raw.push(...removeEdits(object, indices));
    for (const [object, members] of inserts) raw.push(insertEdit(doc, object, members));
    return { ok: true, edits: toTextEdits(doc, raw) };
  } catch (error) {
    if (error instanceof PatchFailure) return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
}

function quote(name: string): string {
  return JSON.stringify(name);
}

function parentObject(doc: JsonDocument, path: JsonPath, kind: string): { object: JsonObject; name: string } {
  const name = path[path.length - 1];
  const parent = path.length > 0 ? findNode(doc.root, path.slice(0, -1)) : undefined;
  if (typeof name !== 'string' || parent === undefined || parent.kind !== 'object') {
    throw new PatchFailure('path', `${kind}: no object member at ${JSON.stringify(path)}`);
  }
  return { object: parent, name };
}

/**
 * Removes members by index. Every run of removed members goes with the comma and whitespace
 * up to the next kept member; a run at the end goes from the previous kept member's end
 * instead. So the separator the kept members use stays, and a member that had its own line
 * takes that line with it. Removing every member empties the braces (`{}`).
 */
function removeEdits(object: JsonObject, indices: ReadonlySet<number>): RawEdit[] {
  const members = object.members;
  if (indices.size === members.length) return [{ start: object.start + 1, end: object.end - 1, text: '' }];
  const edits: RawEdit[] = [];
  for (let i = 0; i < members.length; i++) {
    if (!indices.has(i)) continue;
    let j = i;
    while (indices.has(j + 1)) j++;
    if (j < members.length - 1) edits.push({ start: members[i].start, end: members[j + 1].start, text: '' });
    else edits.push({ start: members[i - 1].end, end: members[j].end, text: '' });
    i = j;
  }
  return edits;
}

function insertEdit(doc: JsonDocument, object: JsonObject, members: readonly { name: string; value: JsonValue }[]): RawEdit {
  const style = memberStyle(doc, object);
  const texts = members.map(({ name, value }) => quote(name) + style.colon + serialize(value));
  if (object.members.length > 0) {
    const last = object.members[object.members.length - 1];
    return { start: last.end, end: last.end, text: texts.map((t) => style.separator + t).join('') };
  }
  return {
    start: object.start + 1,
    end: object.end - 1,
    text: style.open + texts.join(style.separator) + style.close,
  };
}

/** JSON text of a new value: one line; strings escape only what JSON requires (non-ASCII kept). */
function serialize(value: JsonValue): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_name, v: unknown) => {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new PatchFailure('value', `${v} is not a JSON number`);
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
        throw new PatchFailure('value', `${typeof v} is not a JSON value`);
      }
      return v;
    });
  } catch (error) {
    if (error instanceof PatchFailure) throw error;
    throw new PatchFailure('value', 'value cannot be written as JSON');
  }
  if (text === undefined) throw new PatchFailure('value', 'value cannot be written as JSON');
  return text;
}

function sameValue(a: JsonValue, b: JsonValue): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) || (a === 0 && b === 0);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ea = Object.entries(a);
  const eb = Object.entries(b);
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i][0] !== eb[i][0] || !sameValue(ea[i][1], eb[i][1])) return false;
  }
  return true;
}

function toTextEdits(doc: JsonDocument, raw: RawEdit[]): TextEdit[] {
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RawEdit[] = [];
  for (const edit of raw) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && (edit.start < prev.end || (edit.start === prev.start && edit.end === prev.end))) {
      throw new PatchFailure('overlap', `operations at offsets ${prev.start}..${prev.end} and ${edit.start}..${edit.end} overlap`);
    }
    // Edits that meet at an offset become one edit, so no two edits share a position.
    if (prev !== undefined && edit.start === prev.end) {
      prev.end = edit.end;
      prev.text += edit.text;
    } else {
      merged.push({ ...edit });
    }
  }
  return merged.map((edit) => ({
    range: { start: positionAt(doc, edit.start), end: positionAt(doc, edit.end) },
    newText: edit.text,
  }));
}

// --- formatting of inserted members ---
//
// Kept in one place so it can follow the exact Obsidian serialization once confirmed
// (canvas.md 9.1). Rules: copy the separator and colon spacing the object already uses;
// an empty object borrows from its surroundings.

interface MemberStyle {
  /** Between two members, comma included (`",\n\t"`, `", "`, `","`). */
  readonly separator: string;
  /** Between a name and its value (`": "`, `":"`). */
  readonly colon: string;
  /** After `{` and before `}` when filling an empty object. */
  readonly open: string;
  readonly close: string;
}

const DEFAULT_COLON = ': ';
const DEFAULT_INDENT = '\t';

function memberStyle(doc: JsonDocument, object: JsonObject): MemberStyle {
  const { text } = doc;
  const members = object.members;
  if (members.length > 0) {
    const last = members[members.length - 1];
    const colon = text.slice(last.name.end, last.value.start);
    // With two or more members, reuse the separator before the last one; with one, the
    // layout after `{` tells how members are placed.
    const separator =
      members.length > 1 ? text.slice(members[members.length - 2].end, last.start) : ',' + text.slice(object.start + 1, members[0].start);
    return { separator, colon, open: '', close: '' };
  }

  const parent = parentOf(doc.root, object);
  const colon = parent?.kind === 'object' && parent.members.length > 0 ? colonOf(text, parent) : firstColon(text, doc.root) ?? DEFAULT_COLON;
  const multiLine = parent === undefined ? firstLayoutIsMultiLine(text, doc.root) ?? true : spansLines(text, parent);
  if (!multiLine) {
    const pad = parent?.kind === 'object' && parent.members.length > 0 ? text.slice(parent.start + 1, parent.members[0].start) : '';
    return { separator: ',' + pad, colon, open: pad, close: pad };
  }
  const eol = dominantEol(parseLines(text));
  const outer = lineIndent(text, object.start);
  const inner = outer + (indentUnit(text, doc.root) ?? DEFAULT_INDENT);
  return { separator: ',' + eol + inner, colon, open: eol + inner, close: eol + outer };
}

function colonOf(text: string, object: JsonObject): string {
  const last = object.members[object.members.length - 1];
  return text.slice(last.name.end, last.value.start);
}

function containers(node: JsonNode): JsonNode[] {
  if (node.kind === 'object') return node.members.map((m) => m.value);
  if (node.kind === 'array') return [...node.items];
  return [];
}

/** Breadth-first search for the first node where `pick` gives an answer. */
function search<T>(root: JsonNode, pick: (node: JsonNode) => T | undefined): T | undefined {
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const found = pick(queue[i]);
    if (found !== undefined) return found;
    queue.push(...containers(queue[i]));
  }
  return undefined;
}

function parentOf(root: JsonNode, target: JsonNode): JsonObject | JsonArray | undefined {
  return search(root, (node) => (containers(node).includes(target) ? (node as JsonObject | JsonArray) : undefined));
}

function firstColon(text: string, root: JsonNode): string | undefined {
  return search(root, (node) => (node.kind === 'object' && node.members.length > 0 ? colonOf(text, node) : undefined));
}

function spansLines(text: string, node: Span): boolean {
  return text.slice(node.start, node.end).includes('\n');
}

function firstLayoutIsMultiLine(text: string, root: JsonNode): boolean | undefined {
  return search(root, (node) => {
    const first = node.kind === 'object' ? node.members[0] : node.kind === 'array' ? node.items[0] : undefined;
    return first === undefined ? undefined : text.slice(node.start + 1, first.start).includes('\n');
  });
}

/** Leading spaces and tabs of the line holding `offset`. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

/** Indentation added by the first multi-line container whose first entry starts a new line. */
function indentUnit(text: string, root: JsonNode): string | undefined {
  return search(root, (node) => {
    const first = node.kind === 'object' ? node.members[0] : node.kind === 'array' ? node.items[0] : undefined;
    if (first === undefined || !text.slice(node.start + 1, first.start).includes('\n')) return undefined;
    const outer = lineIndent(text, node.start);
    const inner = lineIndent(text, first.start);
    return inner.startsWith(outer) && inner.length > outer.length ? inner.slice(outer.length) : undefined;
  });
}
