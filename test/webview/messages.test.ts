import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineMessages, type MessageOf } from '../../src/webview/messages.ts';

const schemas = {
  toggle: { line: { kind: 'int', min: 0, max: 100 }, version: { kind: 'int', min: 0, max: 1e9 } },
  rename: {
    line: { kind: 'int', min: 0, max: 100 },
    title: { kind: 'string', maxLength: 10, minLength: 1 },
  },
  note: { body: { kind: 'string', maxLength: 20, allowNewline: true } },
  move: {
    to: { kind: 'enum', values: ['left', 'right'] },
    copy: { kind: 'boolean', optional: true },
  },
  ready: {},
} as const;

const validate = defineMessages(schemas);

// Compile-time check: the validator's message type is the expected union.
type Msg = MessageOf<typeof schemas>;
const typed: Msg[] = [
  { type: 'toggle', line: 1, version: 2 },
  { type: 'rename', line: 1, title: 'x' },
  { type: 'move', to: 'left' },
  { type: 'move', to: 'right', copy: true },
  { type: 'ready' },
];
void typed;

function rejects(raw: unknown, pattern?: RegExp): void {
  const result = validate(raw);
  assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(raw)}`);
  if (pattern && !result.ok) assert.match(result.error, pattern);
}

test('accepts valid messages and returns only schema fields', () => {
  assert.deepEqual(validate({ type: 'toggle', line: 3, version: 7 }), {
    ok: true,
    message: { type: 'toggle', line: 3, version: 7 },
  });
  assert.deepEqual(validate({ type: 'ready' }), { ok: true, message: { type: 'ready' } });
  assert.deepEqual(validate({ type: 'move', to: 'right' }), {
    ok: true,
    message: { type: 'move', to: 'right' },
  });
  assert.deepEqual(validate(JSON.parse('{"type":"move","to":"left","copy":false}')), {
    ok: true,
    message: { type: 'move', to: 'left', copy: false },
  });
});

test('narrows the message type by discriminant', () => {
  const result = validate({ type: 'rename', line: 0, title: 'ok' });
  assert.ok(result.ok);
  if (result.message.type === 'rename') {
    const title: string = result.message.title;
    assert.equal(title, 'ok');
  }
});

test('rejects non-objects and undefined types', () => {
  for (const raw of [undefined, null, 1, 'toggle', [], [{ type: 'ready' }]]) rejects(raw);
  rejects({}, /unknown message type/);
  rejects({ type: 'delete' }, /unknown message type/);
  rejects({ type: 'toString' }, /unknown message type/);
  rejects({ type: '__proto__' }, /unknown message type/);
  rejects({ type: 1 }, /unknown message type/);
  rejects(Object.assign(Object.create({ injected: true }), { type: 'ready' }));
  rejects(new Date());
});

test('rejects unknown, missing and non-data fields', () => {
  rejects({ type: 'ready', extra: 1 }, /unknown field extra/);
  rejects(JSON.parse('{"type":"ready","__proto__":{"x":1}}'), /unknown field __proto__/);
  rejects({ type: 'toggle', line: 1 }, /toggle\.version: missing/);
  rejects({ type: 'move', to: 'left', copy: undefined }, /move\.copy/);
  const accessor = { type: 'toggle', version: 1 };
  Object.defineProperty(accessor, 'line', { get: () => 1, enumerable: true });
  rejects(accessor, /non-data/);
  rejects({ type: 'ready', [Symbol('s')]: 1 }, /non-data/);
});

test('validates integer type and range', () => {
  rejects({ type: 'toggle', line: -1, version: 0 }, /out of range 0\.\.100/);
  rejects({ type: 'toggle', line: 101, version: 0 }, /out of range/);
  rejects({ type: 'toggle', line: 1.5, version: 0 }, /integer/);
  rejects({ type: 'toggle', line: '1', version: 0 }, /integer/);
  rejects({ type: 'toggle', line: Number.NaN, version: 0 }, /integer/);
  rejects({ type: 'toggle', line: Infinity, version: 0 }, /integer/);
  assert.ok(validate({ type: 'toggle', line: 0, version: 0 }).ok);
  assert.ok(validate({ type: 'toggle', line: 100, version: 0 }).ok);
});

test('validates string type, length and line breaks', () => {
  assert.ok(validate({ type: 'rename', line: 0, title: '0123456789' }).ok);
  rejects({ type: 'rename', line: 0, title: '0123456789a' }, /longer than 10/);
  rejects({ type: 'rename', line: 0, title: '' }, /shorter than 1/);
  rejects({ type: 'rename', line: 0, title: 5 }, /string/);
  for (const br of ['\n', '\r', '\r\n', '\u0085', '\u2028', '\u2029']) {
    rejects({ type: 'rename', line: 0, title: `a${br}b` }, /line break/);
  }
  assert.ok(validate({ type: 'note', body: 'line 1\nline 2' }).ok);
});

test('validates booleans and enums', () => {
  rejects({ type: 'move', to: 'up' }, /not an allowed value/);
  rejects({ type: 'move', to: 'left', copy: 'yes' }, /boolean/);
});

test('rejects invalid schemas at definition time', () => {
  assert.throws(() => defineMessages({ a: { type: { kind: 'boolean' } } }), /Reserved/);
  assert.throws(() => defineMessages({ a: { ['__proto__']: { kind: 'boolean' } } }), /Reserved/);
  assert.throws(() => defineMessages({ a: { n: { kind: 'int', min: 5, max: 1 } } }), /range/);
  assert.throws(() => defineMessages({ a: { n: { kind: 'int', min: 0, max: 0.5 } } }), /range/);
  assert.throws(() => defineMessages({ a: { s: { kind: 'string', maxLength: -1 } } }), /length/);
  assert.throws(() => defineMessages({ a: { e: { kind: 'enum', values: [] } } }), /Empty enum/);
});
