import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dominantEol, hasTrailingNewline, lineTexts, parseLines, type Eol, type LineDocument } from '../../src/core/lines.ts';
import {
  applyEdits,
  computePatch,
  type ExpectedLine,
  type LineOperation,
  type TextEdit,
} from '../../src/core/patch.ts';

const fixtureDir = new URL('../fixtures/kanban/', import.meta.url);
const fixtureNames = readdirSync(fixtureDir).filter((name) => /^\d\d-.*\.md$/.test(name));

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), 'utf8');
}

function patch(source: string, operations: LineOperation[], expectedLines: ExpectedLine[] = []) {
  const doc = parseLines(source);
  const result = computePatch(doc, 1, { expectedVersion: 1, expectedLines, operations });
  assert.ok(result.ok, result.ok ? '' : `${result.reason}: ${result.message}`);
  return { edits: result.edits, output: applyEdits(doc, result.edits) };
}

function edit(line: number, character: number, endLine: number, endCharacter: number, newText: string): TextEdit {
  return { range: { start: { line, character }, end: { line: endLine, character: endCharacter } }, newText };
}

// --- delete ---

test('delete middle lines', () => {
  const { edits, output } = patch('a\nb\nc\nd\n', [{ kind: 'delete', start: 1, end: 3 }]);
  assert.equal(output, 'a\nd\n');
  assert.deepEqual(edits, [edit(1, 0, 3, 0, '')]);
});

test('delete first and last line with trailing newline', () => {
  assert.equal(patch('a\nb\nc\n', [{ kind: 'delete', start: 0, end: 1 }]).output, 'b\nc\n');
  assert.equal(patch('a\nb\nc\n', [{ kind: 'delete', start: 2, end: 3 }]).output, 'a\nb\n');
});

test('deleting the last line keeps "no trailing newline"', () => {
  const { edits, output } = patch('a\nb\nc', [{ kind: 'delete', start: 2, end: 3 }]);
  assert.equal(output, 'a\nb');
  assert.deepEqual(edits, [edit(1, 1, 2, 1, '')]);
  assert.equal(patch('a\r\nb\r\nc', [{ kind: 'delete', start: 1, end: 3 }]).output, 'a');
});

test('delete everything', () => {
  assert.equal(patch('a\nb\n', [{ kind: 'delete', start: 0, end: 2 }]).output, '');
  assert.equal(patch('a\nb', [{ kind: 'delete', start: 0, end: 2 }]).output, '');
});

// --- insert ---

test('insert at start, middle and end', () => {
  assert.equal(patch('a\nb\n', [{ kind: 'insert', at: 0, lines: ['x'] }]).output, 'x\na\nb\n');
  assert.equal(patch('a\nb\n', [{ kind: 'insert', at: 1, lines: ['x', 'y'] }]).output, 'a\nx\ny\nb\n');
  const end = patch('a\nb\n', [{ kind: 'insert', at: 2, lines: ['x'] }]);
  assert.equal(end.output, 'a\nb\nx\n');
  assert.deepEqual(end.edits, [edit(2, 0, 2, 0, 'x\n')]);
});

test('appending to a file without trailing newline keeps it without one', () => {
  const { edits, output } = patch('a\nb', [{ kind: 'insert', at: 2, lines: ['x', 'y'] }]);
  assert.equal(output, 'a\nb\nx\ny');
  assert.deepEqual(edits, [edit(1, 1, 1, 1, '\nx\ny')]);
});

test('insert into an empty document uses a trailing newline', () => {
  assert.equal(patch('', [{ kind: 'insert', at: 0, lines: ['x'] }]).output, 'x\n');
});

test('inserted lines use the dominant EOL', () => {
  assert.equal(patch('a\r\nb\r\n', [{ kind: 'insert', at: 1, lines: ['x'] }]).output, 'a\r\nx\r\nb\r\n');
  // 2 LF vs 1 CRLF: LF wins; untouched lines keep their own EOL.
  assert.equal(patch('a\r\nb\nc\n', [{ kind: 'insert', at: 1, lines: ['x'] }]).output, 'a\r\nx\nb\nc\n');
});

test('inserting an empty list changes nothing', () => {
  assert.deepEqual(patch('a\n', [{ kind: 'insert', at: 1, lines: [] }]).edits, []);
});

// --- replace ---

test('checkbox toggle narrows to one character', () => {
  const { edits, output } = patch('## a\n- [ ] task\n', [{ kind: 'replace', start: 1, end: 2, lines: ['- [x] task'] }]);
  assert.equal(output, '## a\n- [x] task\n');
  assert.deepEqual(edits, [edit(1, 3, 1, 4, 'x')]);
});

