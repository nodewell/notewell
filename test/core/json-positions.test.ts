import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BOM, parseLines } from '../../src/core/lines.ts';
import { applyEdits, type TextEdit } from '../../src/core/patch.ts';
import {
  computeJsonPatch,
  findNode,
  MAX_JSON_DEPTH,
  nodeText,
  parseJson,
  toValue,
  type JsonDocument,
  type JsonMember,
  type JsonNode,
  type JsonOperation,
  type JsonPath,
  type JsonValue,
} from '../../src/core/json-positions.ts';

const fixtureDir = new URL('../fixtures/canvas/', import.meta.url);
const fixtureNames = readdirSync(fixtureDir).filter((name) => name.endsWith('.canvas'));

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), 'utf8');
}

/** Each fixture as written plus CRLF, BOM and no-final-newline variants. */
function variants(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  for (const name of fixtureNames) {
    const lf = readFixture(name);
    const crlf = lf.replace(/\n/g, '\r\n');
    out.push(
      { name, source: lf },
      { name: `${name} CRLF`, source: crlf },
      { name: `${name} BOM`, source: BOM + lf },
      { name: `${name} BOM CRLF`, source: BOM + crlf },
      { name: `${name} no final newline`, source: lf.replace(/\n$/, '') },
    );
  }
  return out;
}

function parse(source: string): JsonDocument {
  const result = parseJson(source);
  assert.ok(result.ok, result.ok ? '' : `${result.error.message} at ${result.error.offset}`);
  return result.doc;
}

function patch(source: string, operations: JsonOperation[]): { edits: readonly TextEdit[]; output: string } {
  const result = computeJsonPatch(parse(source), operations);
  assert.ok(result.ok, result.ok ? '' : `${result.reason}: ${result.message}`);
  return { edits: result.edits, output: applyEdits(parseLines(source), result.edits) };
}

function failure(source: string, operations: JsonOperation[]): string {
  const result = computeJsonPatch(parse(source), operations);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.reason;
}

function stripBom(source: string): string {
  return source.startsWith(BOM) ? source.slice(1) : source;
}

/** Offset in the text without BOM of an edit position (lines end at LF). */
function offsetOf(text: string, line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset = text.indexOf('\n', offset) + 1;
  return offset + character;
}

function editOffsets(text: string, edit: TextEdit): { start: number; end: number } {
  return {
    start: offsetOf(text, edit.range.start.line, edit.range.start.character),
    end: offsetOf(text, edit.range.end.line, edit.range.end.character),
  };
}

function* allNodes(node: JsonNode): Generator<JsonNode> {
  yield node;
  if (node.kind === 'object') for (const member of node.members) yield* allNodes(member.value);
  if (node.kind === 'array') for (const item of node.items) yield* allNodes(item);
}

/** A deep copy with `fn` applied, for the expected meaning after an operation. */
function mutate(value: JsonValue, fn: (copy: any) => void): JsonValue {
  const copy = structuredClone(value);
  fn(copy);
  return copy;
}

function lineBreaks(text: string): { lf: number; crlf: number } {
  const crlf = text.split('\r\n').length - 1;
  return { lf: text.split('\n').length - 1 - crlf, crlf };
}

/** Checks shared by every preservation test. */
function checkOutput(source: string, output: string, expected: JsonValue): void {
  assert.deepEqual(JSON.parse(stripBom(output)), expected);
  assert.equal(output.startsWith(BOM), source.startsWith(BOM), 'BOM kept');
  assert.equal(/\n$/.test(output), /\n$/.test(source), 'final newline kept');
  const before = lineBreaks(source);
  const after = lineBreaks(output);
  if (before.lf === 0 && before.crlf > 0) assert.equal(after.lf, 0, 'no LF added to a CRLF file');
  if (before.crlf === 0) assert.equal(after.crlf, 0, 'no CRLF added to an LF file');
}

// --- parser ---

