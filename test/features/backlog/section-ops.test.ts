// Stage 2 body writes (backlog.md 5.4): byte parity with Backlog.md 1.54.0 on the
// ops/section-* fixtures, preservation outside the section over every fixture, refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines, type LineDocument } from '../../../src/core/lines.ts';
import { applyEdits, computePatch } from '../../../src/core/patch.ts';
import type { OperationPlan } from '../../../src/features/backlog/operations.ts';
import { formatCommentDate, planAddComment, planSetSection, type EditableSection } from '../../../src/features/backlog/section-ops.ts';
import { parseTaskFile, taskData, type TaskFile } from '../../../src/features/backlog/task-file.ts';

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

const seen = (texts: readonly string[], file: TaskFile, name: EditableSection): string | null => {
  const section = file.sections[name];
  return section === undefined ? null : texts.slice(section.begin + 1, section.end).join('\n');
};
const setSection = (texts: string[], file: TaskFile, section: EditableSection, text: string, now: Date) =>
  planSetSection(texts, file, { section, text, expected: seen(texts, file, section) }, now);

type Case = (texts: string[], file: TaskFile, now: Date) => OperationPlan;
const CASES: Record<string, Case> = {
  'desc-change': (t, f, n) => setSection(t, f, 'description', 'New description.', n),
  'desc-multi': (t, f, n) => setSection(t, f, 'description', 'Line one\n\n- item\n\nLine two', n),
  'desc-add': (t, f, n) => setSection(t, f, 'description', 'Fresh.', n),
  'desc-before': (t, f, n) => setSection(t, f, 'description', 'Inserted before AC.', n),
  'plan-add': (t, f, n) => setSection(t, f, 'plan', '1. Step', n),
  'plan-change': (t, f, n) => setSection(t, f, 'plan', 'New plan', n),
  'plan-empty': (t, f, n) => setSection(t, f, 'plan', '', n),
  'notes-add': (t, f, n) => setSection(t, f, 'notes', 'Note.', n),
  'notes-add-min': (t, f, n) => setSection(t, f, 'notes', 'N.', n),
  'notes-change': (t, f, n) => setSection(t, f, 'notes', 'Changed', n),
  'notes-empty': (t, f, n) => setSection(t, f, 'notes', '', n),
  'notes-padded': (t, f, n) => setSection(t, f, 'notes', '\n\n  padded line  \n\nsecond\n\n', n),
  'final-add': (t, f, n) => setSection(t, f, 'finalSummary', 'Done.', n),
  'final-change': (t, f, n) => setSection(t, f, 'finalSummary', 'Shipped v2.', n),
  'final-clear': (t, f, n) => setSection(t, f, 'finalSummary', '', n),
  'comment-add-new': (t, f, n) => planAddComment(t, f, { text: 'Second' }, n),
  'comment-first': (t, f, n) => planAddComment(t, f, { text: 'First' }, n),
  'comment-multi': (t, f, n) => planAddComment(t, f, { text: 'a\n\nb' }, n),
  'comment-padded': (t, f, n) => planAddComment(t, f, { text: '\n  padded  \n\n' }, n),
};