test('title edit narrows to the changed characters', () => {
  const { edits } = patch('- [ ] old title\n', [{ kind: 'replace', start: 0, end: 1, lines: ['- [ ] new title'] }]);
  assert.deepEqual(edits, [edit(0, 6, 0, 9, 'new')]);
});

test('replace keeps each replaced line\'s own EOL', () => {
  // LF-dominant file, the target line ends in CRLF.
  const source = 'a\nb\r\nc\nd\n';
  const { edits, output } = patch(source, [{ kind: 'replace', start: 1, end: 2, lines: ['B'] }]);
  assert.equal(output, 'a\nB\r\nc\nd\n');
  assert.deepEqual(edits, [edit(1, 0, 1, 1, 'B')]);
});

test('replace with more lines: extra lines use the dominant EOL', () => {
  assert.equal(
    patch('a\r\nb\nc\n', [{ kind: 'replace', start: 0, end: 1, lines: ['x', 'y'] }]).output,
    'x\r\ny\nb\nc\n',
  );
});

test('replace with fewer lines and with none', () => {
  assert.equal(patch('a\nb\nc\n', [{ kind: 'replace', start: 0, end: 2, lines: ['x'] }]).output, 'x\nc\n');
  assert.equal(patch('a\nb\nc\n', [{ kind: 'replace', start: 0, end: 2, lines: [] }]).output, 'c\n');
});

test('replace the last line without trailing newline', () => {
  assert.equal(patch('a\nb', [{ kind: 'replace', start: 1, end: 2, lines: ['x', 'y'] }]).output, 'a\nx\ny');
});

test('identical replacement produces no edit', () => {
  assert.deepEqual(patch('a\nb\n', [{ kind: 'replace', start: 0, end: 2, lines: ['a', 'b'] }]).edits, []);
});

test('edits never split a surrogate pair', () => {
  const { edits, output } = patch('😀 a\n', [{ kind: 'replace', start: 0, end: 1, lines: ['😃 a'] }]);
  assert.equal(output, '😃 a\n');
  assert.deepEqual(edits, [edit(0, 0, 0, 2, '😃')]);
});

test('BOM is outside positions and kept', () => {
  const source = readFixture('22-bom.md');
  const doc = parseLines(source);
  const last = doc.lines.length - 1;
  const { edits, output } = patch(source, [{ kind: 'replace', start: last, end: last + 1, lines: ['- [x] BOM 있는 파일'] }]);
  assert.equal(edits[0]?.range.start.character, 3);
  assert.ok(output.startsWith(source.slice(0, 1)));
  assert.equal(output.length, source.length);
});

// --- several operations ---

test('move a card = delete + insert, in either order', () => {
  const source = '## A\n- [ ] one\n\t- body\n- [ ] two\n## B\n- [ ] three\n';
  const cut: LineOperation = { kind: 'delete', start: 1, end: 3 };
  const put: LineOperation = { kind: 'insert', at: 6, lines: ['- [ ] one', '\t- body'] };
  const forward = patch(source, [cut, put]);
  const backward = patch(source, [put, cut]);
  assert.equal(forward.output, '## A\n- [ ] two\n## B\n- [ ] three\n- [ ] one\n\t- body\n');
  assert.deepEqual(forward.edits, backward.edits);
  assert.deepEqual(forward.edits, [edit(1, 0, 3, 0, ''), edit(6, 0, 6, 0, '- [ ] one\n\t- body\n')]);
});

test('operations touching at a boundary are allowed and merged into one edit', () => {
  const { edits, output } = patch('a\nb\nc\n', [
    { kind: 'delete', start: 1, end: 2 },
    { kind: 'insert', at: 1, lines: ['x'] },
  ]);
  assert.equal(output, 'a\nx\nc\n');
  assert.deepEqual(edits, [edit(1, 0, 1, 1, 'x')]);
  assert.equal(
    patch('a\nb\nc\n', [
      { kind: 'replace', start: 0, end: 1, lines: ['A'] },
      { kind: 'insert', at: 1, lines: ['x'] },
    ]).output,
    'A\nx\nb\nc\n',
  );
});

// --- failures (the refusal reasons of core.md 3.4 are tested here too) ---

function failure(source: string, request: { expectedVersion?: number; expectedLines?: ExpectedLine[]; operations: LineOperation[] }) {
  const result = computePatch(parseLines(source), 1, {
    expectedVersion: request.expectedVersion ?? 1,
    expectedLines: request.expectedLines ?? [],
    operations: request.operations,
  });
  assert.equal(result.ok, false);
  return result.ok ? undefined : result.reason;
}

