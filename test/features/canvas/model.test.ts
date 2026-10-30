import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CANVAS_BYTES,
  MAX_CANVAS_NODES,
  MAX_COORDINATE,
  MAX_NODE_SIZE,
  nodesInGroup,
  parseColor,
  readCanvas,
  type CanvasIssue,
} from '../../../src/features/canvas/model.ts';
import { read, readFixture, variants } from './support.ts';

function issues(source: string): CanvasIssue[] {
  const result = readCanvas(source);
  return [...(result.ok ? result.canvas.issues : result.issues)];
}

function codes(source: string): string[] {
  return issues(source).map((issue) => `${issue.severity}:${issue.code}`);
}

const node = (fields: string) => `{"nodes":[{"id":"a","type":"text","text":"t","x":0,"y":0,"width":10,"height":10${fields}}]}`;

test('every fixture variant reads without errors, nodes and edges in file order', () => {
  for (const { name, source } of variants()) {
    const result = readCanvas(source);
    assert.ok(result.ok, name);
    if (!result.ok) continue;
    assert.equal(result.canvas.readOnly, false, name);
    assert.deepEqual(result.canvas.nodes.map((n) => n.index), result.canvas.nodes.map((_, i) => i), name);
  }
});

test('the four node types and their fields are read', () => {
  const { canvas } = read(readFixture('01-tabs-node-per-line.canvas'));
  assert.deepEqual(canvas.nodes[0], { kind: 'text', index: 0, id: 'a1', type: 'text', x: -200, y: -120, width: 250, height: 140, text: '# Plan\n\n- first\n- second' });
  assert.deepEqual(canvas.nodes[1], {
    kind: 'file', index: 1, id: 'b2', type: 'file', x: 100, y: -120, width: 400, height: 300, file: 'Notes/Weekly.md', color: { kind: 'preset', preset: 4 },
  });
  assert.deepEqual(canvas.nodes[2], { kind: 'group', index: 2, id: 'c3', type: 'group', x: -260, y: -180, width: 800, height: 500, label: 'Week' });
  assert.deepEqual(canvas.edges, [{ index: 0, id: 'e1', fromNode: 'a1', toNode: 'b2', fromSide: 'right', toSide: 'left', fromEnd: 'none', toEnd: 'arrow' }]);
  assert.deepEqual(canvas.issues, []);

  const two = read(readFixture('02-spaces-expanded.canvas')).canvas;
  assert.equal(two.nodes[1].kind, 'link');
  assert.equal(two.nodes[1].kind === 'link' && two.nodes[1].url, 'https://example.com/');
  assert.deepEqual(two.nodes[1].color, { kind: 'hex', hex: '#ff8800' });
  assert.deepEqual(two.edges[0], { index: 0, id: 'e1', fromNode: 'n1', toNode: 'n2', fromEnd: 'none', toEnd: 'none', label: 'see' });
});

test('file subpath, group background and edge options', () => {
  const source = JSON.stringify({
    nodes: [
      { id: 'f', type: 'file', file: 'a.md', subpath: '#Heading', x: 0, y: 0, width: 10, height: 10 },
      { id: 'g', type: 'group', background: 'img.png', backgroundStyle: 'ratio', x: 0, y: 0, width: 10, height: 10, color: '#ABC' },
    ],
    edges: [{ id: 'e', fromNode: 'f', toNode: 'g', fromEnd: 'arrow', toEnd: 'none', color: '6' }],
  });
  const { canvas } = read(source);
  assert.equal(canvas.nodes[0].kind === 'file' && canvas.nodes[0].subpath, '#Heading');
  assert.deepEqual(canvas.nodes[1], {
    kind: 'group', index: 1, id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10, background: 'img.png', backgroundStyle: 'ratio', color: { kind: 'hex', hex: '#aabbcc' },
  });
  assert.deepEqual(canvas.edges[0], { index: 0, id: 'e', fromNode: 'f', toNode: 'g', fromEnd: 'arrow', toEnd: 'none', color: { kind: 'preset', preset: 6 } });
});