function cliNow(after: string): Date {
  const match = /^updated_date: '(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})'$/m.exec(after);
  assert.ok(match);
  const [, y, mo, d, h, mi] = match.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

for (const [name, plan] of Object.entries(CASES)) {
  test(`CLI parity: ops/section-${name}`, () => {
    const after = read(`ops/section-${name}.after.md`);
    const { doc, texts, file } = load(read(`ops/section-${name}.before.md`));
    assert.equal(apply(doc, plan(texts, file, cliNow(after))), after);
  });
}

test('CLI parity: comment-author is the one pair not reproduced (Notewell writes no author)', () => {
  const after = read('ops/section-comment-author.after.md');
  const { doc, texts, file } = load(read('ops/section-comment-author.before.md'));
  assert.equal(apply(doc, planAddComment(texts, file, { text: 'Hi' }, cliNow(after))), after.replace('author: @dana\n', ''));
});

test('CLI parity: comment-add keeps the earlier 1.53.0-shaped comment as it was (the CLI rewrites it)', () => {
  const before = read('ops/section-comment-add.before.md');
  const after = read('ops/section-comment-add.after.md');
  const oldShape = 'author: @bob\ncreated: 2026-10-14 09:49\n---\nLooks good so far\n---\n';
  const newShape = 'author: @bob\ncreated: 2026-10-14 09:49\n\n---\n\nLooks good so far\n\n---\n';
  assert.ok(before.includes(oldShape) && after.includes(newShape));
  const { doc, texts, file } = load(before);
  assert.equal(apply(doc, planAddComment(texts, file, { text: 'Second' }, cliNow(after))), after.replace(newShape, oldShape));
});

test('CLI parity: every section fixture has a case', () => {
  const names = readdirSync(new URL('ops/', fixtures))
    .filter((n) => n.startsWith('section-') && n.endsWith('.before.md'))
    .map((n) => n.slice('section-'.length, -'.before.md'.length));
  assert.deepEqual(names.sort(), [...Object.keys(CASES), 'comment-add', 'comment-author'].sort());
});

// --- Preservation over every fixture ---

const allFiles = [
  ...readdirSync(new URL('project/tasks/', fixtures)).map((n) => `project/tasks/${n}`),
  ...readdirSync(new URL('variants/', fixtures)).map((n) => `variants/${n}`),
  ...readdirSync(new URL('ops/', fixtures)).map((n) => `ops/${n}`),
].filter((n) => n.endsWith('.md'));

function canWrite(file: TaskFile): boolean {
  if (file.frontmatter === null) return false;
  const updated = file.fields.find((f) => f.name === 'updated_date');
  if (updated !== undefined) return updated.value.kind === 'scalar' && updated.end === updated.line + 1;
  return file.fields.some((f) => f.name === 'created_date' || f.name === 'status');
}

/** The source with the frontmatter's updated_date line and one section's lines removed. */
function withoutTarget(source: string, name: 'description' | 'plan' | 'notes' | 'finalSummary' | 'comments'): string {
  const doc = parseLines(source);
  const texts = lineTexts(doc);
  const file = parseTaskFile(texts);
  const skip = new Set<number>();
  const updated = file.fields.find((f) => f.name === 'updated_date');
  if (updated !== undefined) skip.add(updated.line);
  const section = file.sections[name];
  if (section !== undefined) for (let i = section.heading ?? section.begin; i <= section.end; i++) skip.add(i);
  // Blank lines are what a created or removed section adds or takes; compare the rest.
  return doc.lines
    .filter((line, i) => !skip.has(i) && line.text.trim() !== '')
    .map((line) => (line.eol === '\r\n' ? `${line.text}\r` : line.text))
    .join('\n');
}

/** Whether the file ends with a line break, which every edit keeps. */
const endsWithNewline = (source: string): boolean => /\n$/.test(source);

test('preservation: setting, creating and removing each section changes nothing else', () => {
  let changed = 0;
  for (const path of allFiles) {
    const source = read(path);
    const { doc, texts, file } = load(source);
    for (const name of ['description', 'plan', 'notes', 'finalSummary'] as const) {
      // An empty description is refused (see its own test).
      for (const text of name === 'description' ? ['Replaced **text**\n\nwith two paragraphs'] : ['Replaced **text**\n\nwith two paragraphs', '']) {
        const plan = setSection(texts, file, name, text, NOW);
        if (!canWrite(file)) {
          assert.deepEqual(plan, { ok: false, reason: 'unsafe' }, `${path} ${name}`);
          continue;
        }
        if (!plan.ok || plan.operations.length === 0) {
          assert.ok(plan.ok, `${path} ${name}: ${plan.ok ? '' : plan.reason}`);
          continue;
        }
        const after = apply(doc, plan);
        assert.equal(parseLines(after).bom, doc.bom);
        assert.equal(withoutTarget(after, name), withoutTarget(source, name), `${path} ${name} '${text.slice(0, 8)}'`);
        assert.equal(endsWithNewline(after), endsWithNewline(source), `${path} ${name}: end of file`);
        const data = taskData(lineTexts(parseLines(after)));
        assert.equal(data[name], text === '' ? null : text, `${path} ${name}`);
        assert.match(after, /^updated_date: '2027-01-02 03:04'\r?$/m);
        changed++;
      }
    }
  }
  assert.ok(changed > 150, `changed ${changed}`);
});

test('preservation: adding a comment changes nothing else', () => {
  let changed = 0;
  for (const path of allFiles) {
    const source = read(path);
    const { doc, texts, file } = load(source);
    const plan = planAddComment(texts, file, { text: 'A *new* comment' }, NOW);
    if (!canWrite(file)) {
      assert.deepEqual(plan, { ok: false, reason: 'unsafe' }, path);
      continue;
    }
    const before = taskData(texts);
    if (before.commentsRaw !== null) {
      assert.deepEqual(plan, { ok: false, reason: 'unsafe' }, path);
      continue;
    }
    const after = apply(doc, plan);
    assert.equal(withoutTarget(after, 'comments'), withoutTarget(source, 'comments'), path);
    assert.equal(endsWithNewline(after), endsWithNewline(source), `${path}: end of file`);
    const comments = taskData(lineTexts(parseLines(after))).comments!;
    assert.deepEqual(comments.slice(0, -1), before.comments ?? [], `${path}: earlier comments kept`);
    assert.deepEqual(comments.at(-1), { author: null, created: '2027-01-02 03:04', body: 'A *new* comment' }, path);
    changed++;
  }
  assert.ok(changed > 30, `changed ${changed}`);
});

// --- Details and refusals ---

test('formatCommentDate: UTC, unquoted', () => {
  assert.equal(formatCommentDate(NOW), '2027-01-02 03:04');
});

test('stale expected text', () => {
  const { texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const stale = { ok: false, reason: 'stale' };
  assert.deepEqual(planSetSection(texts, file, { section: 'notes', text: 'x', expected: 'Started' }, NOW), stale);
  assert.deepEqual(planSetSection(texts, file, { section: 'notes', text: 'x', expected: null }, NOW), stale);
  assert.deepEqual(planSetSection(texts, file, { section: 'finalSummary', text: 'x', expected: '' }, NOW), stale);
});

test('invalid text and sections', () => {
  const { texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const invalid = { ok: false, reason: 'invalid' };
  const notes = seen(texts, file, 'notes');
  assert.deepEqual(planSetSection(texts, file, { section: 'notes', text: 'a\n<!-- SECTION:NOTES:END -->\nb', expected: notes }, NOW), invalid);
  assert.deepEqual(planSetSection(texts, file, { section: 'notes', text: '<!-- AC:BEGIN -->', expected: notes }, NOW), invalid);
  assert.deepEqual(planSetSection(texts, file, { section: 'ac' as EditableSection, text: 'x', expected: null }, NOW), invalid);
  for (const text of ['', '   \n ', 'a\n---\nb', ' --- ', 'x\n<!-- COMMENTS:END -->']) {
    assert.deepEqual(planAddComment(texts, file, { text }, NOW), invalid, JSON.stringify(text));
  }
});

test('unclosed code fences are refused: they would swallow every later marker', () => {
  const { doc, texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const invalid = { ok: false, reason: 'invalid' };
  const description = seen(texts, file, 'description');
  for (const text of ['Example:\n```ts\nconst x = 1;', '~~~\nopen', '````\n```\nstill open']) {
    assert.deepEqual(planSetSection(texts, file, { section: 'description', text, expected: description }, NOW), invalid, JSON.stringify(text));
    assert.deepEqual(planSetSection(texts, file, { section: 'finalSummary', text, expected: null }, NOW), invalid, JSON.stringify(text));
    assert.deepEqual(planAddComment(texts, file, { text }, NOW), invalid, JSON.stringify(text));
  }
  // Closed fences are fine, and the file keeps all its sections afterwards.
  const closed = 'Example:\n```ts\nconst x = 1;\n```';
  const after = apply(doc, planSetSection(texts, file, { section: 'description', text: closed, expected: description }, NOW));
  const data = taskData(lineTexts(parseLines(after)));
  assert.equal(data.description, closed);
  assert.deepEqual([data.ac?.readOnly, data.plan, data.notes, data.comments?.length], [false, '1. Add script\n2. Wire CI', 'Started with esbuild.', 1]);
});

test('unsafe: no frontmatter, unknown updated_date, comments of another shape', () => {
  const unsafe = { ok: false, reason: 'unsafe' };
  for (const path of ['variants/no-frontmatter.md', 'variants/updated-unknown.md']) {
    const { texts, file } = load(read(path));
    assert.deepEqual(setSection(texts, file, 'notes', 'x', NOW), unsafe, path);
    assert.deepEqual(planAddComment(texts, file, { text: 'x' }, NOW), unsafe, path);
  }
  const raw = load('---\nstatus: To Do\nupdated_date: x\n---\n\n## Comments\n\n<!-- COMMENTS:BEGIN -->\nfree text\n<!-- COMMENTS:END -->\n');
  assert.deepEqual(planAddComment(raw.texts, raw.file, { text: 'x' }, NOW), unsafe);
});

test('same text plans nothing; hand-written blank lines inside markers are replaced', () => {
  const { texts, file } = load(read('project/tasks/task-1 - Set-up-the-build.md'));
  const plan = setSection(texts, file, 'notes', '  Started with esbuild.\n', NOW);
  assert.ok(plan.ok);
  assert.deepEqual(plan.operations, []);
  const spaced = load('---\nstatus: To Do\nupdated_date: x\n---\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n\nold\n\n<!-- SECTION:NOTES:END -->\n');
  assert.equal(
    apply(spaced.doc, setSection(spaced.texts, spaced.file, 'notes', 'new', NOW)),
    "---\nstatus: To Do\nupdated_date: '2027-01-02 03:04'\n---\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\nnew\n<!-- SECTION:NOTES:END -->\n",
  );
});

test('an empty description is refused (the CLI never removes one); other sections are removed', () => {
  const { texts, file } = load(read('project/tasks/task-1.1 - Write-the-parser.md'));
  for (const text of ['', '   \n  ']) {
    assert.deepEqual(setSection(texts, file, 'description', text, NOW), { ok: false, reason: 'invalid' }, JSON.stringify(text));
  }
  const missing = load(read('project/tasks/task-6 - Minimal.md'));
  assert.deepEqual(setSection(missing.texts, missing.file, 'description', '', NOW), { ok: false, reason: 'invalid' });
});

test('removing the first section keeps one blank line after the frontmatter', () => {
  const { doc, texts, file } = load('---\nid: X\nstatus: To Do\nupdated_date: x\n---\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\nn\n<!-- SECTION:NOTES:END -->\n\n## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->\nf\n<!-- SECTION:FINAL_SUMMARY:END -->\n');
  const after = apply(doc, setSection(texts, file, 'notes', '', NOW));
  assert.match(after, /\n---\n\n## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->/);
});

test('an empty comments block gets the comment without a leading blank line; CRLF kept', () => {
  const empty = load('---\r\nstatus: To Do\r\nupdated_date: x\r\n---\r\n\r\n## Comments\r\n\r\n<!-- COMMENTS:BEGIN -->\r\n<!-- COMMENTS:END -->\r\n');
  assert.equal(
    apply(empty.doc, planAddComment(empty.texts, empty.file, { text: 'Hi' }, NOW)),
    "---\r\nstatus: To Do\r\nupdated_date: '2027-01-02 03:04'\r\n---\r\n\r\n## Comments\r\n\r\n<!-- COMMENTS:BEGIN -->\r\ncreated: 2027-01-02 03:04\r\n\r\n---\r\n\r\nHi\r\n\r\n---\r\n<!-- COMMENTS:END -->\r\n",
  );
});
