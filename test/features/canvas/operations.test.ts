import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOM, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, type TextEdit } from '../../../src/core/patch.ts';
import { findNode, nodeText, type JsonDocument } from '../../../src/core/json-positions.ts';
import { readCanvas, type Canvas } from '../../../src/features/canvas/model.ts';
import {
  canvasOperations,
  computeCanvasPatch,
  MIN_NODE_SIZE,
  type CanvasEdit,
  type CanvasEditFailureReason,
} from '../../../src/features/canvas/operations.ts';
import { read, readFixture, stripBom, variants } from './support.ts';

function apply(source: string, edits: CanvasEdit[]): { output: string; textEdits: readonly TextEdit[]; doc: JsonDocument | null; canvas: Canvas } {
  const { canvas, doc } = read(source);
  const result = computeCanvasPatch(doc, canvas, edits);
  assert.ok(result.ok, result.ok ? '' : `${result.reason}: ${result.message}`);
  return { output: applyEdits(parseLines(source), result.edits), textEdits: result.edits, doc, canvas };
}

function refusal(source: string, edits: CanvasEdit[]): CanvasEditFailureReason | undefined {
  const { canvas, doc } = read(source);
  const result = computeCanvasPatch(doc, canvas, edits);
  return result.ok ? undefined : result.reason;
}

/** Offset in the text without BOM of an edit position (lines end at LF). */
function offsetOf(text: string, line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset = text.indexOf('\n', offset) + 1;
  return offset + character;
}

type Raw = Record<string, any>;

/** Nodes fully inside a group's rectangle, from the raw JSON (independent of the model). */
function insideGroup(nodes: Raw[], group: Raw): number[] {
  const out: number[] = [];
  nodes.forEach((n, i) => {
    if (n === group) return;
    if (n.x >= group.x && n.y >= group.y && n.x + n.width <= group.x + group.width && n.y + n.height <= group.y + group.height) out.push(i);
  });
  return out;
}

const NEW_TEXT = 'Edited "quote" \\ back\nnext line\ttab \u0001 é あ ' + String.fromCodePoint(0x1f600);

interface Case {
  readonly label: string;
  readonly edit: CanvasEdit;
  /** Member names of the node object whose values may change, per node index. */
  readonly touched: Map<number, string[]>;
  /** The expected meaning after the edit. */
  readonly expect: (value: Raw) => void;
}

/** Every applicable edit on every node of a canvas. */
function cases(canvas: Canvas, raw: Raw): Case[] {
  const out: Case[] = [];
  const nodes: Raw[] = raw.nodes ?? [];
  for (const node of canvas.nodes) {
    const i = node.index;
    const moved = node.kind === 'group' ? [i, ...insideGroup(nodes, nodes[i])] : [i];
    out.push({
      label: `move ${node.id}`,
      edit: { kind: 'move', id: node.id, x: node.x + 13, y: node.y - 7 },
      touched: new Map(moved.map((j) => [j, ['x', 'y']])),
      expect: (v) => moved.forEach((j) => { v.nodes[j].x += 13; v.nodes[j].y -= 7; }),
    });
    const width = Math.max(MIN_NODE_SIZE, node.width + 10);
    const height = Math.max(MIN_NODE_SIZE, node.height + 10);
    out.push({
      label: `resize ${node.id}`,
      edit: { kind: 'resize', id: node.id, width, height },
      touched: new Map([[i, ['width', 'height']]]),
      expect: (v) => { v.nodes[i].width = width; v.nodes[i].height = height; },
    });
    if (node.kind === 'text') {
      out.push({
        label: `text ${node.id}`,
        edit: { kind: 'text', id: node.id, text: NEW_TEXT },
        touched: new Map([[i, ['text']]]),
        expect: (v) => { v.nodes[i].text = NEW_TEXT; },
      });
    }
    if (node.kind !== 'unknown') {
      out.push({
        label: `color ${node.id}`,
        edit: { kind: 'color', id: node.id, color: '3' },
        touched: new Map([[i, ['color']]]),
        expect: (v) => { v.nodes[i].color = '3'; },
      });
      out.push({
        label: `clear color ${node.id}`,
        edit: { kind: 'color', id: node.id, color: null },
        touched: new Map([[i, ['color']]]),
        expect: (v) => { delete v.nodes[i].color; },
      });
    }
  }
  return out;
}

function lineBreaks(text: string): { lf: number; crlf: number } {
  const crlf = text.split('\r\n').length - 1;
  return { lf: text.split('\n').length - 1 - crlf, crlf };
}