test('unknown node types and unknown members are kept in the model as unknown nodes', () => {
  const { canvas } = read(readFixture('04-unknown.canvas'));
  assert.deepEqual(canvas.nodes[0], { kind: 'unknown', index: 0, id: 'u1', type: 'sticker', x: 1, y: 20, width: 100, height: 100 });
  assert.equal(canvas.nodes[1].kind, 'text');
  assert.deepEqual(canvas.issues, [], 'integer values spelled 1.0 or 2e1 are integers');
});

test('empty and whitespace-only files are an empty canvas without a document', () => {
  for (const source of ['', '  \n', '﻿', '﻿\r\n']) {
    const result = readCanvas(source);
    assert.ok(result.ok);
    if (!result.ok) continue;
    assert.equal(result.doc, null);
    assert.deepEqual(result.canvas.nodes, []);
  }
  for (const source of ['{}', '{"nodes":[],"edges":[]}']) {
    const { canvas, doc } = read(source);
    assert.notEqual(doc, null);
    assert.deepEqual(canvas.nodes, []);
    assert.deepEqual(canvas.edges, []);
  }
});

test('errors make the canvas unreadable and carry the line', () => {
  const syntax = readCanvas('{\n\t"nodes": [\n\t\t{"id": }\n\t]\n}');
  assert.equal(syntax.ok, false);
  if (!syntax.ok) {
    assert.equal(syntax.issues[0].code, 'syntax');
    assert.deepEqual(syntax.issues[0].position, { line: 2, character: 9 });
  }
  assert.deepEqual(codes('[]'), ['error:root']);
  assert.deepEqual(codes('"x"'), ['error:root']);
  assert.deepEqual(codes('{"nodes":{}}'), ['error:not-array']);
  assert.deepEqual(codes('{"nodes":null}'), ['error:not-array']);
  assert.deepEqual(codes('{"edges":"x"}'), ['error:not-array']);
  assert.deepEqual(codes('{"nodes":[1]}'), ['error:not-object']);
  assert.deepEqual(codes('{"edges":[[]]}'), ['error:not-object']);

  const missingX = readCanvas('{\n"nodes":[\n{"id":"a","type":"text","text":"t","y":0,"width":10,"height":10}\n]}');
  assert.equal(missingX.ok, false);
  if (!missingX.ok) {
    assert.equal(missingX.issues[0].code, 'required');
    assert.equal(missingX.issues[0].position.line, 2, 'points at the node');
  }
});

test('required fields: common to all nodes, per type, and on edges', () => {
  const required = (n: Record<string, unknown>) => codes(JSON.stringify({ nodes: [n] }));
  const base = { id: 'a', x: 0, y: 0, width: 10, height: 10 };
  assert.deepEqual(required({ ...base, type: 'text' }), ['error:required'], 'text needs text');
  assert.deepEqual(required({ ...base, type: 'text', text: 1 }), ['error:required']);
  assert.deepEqual(required({ ...base, type: 'file' }), ['error:required'], 'file needs file');
  assert.deepEqual(required({ ...base, type: 'link' }), ['error:required'], 'link needs url');
  assert.deepEqual(required({ ...base, type: 'group' }), [], 'group has no required content');
  assert.deepEqual(required({ ...base, type: 'sticker' }), [], 'unknown types need only the common fields');
  assert.deepEqual(required({ ...base, type: 'sticker', id: 5 }), ['error:required']);
  assert.deepEqual(required({ ...base, type: 'group', x: '0' }), ['error:required']);
  assert.deepEqual(required({ id: 'a', x: 0, y: 0, width: 10, height: 10 }), ['error:required'], 'type is required');
  assert.deepEqual(required({ id: 'a', type: 'sticker' }), ['error:required', 'error:required', 'error:required', 'error:required']);
  assert.deepEqual(codes('{"nodes":[{"id":"a","type":"group","x":1e400,"y":0,"width":10,"height":10}]}'), ['error:required'], 'infinite is not a number');
  assert.deepEqual(codes('{"edges":[{"id":"e","fromNode":"a"}]}'), ['error:required']);
  assert.deepEqual(codes('{"edges":[{"fromNode":"a","toNode":"b"}]}'), ['error:required']);
});

