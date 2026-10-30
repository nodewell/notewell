// JSON Canvas 1.0 model and validation (canvas.md 0, 3, 7, 9.5, 9.8). Pure: the file text in,
// a plain, serializable model of nodes and edges plus a list of issues out. The model never
// writes; operations (operations.ts) patch values in place, so everything the model does not
// know (members, node types, number spellings) stays in the file untouched.
//
// Issues are errors or warnings. Any error makes the canvas unreadable (canvas.md 2: show the
// line and offer the text editor instead). Warnings keep the canvas readable: the offending
// value is ignored or normalized for display only. The size limits (canvas.md 9.8) also make
// the canvas read-only.

import { findMember, parseJson, positionAt, type JsonArray, type JsonDocument, type JsonNode, type JsonObject } from '../../core/json-positions.ts';
import type { Position } from '../../core/patch.ts';

/** Larger files are shown read-only (canvas.md 9.8). UTF-8 bytes, BOM included. */
export const MAX_CANVAS_BYTES = 5 * 1024 * 1024;
/** More nodes are shown read-only (canvas.md 9.8). */
export const MAX_CANVAS_NODES = 5000;
/** Coordinates beyond +-this are clamped for display (canvas.md 7: bounded integers). */
export const MAX_COORDINATE = 10_000_000;
/** Sizes above this are clamped for display; sizes below 1 are shown as 1. */
export const MAX_NODE_SIZE = 1_000_000;

export type NodeSide = 'top' | 'right' | 'bottom' | 'left';
export type EdgeEnd = 'none' | 'arrow';
export type BackgroundStyle = 'cover' | 'ratio' | 'repeat';

/** Presets 1-6 (red, orange, yellow, green, cyan, purple) or a hex color as `#rrggbb`. */
export type CanvasColor = { readonly kind: 'preset'; readonly preset: number } | { readonly kind: 'hex'; readonly hex: string };

interface NodeBase {
  /** Index in the file's `nodes` array (drawing order, first is bottom). */
  readonly index: number;
  readonly id: string;
  /** The `type` as written. */
  readonly type: string;
  /** Geometry as integers within the display limits (rounded and clamped when the file is not). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Absent when the file has no color or an invalid one (a warning then). */
  readonly color?: CanvasColor;
}

export interface TextNode extends NodeBase {
  readonly kind: 'text';
  readonly text: string;
}

export interface FileNode extends NodeBase {
  readonly kind: 'file';
  readonly file: string;
  /** Starts with `#` (heading or block). */
  readonly subpath?: string;
}

export interface LinkNode extends NodeBase {
  readonly kind: 'link';
  readonly url: string;
}

export interface GroupNode extends NodeBase {
  readonly kind: 'group';
  readonly label?: string;
  readonly background?: string;
  readonly backgroundStyle?: BackgroundStyle;
}