test('every value, name and member span holds exactly its JSON text, in every variant', () => {
  for (const { name, source } of variants()) {
    const doc = parse(source);
    assert.equal(doc.bom, source.startsWith(BOM), name);
    assert.deepEqual(toValue(doc.root), JSON.parse(stripBom(source)), name);
    for (const node of allNodes(doc.root)) {
      assert.deepEqual(JSON.parse(nodeText(doc, node)), toValue(node), `${name}: ${nodeText(doc, node)}`);
      if (node.kind !== 'object') continue;
      for (const member of node.members) {
        assert.equal(JSON.parse(nodeText(doc, member.name)), member.name.value, name);
        assert.equal(member.start, member.name.start);
        assert.equal(member.end, member.value.end);
        assert.match(doc.text.slice(member.name.end, member.value.start), /^[ \t\r\n]*:[ \t\r\n]*$/, name);
      }
    }
  }
});

test('escapes decode like JSON.parse and spans cover the raw escape text', () => {
  const doc = parse(readFixture('05-escapes.canvas'));
  const text = findNode(doc.root, ['nodes', 0, 'text']);
  assert.ok(text?.kind === 'string');
  const backslash = String.fromCharCode(92);
  assert.ok(nodeText(doc, text).includes(backslash + 'u00e9'));
  assert.ok(text.value.includes('é é'));
  assert.ok(text.value.includes(String.fromCodePoint(0x1f600) + ' ' + String.fromCodePoint(0x1f600)));
  assert.equal(toValue(findNode(doc.root, ['nodes', 1, 'id']) as JsonNode), 's2');
});

test('lookups: paths, missing steps, wrong container types and duplicate names', () => {
  const doc = parse('{"a":[{"b":1}],"d":1,"d":2}');
  assert.equal(toValue(findNode(doc.root, ['a', 0, 'b']) as JsonNode), 1);
  assert.equal(findNode(doc.root, ['a', 1]), undefined);
  assert.equal(findNode(doc.root, ['a', 'b']), undefined);
  assert.equal(findNode(doc.root, [0]), undefined);
  assert.equal(toValue(findNode(doc.root, ['d']) as JsonNode), 2);
  assert.deepEqual(toValue(doc.root), JSON.parse('{"a":[{"b":1}],"d":1,"d":2}'));
});

test('a member named __proto__ stays plain data', () => {
  const value = toValue(parse('{"__proto__":{"x":1}}').root) as Record<string, JsonValue>;
  assert.deepEqual(Object.entries(value), [['__proto__', { x: 1 }]]);
});

test('scalars and whitespace-only layouts at the root', () => {
  assert.equal(toValue(parse(' 42 ').root), 42);
  assert.equal(toValue(parse('"x"').root), 'x');
  assert.equal(toValue(parse('\t\r\nnull\r\n').root), null);
  assert.equal(toValue(parse('-1.5e+3').root), -1500);
  assert.deepEqual(toValue(parse('[ ]').root), []);
});

test('invalid JSON is rejected with offset and position', () => {
  const cases: [string, number, string?][] = [
    ['', 0, 'empty document'],
    ['  \n ', 4, 'empty document'],
    ['{', 1],
    ['{"a":1,}', 7],
    ['[1,]', 3],
    ['{"a" 1}', 5],
    ['{"a":1 "b":2}', 7],
    ['[1 2]', 3],
    ['01', 0],
    ['1.', 0],
    ['-', 0],
    ['1e', 0],
    ['+1', 0],
    ['.5', 0],
    ['tru', 0],
    ['NaN', 0],
    ["{'a':1}", 1],
    ['"abc', 0, 'unterminated string'],
    ['{} x', 3, 'unexpected content after the JSON value'],
    ['{"a":1}//c', 7],
    ['["a\tb"]', 3, 'control character in string'],
    ['"a\\x"', 2, 'invalid escape'],
    ['"\\u12"', 1, 'invalid \\u escape'],
    ['{"a":}', 5],
  ];
  for (const [source, offset, message] of cases) {
    const result = parseJson(source);
    assert.equal(result.ok, false, source);
    if (result.ok) continue;
    assert.equal(result.error.offset, offset, source);
    if (message !== undefined) assert.equal(result.error.message, message, source);
  }
});

test('error positions are line and character without the BOM, CRLF aware', () => {
  const result = parseJson(BOM + '{\r\n\t"a": 1,\r\n\t"b": ]\r\n}');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.position, { line: 2, character: 6 });
  assert.equal(result.error.offset, 19);
});

test('nesting deeper than the limit is rejected instead of overflowing the stack', () => {
  const deep = '['.repeat(MAX_JSON_DEPTH + 1) + ']'.repeat(MAX_JSON_DEPTH + 1);
  const result = parseJson(deep);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.message, 'nesting too deep');
  assert.ok(parseJson('['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH)).ok);
});

