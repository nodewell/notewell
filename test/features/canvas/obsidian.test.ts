// Files saved by Obsidian 1.12.7's canvas view (test/fixtures/canvas/obsidian/, canvas.md 0 and
// 9.1): Notewell's edits must mean what Obsidian's do, written in Obsidian's own spelling, and
// a file Notewell edited must survive Obsidian saving it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLines } from '../../../src/core/lines.ts';
import { applyEdits } from '../../../src/core/patch.ts';
import { computeCanvasPatch, type CanvasEdit } from '../../../src/features/canvas/operations.ts';
import { read } from './support.ts';

const dir = new URL('../../fixtures/canvas/obsidian/', import.meta.url);
const created = readFileSync(new URL('1-created.canvas', dir), 'utf8');
const obsidianEdited = readFileSync(new URL('2-obsidian-moved-colored.canvas', dir), 'utf8');
const notewellEdited = readFileSync(new URL('3-notewell-edited.canvas', dir), 'utf8');
const resaved = readFileSync(new URL('4-obsidian-resaved.canvas', dir), 'utf8');

const TEXT_ID = '0ef984af45027cc7';
const LIST_ID = '14b35a1674036d60';

type Raw = Record<string, any>;

function apply(source: string, edits: CanvasEdit[]): string {
  const { canvas, doc } = read(source);
  const result = computeCanvasPatch(doc, canvas, edits);
  assert.ok(result.ok, result.ok ? '' : `${result.reason}: ${result.message}`);
  return applyEdits(parseLines(source), result.edits);
}

/** Nodes and edges by id: Obsidian reorders the nodes array when a card is selected. */
function byId(source: string): { nodes: Map<string, Raw>; edges: Map<string, Raw> } {
  const value = JSON.parse(source);
  return {
    nodes: new Map(value.nodes.map((n: Raw) => [n.id, n])),
    edges: new Map(value.edges.map((e: Raw) => [e.id, e])),
  };
}

/** The node's line without the separating comma (its position in the array differs). */
function lineOf(source: string, id: string): string {
  const line = source.split('\n').find((l) => l.includes(`"id":"${id}"`));
  assert.ok(line, id);
  return line.replace(/,$/, '');
}

test('Obsidian files read without issues', () => {
  for (const source of [created, obsidianEdited, notewellEdited, resaved]) {
    const { canvas } = read(source);
    assert.deepEqual(canvas.issues, []);
    assert.equal(canvas.nodes.length, 6);
    assert.equal(canvas.edges.length, 1);
  }
});

test('the move and color Obsidian made, made by Notewell, mean the same and are spelled the same', () => {
  const output = apply(created, [
    { kind: 'move', id: TEXT_ID, x: 40, y: 20 },
    { kind: 'color', id: LIST_ID, color: '4' },
  ]);
  assert.deepEqual(byId(output), byId(obsidianEdited));
  // A new color member goes at the end of the one-line object without spaces, as Obsidian writes it.
  assert.equal(lineOf(output, LIST_ID), lineOf(obsidianEdited, LIST_ID));
  assert.equal(lineOf(output, TEXT_ID), lineOf(obsidianEdited, TEXT_ID));
  // Notewell keeps the drawing order (canvas.md 3.2); Obsidian moved the selected card to the end.
  assert.equal(output.split('\n').length, created.split('\n').length);
});

test('Notewell edits on an Obsidian file touch only their values', () => {
  const output = apply(obsidianEdited, [
    { kind: 'text', id: TEXT_ID, text: '한글 텍스트 😀 "따옴표" \\ 역슬래시 (VS Code)' },
    { kind: 'move', id: TEXT_ID, x: 60, y: 20 },
    { kind: 'resize', id: TEXT_ID, width: 260, height: 130 },
    { kind: 'color', id: LIST_ID, color: '2' },
  ]);
  assert.equal(output, notewellEdited);
});

test('Obsidian saving a file Notewell edited loses nothing Notewell wrote', () => {
  const before = byId(notewellEdited);
  const after = byId(resaved);
  assert.deepEqual(after.edges, before.edges);
  for (const [id, node] of before.nodes) {
    // The group was moved in Obsidian in that step; every other value is unchanged.
    const expected = id === '3e60eea8256ac47e' ? { ...node, x: -60 } : node;
    assert.deepEqual(after.nodes.get(id), expected, id);
  }
});
