import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dominantEol, hasTrailingNewline, joinLines, lineTexts, parseLines } from '../../src/core/lines.ts';

const fixtureDir = new URL('../fixtures/kanban/', import.meta.url);
const fixtureNames = readdirSync(fixtureDir).filter((name) => /^\d\d-.*\.md$/.test(name));

function readFixture(name: string): Buffer {
  return readFileSync(new URL(name, fixtureDir));
}

function roundTripBytes(raw: Buffer): Buffer {
  return Buffer.from(joinLines(parseLines(raw.toString('utf8'))), 'utf8');
}

test('empty source has no lines', () => {
  const doc = parseLines('');
  assert.deepEqual(doc, { bom: false, lines: [] });
  assert.equal(joinLines(doc), '');
  assert.equal(hasTrailingNewline(doc), false);
  assert.equal(dominantEol(doc), '\n');
});

test('LF lines', () => {
  const doc = parseLines('a\n\nb\n');
  assert.deepEqual(doc.lines, [
    { text: 'a', eol: '\n' },
    { text: '', eol: '\n' },
    { text: 'b', eol: '\n' },
  ]);
  assert.equal(hasTrailingNewline(doc), true);
  assert.equal(dominantEol(doc), '\n');
});

test('CRLF lines', () => {
  const doc = parseLines('a\r\n\r\nb\r\n');
  assert.deepEqual(lineTexts(doc), ['a', '', 'b']);
  assert.ok(doc.lines.every((line) => line.eol === '\r\n'));
  assert.equal(dominantEol(doc), '\r\n');
});

test('no trailing newline keeps the last line without EOL', () => {
  const doc = parseLines('a\nb');
  assert.deepEqual(doc.lines, [
    { text: 'a', eol: '\n' },
    { text: 'b', eol: '' },
  ]);
  assert.equal(hasTrailingNewline(doc), false);
  assert.equal(joinLines(doc), 'a\nb');
});

test('single line break is one empty line', () => {
  assert.deepEqual(parseLines('\n').lines, [{ text: '', eol: '\n' }]);
  assert.deepEqual(parseLines('\r\n').lines, [{ text: '', eol: '\r\n' }]);
});

test('BOM is kept separately and restored', () => {
  const doc = parseLines('\uFEFF---\nx\n');
  assert.equal(doc.bom, true);
  assert.equal(doc.lines[0]?.text, '---');
  assert.equal(joinLines(doc), '\uFEFF---\nx\n');
  assert.equal(parseLines('---\n').bom, false);
});

test('a BOM-like character later in the text is ordinary content', () => {
  const doc = parseLines('a\n\uFEFFb');
  assert.equal(doc.bom, false);
  assert.equal(doc.lines[1]?.text, '\uFEFFb');
});

test('lone CR is content, not a line break', () => {
  const doc = parseLines('a\rb\n\r');
  assert.deepEqual(doc.lines, [
    { text: 'a\rb', eol: '\n' },
    { text: '\r', eol: '' },
  ]);
  assert.equal(joinLines(doc), 'a\rb\n\r');
});

test('mixed EOLs are kept per line', () => {
  const source = 'a\r\nb\nc\r\nd';
  const doc = parseLines(source);
  assert.deepEqual(
    doc.lines.map((line) => line.eol),
    ['\r\n', '\n', '\r\n', ''],
  );
  assert.equal(joinLines(doc), source);
});

test('dominant EOL is the majority, ties go to the first EOL seen', () => {
  assert.equal(dominantEol(parseLines('a\r\nb\nc\r\n')), '\r\n');
  assert.equal(dominantEol(parseLines('a\nb\r\nc\n')), '\n');
  assert.equal(dominantEol(parseLines('a\r\nb\n')), '\r\n');
  assert.equal(dominantEol(parseLines('a\nb\r\n')), '\n');
  assert.equal(dominantEol(parseLines('no break')), '\n');
});

test('every kanban fixture round-trips byte for byte', () => {
  assert.ok(fixtureNames.length >= 24);
  for (const name of fixtureNames) {
    const raw = readFixture(name);
    assert.ok(roundTripBytes(raw).equals(raw), name);
  }
});

test('fixture 21: CRLF', () => {
  const raw = readFixture('21-crlf.md');
  const doc = parseLines(raw.toString('utf8'));
  assert.ok(roundTripBytes(raw).equals(raw));
  assert.ok(doc.lines.length > 0);
  assert.ok(doc.lines.every((line) => line.eol === '\r\n'));
  assert.ok(doc.lines.every((line) => !line.text.includes('\r')));
  assert.equal(dominantEol(doc), '\r\n');
});

test('fixture 22: BOM', () => {
  const raw = readFixture('22-bom.md');
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const doc = parseLines(raw.toString('utf8'));
  assert.equal(doc.bom, true);
  assert.equal(doc.lines[0]?.text, '---');
  assert.ok(roundTripBytes(raw).equals(raw));
  assert.equal(dominantEol(doc), '\n');
});

test('fixture 23: no trailing newline', () => {
  const raw = readFixture('23-no-trailing-newline.md');
  assert.notEqual(raw[raw.length - 1], 0x0a);
  const doc = parseLines(raw.toString('utf8'));
  assert.equal(hasTrailingNewline(doc), false);
  assert.equal(doc.lines[doc.lines.length - 1]?.eol, '');
  assert.ok(roundTripBytes(raw).equals(raw));
});

test('fixture 24: mixed EOL', () => {
  const raw = readFixture('24-mixed-eol.md');
  const doc = parseLines(raw.toString('utf8'));
  assert.deepEqual(
    doc.lines.map((line) => line.eol),
    ['\n', '\n', '\r\n', '\n', '\r\n', '\n', '\r\n'],
  );
  assert.ok(roundTripBytes(raw).equals(raw));
  // 4 LF vs 3 CRLF
  assert.equal(dominantEol(doc), '\n');
});
