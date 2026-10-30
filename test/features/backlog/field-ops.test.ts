// Stage 2 frontmatter field writes (backlog.md 5.4): byte parity with Backlog.md 1.54.0 on
// the ops/field-* fixtures, non-target preservation over every fixture, and refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines, type LineDocument } from '../../../src/core/lines.ts';
import { applyEdits, computePatch } from '../../../src/core/patch.ts';
import {
  KEY_ORDER,
  planSetList,
  planSetScalar,
  type ListFieldName,
  type ScalarFieldName,
} from '../../../src/features/backlog/field-ops.ts';
import type { OperationPlan } from '../../../src/features/backlog/operations.ts';
import { parseTaskFile, taskData, type TaskFile } from '../../../src/features/backlog/task-file.ts';
import { fieldOf, listOf, scalarOf } from '../../../src/features/backlog/yaml-lite.ts';

const fixtures = new URL('../../fixtures/backlog/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, fixtures), 'utf8');
const NOW = new Date(Date.UTC(2027, 0, 2, 3, 4));

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

const scalarSeen = (texts: readonly string[], file: TaskFile, name: string): string | null => {
  const field = fieldOf(file.fields, name);
  // All the field's lines, as the webview sends them (a folded value spans several).
  return field === undefined ? null : texts.slice(field.line, field.end).join('\n');
};
const listSeen = (texts: readonly string[], file: TaskFile, name: string): string[] | null => {
  const field = fieldOf(file.fields, name);
  return field === undefined ? null : texts.slice(field.line, field.end);
};

const setScalar = (texts: string[], file: TaskFile, name: ScalarFieldName, value: string | null, now: Date) =>
  planSetScalar(texts, file, { name, value, expected: scalarSeen(texts, file, name) }, now);
const setList = (texts: string[], file: TaskFile, name: ListFieldName, values: string[], now: Date) =>
  planSetList(texts, file, { name, values, expected: listSeen(texts, file, name) }, now);

// --- CLI parity ---

type Case = (texts: string[], file: TaskFile, now: Date) => OperationPlan;
const CASES: Record<string, Case> = {
  title: (t, f, n) => setScalar(t, f, 'title', 'New: title', n),
  'title-plain': (t, f, n) => setScalar(t, f, 'title', 'Parser v2', n),
  'priority-add': (t, f, n) => setScalar(t, f, 'priority', 'high', n),
  'priority-change': (t, f, n) => setScalar(t, f, 'priority', 'low', n),
  'type-add': (t, f, n) => setScalar(t, f, 'type', 'bug', n),
  'type-clear': (t, f, n) => setScalar(t, f, 'type', null, n),
  'milestone-add': (t, f, n) => setScalar(t, f, 'milestone', 'm-0', n),
  'milestone-clear': (t, f, n) => setScalar(t, f, 'milestone', null, n),
  'due-add': (t, f, n) => setScalar(t, f, 'due_date', '2026-12-01', n),
  'due-change': (t, f, n) => setScalar(t, f, 'due_date', '2027-01-15', n),
  'due-clear': (t, f, n) => setScalar(t, f, 'due_date', '', n),
  'assignee-add': (t, f, n) => setList(t, f, 'assignee', ['@carol'], n),
  'assignee-multi': (t, f, n) => setList(t, f, 'assignee', ['@alice', '@bob'], n),
  'assignee-clear': (t, f, n) => setList(t, f, 'assignee', [], n),
  'label-add': (t, f, n) => setList(t, f, 'labels', ['ui', 'infra'], n),
  'label-remove': (t, f, n) => setList(t, f, 'labels', ['infra'], n),
  'labels-clear': (t, f, n) => setList(t, f, 'labels', [], n),
  'label-first': (t, f, n) => setList(t, f, 'labels', ['needs: review'], n),
  'dep-add': (t, f, n) => setList(t, f, 'dependencies', ['TASK-1'], n),
  'dep-clear': (t, f, n) => setList(t, f, 'dependencies', [], n),
  'ref-add': (t, f, n) => setList(t, f, 'references', ['https://example.com/a'], n),
  'ref-remove': (t, f, n) => setList(t, f, 'references', [], n),
  'doc-add': (t, f, n) => setList(t, f, 'documentation', ['docs/a.md'], n),
  'doc-clear': (t, f, n) => setList(t, f, 'documentation', [], n),
  'modified-add': (t, f, n) => setList(t, f, 'modified_files', ['src/a.ts'], n),
};

/** The minute the CLI wrote into updated_date, so the expected file can be compared exactly. */
function cliNow(after: string): Date {
  const match = /^updated_date: '(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})'$/m.exec(after);
  assert.ok(match);
  const [, y, mo, d, h, mi] = match.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

for (const [name, plan] of Object.entries(CASES)) {
  test(`CLI parity: ops/field-${name}`, () => {
    const before = read(`ops/field-${name}.before.md`);
    const after = read(`ops/field-${name}.after.md`);
    const { doc, texts, file } = load(before);
    assert.equal(apply(doc, plan(texts, file, cliNow(after))), after);
  });
}

test('CLI parity: every field fixture has a case', () => {
  const names = readdirSync(new URL('ops/', fixtures))
    .filter((n) => n.startsWith('field-') && n.endsWith('.before.md'))
    .map((n) => n.slice('field-'.length, -'.before.md'.length));
  assert.deepEqual(names.sort(), Object.keys(CASES).sort());
});

// --- Non-target preservation over every fixture ---

const allFiles = [
  ...readdirSync(new URL('project/tasks/', fixtures)).map((n) => `project/tasks/${n}`),
  ...readdirSync(new URL('variants/', fixtures)).map((n) => `variants/${n}`),
  ...readdirSync(new URL('ops/', fixtures)).map((n) => `ops/${n}`),
].filter((n) => n.endsWith('.md'));

/** Lines outside the named fields, with their line endings. */
function rest(doc: LineDocument, names: readonly string[]): LineDocument['lines'] {
  const file = parseTaskFile(lineTexts(doc));
  const skip = new Set<number>();
  for (const field of file.fields) if (names.includes(field.name)) for (let i = field.line; i < field.end; i++) skip.add(i);
  return doc.lines.filter((_, i) => !skip.has(i));
}

/** Refusals that the fixture's shape explains. */
function expectedRefusal(file: TaskFile, name: string): string | undefined {
  if (file.frontmatter === null) return 'unsafe';
  const updated = fieldOf(file.fields, 'updated_date');
  if (updated !== undefined && (updated.value.kind !== 'scalar' || updated.end !== updated.line + 1)) return 'unsafe';
  if (updated === undefined && fieldOf(file.fields, 'created_date') === undefined && fieldOf(file.fields, 'status') === undefined) return 'unsafe';
  const field = fieldOf(file.fields, name);
  if (field === undefined) return undefined;
  if (field.value.kind === 'unknown') return 'unsafe';
  if (field.value.kind === 'list' && field.value.flow) return 'unsafe';
  return undefined;
}

function checkPreserved(path: string, name: string, plan: OperationPlan, doc: LineDocument, file: TaskFile, check: (after: string) => void): boolean {
  const refusal = expectedRefusal(file, name);
  if (!plan.ok) {
    assert.equal(plan.reason, refusal, `${path} ${name}: refused as ${plan.reason}`);
    return false;
  }
  assert.equal(refusal, undefined, `${path} ${name}: expected ${refusal}`);
  if (plan.operations.length === 0) return false;
  const after = apply(doc, plan);
  const afterDoc = parseLines(after);
  assert.equal(afterDoc.bom, doc.bom, `${path} ${name}: BOM`);
  assert.deepEqual(rest(afterDoc, [name, 'updated_date']), rest(doc, [name, 'updated_date']), `${path} ${name}: other lines`);
  assert.match(after, /^updated_date: '2027-01-02 03:04'\r?$/m, `${path} ${name}: updated_date`);
  check(after);
  return true;
}

const SCALAR_VALUES: Record<ScalarFieldName, string> = {
  title: 'Changed: title',
  priority: 'medium',
  type: 'chore',
  milestone: 'm-1',
  due_date: '2027-02-03',
  project: 'Web',
  reporter: '@dana',
};

test('preservation: setting and removing every scalar field changes only that field and updated_date', () => {
  let changed = 0;
  for (const path of allFiles) {
    const { doc, texts, file } = load(read(path));
    for (const [name, value] of Object.entries(SCALAR_VALUES) as [ScalarFieldName, string][]) {
      const set = setScalar(texts, file, name, value, NOW);
      if (checkPreserved(path, name, set, doc, file, (after) => assert.equal(scalarOf(parseTaskFile(lineTexts(parseLines(after))).fields, name), value))) changed++;
      if (name === 'title') continue;
      const removed = setScalar(texts, file, name, null, NOW);
      if (checkPreserved(path, name, removed, doc, file, (after) => assert.equal(fieldOf(parseTaskFile(lineTexts(parseLines(after))).fields, name), undefined))) changed++;
    }
  }
  assert.ok(changed > 200, `changed ${changed}`);
});

const LIST_NAMES: ListFieldName[] = ['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files'];

test('preservation: adding, removing and clearing list items changes only that field and updated_date', () => {
  let changed = 0;
  for (const path of allFiles) {
    const { doc, texts, file } = load(read(path));
    for (const name of LIST_NAMES) {
      const current = listOf(file.fields, name);
      const variants = [[...current, 'new: item'], current.slice(1), [], ['@solo']];
      for (const values of variants) {
        const plan = setList(texts, file, name, values, NOW);
        const ok = checkPreserved(path, name, plan, doc, file, (after) => {
          const fields = parseTaskFile(lineTexts(parseLines(after))).fields;
          assert.deepEqual(listOf(fields, name), values, `${path} ${name}`);
          if (values.length === 0) assert.equal(fieldOf(fields, name) !== undefined, ['assignee', 'labels', 'dependencies'].includes(name));
        });
        if (ok) changed++;
      }
    }
  }
  assert.ok(changed > 300, `changed ${changed}`);
});

// --- Details and refusals ---

test('new keys go to the CLI key position, also next to an inserted updated_date', () => {
  const { doc, texts, file } = load('---\nid: X\ntitle: T\nstatus: To Do\nassignee: []\ncreated_date: x\nlabels: []\ndependencies: []\nordinal: 1\n---\n');
  const after = (plan: OperationPlan) => lineTexts(parseLines(apply(doc, plan))).slice(1, -1).map((t) => t.split(':')[0]).filter((k) => !k.startsWith(' '));
  assert.deepEqual(after(setScalar(texts, file, 'reporter', '@r', NOW)), ['id', 'title', 'status', 'assignee', 'reporter', 'created_date', 'updated_date', 'labels', 'dependencies', 'ordinal']);
  assert.deepEqual(after(setScalar(texts, file, 'due_date', '2027-01-01', NOW)), ['id', 'title', 'status', 'assignee', 'created_date', 'updated_date', 'due_date', 'labels', 'dependencies', 'ordinal']);
  assert.deepEqual(after(setScalar(texts, file, 'project', 'P', NOW)), ['id', 'title', 'status', 'assignee', 'created_date', 'updated_date', 'labels', 'dependencies', 'project', 'ordinal']);
  assert.deepEqual(after(setList(texts, file, 'modified_files', ['a'], NOW)), ['id', 'title', 'status', 'assignee', 'created_date', 'updated_date', 'labels', 'dependencies', 'modified_files', 'ordinal']);
  assert.ok(KEY_ORDER.indexOf('updated_date') < KEY_ORDER.indexOf('due_date'));
});

test('a key with no known neighbour before it goes before the first known key after it', () => {
  const { doc, texts, file } = load('---\ncustom: 1\nstatus: To Do\nupdated_date: x\n---\n');
  assert.equal(apply(doc, setScalar(texts, file, 'title', 'T', NOW)), "---\ncustom: 1\ntitle: T\nstatus: To Do\nupdated_date: '2027-01-02 03:04'\n---\n");
});

test('scalars: double quotes are kept, other values are written as the CLI writes them', () => {
  const { doc, texts, file } = load("---\ntitle: \"Old\"\npriority: 'high'\nstatus: To Do\nupdated_date: x\n---\n");
  assert.match(apply(doc, setScalar(texts, file, 'title', 'a "b"', NOW)), /\ntitle: "a \\"b\\""\n/);
  assert.match(apply(doc, setScalar(texts, file, 'priority', 'LOW', NOW)), /\npriority: low\n/);
});

test('scalars: invalid values', () => {
  const { texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const invalid = (name: ScalarFieldName, value: string | null) => assert.deepEqual(setScalar(texts, file, name, value, NOW), { ok: false, reason: 'invalid' }, `${name}=${value}`);
  invalid('title', '');
  invalid('title', null);
  invalid('title', 'two\nlines');
  invalid('priority', 'urgent');
  invalid('due_date', '2027-1-1');
  invalid('due_date', 'tomorrow');
  assert.deepEqual(planSetScalar(texts, file, { name: 'status' as ScalarFieldName, value: 'Done', expected: 'status: In Progress' }, NOW), { ok: false, reason: 'invalid' });
});

// As CLI 1.54.0 `backlog task edit <id> --priority <value>` wrote them with
// `priorities: ["Very High", "Low: later", "yes"]` (checked 2026-10-17; rechecked with each
// new CLI): any case and spacing accepted, written trimmed, with one space
// per run and in lower case, quoted as needed; values not configured are refused.
test('priority: only configured priorities, written normalized as the CLI does', () => {
  const priorities = ['Very High', 'Low: later', 'yes'];
  const { doc, texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const set = (value: string) => planSetScalar(texts, file, { name: 'priority', value, expected: scalarSeen(texts, file, 'priority'), priorities }, NOW);
  assert.match(apply(doc, set('very high')), /\npriority: very high\n/);
  assert.match(apply(doc, set('VERY  High ')), /\npriority: very high\n/);
  assert.match(apply(doc, set('LOW:  LATER')), /\npriority: 'low: later'\n/);
  assert.match(apply(doc, set(' yes')), /\npriority: 'yes'\n/);
  for (const value of ['high', 'nope', 'very-high', 'veryhigh', '   ']) assert.deepEqual(set(value), { ok: false, reason: 'invalid' }, JSON.stringify(value));
  // Removing stays possible with any list; with none configured (an unreadable config) nothing else is.
  assert.ok(planSetScalar(texts, file, { name: 'priority', value: null, expected: scalarSeen(texts, file, 'priority'), priorities: [] }, NOW).ok);
  assert.deepEqual(planSetScalar(texts, file, { name: 'priority', value: 'high', expected: scalarSeen(texts, file, 'priority'), priorities: [] }, NOW), { ok: false, reason: 'invalid' });
});

test('lists: invalid values and names', () => {
  const { texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  for (const values of [[''], ['a\nb']]) assert.deepEqual(setList(texts, file, 'labels', values, NOW), { ok: false, reason: 'invalid' });
  assert.deepEqual(planSetList(texts, file, { name: 'subtasks' as ListFieldName, values: ['a'], expected: null }, NOW), { ok: false, reason: 'invalid' });
});

test('stale expectations', () => {
  const { texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const stale = { ok: false, reason: 'stale' };
  assert.deepEqual(planSetScalar(texts, file, { name: 'priority', value: 'low', expected: 'priority: medium' }, NOW), stale);
  assert.deepEqual(planSetScalar(texts, file, { name: 'priority', value: 'low', expected: null }, NOW), stale);
  assert.deepEqual(planSetScalar(texts, file, { name: 'reporter', value: '@r', expected: 'reporter: x' }, NOW), stale);
  assert.deepEqual(planSetList(texts, file, { name: 'labels', values: ['a'], expected: ['labels:', '  - build'] }, NOW), stale);
  assert.deepEqual(planSetList(texts, file, { name: 'labels', values: ['a'], expected: null }, NOW), stale);
  assert.deepEqual(planSetList(texts, file, { name: 'subtasks' as ListFieldName, values: [], expected: null }, NOW), { ok: false, reason: 'invalid' });
});

test('unknown shapes are refused: unknown-keys variant and flow lists', () => {
  const { texts, file } = load(read('variants/unknown-keys.md'));
  const unsafe = { ok: false, reason: 'unsafe' };
  assert.deepEqual(setScalar(texts, file, 'priority', 'low', NOW), unsafe);
  assert.deepEqual(setList(texts, file, 'assignee', ['@a'], NOW), unsafe);
  assert.deepEqual(setList(texts, file, 'labels', ['alpha'], NOW), unsafe, 'flow list');
  const scalarList = load("---\nstatus: To Do\nassignee: '@me'\nupdated_date: x\n---\n");
  assert.deepEqual(setList(scalarList.texts, scalarList.file, 'assignee', ['@you'], NOW), unsafe);
  const listScalar = load('---\nstatus: To Do\ntitle:\n  - a\nupdated_date: x\n---\n');
  assert.deepEqual(setScalar(listScalar.texts, listScalar.file, 'title', 'T', NOW), unsafe);
});

test('no change plans nothing; unchanged list items keep their lines', () => {
  const { doc, texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  for (const plan of [setScalar(texts, file, 'priority', 'high', NOW), setList(texts, file, 'labels', ['build', 'infra'], NOW), setScalar(texts, file, 'due_date', null, NOW)]) {
    assert.ok(plan.ok);
    assert.deepEqual(plan.operations, []);
  }
  const quoted = load('---\nstatus: To Do\nupdated_date: x\nlabels:\n    - "kept"\n    - b\n---\n');
  assert.equal(
    apply(quoted.doc, setList(quoted.texts, quoted.file, 'labels', ['new', 'kept'], NOW)),
    "---\nstatus: To Do\nupdated_date: '2027-01-02 03:04'\nlabels:\n    - new\n    - \"kept\"\n---\n",
    'existing indent and item lines are reused',
  );
  assert.ok(doc.lines.length > 0);
});

test('CRLF files get CRLF in new lines', () => {
  const { doc, texts, file } = load(read('variants/crlf.md'));
  const after = apply(doc, setList(texts, file, 'labels', ['build', 'infra', 'new'], NOW));
  assert.ok(after.includes('  - new\r\n'));
  assert.ok(!/[^\r]\n/.test(after), 'no bare LF');
  assert.deepEqual(taskData(lineTexts(parseLines(after))).labels, ['build', 'infra', 'new']);
});