test('a large canvas parses', () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, type: 'text', text: `card ${i}`, x: i, y: -i, width: 100, height: 60 }));
  const source = JSON.stringify({ nodes, edges: [] }, null, '\t');
  const doc = parse(source);
  assert.equal(toValue(findNode(doc.root, ['nodes', 4999, 'x']) as JsonNode), 4999);
});

// --- value patches: exact output ---

test('replace touches only the value range', () => {
  const source = '{\n\t"nodes":[\n\t\t{"id":"a","x":1.0,"y":2}\n\t]\n}\n';
  const { edits, output } = patch(source, [{ kind: 'replace', path: ['nodes', 0, 'y'], value: 120 }]);
  assert.equal(output, '{\n\t"nodes":[\n\t\t{"id":"a","x":1.0,"y":120}\n\t]\n}\n');
  assert.deepEqual(edits, [{ range: { start: { line: 2, character: 24 }, end: { line: 2, character: 25 } }, newText: '120' }]);
});

test('an equal value produces no edit, keeping the original spelling', () => {
  const source = '{"x":1.0,"y":-0,"s":"\\u00e9","o":{"a":[1,2]}}';
  const { edits } = patch(source, [
    { kind: 'replace', path: ['x'], value: 1 },
    { kind: 'set', path: ['y'], value: 0 },
    { kind: 'replace', path: ['s'], value: 'é' },
    { kind: 'replace', path: ['o'], value: { a: [1, 2] } },
  ]);
  assert.deepEqual(edits, []);
  assert.equal(patch(source, [{ kind: 'replace', path: ['o'], value: { a: [2, 1] } }]).output, '{"x":1.0,"y":-0,"s":"\\u00e9","o":{"a":[2,1]}}');
});

test('new strings escape only what JSON requires and keep non-ASCII', () => {
  const value = '한국어 "q" back\\ line\nnext\ttab' + String.fromCharCode(1) + ' ' + String.fromCodePoint(0x1f600);
  const { output } = patch('{"t":""}', [{ kind: 'replace', path: ['t'], value }]);
  assert.equal(output, '{"t":' + JSON.stringify(value) + '}');
  assert.ok(output.includes('한국어'));
  assert.ok(output.includes(String.fromCodePoint(0x1f600)));
  assert.equal(JSON.parse(output).t, value);
});

test('insert mimics the layout of the object', () => {
  const cases: [string, string][] = [
    ['{"a":1}', '{"a":1,"c":"4"}'],
    ['{ "a": 1 }', '{ "a": 1, "c": "4" }'],
    ['{ "a" : 1 , "b" : 2 }', '{ "a" : 1 , "b" : 2 , "c" : "4" }'],
    ['{\n\t"a": 1\n}', '{\n\t"a": 1,\n\t"c": "4"\n}'],
    ['{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n', '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": "4"\r\n}\r\n'],
    ['[\n\t{"id":"x","b":2}\n]', '[\n\t{"id":"x","b":2,"c":"4"}\n]'],
  ];
  for (const [source, expected] of cases) {
    const path: JsonPath = source.startsWith('[') ? [0, 'c'] : ['c'];
    assert.equal(patch(source, [{ kind: 'insert', path, value: '4' }]).output, expected, source);
  }
});

test('insert into an empty object borrows the layout around it', () => {
  const cases: [string, JsonPath, string][] = [
    // Root: the default layout (tab indent, one member per line, ': ').
    ['{}', ['nodes'], '{\n\t"nodes": []\n}'],
    ['{}\r\n', ['nodes'], '{\r\n\t"nodes": []\r\n}\r\n'],
    // Inside a multi-line object: indent one unit deeper than the line holding the braces.
    ['{\n  "a": 1,\n  "m": {}\n}', ['m', 'k'], '{\n  "a": 1,\n  "m": {\n    "k": []\n  }\n}'],
    ['{\n\t"n": [\n\t\t{\n\t\t\t"m": {}\n\t\t}\n\t]\n}', ['n', 0, 'm', 'k'], '{\n\t"n": [\n\t\t{\n\t\t\t"m": {\n\t\t\t\t"k": []\n\t\t\t}\n\t\t}\n\t]\n}'],
    // Inside a one-line object: stay on the line, with its padding and colon spacing.
    ['[{"id":"a","m":{}}]', [0, 'm', 'k'], '[{"id":"a","m":{"k":[]}}]'],
    ['{ "id" : "a" , "m" : { } }', ['m', 'k'], '{ "id" : "a" , "m" : { "k" : [] } }'],
  ];
  for (const [source, path, expected] of cases) {
    assert.equal(patch(source, [{ kind: 'insert', path, value: [] }]).output, expected, source);
  }
});