/** A node type JSON Canvas 1.0 does not define: drawn as a grey box, move and resize only (9.5). */
export interface UnknownNode extends NodeBase {
  readonly kind: 'unknown';
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode | UnknownNode;

export interface CanvasEdge {
  /** Index in the file's `edges` array. */
  readonly index: number;
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly fromSide?: NodeSide;
  readonly toSide?: NodeSide;
  /** Defaults applied: `none` at the start, `arrow` at the end. */
  readonly fromEnd: EdgeEnd;
  readonly toEnd: EdgeEnd;
  readonly color?: CanvasColor;
  readonly label?: string;
}

export type CanvasIssueCode =
  // errors
  | 'syntax'
  | 'root'
  | 'not-array'
  | 'not-object'
  | 'required'
  // warnings
  | 'not-integer'
  | 'out-of-range'
  | 'color'
  | 'field'
  | 'duplicate-node-id'
  | 'duplicate-edge-id'
  | 'dangling-edge'
  | 'too-large'
  | 'too-many-nodes';

export interface CanvasIssue {
  readonly severity: 'error' | 'warning';
  readonly code: CanvasIssueCode;
  /** English, for logs and tests; the UI builds its own text from `code`. */
  readonly message: string;
  /** Offset in the text without BOM, and its zero-based line and character. */
  readonly offset: number;
  readonly position: Position;
}

export interface Canvas {
  /** Every node, in file order. Duplicated ids are kept (see `duplicateNodeIds`). */
  readonly nodes: readonly CanvasNode[];
  /** Edges whose both ends exist, in file order. */
  readonly edges: readonly CanvasEdge[];
  /** Node ids that appear more than once: such nodes cannot be addressed by operations. */
  readonly duplicateNodeIds: readonly string[];
  /** True when the size limits are exceeded (canvas.md 9.8). */
  readonly readOnly: boolean;
  readonly issues: readonly CanvasIssue[];
}

export type CanvasReadResult =
  /** `doc` is null for an empty (whitespace-only) file, read as an empty canvas. */
  | { readonly ok: true; readonly canvas: Canvas; readonly doc: JsonDocument | null }
  /** At least one error; `issues` holds errors first, then warnings, each in file order. */
  | { readonly ok: false; readonly issues: readonly CanvasIssue[] };

const SIDES: readonly string[] = ['top', 'right', 'bottom', 'left'];
const ENDS: readonly string[] = ['none', 'arrow'];
const BACKGROUND_STYLES: readonly string[] = ['cover', 'ratio', 'repeat'];
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PRESET_COLOR = /^[1-6]$/;

/** Reads a `.canvas` file. */
export function readCanvas(source: string): CanvasReadResult {
  const bytes = utf8Length(source);
  if (source.replace(/^﻿/, '').trim() === '') {
    const issues: CanvasIssue[] = [];
    return { ok: true, canvas: { nodes: [], edges: [], duplicateNodeIds: [], readOnly: false, issues }, doc: null };
  }
  const parsed = parseJson(source);
  if (!parsed.ok) {
    const { message, offset, position } = parsed.error;
    return { ok: false, issues: [{ severity: 'error', code: 'syntax', message, offset, position }] };
  }
  const reader = new Reader(parsed.doc);
  const canvas = reader.read(bytes);
  const errors = reader.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) return { ok: false, issues: [...errors, ...reader.issues.filter((issue) => issue.severity !== 'error')] };
  return { ok: true, canvas, doc: parsed.doc };
}

/** Parses a color value: presets `"1"`-`"6"` and `#RGB`/`#RRGGBB` (normalized to `#rrggbb`). */
export function parseColor(value: string): CanvasColor | undefined {
  if (PRESET_COLOR.test(value)) return { kind: 'preset', preset: Number(value) };
  if (!HEX_COLOR.test(value)) return undefined;
  const digits = value.slice(1).toLowerCase();
  const hex = digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits;
  return { kind: 'hex', hex: '#' + hex };
}

/** Nodes drawn fully inside a group's rectangle (they move with it), the group excluded. */
export function nodesInGroup(canvas: Canvas, group: CanvasNode): CanvasNode[] {
  return canvas.nodes.filter(
    (node) =>
      node !== group &&
      node.x >= group.x &&
      node.y >= group.y &&
      node.x + node.width <= group.x + group.width &&
      node.y + node.height <= group.y + group.height,
  );
}

function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) length += 1;
    else if (c < 0x800) length += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}

class Reader {
  readonly doc: JsonDocument;
  readonly issues: CanvasIssue[] = [];

  constructor(doc: JsonDocument) {
    this.doc = doc;
  }

  issue(severity: CanvasIssue['severity'], code: CanvasIssueCode, message: string, at: { start: number }): void {
    this.issues.push({ severity, code, message, offset: at.start, position: positionAt(this.doc, at.start) });
  }