test('overlapping operations are refused', () => {
  const src = 'a\nb\nc\nd\n';
  assert.equal(failure(src, { operations: [{ kind: 'delete', start: 0, end: 2 }, { kind: 'delete', start: 1, end: 3 }] }), 'overlap');
  assert.equal(failure(src, { operations: [{ kind: 'delete', start: 0, end: 2 }, { kind: 'delete', start: 0, end: 2 }] }), 'overlap');
  assert.equal(failure(src, { operations: [{ kind: 'delete', start: 0, end: 3 }, { kind: 'insert', at: 1, lines: ['x'] }] }), 'overlap');
  assert.equal(
    failure(src, { operations: [{ kind: 'insert', at: 2, lines: ['x'] }, { kind: 'insert', at: 2, lines: ['y'] }] }),
    'overlap',
  );
});

test('out-of-range and malformed operations are refused', () => {
  const src = 'a\nb\n';
  assert.equal(failure(src, { operations: [{ kind: 'delete', start: 1, end: 3 }] }), 'range');
  assert.equal(failure(src, { operations: [{ kind: 'insert', at: 3, lines: ['x'] }] }), 'range');
  assert.equal(failure(src, { operations: [{ kind: 'delete', start: 1, end: 1 }] }), 'invalid');
  assert.equal(failure(src, { operations: [{ kind: 'delete', start: -1, end: 1 }] }), 'invalid');
  assert.equal(failure(src, { operations: [{ kind: 'insert', at: 0.5, lines: ['x'] }] }), 'invalid');
  assert.equal(failure(src, { operations: [{ kind: 'insert', at: 0, lines: ['x\ny'] }] }), 'invalid');
  assert.equal(failure(src, { operations: [{ kind: 'replace', start: 0, end: 1, lines: ['x\r'] }] }), 'invalid');
});

// --- property test over fixtures ---

/** Small seeded PRNG (mulberry32) so failures reproduce. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLE_LINES = ['- [ ] new card', '\t- body', '', '## Lane', '- [x] 완료 😀', '   spaced  '];

function randomOperations(doc: LineDocument, next: () => number): LineOperation[] {
  const count = doc.lines.length;
  const int = (max: number): number => Math.floor(next() * (max + 1));
  const sample = (): string[] => Array.from({ length: int(3) }, () => SAMPLE_LINES[int(SAMPLE_LINES.length - 1)]);
  const taken: [number, number][] = [];
  const ops: LineOperation[] = [];
  for (let tries = 0; tries < 12 && ops.length < 4; tries++) {
    const kind = (['delete', 'insert', 'replace'] as const)[int(2)];
    if (kind === 'insert') {
      const at = int(count);
      if (taken.some(([s, e]) => (s < at && at < e) || (s === e && s === at))) continue;
      taken.push([at, at]);
      ops.push({ kind, at, lines: sample() });
    } else {
      if (count === 0) continue;
      const start = int(count - 1);
      const end = start + 1 + int(Math.min(2, count - start - 1));
      if (taken.some(([s, e]) => (s === e ? start < s && s < end : start < e && s < end))) continue;
      taken.push([start, end]);
      ops.push(kind === 'delete' ? { kind, start, end } : { kind, start, end, lines: sample() });
    }
  }
  return ops;
}

/**
 * Expected line texts, where each line came from (an untouched original line index, or
 * null for a new line) and the EOL a new line should get when it is not the last line.
 */