test('several inserts into one object become one edit in operation order', () => {
  const { edits, output } = patch('{\n\t"a": 1\n}', [
    { kind: 'insert', path: ['z'], value: 1 },
    { kind: 'set', path: ['b'], value: 'x' },
  ]);
  assert.equal(output, '{\n\t"a": 1,\n\t"z": 1,\n\t"b": "x"\n}');
  assert.equal(edits.length, 1);
  assert.equal(patch('{}', [{ kind: 'insert', path: ['a'], value: 1 }, { kind: 'insert', path: ['b'], value: 2 }]).output, '{\n\t"a": 1,\n\t"b": 2\n}');
});

test('replacing the last value and inserting after it merge into one edit', () => {
  const { edits, output } = patch('{"x":1,"y":2}', [
    { kind: 'replace', path: ['y'], value: 3 },
    { kind: 'insert', path: ['color'], value: '1' },
  ]);
  assert.equal(output, '{"x":1,"y":3,"color":"1"}');
  assert.equal(edits.length, 1);
});

test('remove takes the member, one comma and the layout between members', () => {
  const cases: [string, JsonPath[], string][] = [
    ['{"a":1,"b":2,"c":3}', [['a']], '{"b":2,"c":3}'],
    ['{"a":1,"b":2,"c":3}', [['b']], '{"a":1,"c":3}'],
    ['{"a":1,"b":2,"c":3}', [['c']], '{"a":1,"b":2}'],
    ['{"a":1,"b":2,"c":3}', [['b'], ['c']], '{"a":1}'],
    ['{"a":1,"b":2,"c":3}', [['a'], ['c']], '{"b":2}'],
    ['{"a":1,"b":2,"c":3}', [['a'], ['b'], ['c']], '{}'],
    ['{ "a" : 1 }', [['a']], '{}'],
    ['{\n\t"a": 1\n}\n', [['a']], '{}\n'],
    ['{\n\t"a": 1,\n\t"b": 2\n}', [['a']], '{\n\t"b": 2\n}'],
    ['{\n\t"a": 1,\n\t"b": 2\n}', [['b']], '{\n\t"a": 1\n}'],
    ['{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": 3\r\n}', [['b']], '{\r\n  "a": 1,\r\n  "c": 3\r\n}'],
    ['{ "a" : 1 , "b" : 2 }', [['b']], '{ "a" : 1 }'],
    ['[{"id":"x","color":"1","y":0}]', [[0, 'color']], '[{"id":"x","y":0}]'],
  ];
  for (const [source, paths, expected] of cases) {
    const operations = paths.map((path): JsonOperation => ({ kind: 'remove', path }));
    assert.equal(patch(source, operations).output, expected, `${source} - ${JSON.stringify(paths)}`);
  }
});

test('edits use the line patch engine coordinates (no BOM, CRLF lines)', () => {
  const source = BOM + '{\r\n\t"a": 1,\r\n\t"b": 2\r\n}\r\n';
  const { edits, output } = patch(source, [{ kind: 'replace', path: ['b'], value: 30 }]);
  assert.deepEqual(edits, [{ range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } }, newText: '30' }]);
  assert.equal(output, BOM + '{\r\n\t"a": 1,\r\n\t"b": 30\r\n}\r\n');
});

// --- refused operations ---

