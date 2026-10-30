// Canvas edits (canvas.md 5) as value-level JSON operations and minimal text edits. Pure. Each
// edit names a node by id and gives new values; only the values that change are written, in
// place (canvas.md 3.1), so unknown members, unknown node types and the drawing order stay.
//
// Unknown node types allow move and resize only (canvas.md 9.5). A read-only canvas (size
// limits, 9.8) and duplicated node ids refuse every edit.

import { computeJsonPatch, findNode, type JsonDocument, type JsonOperation } from '../../core/json-positions.ts';
import type { TextEdit } from '../../core/patch.ts';
import { MAX_COORDINATE, MAX_NODE_SIZE, nodesInGroup, type Canvas, type CanvasNode } from './model.ts';

/** Smallest width and height a resize may set. */
export const MIN_NODE_SIZE = 20;

/** Color presets the editor offers (canvas.md 5: six presets or none, no hex input). */
export const COLOR_PRESETS: readonly string[] = ['1', '2', '3', '4', '5', '6'];

export type CanvasEdit =
  /** New top-left corner; a group also moves the nodes drawn inside it. */
  | { readonly kind: 'move'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly kind: 'resize'; readonly id: string; readonly width: number; readonly height: number }
  /** New Markdown of a text node, as typed. */
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  /** A preset `"1"`-`"6"`, or null to remove the color. */
  | { readonly kind: 'color'; readonly id: string; readonly color: string | null };

/**
 * - `read-only`: the canvas is over the size limits
 * - `not-found`: no node with that id
 * - `ambiguous`: the id is used by several nodes, or the node has several `color` members
 * - `unsupported`: the edit does not apply to the node's type
 * - `value`: a new value is not an integer, out of range or not an allowed color
 * - `patch`: the JSON patch failed (for example two edits touching the same value)
 */
export type CanvasEditFailureReason = 'read-only' | 'not-found' | 'ambiguous' | 'unsupported' | 'value' | 'patch';

export type CanvasOperationsResult =
  | { readonly ok: true; readonly operations: readonly JsonOperation[] }
  | { readonly ok: false; readonly reason: CanvasEditFailureReason; readonly message: string };

export type CanvasPatchResult =
  | { readonly ok: true; readonly edits: readonly TextEdit[] }
  | { readonly ok: false; readonly reason: CanvasEditFailureReason; readonly message: string };

class EditFailure extends Error {
  readonly reason: CanvasEditFailureReason;
  constructor(reason: CanvasEditFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * The JSON operations for `edits`, against the document `canvas` was read from. A value is
 * written only when it differs from what the model shows, so an unchanged coordinate keeps
 * its original spelling.
 */
export function canvasOperations(doc: JsonDocument | null, canvas: Canvas, edits: readonly CanvasEdit[]): CanvasOperationsResult {
  try {
    if (canvas.readOnly) throw new EditFailure('read-only', 'the canvas is read-only');
    const operations: JsonOperation[] = [];
    for (const edit of edits) operations.push(...editOperations(doc, canvas, edit));
    return { ok: true, operations };
  } catch (error) {
    if (error instanceof EditFailure) return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
}

/** Minimal text edits for `edits` (one WorkspaceEdit), or why they cannot be made. */
export function computeCanvasPatch(doc: JsonDocument | null, canvas: Canvas, edits: readonly CanvasEdit[]): CanvasPatchResult {
  const result = canvasOperations(doc, canvas, edits);
  if (!result.ok) return result;
  if (result.operations.length === 0) return { ok: true, edits: [] };
  if (doc === null) return { ok: false, reason: 'patch', message: 'the canvas file is empty' };
  const patch = computeJsonPatch(doc, result.operations);
  return patch.ok ? patch : { ok: false, reason: 'patch', message: patch.message };
}

function editOperations(doc: JsonDocument | null, canvas: Canvas, edit: CanvasEdit): JsonOperation[] {
  const node = target(canvas, edit.id);
  const path = (n: CanvasNode, name: string) => ['nodes', n.index, name];
  switch (edit.kind) {
    case 'move': {
      checkInteger(edit.x, -MAX_COORDINATE, MAX_COORDINATE, 'x');
      checkInteger(edit.y, -MAX_COORDINATE, MAX_COORDINATE, 'y');
      const dx = edit.x - node.x;
      const dy = edit.y - node.y;
      const moved = node.kind === 'group' ? [node, ...nodesInGroup(canvas, node)] : [node];
      const operations: JsonOperation[] = [];
      for (const n of moved) {
        const x = n.x + dx;
        const y = n.y + dy;
        checkInteger(x, -MAX_COORDINATE, MAX_COORDINATE, `x of node ${JSON.stringify(n.id)}`);
        checkInteger(y, -MAX_COORDINATE, MAX_COORDINATE, `y of node ${JSON.stringify(n.id)}`);
        if (dx !== 0) operations.push({ kind: 'replace', path: path(n, 'x'), value: x });
        if (dy !== 0) operations.push({ kind: 'replace', path: path(n, 'y'), value: y });
      }
      return operations;
    }
    case 'resize': {
      checkInteger(edit.width, MIN_NODE_SIZE, MAX_NODE_SIZE, 'width');
      checkInteger(edit.height, MIN_NODE_SIZE, MAX_NODE_SIZE, 'height');
      const operations: JsonOperation[] = [];
      if (edit.width !== node.width) operations.push({ kind: 'replace', path: path(node, 'width'), value: edit.width });
      if (edit.height !== node.height) operations.push({ kind: 'replace', path: path(node, 'height'), value: edit.height });
      return operations;
    }
    case 'text': {
      if (node.kind !== 'text') throw new EditFailure('unsupported', `node ${JSON.stringify(node.id)} is not a text node`);
      if (typeof edit.text !== 'string') throw new EditFailure('value', 'text must be a string');
      return edit.text === node.text ? [] : [{ kind: 'replace', path: path(node, 'text'), value: edit.text }];
    }
    case 'color': {
      if (node.kind === 'unknown') throw new EditFailure('unsupported', `node ${JSON.stringify(node.id)} has an unsupported type`);
      if (edit.color !== null && !COLOR_PRESETS.includes(edit.color)) throw new EditFailure('value', `color must be a preset "1"-"6" or null`);
      const object = doc === null ? undefined : findNode(doc.root, ['nodes', node.index]);
      const colors = object?.kind === 'object' ? object.members.filter((m) => m.name.value === 'color').length : 0;
      if (colors > 1) throw new EditFailure('ambiguous', `node ${JSON.stringify(node.id)} has several "color" members`);
      if (edit.color === null) return colors === 0 ? [] : [{ kind: 'remove', path: path(node, 'color') }];
      return [{ kind: 'set', path: path(node, 'color'), value: edit.color }];
    }
  }
}

function target(canvas: Canvas, id: string): CanvasNode {
  if (canvas.duplicateNodeIds.includes(id)) throw new EditFailure('ambiguous', `node id ${JSON.stringify(id)} is used more than once`);
  const node = canvas.nodes.find((n) => n.id === id);
  if (node === undefined) throw new EditFailure('not-found', `no node ${JSON.stringify(id)}`);
  return node;
}

function checkInteger(value: number, min: number, max: number, what: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new EditFailure('value', `${what} must be an integer in ${min}..${max}`);
  }
}