test('errors come first, then warnings', () => {
  const result = readCanvas('{"nodes":[{"id":"a","type":"group","x":0.5,"y":0,"width":10,"height":10},{"id":"b","type":"text","x":0,"y":0,"width":10,"height":10}]}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.issues.map((i) => i.code), ['required', 'not-integer']);
});

test('colors: presets 1-6 and #RGB/#RRGGBB only', () => {
  assert.deepEqual(parseColor('1'), { kind: 'preset', preset: 1 });
  assert.deepEqual(parseColor('6'), { kind: 'preset', preset: 6 });
  assert.deepEqual(parseColor('#FF8800'), { kind: 'hex', hex: '#ff8800' });
  assert.deepEqual(parseColor('#a1B'), { kind: 'hex', hex: '#aa11bb' });
  for (const bad of ['0', '7', '10', '', 'red', '#ff88', '#ff88001', 'ff8800', '#gg0000', ' 1', 'rgb(1,2,3)', 'url(x)']) {
    assert.equal(parseColor(bad), undefined, bad);
  }
  for (const bad of ['"7"', '"red"', '4', 'null', '["1"]']) {
    const result = readCanvas(node(`,"color":${bad}`));
    assert.ok(result.ok, bad);
    if (!result.ok) continue;
    assert.equal(result.canvas.nodes[0].color, undefined, bad);
    assert.deepEqual(result.canvas.issues.map((i) => i.code), ['color'], bad);
  }
  assert.deepEqual(codes('{"nodes":[{"id":"a","type":"group","x":0,"y":0,"width":1,"height":1}],"edges":[{"id":"e","fromNode":"a","toNode":"a","color":"#12"}]}'), ['warning:color']);
});

test('geometry: integers within limits; others are rounded or clamped for display with a warning', () => {
  const at = (fields: string) => {
    const result = readCanvas(`{"nodes":[{"id":"a","type":"group",${fields}}]}`);
    assert.ok(result.ok);
    return result.ok ? { node: result.canvas.nodes[0], codes: result.canvas.issues.map((i) => i.code) } : undefined;
  };
  assert.deepEqual(at('"x":1.0,"y":-0,"width":2e2,"height":10'), { node: { kind: 'group', index: 0, id: 'a', type: 'group', x: 1, y: 0, width: 200, height: 10 }, codes: [] });
  assert.ok(Object.is(at('"x":0,"y":-0,"width":1,"height":1')?.node.y, 0), 'no -0');
  assert.deepEqual(at('"x":10.4,"y":-2.5,"width":1,"height":1')?.codes, ['not-integer', 'not-integer']);
  assert.equal(at('"x":10.6,"y":0,"width":1,"height":1')?.node.x, 11);
  const big = at(`"x":1e12,"y":-1e12,"width":1e12,"height":0`);
  assert.deepEqual(big?.codes, ['out-of-range', 'out-of-range', 'out-of-range', 'out-of-range']);
  assert.equal(big?.node.x, MAX_COORDINATE);
  assert.equal(big?.node.y, -MAX_COORDINATE);
  assert.equal(big?.node.width, MAX_NODE_SIZE);
  assert.equal(big?.node.height, 1);
  assert.deepEqual(at('"x":0,"y":0,"width":-5,"height":1')?.node.width, 1);
});

test('optional fields with wrong values are ignored with a warning', () => {
  const result = readCanvas(JSON.stringify({
    nodes: [
      { id: 'f', type: 'file', file: 'a.md', subpath: 'Heading', x: 0, y: 0, width: 10, height: 10 },
      { id: 'g', type: 'group', label: 3, backgroundStyle: 'stretch', x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [{ id: 'e', fromNode: 'f', toNode: 'g', fromSide: 'middle', toEnd: 'circle', label: false }],
  }));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.canvas.issues.map((i) => i.code), ['field', 'field', 'field', 'field', 'field', 'field']);
  assert.equal(result.canvas.nodes[0].kind === 'file' && result.canvas.nodes[0].subpath, undefined);
  assert.deepEqual(result.canvas.nodes[1], { kind: 'group', index: 1, id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10 });
  assert.deepEqual(result.canvas.edges[0], { index: 0, id: 'e', fromNode: 'f', toNode: 'g', fromEnd: 'none', toEnd: 'arrow' });
});

test('duplicate ids and dangling edges are warnings', () => {
  const result = readCanvas(JSON.stringify({
    nodes: [
      { id: 'a', type: 'group', x: 0, y: 0, width: 10, height: 10 },
      { id: 'a', type: 'group', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', type: 'group', x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [
      { id: 'e', fromNode: 'a', toNode: 'b' },
      { id: 'e', fromNode: 'b', toNode: 'a' },
      { id: 'f', fromNode: 'b', toNode: 'missing' },
    ],
  }));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.canvas.duplicateNodeIds, ['a']);
  assert.equal(result.canvas.nodes.length, 3);
  assert.deepEqual(result.canvas.edges.map((e) => e.index), [0, 1], 'the dangling edge is left out');
  assert.deepEqual(result.canvas.issues.map((i) => i.code), ['duplicate-node-id', 'duplicate-node-id', 'duplicate-edge-id', 'dangling-edge']);
  assert.equal(result.canvas.readOnly, false);
});

test('size limits: over 5,000 nodes or 5 MB is read-only (canvas.md 9.8)', () => {
  const nodes = (count: number) =>
    JSON.stringify({ nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, type: 'group', x: 0, y: 0, width: 10, height: 10 })) });
  const atLimit = read(nodes(MAX_CANVAS_NODES)).canvas;
  assert.equal(atLimit.readOnly, false);
  const over = read(nodes(MAX_CANVAS_NODES + 1)).canvas;
  assert.equal(over.readOnly, true);
  assert.deepEqual(over.issues.map((i) => i.code), ['too-many-nodes']);

  const filler = (length: number) => `{"nodes":[{"id":"a","type":"text","text":"${'x'.repeat(length)}","x":0,"y":0,"width":10,"height":10}]}`;
  const overhead = filler(0).length;
  assert.equal(read(filler(MAX_CANVAS_BYTES - overhead)).canvas.readOnly, false);
  const large = read(filler(MAX_CANVAS_BYTES - overhead + 1)).canvas;
  assert.equal(large.readOnly, true);
  assert.deepEqual(large.issues.map((i) => i.code), ['too-large']);
  // Bytes are UTF-8: three bytes per character here.
  const wide = `{"nodes":[{"id":"a","type":"text","text":"${'あ'.repeat(Math.ceil(MAX_CANVAS_BYTES / 3))}","x":0,"y":0,"width":10,"height":10}]}`;
  assert.equal(read(wide).canvas.readOnly, true);
});

test('nodes inside a group are those drawn fully within its rectangle', () => {
  const { canvas } = read(readFixture('01-tabs-node-per-line.canvas'));
  assert.deepEqual(nodesInGroup(canvas, canvas.nodes[2]).map((n) => n.id), ['a1', 'b2']);
  const partial = read(JSON.stringify({
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100 },
      { id: 'in', type: 'text', text: '', x: 0, y: 0, width: 100, height: 100 },
      { id: 'edge', type: 'text', text: '', x: 50, y: 50, width: 51, height: 10 },
      { id: 'out', type: 'text', text: '', x: -1, y: 0, width: 10, height: 10 },
    ],
  })).canvas;
  assert.deepEqual(nodesInGroup(partial, partial.nodes[0]).map((n) => n.id), ['in']);
});