test('preservation: every edit on every node of every fixture changes only its values', () => {
  let count = 0;
  for (const { name, source } of variants()) {
    const { canvas, doc } = read(source);
    const raw = JSON.parse(stripBom(source)) as Raw;
    for (const c of cases(canvas, raw)) {
      const label = `${name}: ${c.label}`;
      const { output, textEdits } = apply(source, [c.edit]);
      count++;

      // Meaning: exactly the expected change.
      const expected = structuredClone(raw);
      c.expect(expected);
      assert.deepEqual(JSON.parse(stripBom(output)), expected, label);

      // Bytes: each edit lies inside a touched value, or (adding or removing a member) inside
      // the touched node object without disturbing its other members.
      assert.ok(doc !== null);
      const text = doc.text;
      for (const edit of textEdits) {
        const start = offsetOf(text, edit.range.start.line, edit.range.start.character);
        const end = offsetOf(text, edit.range.end.line, edit.range.end.character);
        const inside = [...c.touched].some(([index, names]) => {
          const object = findNode(doc.root, ['nodes', index]);
          assert.ok(object?.kind === 'object');
          const values = names.map((n) => findNode(object, [n])).filter((v) => v !== undefined);
          if (values.some((v) => v.start === start && v.end === end)) return true;
          if (start < object.start || end > object.end) return false;
          // A member insert or removal: other members keep their exact text.
          const removed = text.slice(start, end);
          return object.members.every((m) => names.includes(m.name.value) || !removed.includes(nodeText(doc, m)));
        });
        assert.ok(inside, `${label}: edit ${start}..${end} outside the touched values`);
      }
      const otherMembers = [...c.touched].flatMap(([index, names]) => {
        const object = findNode(doc.root, ['nodes', index]);
        return object?.kind === 'object' ? object.members.filter((m) => !names.includes(m.name.value)).map((m) => nodeText(doc, m)) : [];
      });
      for (const member of otherMembers) assert.ok(stripBom(output).includes(member), `${label}: kept ${member}`);

      // File shape: BOM, final newline, line endings.
      assert.equal(output.startsWith(BOM), source.startsWith(BOM), label);
      assert.equal(/\n$/.test(output), /\n$/.test(source), label);
      const before = lineBreaks(source);
      const after = lineBreaks(output);
      if (before.crlf === 0) assert.equal(after.crlf, 0, `${label}: no CRLF in an LF file`);
      if (before.lf === 0 && before.crlf > 0) assert.equal(after.lf, 0, `${label}: no LF in a CRLF file`);

      // Idempotent: the same edit on the result changes nothing.
      const again = apply(output, [c.edit]);
      assert.equal(again.textEdits.length, 0, `${label}: second application`);
      assert.equal(again.output, output, label);
    }
  }
  assert.ok(count > 100, `ran ${count} cases`);
});

test('preservation: unknown members, unknown types and number spellings stay byte for byte', () => {
  const source = readFixture('04-unknown.canvas');
  const moved = apply(source, [{ kind: 'move', id: 'u1', x: 1, y: 40 }]).output;
  assert.equal(moved, source.replace('"y": 2e1', '"y": 40'), 'x spelled 1.0 is not rewritten');
  const resized = apply(source, [{ kind: 'resize', id: 'u1', width: 150, height: 100 }]).output;
  assert.equal(resized, source.replace('"width": 100, "height": 100, "sticker"', '"width": 150, "height": 100, "sticker"'));
  const text = apply(source, [{ kind: 'text', id: 'u2', text: 'changed' }]).output;
  assert.equal(text, source.replace('"kept"', '"changed"'));
  const colored = apply(source, [{ kind: 'color', id: 'u2', color: '2' }]).output;
  assert.equal(colored, source.replace('"plugin-data": [1, 2, { "deep": [true, false, null] }] }', '"plugin-data": [1, 2, { "deep": [true, false, null] }], "color": "2" }'));
});

test('unknown node types allow move and resize only (canvas.md 9.5)', () => {
  const source = readFixture('04-unknown.canvas');
  assert.equal(refusal(source, [{ kind: 'text', id: 'u1', text: 'x' }]), 'unsupported');
  assert.equal(refusal(source, [{ kind: 'color', id: 'u1', color: '1' }]), 'unsupported');
  assert.equal(refusal(source, [{ kind: 'color', id: 'u1', color: null }]), 'unsupported');
  assert.equal(refusal(source, [{ kind: 'move', id: 'u1', x: 5, y: 5 }]), undefined);
  assert.equal(refusal(source, [{ kind: 'resize', id: 'u1', width: 50, height: 50 }]), undefined);
});

test('text content applies to text nodes only', () => {
  const source = readFixture('01-tabs-node-per-line.canvas');
  assert.equal(refusal(source, [{ kind: 'text', id: 'b2', text: 'x' }]), 'unsupported');
  assert.equal(refusal(source, [{ kind: 'text', id: 'c3', text: 'x' }]), 'unsupported');
  const out = apply(source, [{ kind: 'text', id: 'a1', text: 'a "b"\nc' }]).output;
  assert.equal(out, source.replace('"# Plan\\n\\n- first\\n- second"', '"a \\"b\\"\\nc"'));
});