  read(bytes: number): Canvas {
    const root = this.doc.root;
    const empty = { nodes: [], edges: [], duplicateNodeIds: [], readOnly: false, issues: this.issues };
    if (root.kind !== 'object') {
      this.issue('error', 'root', 'the canvas must be a JSON object', root);
      return empty;
    }
    const nodes: CanvasNode[] = [];
    const nodeList = this.array(root, 'nodes');
    nodeList?.items.forEach((item, index) => {
      const node = this.node(item, index);
      if (node !== undefined) nodes.push(node);
    });

    const seen = new Map<string, number>();
    for (const node of nodes) seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    const duplicateNodeIds = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    for (const node of nodes) {
      if ((seen.get(node.id) ?? 0) > 1) this.issue('warning', 'duplicate-node-id', `node id ${JSON.stringify(node.id)} is used more than once`, nodeList!.items[node.index]);
    }

    const edges: CanvasEdge[] = [];
    const edgeList = this.array(root, 'edges');
    const edgeIds = new Set<string>();
    edgeList?.items.forEach((item, index) => {
      const edge = this.edge(item, index);
      if (edge === undefined) return;
      if (edgeIds.has(edge.id)) this.issue('warning', 'duplicate-edge-id', `edge id ${JSON.stringify(edge.id)} is used more than once`, item);
      edgeIds.add(edge.id);
      const missing = [edge.fromNode, edge.toNode].filter((id) => !seen.has(id));
      if (missing.length > 0) {
        this.issue('warning', 'dangling-edge', `edge ${JSON.stringify(edge.id)} points to a missing node ${JSON.stringify(missing[0])}`, item);
        return;
      }
      edges.push(edge);
    });

    let readOnly = false;
    if (bytes > MAX_CANVAS_BYTES) {
      readOnly = true;
      this.issue('warning', 'too-large', `the file is larger than ${MAX_CANVAS_BYTES} bytes; shown read-only`, root);
    }
    if (nodeList !== undefined && nodeList.items.length > MAX_CANVAS_NODES) {
      readOnly = true;
      this.issue('warning', 'too-many-nodes', `the canvas has more than ${MAX_CANVAS_NODES} nodes; shown read-only`, nodeList);
    }
    return { nodes, edges, duplicateNodeIds, readOnly, issues: this.issues };
  }

  /** An optional top-level array; anything but an array there is an error. */
  array(root: JsonObject, name: string): JsonArray | undefined {
    const member = findMember(root, name);
    if (member === undefined) return undefined;
    if (member.value.kind !== 'array') {
      this.issue('error', 'not-array', `"${name}" must be an array`, member.value);
      return undefined;
    }
    return member.value;
  }

  requiredString(object: JsonObject, name: string, what: string): string | undefined {
    const value = findMember(object, name)?.value;
    if (value?.kind === 'string') return value.value;
    this.issue('error', 'required', `${what} needs a string "${name}"`, value ?? object);
    return undefined;
  }

  optionalString(object: JsonObject, name: string, what: string, allowed?: readonly string[]): string | undefined {
    const value = findMember(object, name)?.value;
    if (value === undefined) return undefined;
    if (value.kind === 'string' && (allowed === undefined || allowed.includes(value.value))) return value.value;
    const expected = allowed === undefined ? 'a string' : `one of ${allowed.join(', ')}`;
    this.issue('warning', 'field', `${what}: "${name}" must be ${expected}; ignored`, value);
    return undefined;
  }

  /** A required number, rounded and clamped for display with a warning when needed. */
  geometry(object: JsonObject, name: string, what: string, min: number, max: number): number | undefined {
    const value = findMember(object, name)?.value;
    if (value?.kind !== 'number' || !Number.isFinite(value.value)) {
      this.issue('error', 'required', `${what} needs a number "${name}"`, value ?? object);
      return undefined;
    }
    let number = value.value;
    if (!Number.isInteger(number)) {
      this.issue('warning', 'not-integer', `${what}: "${name}" is not an integer; rounded for display`, value);
      number = Math.round(number);
    }
    if (number < min || number > max) {
      this.issue('warning', 'out-of-range', `${what}: "${name}" is outside ${min}..${max}; clamped for display`, value);
      number = Math.min(max, Math.max(min, number));
    }
    return number + 0; // no -0
  }

  color(object: JsonObject, what: string): CanvasColor | undefined {
    const value = findMember(object, 'color')?.value;
    if (value === undefined) return undefined;
    const color = value.kind === 'string' ? parseColor(value.value) : undefined;
    if (color === undefined) this.issue('warning', 'color', `${what}: "color" must be "1"-"6", #RGB or #RRGGBB; ignored`, value);
    return color;
  }

