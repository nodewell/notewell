// Stage 1 operations (backlog.md 5.1-5.3, 8): byte parity with the CLI on the ops
// fixtures, non-target preservation over every fixture, and refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines, type LineDocument } from '../../../src/core/lines.ts';
import { applyEdits, computePatch } from '../../../src/core/patch.ts';
import {
  formatUpdatedDate,
  planSetStatus,
  planToggleCheck,
  type OperationPlan,
} from '../../../src/features/backlog/operations.ts';
import { parseChecklist, parseTaskFile } from '../../../src/features/backlog/task-file.ts';
import { fieldOf } from '../../../src/features/backlog/yaml-lite.ts';

const fixtures = new URL('../../fixtures/backlog/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, fixtures), 'utf8');
const STATUSES = ['To Do', 'In Progress', 'Done'];
const NOW = new Date(Date.UTC(2026, 9, 14, 9, 50, 30));
const LATER = new Date(Date.UTC(2027, 0, 2, 3, 4));

/** Applies a plan with the core patch engine; throws if the engine refuses it. */
function apply(doc: LineDocument, plan: OperationPlan): string {
  assert.ok(plan.ok, `plan refused: ${plan.ok ? '' : plan.reason}`);
  const result = computePatch(doc, 1, { expectedVersion: 1, expectedLines: plan.expectedLines, operations: plan.operations });
  assert.ok(result.ok, result.ok ? '' : result.message);
  return applyEdits(doc, result.edits);
}

function load(source: string) {
  const doc = parseLines(source);
  const texts = lineTexts(doc);
  return { doc, texts, file: parseTaskFile(texts) };
}

const statusLine = (texts: readonly string[], file: ReturnType<typeof parseTaskFile>): string =>
  texts[fieldOf(file.fields, 'status')?.line ?? -1] ?? '';

test('formatUpdatedDate: UTC minutes with single quotes', () => {
  assert.equal(formatUpdatedDate(NOW), "'2026-10-14 09:50'");
  assert.equal(formatUpdatedDate(LATER), "'2027-01-02 03:04'");
  assert.equal(formatUpdatedDate(new Date('2026-12-31T23:59:59.999-01:00')), "'2027-01-01 00:59'");
});

// --- CLI parity: the ops fixtures, byte for byte ---

const opsCases: Record<string, (texts: string[], file: ReturnType<typeof parseTaskFile>) => OperationPlan> = {
  status: (texts, file) => planSetStatus(texts, file, { status: 'Done', statusLine: statusLine(texts, file), statuses: STATUSES }, NOW),
  noupdated: (texts, file) =>
    planSetStatus(texts, file, { status: 'In Progress', statusLine: statusLine(texts, file), statuses: STATUSES }, NOW),
  check: (texts, file) => toggleNumber(texts, file, 'ac', 2, true),
  uncheck: (texts, file) => toggleNumber(texts, file, 'ac', 1, false),
  dod: (texts, file) => toggleNumber(texts, file, 'dod', 1, true),
  // Generated later than the others: the CLI wrote 13:08.
  'uncheck-dod': (texts, file) => {
    const item = parseChecklist(texts, file.sections.dod)!.items[0];
    return planToggleCheck(texts, file, { list: 'dod', line: item.line, source: texts[item.line], checked: false }, new Date(Date.UTC(2026, 9, 14, 13, 8)));
  },
};

function toggleNumber(texts: string[], file: ReturnType<typeof parseTaskFile>, list: 'ac' | 'dod', number: number, checked: boolean) {
  const item = parseChecklist(texts, file.sections[list])?.items.find((candidate) => candidate.number === number);
  assert.ok(item);
  return planToggleCheck(texts, file, { list, line: item.line, source: texts[item.line], checked }, NOW);
}

for (const [name, plan] of Object.entries(opsCases)) {
  test(`CLI parity: ops/${name} matches the CLI result byte for byte`, () => {
    const { doc, texts, file } = load(read(`ops/${name}.before.md`));
    assert.equal(apply(doc, plan(texts, file)), read(`ops/${name}.after.md`));
  });
}

test('CLI parity: every ops fixture has a case', () => {
  // Stage 2 pairs (field-*, section-*, ordinal-*) have their own tests.
  const names = readdirSync(new URL('ops/', fixtures))
    .filter((n) => n.endsWith('.before.md') && !/^(field|section|ordinal)-/.test(n))
    .map((n) => n.slice(0, -'.before.md'.length));
  assert.deepEqual(names.sort(), Object.keys(opsCases).sort());
});

// --- Non-target preservation over every fixture ---

const allFiles = [
  ...readdirSync(new URL('project/tasks/', fixtures)).map((n) => `project/tasks/${n}`),
  ...readdirSync(new URL('variants/', fixtures)).map((n) => `variants/${n}`),
].filter((n) => n.endsWith('.md'));

/**
 * Only `targets` (original line indexes) and the updated_date line may differ; an inserted
 * updated_date line is the only extra line. Line endings, BOM and the end of file stay.
 */
function assertOnlyChanged(before: LineDocument, afterSource: string, targets: readonly number[], label: string): void {
  const after = parseLines(afterSource);
  assert.equal(after.bom, before.bom, `${label}: BOM`);
  const updatedLine = (lines: LineDocument['lines']) => lines.findIndex((line) => /^updated_date:/.test(line.text));
  const beforeUpdated = updatedLine(before.lines);
  const afterUpdated = updatedLine(after.lines);
  assert.ok(afterUpdated !== -1, `${label}: updated_date present`);
  assert.match(after.lines[afterUpdated].text, /^updated_date: '\d{4}-\d{2}-\d{2} \d{2}:\d{2}'$/, label);
  const rest = after.lines.filter((_, i) => i !== afterUpdated);
  const original = before.lines.filter((_, i) => i !== beforeUpdated);
  const shift = (i: number) => (beforeUpdated !== -1 && i > beforeUpdated ? i - 1 : i);
  assert.equal(rest.length, original.length, `${label}: line count`);
  const targetSet = new Set(targets.map(shift));
  original.forEach((line, i) => {
    if (targetSet.has(i)) {
      assert.equal(rest[i].eol, line.eol, `${label}: target eol ${i}`);
      assert.notEqual(rest[i].text, line.text, `${label}: target ${i} changed`);
    } else {
      assert.deepEqual(rest[i], line, `${label}: line ${i}`);
    }
  });
  if (beforeUpdated === -1) {
    assert.equal(after.lines[afterUpdated].eol, after.lines[afterUpdated - 1].eol === '' ? '\n' : after.lines[afterUpdated - 1].eol);
  } else {
    assert.equal(after.lines[afterUpdated].eol, before.lines[beforeUpdated].eol, `${label}: updated_date eol`);
  }
}

test('preservation: every status change on every fixture touches only status and updated_date', () => {
  let checked = 0;
  for (const path of allFiles) {
    const { doc, texts, file } = load(read(path));
    for (const status of [...STATUSES, 'done', 'IN PROGRESS']) {
      const plan = planSetStatus(texts, file, { status, statusLine: statusLine(texts, file), statuses: STATUSES }, LATER);
      const label = `${path} -> ${status}`;
      if (!plan.ok) {
        assert.ok(['no-frontmatter.md', 'updated-unknown.md'].some((n) => path.endsWith(n)), `${label}: ${plan.reason}`);
        assert.equal(plan.reason, 'unsafe', label);
        continue;
      }
      const statusIndex = fieldOf(file.fields, 'status')!.line;
      const current = fieldOf(file.fields, 'status')!.value;
      const same = current.kind === 'scalar' && current.value.toLowerCase() === status.toLowerCase() && current.value === STATUSES.find((s) => s.toLowerCase() === status.toLowerCase());
      if (same) {
        assert.deepEqual(plan.operations, [], `${label}: same status, no change`);
        continue;
      }
      assertOnlyChanged(doc, apply(doc, plan), [statusIndex], label);
      checked++;
    }
  }
  assert.ok(checked > 40, `checked ${checked} changes`);
});

test('preservation: every check toggle on every fixture touches only the mark and updated_date', () => {
  let checked = 0;
  for (const path of allFiles) {
    const { doc, texts, file } = load(read(path));
    for (const list of ['ac', 'dod'] as const) {
      const checklist = parseChecklist(texts, file.sections[list]);
      for (const item of checklist?.items ?? []) {
        const label = `${path} ${list} #${item.number}`;
        const plan = planToggleCheck(texts, file, { list, line: item.line, source: texts[item.line], checked: !item.checked }, LATER);
        if (checklist?.readOnly === true) {
          assert.deepEqual(plan, { ok: false, reason: 'unsafe' }, label);
          continue;
        }
        const after = apply(doc, plan);
        assertOnlyChanged(doc, after, [item.line], label);
        // Check items are in the body, so an inserted updated_date line shifts them by one.
        const shift = fieldOf(file.fields, 'updated_date') === undefined ? 1 : 0;
        const changed = lineTexts(parseLines(after))[item.line + shift];
        assert.equal(changed, `- [${item.checked ? ' ' : 'x'}]${texts[item.line].slice(5)}`, `${label}: only the mark`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 15, `checked ${checked} toggles`);
});

// --- Details and refusals ---

test('status: the quote style of the line is kept; config spelling is written', () => {
  const quoted = load(read('variants/quoted-status.md'));
  const plan = planSetStatus(quoted.texts, quoted.file, { status: 'in progress', statusLine: 'status: "To Do"', statuses: STATUSES }, NOW);
  assert.match(apply(quoted.doc, plan), /\nstatus: "In Progress"\n/);
  const single = load("---\nid: X\nstatus: 'To Do'\ncreated_date: '2026-10-01 10:00'\n---\n");
  const singlePlan = planSetStatus(single.texts, single.file, { status: 'Done', statusLine: "status: 'To Do'", statuses: STATUSES }, NOW);
  assert.match(apply(single.doc, singlePlan), /\nstatus: 'Done'\n/);
});

test('status: a plain value that needs quotes falls back to single quotes', () => {
  const { doc, texts, file } = load('---\nid: X\nstatus: To Do\ncreated_date: x\n---\n');
  const plan = planSetStatus(texts, file, { status: 'Review: 2', statusLine: 'status: To Do', statuses: ['To Do', 'Review: 2'] }, NOW);
  assert.match(apply(doc, plan), /\nstatus: 'Review: 2'\n/);
});

test('status: only configured statuses (case-insensitive); other-status can move into one', () => {
  const { doc, texts, file } = load(read('variants/other-status.md'));
  const request = { statusLine: 'status: Blocked', statuses: STATUSES };
  assert.deepEqual(planSetStatus(texts, file, { ...request, status: 'Blocked' }, NOW), { ok: false, reason: 'invalid' });
  assert.deepEqual(planSetStatus(texts, file, { ...request, status: 'Nope' }, NOW), { ok: false, reason: 'invalid' });
  assert.match(apply(doc, planSetStatus(texts, file, { ...request, status: 'to do' }, NOW)), /\nstatus: To Do\n/);
});

test('status: the same status plans nothing; a case difference is normalised', () => {
  const { doc, texts, file } = load('---\nstatus: to do\nupdated_date: x\n---\n');
  const plan = planSetStatus(texts, file, { status: 'To Do', statusLine: 'status: to do', statuses: STATUSES }, NOW);
  assert.equal(apply(doc, plan), "---\nstatus: To Do\nupdated_date: '2026-10-14 09:50'\n---\n");
  const same = load("---\nstatus: To Do\nupdated_date: '2020-01-01 00:00'\n---\n");
  const none = planSetStatus(same.texts, same.file, { status: 'to do', statusLine: 'status: To Do', statuses: STATUSES }, NOW);
  assert.ok(none.ok);
  assert.deepEqual(none.operations, []);
});

test('status: a stale status line, unknown or missing status, no frontmatter', () => {
  const ok = load(read('project/tasks/task-6 - Minimal.md'));
  assert.deepEqual(planSetStatus(ok.texts, ok.file, { status: 'Done', statusLine: 'status: Done', statuses: STATUSES }, NOW), {
    ok: false,
    reason: 'stale',
  });
  for (const source of ['---\nstatus:\n  - To Do\n---\n', '---\nstatus: [To Do]\n---\n', '---\nid: X\n---\n', 'status: To Do\n']) {
    const { texts, file } = load(source);
    const plan = planSetStatus(texts, file, { status: 'Done', statusLine: statusLine(texts, file), statuses: STATUSES }, NOW);
    assert.deepEqual(plan, { ok: false, reason: 'unsafe' }, source);
  }
});

test('updated_date: inserted after status when there is no created_date', () => {
  const { doc, texts, file } = load('---\nid: X\nstatus: To Do\ntitle: T\n---\n');
  const plan = planSetStatus(texts, file, { status: 'Done', statusLine: 'status: To Do', statuses: STATUSES }, NOW);
  assert.equal(apply(doc, plan), "---\nid: X\nstatus: Done\nupdated_date: '2026-10-14 09:50'\ntitle: T\n---\n");
});

test('updated_date: inserted after a multi-line created_date field; CRLF kept', () => {
  const { doc, texts, file } = load('---\r\nstatus: To Do\r\ncreated_date:\r\n  - x\r\nid: X\r\n---\r\n');
  const plan = planSetStatus(texts, file, { status: 'Done', statusLine: 'status: To Do', statuses: STATUSES }, NOW);
  assert.equal(apply(doc, plan), "---\r\nstatus: Done\r\ncreated_date:\r\n  - x\r\nupdated_date: '2026-10-14 09:50'\r\nid: X\r\n---\r\n");
});

test('updated_date: in an unknown shape the whole operation is refused', () => {
  const { texts, file } = load(read('variants/updated-unknown.md'));
  assert.deepEqual(planSetStatus(texts, file, { status: 'Done', statusLine: 'status: To Do', statuses: STATUSES }, NOW), {
    ok: false,
    reason: 'unsafe',
  });
  for (const line of ['updated_date: |', 'updated_date: "a\\qb"', 'updated_date: [x]']) {
    const bad = load(`---\nstatus: To Do\n${line}\n---\n<!-- AC:BEGIN -->\n- [ ] #1 a\n<!-- AC:END -->\n`);
    const request = { list: 'ac' as const, line: 5, source: '- [ ] #1 a', checked: true };
    assert.deepEqual(planToggleCheck(bad.texts, bad.file, request, NOW), { ok: false, reason: 'unsafe' }, line);
  }
});

test('updated_date: the line is an expected line, so a concurrent change is caught', () => {
  const { texts, file } = load(read('project/tasks/task-3 - Ship-it.md'));
  const plan = planSetStatus(texts, file, { status: 'To Do', statusLine: 'status: Done', statuses: STATUSES }, NOW);
  assert.ok(plan.ok);
  assert.ok(plan.expectedLines.some((line) => line.text.startsWith('updated_date:')));
  const changed = parseLines(read('project/tasks/task-3 - Ship-it.md').replace("updated_date: '2026-10-14 09:49'", "updated_date: '2026-10-14 10:00'"));
  const result = computePatch(changed, 1, { expectedVersion: 1, ...plan });
  assert.equal(result.ok ? 'ok' : result.reason, 'content');
});

test('toggle: unchecking [X] writes [ ]; checking keeps the rest of the line', () => {
  const { doc, texts, file } = load(read('variants/odd-check.md'));
  const plan = planToggleCheck(texts, file, { list: 'dod', line: 16, source: '- [X] #1 upper-case check', checked: false }, NOW);
  const after = apply(doc, plan);
  assert.match(after, /\n- \[ \] #1 upper-case check\n/);
  assert.match(after, /\nupdated_date: '2026-10-14 09:50'\n/);
});

test('toggle: the same state plans nothing', () => {
  const { texts, file } = load(read('project/tasks/task-3 - Ship-it.md'));
  const plan = planToggleCheck(texts, file, { list: 'ac', line: 20, source: '- [x] #1 Tagged', checked: true }, NOW);
  assert.ok(plan.ok);
  assert.deepEqual(plan.operations, []);
});

test('toggle: refusals', () => {
  const odd = load(read('variants/odd-check.md'));
  assert.deepEqual(planToggleCheck(odd.texts, odd.file, { list: 'ac', line: 10, source: '- [ ] #1 fine', checked: true }, NOW), {
    ok: false,
    reason: 'unsafe',
  });
  assert.deepEqual(planToggleCheck(odd.texts, odd.file, { list: 'ac', line: 10, source: '- [x] #1 fine', checked: true }, NOW), {
    ok: false,
    reason: 'stale',
  });
  const task = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const cases: [string, { list: 'ac' | 'dod'; line: number; source: string }][] = [
    ['wrong list', { list: 'dod', line: 41, source: '- [ ] #2 Typecheck passes' }],
    ['not an item', { list: 'ac', line: 39, source: '<!-- AC:BEGIN -->' }],
    ['out of range', { list: 'ac', line: 999, source: '' }],
    ['source differs', { list: 'ac', line: 41, source: '- [ ] #2 Typecheck' }],
  ];
  for (const [label, request] of cases) {
    assert.deepEqual(planToggleCheck(task.texts, task.file, { ...request, checked: true }, NOW), { ok: false, reason: 'stale' }, label);
  }
  const noFrontmatter = load('<!-- AC:BEGIN -->\n- [ ] #1 a\n<!-- AC:END -->\n');
  assert.deepEqual(
    planToggleCheck(noFrontmatter.texts, noFrontmatter.file, { list: 'ac', line: 1, source: '- [ ] #1 a', checked: true }, NOW),
    { ok: false, reason: 'unsafe' },
  );
});

test('an indented --- inside a block scalar does not end the frontmatter (writes stay in it)', () => {
  const source = "---\nid: X\nnotes: |\n  before\n  ---\n  after\nstatus: To Do\ncreated_date: '2026-10-01 10:00'\n---\n\nBody\n";
  const { doc, texts, file } = load(source);
  assert.deepEqual(file.frontmatter, { openLine: 0, closeLine: 8 });
  const after = apply(doc, planSetStatus(texts, file, { status: 'Done', statusLine: 'status: To Do', statuses: STATUSES }, NOW));
  assert.equal(after, "---\nid: X\nnotes: |\n  before\n  ---\n  after\nstatus: Done\ncreated_date: '2026-10-01 10:00'\nupdated_date: '2026-10-14 09:50'\n---\n\nBody\n");
});

test('no-frontmatter variant: status change is refused', () => {
  const { texts, file } = load(read('variants/no-frontmatter.md'));
  assert.deepEqual(planSetStatus(texts, file, { status: 'Done', statusLine: '', statuses: STATUSES }, NOW), { ok: false, reason: 'unsafe' });
});