test('color: set a preset, replace, clear; follows the object layout', () => {
  const tabs = readFixture('01-tabs-node-per-line.canvas');
  assert.equal(apply(tabs, [{ kind: 'color', id: 'a1', color: '3' }]).output, tabs.replace('"height":140}', '"height":140,"color":"3"}'));
  assert.equal(apply(tabs, [{ kind: 'color', id: 'b2', color: '1' }]).output, tabs.replace('"color":"4"', '"color":"1"'));
  assert.equal(apply(tabs, [{ kind: 'color', id: 'b2', color: null }]).output, tabs.replace(',"color":"4"', ''));
  assert.equal(apply(tabs, [{ kind: 'color', id: 'b2', color: '4' }]).textEdits.length, 0);
  assert.equal(apply(tabs, [{ kind: 'color', id: 'a1', color: null }]).textEdits.length, 0);

  const spaced = readFixture('02-spaces-expanded.canvas');
  assert.equal(apply(spaced, [{ kind: 'color', id: 'n1', color: '5' }]).output, spaced.replace('"height": 100\n    },', '"height": 100,\n      "color": "5"\n    },'));
  assert.equal(apply(spaced, [{ kind: 'color', id: 'n2', color: null }]).output, spaced.replace(',\n      "color": "#FF8800"', ''));
  assert.equal(apply(spaced, [{ kind: 'color', id: 'n2', color: '2' }]).output, spaced.replace('"#FF8800"', '"2"'), 'a hex color is replaced by a preset');

  const crlf = spaced.replace(/\n/g, '\r\n');
  assert.equal(apply(crlf, [{ kind: 'color', id: 'n1', color: '5' }]).output, crlf.replace('"height": 100\r\n    },', '"height": 100,\r\n      "color": "5"\r\n    },'));

  for (const bad of ['0', '7', '#ff0000', 'red', '']) assert.equal(refusal(tabs, [{ kind: 'color', id: 'a1', color: bad }]), 'value', bad);
  const twice = '{"nodes":[{"id":"a","type":"group","x":0,"y":0,"width":10,"height":10,"color":"1","color":"2"}]}';
  assert.equal(refusal(twice, [{ kind: 'color', id: 'a', color: null }]), 'ambiguous');
  assert.equal(refusal(twice, [{ kind: 'color', id: 'a', color: '3' }]), 'ambiguous');
});

test('move: a group carries the nodes drawn inside it; others stay', () => {
  const source = JSON.stringify(
    {
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100 },
        { id: 'in', type: 'text', text: '', x: 10, y: 10, width: 20, height: 20 },
        { id: 'inner', type: 'group', x: 40, y: 40, width: 50, height: 50 },
        { id: 'deep', type: 'text', text: '', x: 50, y: 50, width: 20, height: 20 },
        { id: 'half', type: 'text', text: '', x: 90, y: 90, width: 20, height: 20 },
      ],
    },
    null,
    '\t',
  );
  const out = JSON.parse(apply(source, [{ kind: 'move', id: 'g', x: 5, y: 0 }]).output);
  assert.deepEqual(out.nodes.map((n: Raw) => [n.id, n.x, n.y]), [['g', 5, 0], ['in', 15, 10], ['inner', 45, 40], ['deep', 55, 50], ['half', 90, 90]]);
  const inner = JSON.parse(apply(source, [{ kind: 'move', id: 'inner', x: 40, y: 30 }]).output);
  assert.deepEqual(inner.nodes.map((n: Raw) => [n.id, n.x, n.y]), [['g', 0, 0], ['in', 10, 10], ['inner', 40, 30], ['deep', 50, 40], ['half', 90, 90]]);
  assert.equal(apply(source, [{ kind: 'move', id: 'g', x: 0, y: 0 }]).textEdits.length, 0, 'no change, no edit');
  // A text node is not a group: it moves alone even when nodes lie inside it.
  const alone = JSON.parse(apply(source, [{ kind: 'move', id: 'in', x: 0, y: 0 }]).output);
  assert.deepEqual(alone.nodes.map((n: Raw) => n.x), [0, 0, 40, 50, 90]);
});

test('move: only the changed axis is written, so a non-integer stays when its axis does not move', () => {
  const source = '{"nodes":[{"id":"a","type":"text","text":"","x":10.5,"y":3,"width":30,"height":30}]}';
  const { canvas } = read(source);
  assert.equal(canvas.nodes[0].x, 11);
  assert.equal(apply(source, [{ kind: 'move', id: 'a', x: 11, y: 8 }]).output, source.replace('"y":3', '"y":8'));
  assert.equal(apply(source, [{ kind: 'move', id: 'a', x: 20, y: 3 }]).output, source.replace('"x":10.5', '"x":20'));
});