  node(item: JsonNode, index: number): CanvasNode | undefined {
    if (item.kind !== 'object') {
      this.issue('error', 'not-object', `node ${index} must be an object`, item);
      return undefined;
    }
    const what = `node ${index}`;
    const id = this.requiredString(item, 'id', what);
    const type = this.requiredString(item, 'type', what);
    const x = this.geometry(item, 'x', what, -MAX_COORDINATE, MAX_COORDINATE);
    const y = this.geometry(item, 'y', what, -MAX_COORDINATE, MAX_COORDINATE);
    const width = this.geometry(item, 'width', what, 1, MAX_NODE_SIZE);
    const height = this.geometry(item, 'height', what, 1, MAX_NODE_SIZE);
    const color = this.color(item, what);
    if (type === 'text') {
      const text = this.requiredString(item, 'text', what);
      if (text === undefined || id === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
      return withColor({ kind: 'text', index, id, type, x, y, width, height, text }, color);
    }
    if (type === 'file') {
      const file = this.requiredString(item, 'file', what);
      let subpath = this.optionalString(item, 'subpath', what);
      if (subpath !== undefined && !subpath.startsWith('#')) {
        this.issue('warning', 'field', `${what}: "subpath" must start with #; ignored`, findMember(item, 'subpath')!.value);
        subpath = undefined;
      }
      if (file === undefined || id === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
      const node: FileNode = { kind: 'file', index, id, type, x, y, width, height, file };
      return withColor(subpath === undefined ? node : { ...node, subpath }, color);
    }
    if (type === 'link') {
      const url = this.requiredString(item, 'url', what);
      if (url === undefined || id === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
      return withColor({ kind: 'link', index, id, type, x, y, width, height, url }, color);
    }
    if (type === 'group') {
      const label = this.optionalString(item, 'label', what);
      const background = this.optionalString(item, 'background', what);
      const backgroundStyle = this.optionalString(item, 'backgroundStyle', what, BACKGROUND_STYLES) as BackgroundStyle | undefined;
      if (id === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
      const node: { -readonly [P in keyof GroupNode]: GroupNode[P] } = { kind: 'group', index, id, type, x, y, width, height };
      if (label !== undefined) node.label = label;
      if (background !== undefined) node.background = background;
      if (backgroundStyle !== undefined) node.backgroundStyle = backgroundStyle;
      return withColor(node, color);
    }
    if (type === undefined || id === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
    return withColor({ kind: 'unknown', index, id, type, x, y, width, height }, color);
  }

  edge(item: JsonNode, index: number): CanvasEdge | undefined {
    if (item.kind !== 'object') {
      this.issue('error', 'not-object', `edge ${index} must be an object`, item);
      return undefined;
    }
    const what = `edge ${index}`;
    const id = this.requiredString(item, 'id', what);
    const fromNode = this.requiredString(item, 'fromNode', what);
    const toNode = this.requiredString(item, 'toNode', what);
    const fromSide = this.optionalString(item, 'fromSide', what, SIDES) as NodeSide | undefined;
    const toSide = this.optionalString(item, 'toSide', what, SIDES) as NodeSide | undefined;
    const fromEnd = (this.optionalString(item, 'fromEnd', what, ENDS) ?? 'none') as EdgeEnd;
    const toEnd = (this.optionalString(item, 'toEnd', what, ENDS) ?? 'arrow') as EdgeEnd;
    const label = this.optionalString(item, 'label', what);
    const color = this.color(item, what);
    if (id === undefined || fromNode === undefined || toNode === undefined) return undefined;
    const edge: { -readonly [P in keyof CanvasEdge]: CanvasEdge[P] } = { index, id, fromNode, toNode, fromEnd, toEnd };
    if (fromSide !== undefined) edge.fromSide = fromSide;
    if (toSide !== undefined) edge.toSide = toSide;
    if (label !== undefined) edge.label = label;
    if (color !== undefined) edge.color = color;
    return edge;
  }
}

function withColor<T extends CanvasNode>(node: T, color: CanvasColor | undefined): T {
  return color === undefined ? node : { ...node, color };
}
