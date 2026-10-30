// Column order (backlog.md 5.4, 9 #3): byte parity with Backlog.md 1.54.0 `--ordinal` on the
// ops/ordinal-* fixtures, the values chosen between neighbours, refusals, and non-target
// preservation over every fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines, type LineDocument } from '../../../src/core/lines.ts';
import { applyEdits, computePatch } from '../../../src/core/patch.ts';
import type { OperationPlan } from '../../../src/features/backlog/operations.ts';
import { formatOrdinal, ordinalBetween, planMoveInColumn, planSetOrdinal, type Neighbour } from '../../../src/features/backlog/ordinal-ops.ts';
import { parseTaskFile, taskData } from '../../../src/features/backlog/task-file.ts';
import { fieldOf } from '../../../src/features/backlog/yaml-lite.ts';

const fixtures = new URL('../../fixtures/backlog/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, fixtures), 'utf8');

function load(source: string) {
  const doc = parseLines(source);
  const texts = lineTexts(doc);
  return { doc, texts, file: parseTaskFile(texts) };
}

function apply(doc: LineDocument, plan: OperationPlan): string {
  assert.ok(plan.ok, plan.ok ? '' : `refused: ${plan.reason}`);
  const result = computePatch(doc, 1, { expectedVersion: 1, expectedLines: plan.expectedLines, operations: plan.operations });
  assert.ok(result.ok, result.ok ? '' : result.message);
  return applyEdits(doc, result.edits);
}

const at = (ordinal: number | null): Neighbour => ({ ordinal });

// --- CLI parity ---

const CASES: Record<string, number> = { change: 1500, decimal: 1000.5, zero: 0, add: 1000 };

for (const [name, value] of Object.entries(CASES)) {
  test(`CLI parity: ops/ordinal-${name}`, () => {
    const { doc, texts, file } = load(read(`ops/ordinal-${name}.before.md`));
    assert.equal(apply(doc, planSetOrdinal(texts, file, value)), read(`ops/ordinal-${name}.after.md`));
  });
}

test('CLI parity: every ordinal fixture has a case', () => {
  const names = readdirSync(new URL('ops/', fixtures))
    .filter((n) => n.startsWith('ordinal-') && n.endsWith('.before.md'))
    .map((n) => n.slice('ordinal-'.length, -'.before.md'.length));
  assert.deepEqual(names.sort(), Object.keys(CASES).sort());
});

test('parity through the move planner: between 1000 and 2000 writes the CLI fixture value', () => {
  const { doc, texts, file } = load(read('ops/ordinal-change.before.md'));
  // TASK-1.1 (2000) already sits between 1000 and 2001: nothing to write.
  const stay = planMoveInColumn(texts, file, { above: at(1000), below: at(2001) });
  assert.ok(stay.ok);
  assert.deepEqual(stay.operations, []);
  assert.equal(apply(doc, planMoveInColumn(texts, file, { above: at(1000), below: at(1999) })), read('ops/ordinal-change.after.md'));
});

// --- Values ---

test('values: integers first, decimals only without a gap, never negative', () => {
  const between = (above: Neighbour, below: Neighbour) => ordinalBetween({ above, below });
  assert.equal(between(undefined, undefined), 1000, 'empty column');
  assert.equal(between(at(1000), at(2000)), 1500);
  assert.equal(between(at(1000), at(1003)), 1002);
  assert.equal(between(at(1000), at(1002)), 1001);
  assert.equal(between(at(1000), at(1001)), 1000.5);
  assert.equal(between(at(1000.5), at(1001)), 1000.75);
  assert.equal(between(undefined, at(3000)), 2000, 'top: 1000 below the first');
  assert.equal(between(undefined, at(1000)), 0);
  assert.equal(between(undefined, at(500)), 250, 'near zero: halve');
  assert.equal(between(undefined, at(1)), 0);
  assert.equal(between(undefined, at(0.5)), 0);
  assert.equal(between(undefined, at(0)), undefined, 'nothing below zero');
  assert.equal(between(at(5000), undefined), 6000, 'bottom: 1000 after the last');
  assert.equal(between(at(1000.5), undefined), 2000);
  assert.equal(between(at(1000), at(null)), 2000, 'tasks without ordinal sort after all ordered ones');
  assert.equal(between(undefined, at(null)), 1000);
});

test('values: positions one file cannot express are refused', () => {
  const between = (above: Neighbour, below: Neighbour) => ordinalBetween({ above, below });
  assert.equal(between(at(1000), at(1000)), undefined, 'equal neighbours');
  assert.equal(between(at(2000), at(1000)), undefined, 'out of order');
  assert.equal(between(at(null), at(null)), undefined, 'among tasks ordered by ID');
  assert.equal(between(at(null), undefined), undefined);
  assert.equal(between(at(1), at(1 + Number.EPSILON)), undefined, 'no printable value between');
});

test('formatOrdinal writes plain numbers only', () => {
  assert.equal(formatOrdinal(1500), '1500');
  assert.equal(formatOrdinal(1000.5), '1000.5');
  assert.equal(formatOrdinal(0), '0');
  assert.equal(formatOrdinal(-1), undefined);
  assert.equal(formatOrdinal(1e-7), undefined);
  assert.equal(formatOrdinal(1e21), undefined);
  assert.equal(formatOrdinal(Number.NaN), undefined);
});

// --- Plans ---

test('move planner: no change when already in place; refusals', () => {
  const { texts, file } = load(read('project/tasks/task-2 - Render-the-board.md'));
  const unchanged = planMoveInColumn(texts, file, { above: at(2000), below: at(4000) });
  assert.ok(unchanged.ok);
  assert.deepEqual(unchanged.operations, []);
  assert.deepEqual(planMoveInColumn(texts, file, { above: at(1000), below: at(1000) }), { ok: false, reason: 'unsafe' });
  assert.deepEqual(planMoveInColumn(texts, file, { above: at(null), below: undefined }), { ok: false, reason: 'unsafe' });
  assert.deepEqual(planSetOrdinal(texts, file, -1), { ok: false, reason: 'invalid' });

  const noFrontmatter = load(read('variants/no-frontmatter.md'));
  assert.deepEqual(planMoveInColumn(noFrontmatter.texts, noFrontmatter.file, { above: undefined, below: undefined }), { ok: false, reason: 'unsafe' });
  const multiline = load('---\nid: TASK-1\nordinal:\n  - 1\n---\n');
  assert.deepEqual(planMoveInColumn(multiline.texts, multiline.file, { above: at(1), below: at(5) }), { ok: false, reason: 'unsafe' });
});

test('move planner: the expected line guards against a concurrent edit', () => {
  const { doc, texts, file } = load(read('project/tasks/task-2 - Render-the-board.md'));
  const plan = planMoveInColumn(texts, file, { above: undefined, below: at(1000) });
  assert.ok(plan.ok);
  const line = fieldOf(file.fields, 'ordinal')!.line;
  assert.deepEqual(plan.expectedLines, [{ line, text: 'ordinal: 3000' }]);
  // The same plan against a file whose ordinal changed meanwhile is refused by the patch.
  const moved = parseLines(read('project/tasks/task-2 - Render-the-board.md').replace('ordinal: 3000', 'ordinal: 3500'));
  const result = computePatch(moved, 1, { expectedVersion: 1, expectedLines: plan.expectedLines, operations: plan.operations });
  assert.equal(result.ok, false);
  assert.ok(apply(doc, plan).includes('ordinal: 0\n'));
});

// --- Non-target preservation over every fixture ---

const allFiles = [
  ...readdirSync(new URL('project/tasks/', fixtures)).map((n) => `project/tasks/${n}`),
  ...readdirSync(new URL('variants/', fixtures)).map((n) => `variants/${n}`),
  ...readdirSync(new URL('ops/', fixtures)).map((n) => `ops/${n}`),
].filter((n) => n.endsWith('.md'));

/** Lines other than the ordinal field, with their line endings. */
function rest(doc: LineDocument): LineDocument['lines'] {
  const file = parseTaskFile(lineTexts(doc));
  const field = fieldOf(file.fields, 'ordinal');
  return doc.lines.filter((_, i) => field === undefined || i < field.line || i >= field.end);
}

test('preservation: setting the ordinal changes only the ordinal line in every fixture', () => {
  let changed = 0;
  for (const path of allFiles) {
    const { doc, texts, file } = load(read(path));
    const plan = planSetOrdinal(texts, file, 4321);
    const field = fieldOf(file.fields, 'ordinal');
    if (file.frontmatter === null || (field !== undefined && (field.value.kind !== 'scalar' || field.end !== field.line + 1))) {
      assert.deepEqual(plan, { ok: false, reason: 'unsafe' }, path);
      continue;
    }
    const after = apply(doc, plan);
    const afterDoc = parseLines(after);
    assert.equal(afterDoc.bom, doc.bom, `${path}: BOM`);
    assert.deepEqual(rest(afterDoc), rest(doc), `${path}: other lines`);
    assert.equal(taskData(lineTexts(afterDoc)).ordinal, 4321, path);
    assert.match(after, /^ordinal: 4321\r?$/m, path);
    changed++;
  }
  assert.ok(changed > 20, `only ${changed} fixtures changed`);
});