function model(doc: LineDocument, ops: readonly LineOperation[]) {
  const dominant = dominantEol(doc);
  const spans = ops
    .map((op) =>
      op.kind === 'insert'
        ? { start: op.at, end: op.at, lines: op.lines }
        : { start: op.start, end: op.end, lines: op.kind === 'replace' ? op.lines : [] },
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const texts: string[] = [];
  const origins: (number | null)[] = [];
  const newEols: (Eol | null)[] = [];
  let next = 0;
  const keep = (i: number): void => {
    texts.push(doc.lines[i].text);
    origins.push(i);
    newEols.push(null);
  };
  for (const span of spans) {
    for (; next < span.start; next++) keep(next);
    span.lines.forEach((text, i) => {
      // A replaced line keeps the EOL of the original line at the same position.
      const original = span.start + i < span.end ? doc.lines[span.start + i].eol : '';
      texts.push(text);
      origins.push(null);
      newEols.push(original === '' ? dominant : original);
    });
    next = Math.max(next, span.end);
  }
  for (; next < doc.lines.length; next++) keep(next);
  return { texts, origins, newEols };
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('random operations on every fixture keep non-target bytes and EOL rules', () => {
  const next = random(20261014);
  let checked = 0;
  for (const name of fixtureNames) {
    const source = readFixture(name);
    const doc = parseLines(source);
    const starts: number[] = [];
    let offset = 0;
    for (const line of doc.lines) {
      starts.push(offset);
      offset += line.text.length + line.eol.length;
    }
    const toOffset = (p: { line: number; character: number }): number =>
      p.line < starts.length ? starts[p.line] + p.character : offset;

    for (let round = 0; round < 40; round++) {
      const ops = randomOperations(doc, next);
      const label = `${name} #${round} ${JSON.stringify(ops)}`;
      const result = computePatch(doc, 7, { expectedVersion: 7, expectedLines: [], operations: ops });
      assert.ok(result.ok, label);
      const shuffled = computePatch(doc, 7, { expectedVersion: 7, expectedLines: [], operations: shuffle(ops, next) });
      assert.deepEqual(shuffled, result, `order independence: ${label}`);

      const out = parseLines(applyEdits(doc, result.edits));
      const expected = model(doc, ops);
      // Without a trailing newline, an empty last line keeps its line break (it would have
      // no bytes otherwise), so then the file ends with a newline.
      const lastText = expected.texts[expected.texts.length - 1];
      const emptyTail = !hasTrailingNewline(doc) && doc.lines.length > 0 && lastText === '';
      assert.deepEqual(lineTexts(out), expected.texts, label);
      assert.equal(out.bom, doc.bom, label);
      if (doc.lines.length > 0 && out.lines.length > 0) {
        assert.equal(hasTrailingNewline(out), emptyTail || hasTrailingNewline(doc), label);
      }

      // Edits are sorted and disjoint.
      const ranges = result.edits.map((e) => [toOffset(e.range.start), toOffset(e.range.end)] as const);
      for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i - 1][1] < ranges[i][0], label);

      const covered = (from: number, to: number): boolean => ranges.some(([a, b]) => a < to && from < b);
      const lastOriginal = doc.lines.length - 1;
      out.lines.forEach((line, i) => {
        const origin = expected.origins[i];
        const isLast = i === out.lines.length - 1;
        if (origin === null) {
          if (!isLast) assert.equal(line.eol, expected.newEols[i], label);
          return;
        }
        // Untouched original line: its text bytes are never inside an edit.
        const start = starts[origin];
        assert.ok(!covered(start, start + doc.lines[origin].text.length) || doc.lines[origin].text === '', label);
        if (isLast || origin === lastOriginal) return;
        // ... and neither is its line ending, which is unchanged.
        assert.equal(line.eol, doc.lines[origin].eol, label);
        assert.ok(!covered(start + line.text.length, start + line.text.length + line.eol.length), label);
      });
      checked++;
    }
  }
  assert.ok(checked >= 24 * 40);
});

// --- optimistic concurrency (core.md 3.4) ---

test('version mismatch is refused without edits', () => {
  const doc = parseLines('a\nb\n');
  const result = computePatch(doc, 5, {
    expectedVersion: 4,
    expectedLines: [{ line: 0, text: 'a' }],
    operations: [{ kind: 'delete', start: 0, end: 1 }],
  });
  assert.deepEqual(Object.keys(result).sort(), ['message', 'ok', 'reason']);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.reason, 'version');
});

test('changed or missing target lines are refused as content', () => {
  const src = '## A\n- [ ] one\n- [ ] two\n';
  const ops: LineOperation[] = [{ kind: 'replace', start: 1, end: 2, lines: ['- [x] one'] }];
  assert.equal(failure(src, { expectedLines: [{ line: 1, text: '- [ ] uno' }], operations: ops }), 'content');
  assert.equal(failure(src, { expectedLines: [{ line: 3, text: '- [ ] one' }], operations: ops }), 'content');
  assert.equal(failure(src, { expectedLines: [{ line: -1, text: '' }], operations: ops }), 'content');
});

test('version is checked before everything else', () => {
  const doc = parseLines('a\n');
  const result = computePatch(doc, 2, {
    expectedVersion: 1,
    expectedLines: [{ line: 9, text: 'x' }],
    operations: [{ kind: 'delete', start: 0, end: 9 }],
  });
  assert.equal(result.ok ? undefined : result.reason, 'version');
});

test('matching version and lines produce edits', () => {
  const src = '## A\n- [ ] one\n\t- body\n- [ ] two\n';
  const { output } = patch(
    src,
    [{ kind: 'replace', start: 1, end: 2, lines: ['- [x] one'] }],
    [
      { line: 1, text: '- [ ] one' },
      { line: 2, text: '\t- body' },
    ],
  );
  assert.equal(output, '## A\n- [x] one\n\t- body\n- [ ] two\n');
});

test('without a trailing newline, an empty new last line keeps its line break', () => {
  // Deleting the last line leaves an empty line last: it stays (only the deleted text goes).
  assert.equal(patch('## A\n\n- [ ] x', [{ kind: 'delete', start: 2, end: 3 }]).output, '## A\n\n');
  // A non-empty new last line still loses its line break.
  assert.equal(patch('## A\n- [ ] a\n- [ ] x', [{ kind: 'delete', start: 2, end: 3 }]).output, '## A\n- [ ] a');
});