test('refused operations', () => {
  const source = '{"nodes":[{"id":"a","x":1,"m":{}}],"v":1}';
  assert.equal(failure(source, [{ kind: 'replace', path: ['nodes', 0, 'color'], value: '1' }]), 'path');
  assert.equal(failure(source, [{ kind: 'replace', path: ['nodes', 3, 'x'], value: 1 }]), 'path');
  assert.equal(failure(source, [{ kind: 'set', path: ['nodes', 5], value: 1 }]), 'path');
  assert.equal(failure(source, [{ kind: 'set', path: ['v', 'x'], value: 1 }]), 'path');
  assert.equal(failure(source, [{ kind: 'insert', path: [], value: 1 }]), 'path');
  assert.equal(failure(source, [{ kind: 'remove', path: ['nodes', 0] }]), 'path');
  assert.equal(failure(source, [{ kind: 'remove', path: ['missing'] }]), 'path');
  assert.equal(failure(source, [{ kind: 'insert', path: ['nodes', 0, 'x'], value: 2 }]), 'exists');
  for (const value of [NaN, Infinity, undefined, () => 1, { a: NaN }, [undefined], 1n] as unknown as JsonValue[]) {
    assert.equal(failure(source, [{ kind: 'set', path: ['v'], value }]), 'value', String(value));
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(failure(source, [{ kind: 'set', path: ['v'], value: cyclic as JsonValue }]), 'value');
  assert.equal(failure(source, [{ kind: 'replace', path: ['v'], value: 2 }, { kind: 'replace', path: ['v'], value: 3 }]), 'overlap');
  assert.equal(failure(source, [{ kind: 'replace', path: ['nodes'], value: [] }, { kind: 'replace', path: ['nodes', 0, 'x'], value: 3 }]), 'overlap');
  assert.equal(failure(source, [{ kind: 'remove', path: ['v'] }, { kind: 'remove', path: ['v'] }]), 'overlap');
  assert.equal(failure(source, [{ kind: 'remove', path: ['v'] }, { kind: 'replace', path: ['v'], value: 2 }]), 'overlap');
  assert.equal(failure(source, [{ kind: 'insert', path: ['w'], value: 1 }, { kind: 'set', path: ['w'], value: 2 }]), 'overlap');
  assert.equal(failure(source, [{ kind: 'replace', path: ['nodes', 0, 'm'], value: { a: 1 } }, { kind: 'insert', path: ['nodes', 0, 'm', 'k'], value: 1 }]), 'overlap');
});

// --- preservation over every fixture and variant ---

interface Scenario {
  readonly label: string;
  /** Operations for one card object at `nodes[index]`, or undefined when not applicable. */
  readonly ops: (card: Record<string, JsonValue>, base: JsonPath) => JsonOperation[] | undefined;
  readonly apply: (card: Record<string, any>) => void;
}

const scenarios: Scenario[] = [
  {
    label: 'move',
    ops: (card, base) => (typeof card.x === 'number' ? [{ kind: 'replace', path: [...base, 'x'], value: card.x + 17 }, { kind: 'replace', path: [...base, 'y'], value: -33 }] : undefined),
    apply: (card) => {
      card.x += 17;
      card.y = -33;
    },
  },
  {
    label: 'resize',
    ops: (card, base) => (typeof card.width === 'number' ? [{ kind: 'set', path: [...base, 'width'], value: 640 }, { kind: 'set', path: [...base, 'height'], value: 480 }] : undefined),
    apply: (card) => {
      card.width = 640;
      card.height = 480;
    },
  },
  {
    label: 'text',
    ops: (card, base) => (typeof card.text === 'string' ? [{ kind: 'replace', path: [...base, 'text'], value: 'new "text"\n한국어 \\ end' }] : undefined),
    apply: (card) => {
      card.text = 'new "text"\n한국어 \\ end';
    },
  },
  {
    label: 'set color',
    ops: (_card, base) => [{ kind: 'set', path: [...base, 'color'], value: '5' }],
    apply: (card) => {
      card.color = '5';
    },
  },
  {
    label: 'remove color',
    ops: (card, base) => ('color' in card ? [{ kind: 'remove', path: [...base, 'color'] }] : undefined),
    apply: (card) => {
      delete card.color;
    },
  },
  {
    label: 'remove id and add two members',
    ops: (card, base) =>
      'id' in card
        ? [
            { kind: 'remove', path: [...base, 'id'] },
            { kind: 'insert', path: [...base, 'zz-new'], value: { a: [1, null, true] } },
            { kind: 'set', path: [...base, 'zz-two'], value: 'two' },
          ]
        : undefined,
    apply: (card) => {
      delete card.id;
      card['zz-new'] = { a: [1, null, true] };
      card['zz-two'] = 'two';
    },
  },
];

/** Card objects to try: every nodes/edges entry, else the root itself. */
function targets(doc: JsonDocument): JsonPath[] {
  const paths: JsonPath[] = [];
  for (const list of ['nodes', 'edges']) {
    const array = findNode(doc.root, [list]);
    if (array?.kind === 'array') array.items.forEach((item, i) => item.kind === 'object' && paths.push([list, i]));
  }
  return paths.length > 0 ? paths : [[]];
}

test('every operation on every card keeps all other bytes, in every fixture variant', () => {
  let checked = 0;
  for (const { name, source } of variants()) {
    const doc = parse(source);
    const original = toValue(doc.root);
    for (const base of targets(doc)) {
      const cardNode = findNode(doc.root, base) as JsonNode;
      const card = toValue(cardNode) as Record<string, JsonValue>;
      for (const scenario of scenarios) {
        const operations = scenario.ops(card, base);
        if (operations === undefined) continue;
        const label = `${name} ${JSON.stringify(base)} ${scenario.label}`;
        const { edits, output } = patch(source, operations);
        checkOutput(source, output, mutate(original, (copy) => scenario.apply(base.reduce((v: any, step) => v[step], copy))));

        // Every edit lies inside the card object; outside it the text is untouched.
        const text = stripBom(source);
        for (const edit of edits) {
          const { start, end } = editOffsets(text, edit);
          assert.ok(start > cardNode.start && end < cardNode.end, `${label}: edit outside the card`);
        }
        const outText = stripBom(output);
        const tail = text.length - cardNode.end;
        assert.equal(outText.slice(0, cardNode.start), text.slice(0, cardNode.start), label);
        assert.equal(outText.slice(outText.length - tail), text.slice(cardNode.end), label);

        // Replacements change only the value ranges; members not named stay byte for byte.
        const touched = new Set(operations.map((op) => op.path[op.path.length - 1]));
        const outCard = findNode(parse(output).root, base);
        assert.ok(cardNode.kind === 'object' && outCard?.kind === 'object');
        for (const member of cardNode.members) {
          if (touched.has(member.name.value)) continue;
          const after: JsonMember | undefined = outCard.members.find((m) => m.name.value === member.name.value);
          assert.ok(after !== undefined, label);
          assert.equal(nodeText(parse(output), after), nodeText(doc, member), label);
        }

        // Doing it again changes nothing (for set/replace) or is refused (for remove/insert).
        const again = computeJsonPatch(parse(output), operations.map((op) => (op.kind === 'insert' ? { ...op, kind: 'set' } : op)));
        if (operations.every((op) => op.kind !== 'remove')) {
          assert.ok(again.ok && again.edits.length === 0, `${label}: not idempotent`);
        } else {
          assert.ok(!again.ok && again.reason === 'path', label);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} cases`);
});

test('unknown members, unknown node types and number spellings survive a move', () => {
  const source = readFixture('04-unknown.canvas');
  const { output } = patch(source, [{ kind: 'replace', path: ['nodes', 1, 'x'], value: 5 }]);
  const expected = source.replace('"text": "kept", "x": 0,', '"text": "kept", "x": 5,');
  assert.notEqual(expected, source);
  assert.equal(output, expected);
  assert.ok(output.includes('"x": 1.0, "y": 2e1'));
  assert.ok(output.includes('"x-metadata" : { "author" : "someone", "tags" : [ ] }'));
});

test('setting color on a one-line card in an Obsidian-like file stays on that line', () => {
  const source = readFixture('01-tabs-node-per-line.canvas');
  const { output } = patch(source, [{ kind: 'set', path: ['nodes', 0, 'color'], value: '1' }]);
  assert.equal(output, source.replace('"height":140}', '"height":140,"color":"1"}'));
  const removed = patch(source, [{ kind: 'remove', path: ['nodes', 1, 'color'] }]).output;
  assert.equal(removed, source.replace(',"color":"4"}', '}'));
});

test('an expanded card gets the new member on its own line with the same indent', () => {
  const source = readFixture('02-spaces-expanded.canvas').replace(/\n/g, '\r\n');
  const { output } = patch(source, [{ kind: 'set', path: ['nodes', 0, 'color'], value: '2' }]);
  assert.equal(output, source.replace('"height": 100\r\n    },', '"height": 100,\r\n      "color": "2"\r\n    },'));
});