test('new values must be integers within the limits', () => {
  const source = readFixture('03-one-line.canvas');
  const cases: CanvasEdit[] = [
    { kind: 'move', id: 'x', x: 1.5, y: 0 },
    { kind: 'move', id: 'x', x: 0, y: Number.NaN },
    { kind: 'move', id: 'x', x: 1e8, y: 0 },
    { kind: 'resize', id: 'x', width: MIN_NODE_SIZE - 1, height: 50 },
    { kind: 'resize', id: 'x', width: 50, height: 2e6 },
    { kind: 'resize', id: 'x', width: 50.5, height: 50 },
    { kind: 'move', id: 'x', x: '1' as unknown as number, y: 0 },
    { kind: 'text', id: 'x', text: 5 as unknown as string },
  ];
  for (const edit of cases) assert.equal(refusal(source, [edit]), 'value', JSON.stringify(edit));
  const group = '{"nodes":[{"id":"g","type":"group","x":0,"y":0,"width":100,"height":100},{"id":"t","type":"text","text":"","x":9999990,"y":0,"width":1,"height":1}]}';
  assert.equal(refusal(group.replace('"x":9999990', '"x":50'), [{ kind: 'move', id: 'g', x: 9999990, y: 0 }]), 'value', 'a carried node would leave the limits');
  assert.equal(refusal(source, [{ kind: 'resize', id: 'x', width: MIN_NODE_SIZE, height: MIN_NODE_SIZE }]), undefined);
});

test('unknown ids, duplicated ids and read-only canvases are refused', () => {
  const source = readFixture('03-one-line.canvas');
  assert.equal(refusal(source, [{ kind: 'move', id: 'nope', x: 0, y: 0 }]), 'not-found');
  assert.equal(refusal('', [{ kind: 'move', id: 'a', x: 0, y: 0 }]), 'not-found');
  assert.deepEqual(apply('', []).textEdits, []);
  const dup = '{"nodes":[{"id":"a","type":"group","x":0,"y":0,"width":10,"height":10},{"id":"a","type":"group","x":0,"y":0,"width":10,"height":10},{"id":"b","type":"group","x":0,"y":0,"width":30,"height":30}]}';
  assert.equal(refusal(dup, [{ kind: 'move', id: 'a', x: 1, y: 1 }]), 'ambiguous');
  assert.equal(refusal(dup, [{ kind: 'move', id: 'b', x: 1, y: 1 }]), undefined, 'other nodes stay editable');

  const many = JSON.stringify({ nodes: Array.from({ length: 5001 }, (_, i) => ({ id: `n${i}`, type: 'group', x: 0, y: 0, width: 10, height: 10 })) });
  const result = readCanvas(many);
  assert.ok(result.ok && result.canvas.readOnly);
  if (result.ok) assert.deepEqual(canvasOperations(result.doc, result.canvas, [{ kind: 'resize', id: 'n0', width: 20, height: 20 }]), { ok: false, reason: 'read-only', message: 'the canvas is read-only' });
});

test('several edits combine into one patch; edits touching the same value are refused', () => {
  const source = readFixture('02-spaces-expanded.canvas');
  const out = apply(source, [
    { kind: 'move', id: 'n1', x: 5, y: 6 },
    { kind: 'resize', id: 'n1', width: 210, height: 110 },
    { kind: 'text', id: 'n1', text: 'Bye' },
    { kind: 'color', id: 'n2', color: null },
  ]).output;
  const value = JSON.parse(out);
  assert.deepEqual(value.nodes[0], { id: 'n1', type: 'text', text: 'Bye', x: 5, y: 6, width: 210, height: 110 });
  assert.equal(value.nodes[1].color, undefined);
  assert.equal(refusal(source, [{ kind: 'move', id: 'n1', x: 5, y: 6 }, { kind: 'move', id: 'n1', x: 7, y: 8 }]), 'patch');
});

test('operations are value paths into the nodes array', () => {
  const { canvas, doc } = read(readFixture('01-tabs-node-per-line.canvas'));
  const result = canvasOperations(doc, canvas, [{ kind: 'move', id: 'c3', x: -250, y: -180 }]);
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.operations, [
      { kind: 'replace', path: ['nodes', 2, 'x'], value: -250 },
      { kind: 'replace', path: ['nodes', 0, 'x'], value: -190 },
      { kind: 'replace', path: ['nodes', 1, 'x'], value: 110 },
    ]);
  }
});
