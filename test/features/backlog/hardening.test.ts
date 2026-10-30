// Write-path hardening (backlog.md 5): hostile files, hostile input and races against the
// session with ports that behave like the panel's (the write checks the file still holds
// `before`). A write either does exactly what was asked, or nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, type TextEdit } from '../../../src/core/patch.ts';
import { backlogDirectory, parseConfig } from '../../../src/features/backlog/config.ts';
import type { ErrorReason, ExtensionMessage } from '../../../src/features/backlog/messages.ts';
import { ordinalBetween, planMoveInColumn } from '../../../src/features/backlog/ordinal-ops.ts';
import { BacklogSession, dependenciesAllowed, type BacklogPorts, type DependencyGraph } from '../../../src/features/backlog/session.ts';
import { parseComments, parseChecklist, parseTaskFile, sectionText, taskData } from '../../../src/features/backlog/task-file.ts';
import { idKey } from '../../../src/features/backlog/task-index.ts';
import { DEFAULT_STRINGS, type BacklogView, type TaskSummary } from '../../../src/features/backlog/view.ts';
import { listOf, scalarOf } from '../../../src/features/backlog/yaml-lite.ts';

const NOW = new Date(Date.UTC(2026, 9, 15, 8, 30));
const ERRORS: Record<ErrorReason, string> = { stale: 'stale', invalid: 'invalid', unsafe: 'unsafe', failed: 'failed', nothingToUndo: 'nothing', readOnly: 'readOnly', encoding: 'encoding' };
const STATUSES = ['To Do', 'In Progress', 'Done'];

/** A task as Backlog.md 1.54.0 writes it. */
const TASK = [
  '---',
  'id: TASK-1',
  'title: Build it',
  'status: To Do',
  'assignee: []',
  "created_date: '2026-10-01 10:00'",
  "updated_date: '2026-10-01 10:00'",
  'labels:',
  '  - build',
  'dependencies: []',
  'priority: high',
  'ordinal: 2000',
  '---',
  '',
  '## Description',
  '',
  '<!-- SECTION:DESCRIPTION:BEGIN -->',
  'Describe it.',
  '<!-- SECTION:DESCRIPTION:END -->',
  '',
  '## Acceptance Criteria',
  '<!-- AC:BEGIN -->',
  '- [ ] #1 First',
  '- [ ] #2 Second',
  '<!-- AC:END -->',
  '',
  '## Implementation Notes',
  '',
  '<!-- SECTION:NOTES:BEGIN -->',
  'Some notes.',
  '<!-- SECTION:NOTES:END -->',
  '',
].join('\n');

const P = 'tasks/task-1 - Build-it.md';
const Q = 'tasks/task-2 - Other.md';

interface Harness {
  readonly session: BacklogSession;
  readonly files: Map<string, string>;
  readonly posted: ExtensionMessage[];
  writes: number;
  /** Runs right before the write port compares the file (another tool writing meanwhile). */
  beforeWrite?: (path: string) => void;
  handle(message: unknown): Promise<void>;
  errors(): string[];
}

/** The board's task summaries, from the files (for moveInColumn). */
function summaries(files: Map<string, string>): TaskSummary[] {
  return [...files].map(([path, text]) => {
    const data = taskData(lineTexts(parseLines(text)));
    return { path, id: data.id ?? '', title: data.title, status: data.status ?? 'To Do', ordinal: data.ordinal } as unknown as TaskSummary;
  });
}

function harness(files: Record<string, string>, overrides: Partial<BacklogPorts> = {}): Harness {
  const h = {
    files: new Map(Object.entries(files)),
    posted: [] as ExtensionMessage[],
    writes: 0,
  } as Harness & { session: BacklogSession };
  const graph: DependencyGraph = { keyOf: (id) => idKey(id, 'task'), tasks: new Map() };
  const ports: BacklogPorts = {
    view: () =>
      ({
        project: 'demo', statuses: STATUSES, doneStatus: 'Done', tasks: summaries(h.files), archived: [], unreadable: [], milestones: [],
        taskTypes: [], priorities: ['High', 'Medium', 'Low'], detailPosition: 'bottom', layout: { columnWidths: {}, paneSizes: {} }, strings: DEFAULT_STRINGS,
      }) as BacklogView,
    detail: () => null,
    readTask: async (path) => {
      const text = h.files.get(path);
      return text === undefined ? undefined : { text, version: 1 };
    },
    write: async (path, { before, after, edits }) => {
      h.beforeWrite?.(path);
      const text = h.files.get(path);
      if (text === undefined || text !== before) return 'stale';
      assert.equal(applyEdits(parseLines(before), edits as TextEdit[]), after, 'edits and after describe the same change');
      h.files.set(path, after);
      h.writes++;
      return 'written';
    },
    statuses: () => STATUSES,
    post: (message) => void h.posted.push(message),
    openTask: async () => undefined,
    openPath: async () => undefined,
    openUrl: async () => undefined,
    now: () => NOW,
    errors: ERRORS,
    dependencies: () => graph,
    saveLayout: async () => undefined,
    setDetailPosition: async () => undefined,
    ...overrides,
  };
  h.session = new BacklogSession(ports);
  h.handle = (message) => h.session.handle(message);
  h.errors = () => h.posted.filter((m) => m.type === 'error').map((m) => (m as { reason: string }).reason);
  return h;
}

const lines = (text: string): string[] => lineTexts(parseLines(text));
const fileOf = (text: string) => parseTaskFile(lines(text));
const lineOf = (text: string, prefix: string): string => lines(text).find((l) => l.startsWith(prefix))!;
const indexOf = (text: string, line: string): number => lines(text).indexOf(line);

/**
 * Every line (with its ending) that does not match `changed` is kept, in order, byte for byte;
 * the BOM too. An independent check: it does not use the task parser.
 */
function assertOnlyChanged(before: string, after: string, changed: (text: string) => boolean): void {
  const keep = (text: string) => {
    const doc = parseLines(text);
    return { bom: doc.bom, lines: doc.lines.filter((l) => !changed(l.text)).map((l) => JSON.stringify(l.text + l.eol)) };
  };
  assert.deepEqual(keep(after), keep(before));
}

const isUpdated = (t: string): boolean => t.startsWith('updated_date:');

/** Every write operation the panel can send for TASK at path P. */
function operations(text: string): { name: string; message: Record<string, unknown> }[] {
  return [
    { name: 'setStatus (detail)', message: { type: 'setStatus', path: P, statusLine: lineOf(text, 'status:'), status: 'Done' } },
    { name: 'setStatus (board)', message: { type: 'setStatus', path: P, statusLine: '', fromStatus: 'To Do', status: 'Done' } },
    { name: 'toggleCheck', message: { type: 'toggleCheck', path: P, list: 'ac', line: indexOf(text, '- [ ] #1 First'), source: '- [ ] #1 First', checked: true } },
    { name: 'setField', message: { type: 'setField', path: P, name: 'title', value: 'Renamed', expected: lineOf(text, 'title:') } },
    { name: 'setList', message: { type: 'setList', path: P, name: 'labels', values: 'build\nci', expected: 'labels:\n  - build' } },
    { name: 'setSection', message: { type: 'setSection', path: P, section: 'notes', text: 'New notes.', expected: 'Some notes.' } },
    { name: 'addComment', message: { type: 'addComment', path: P, text: 'A comment', seen: 0 } },
    { name: 'moveInColumn', message: { type: 'moveInColumn', path: P, fromStatus: 'To Do', afterPath: Q } },
  ];
}

const OTHER = TASK.replace('id: TASK-1', 'id: TASK-2').replace('title: Build it', 'title: Other').replace('ordinal: 2000', 'ordinal: 5000');

// --- 1. The file changes between read and write ---------------------------------------------

test('1: every operation (and undo) refuses when another tool rewrote the file between read and write', async () => {
  const cli = TASK.replace('Some notes.', 'Notes written by the CLI.');
  for (const { name, message } of operations(TASK)) {
    const h = harness({ [P]: TASK, [Q]: OTHER });
    h.beforeWrite = (path) => void h.files.set(path, cli);
    await h.handle(message);
    assert.equal(h.files.get(P), cli, `${name}: the other tool's text stays`);
    assert.deepEqual(h.errors(), ['stale'], name);
  }
  // Undo: written first, then another tool changes it before the undo writes.
  for (const { name, message } of operations(TASK)) {
    const h = harness({ [P]: TASK, [Q]: OTHER });
    await h.handle(message);
    const edited = h.files.get(P)!;
    assert.notEqual(edited, TASK, name);
    h.beforeWrite = (path) => void h.files.set(path, cli);
    await h.handle({ type: 'undo' });
    assert.equal(h.files.get(P), cli, `undo after ${name}`);
    assert.deepEqual(h.errors(), ['stale'], `undo after ${name}`);
  }
});

// --- 2. Rapid repeated clicks ----------------------------------------------------------------

test('2: rapid clicks are handled in order, each on the result of the previous one; undo unwinds them exactly', async () => {
  const h = harness({ [P]: TASK });
  const first = indexOf(TASK, '- [ ] #1 First');
  const second = indexOf(TASK, '- [ ] #2 Second');
  // Not awaited one by one: as fast as the webview can post them.
  await Promise.all([
    h.handle({ type: 'toggleCheck', path: P, list: 'ac', line: first, source: '- [ ] #1 First', checked: true }),
    h.handle({ type: 'toggleCheck', path: P, list: 'ac', line: second, source: '- [ ] #2 Second', checked: true }),
    // The same click again, with what the panel showed before the first one: stale, not a double toggle.
    h.handle({ type: 'toggleCheck', path: P, list: 'ac', line: first, source: '- [ ] #1 First', checked: true }),
    h.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status: 'In Progress' }),
    h.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status: 'Done' }),
  ]);
  const text = h.files.get(P)!;
  assert.match(text, /- \[x\] #1 First/);
  assert.match(text, /- \[x\] #2 Second/);
  assert.match(text, /\nstatus: In Progress\n/);
  assert.deepEqual(h.errors(), ['stale', 'stale']);
  assert.equal(h.writes, 3);
  await Promise.all([h.handle({ type: 'undo' }), h.handle({ type: 'undo' }), h.handle({ type: 'undo' })]);
  assert.equal(h.files.get(P), TASK);
});

// --- 3. Unusual status lines -----------------------------------------------------------------

test('3: unusual status lines are rewritten in place or refused, never mangled', async () => {
  const cases: { line: string; ok: boolean }[] = [
    { line: "status: 'To Do'", ok: true },
    { line: 'status: "To Do"', ok: true },
    { line: 'status: To Do   ', ok: true },
    { line: 'status:\tTo Do', ok: true },
    { line: 'status:   To Do', ok: true },
    { line: 'status: To Do # moved by hand', ok: false },
    { line: "status: 'To Do' # comment", ok: false },
    { line: 'status: "To Do', ok: false },
    { line: 'status: [To Do]', ok: false },
    { line: 'status: &a To Do', ok: false },
    { line: 'status: !!str To Do', ok: false },
    { line: 'status: |', ok: false },
  ];
  for (const { line, ok } of cases) {
    for (const eol of ['\n', '\r\n']) {
      const before = TASK.replace('status: To Do', line).replaceAll('\n', eol);
      const h = harness({ [P]: before });
      await h.handle({ type: 'setStatus', path: P, statusLine: line, status: 'Done' });
      const after = h.files.get(P)!;
      const label = `${JSON.stringify(line)} ${JSON.stringify(eol)}`;
      if (!ok) {
        assert.equal(after, before, label);
        assert.deepEqual(h.errors(), ['unsafe'], label);
        continue;
      }
      assert.deepEqual(h.errors(), [], label);
      assert.equal(scalarOf(fileOf(after).fields, 'status'), 'Done', label);
      assertOnlyChanged(before, after, (t) => t.startsWith('status:') || isUpdated(t));
      if (eol === '\r\n') assert.ok(!/[^\r]\n/.test(after), `${label}: no bare LF`);
      // From the board too (no source line).
      const b = harness({ [P]: before });
      await b.handle({ type: 'setStatus', path: P, statusLine: '', fromStatus: 'to do', status: 'Done' });
      assert.equal(scalarOf(fileOf(b.files.get(P)!).fields, 'status'), 'Done', `board ${label}`);
    }
  }
});

// --- 4. Unusual AC lists ---------------------------------------------------------------------

test('4: AC toggles change one mark in well-formed lists and refuse lists they cannot read', async () => {
  const withAc = (items: string[]) => TASK.replace('- [ ] #1 First\n- [ ] #2 Second', items.join('\n'));
  const writable: { items: string[]; line: string }[] = [
    { items: ['- [ ] #1 First', '- [ ] #1 Again'], line: '- [ ] #1 Again' },
    { items: ['- [ ] #1 First', '- [ ] #3 Third'], line: '- [ ] #3 Third' },
    { items: ['- [ ] #3 Third', '- [ ] #1 First'], line: '- [ ] #1 First' },
    { items: ['- [X] #1 Upper', '- [ ] #2 Second'], line: '- [X] #1 Upper' },
    { items: ['- [ ] #1 First', '', '- [ ] #2 After a blank'], line: '- [ ] #2 After a blank' },
  ];
  for (const { items, line } of writable) {
    const before = withAc(items);
    const h = harness({ [P]: before });
    const checked = line.startsWith('- [ ]');
    await h.handle({ type: 'toggleCheck', path: P, list: 'ac', line: indexOf(before, line), source: line, checked });
    const after = h.files.get(P)!;
    assert.deepEqual(h.errors(), [], line);
    const changed = `- [${checked ? 'x' : ' '}]${line.slice(5)}`;
    assert.ok(lines(after).includes(changed), line);
    assertOnlyChanged(before, after, (t) => t === line || t === changed || isUpdated(t));
  }
  const readOnly: string[][] = [
    ['- [ ] #1 First', '  - [ ] nested sub-item'],
    ['- [ ] #1 First', '```', '- [ ] #2 In a fence', '```'],
    ['- [ ] #1 First', 'A loose line'],
    ['- [ ] #1 First', '* [ ] #2 Star bullet'],
    ['- [ ] #1 First', '- [ ]#2 No space'],
  ];
  for (const items of readOnly) {
    const before = withAc(items);
    for (const line of ['- [ ] #1 First', ...items.filter((l) => l.includes('[ ]') && l !== '- [ ] #1 First')]) {
      const h = harness({ [P]: before });
      await h.handle({ type: 'toggleCheck', path: P, list: 'ac', line: indexOf(before, line), source: line, checked: true });
      assert.equal(h.files.get(P), before, JSON.stringify(items));
      assert.equal(h.errors().length, 1, JSON.stringify(items));
    }
  }
  // A line number pointing outside the list (at a look-alike in the notes) is stale.
  const fake = TASK.replace('Some notes.', '- [ ] #1 First');
  const h = harness({ [P]: fake });
  await h.handle({ type: 'toggleCheck', path: P, list: 'ac', line: lines(fake).lastIndexOf('- [ ] #1 First'), source: '- [ ] #1 First', checked: true });
  assert.equal(h.files.get(P), fake);
  assert.equal(h.errors().length, 1);
});

// --- 5. Section markers in odd places --------------------------------------------------------

test('5: a section is written only when its markers are unambiguous', async () => {
  const notes = (body: string) => TASK.replace('<!-- SECTION:NOTES:BEGIN -->\nSome notes.\n<!-- SECTION:NOTES:END -->', body);
  const refused: { name: string; before: string; expected: string | undefined }[] = [
    { name: 'duplicated BEGIN', before: notes('<!-- SECTION:NOTES:BEGIN -->\n<!-- SECTION:NOTES:BEGIN -->\nSome notes.\n<!-- SECTION:NOTES:END -->'), expected: 'Some notes.' },
    { name: 'BEGIN without END', before: notes('<!-- SECTION:NOTES:BEGIN -->\nSome notes.'), expected: undefined },
    { name: 'lower-case markers', before: notes('<!-- section:notes:begin -->\nSome notes.\n<!-- section:notes:end -->'), expected: undefined },
    { name: 'marker text in inline code elsewhere', before: TASK.replace('Describe it.', 'Use `<!-- SECTION:NOTES:END -->` to end notes.'), expected: 'Some notes.' },
    { name: 'END marker in a fence of another section', before: TASK.replace('Describe it.', '```\n<!-- SECTION:NOTES:END -->\n```'), expected: 'Some notes.' },
    { name: 'END marker in a fence, notes missing', before: notes('').replace('Describe it.', '```\n<!-- SECTION:NOTES:BEGIN -->\n```'), expected: undefined },
  ];
  for (const { name, before, expected } of refused) {
    const h = harness({ [P]: before });
    await h.handle({ type: 'setSection', path: P, section: 'notes', text: 'Replaced.', ...(expected === undefined ? {} : { expected }) });
    assert.equal(h.files.get(P), before, name);
    assert.equal(h.errors().length, 1, name);
  }
  const written: { name: string; before: string; expected: string }[] = [
    { name: 'odd spacing', before: notes('<!--SECTION:NOTES:BEGIN-->\nSome notes.\n<!--   SECTION:NOTES:END   -->'), expected: 'Some notes.' },
    // The marker text inside the section's own fence is replaced with the rest of the content.
    { name: 'END marker in a fence inside the section', before: notes('<!-- SECTION:NOTES:BEGIN -->\n```\n<!-- SECTION:NOTES:END -->\n```\n<!-- SECTION:NOTES:END -->'), expected: '```\n<!-- SECTION:NOTES:END -->\n```' },
  ];
  for (const { name, before, expected } of written) {
    const h = harness({ [P]: before });
    await h.handle({ type: 'setSection', path: P, section: 'notes', text: 'Replaced.', expected });
    assert.deepEqual(h.errors(), [], name);
    const after = h.files.get(P)!;
    assert.equal(sectionText(lines(after), fileOf(after).sections.notes), 'Replaced.', name);
  }
});

// --- 6. Structure injection through user text -------------------------------------------------

const INJECTIONS = [
  '<!-- SECTION:NOTES:END -->',
  '<!-- SECTION:NOTES:BEGIN -->',
  '<!-- AC:BEGIN -->',
  '  <!--section:plan:end-->  ',
  'before <!-- SECTION:NOTES:END --> after',
  '`<!-- COMMENTS:END -->`',
  '<!--SECTION:DESCRIPTION:END-->',
  '## Acceptance Criteria',
  '## Description',
  '##   implementation notes  ',
  '# Comments',
];

test('6: user text cannot inject section markers or section headings', async () => {
  for (const injected of INJECTIONS) {
    for (const section of ['description', 'plan', 'notes', 'finalSummary']) {
      const h = harness({ [P]: TASK });
      const expected = section === 'description' ? 'Describe it.' : section === 'notes' ? 'Some notes.' : undefined;
      await h.handle({ type: 'setSection', path: P, section, text: `Line one\n${injected}\n- [ ] #1 sneaky`, ...(expected === undefined ? {} : { expected }) });
      assert.equal(h.files.get(P), TASK, `${section} ${injected}`);
      assert.deepEqual(h.errors(), ['invalid'], `${section} ${injected}`);
    }
    const c = harness({ [P]: TASK });
    await c.handle({ type: 'addComment', path: P, text: `Hi\n${injected}`, seen: 0 });
    assert.equal(c.files.get(P), TASK, `comment ${injected}`);
    // One-line values are quoted YAML: a heading there is just text; marker text is still refused.
    if (!injected.includes('<!--')) continue;
    const t = harness({ [P]: TASK });
    await t.handle({ type: 'setField', path: P, name: 'title', value: injected.trim(), expected: 'title: Build it' });
    assert.equal(t.files.get(P), TASK, `title ${injected}`);
    const l = harness({ [P]: TASK });
    await l.handle({ type: 'setList', path: P, name: 'labels', values: injected, expected: 'labels:\n  - build' });
    assert.equal(l.files.get(P), TASK, `label ${injected}`);
  }
});

test('6: frontmatter-looking and rule lines in section text stay content; the structure is intact', async () => {
  const text = '---\nid: TASK-99\nstatus: Done\n---\n\n***\nid: x';
  const h = harness({ [P]: TASK });
  await h.handle({ type: 'setSection', path: P, section: 'notes', text, expected: 'Some notes.' });
  assert.deepEqual(h.errors(), []);
  const after = h.files.get(P)!;
  const file = fileOf(after);
  assert.equal(sectionText(lines(after), file.sections.notes), text);
  assert.equal(scalarOf(file.fields, 'id'), 'TASK-1');
  assert.equal(scalarOf(file.fields, 'status'), 'To Do');
  assert.deepEqual(Object.keys(file.sections).sort(), ['ac', 'description', 'notes']);
  // In a comment `---` delimits: refused.
  const c = harness({ [P]: TASK });
  await c.handle({ type: 'addComment', path: P, text: 'a\n---\nb', seen: 0 });
  assert.deepEqual(c.errors(), ['invalid']);
});

// --- 7. Unclosed fences and HTML comments -----------------------------------------------------

test('7: text with an unclosed fence or HTML comment is refused', async () => {
  const texts = ['```\ncode', '~~~~\ncode\n~~~', 'a <!-- hidden', '<!--\nnever closed', 'x --> y <!-- z'];
  for (const text of texts) {
    const h = harness({ [P]: TASK });
    await h.handle({ type: 'setSection', path: P, section: 'notes', text, expected: 'Some notes.' });
    assert.equal(h.files.get(P), TASK, text);
    assert.deepEqual(h.errors(), ['invalid'], text);
    const c = harness({ [P]: TASK });
    await c.handle({ type: 'addComment', path: P, text, seen: 0 });
    assert.equal(c.files.get(P), TASK, `comment ${text}`);
  }
  // Closed ones are fine.
  for (const text of ['```\ncode\n```', 'a <!-- note --> b', '<!--\nmulti\n-->']) {
    const h = harness({ [P]: TASK });
    await h.handle({ type: 'setSection', path: P, section: 'notes', text, expected: 'Some notes.' });
    assert.deepEqual(h.errors(), [], text);
  }
});

// --- 8. Field values ------------------------------------------------------------------------

test('8: field values are written so they read back exactly, or refused', async () => {
  const roundTrip = [
    'a: b', 'C# rocks', 'x #y', "it's", '"quoted"', "'single'", '- leading dash', '@alice', '[link]', '{brace}', '%pct', '!bang', '&anchor',
    '*star', '|pipe', '>gt', '?q', '`tick`', 'yes', 'null', '123', '1e3', '0x1F', '2026-10-15', '~', '  padded  ', 'tab\there', 'back\\slash',
    '🚀 emoji 👩‍💻', 'שלום \u200F rtl', '\u202Eoverride', 'x'.repeat(2000), '---', '...', '#', ':', '-', 'trailing:',
  ];
  for (const style of ['plain', 'double']) {
    const base = style === 'double' ? TASK.replace('title: Build it', 'title: "Build it"') : TASK;
    for (const value of roundTrip) {
      const h = harness({ [P]: base });
      await h.handle({ type: 'setField', path: P, name: 'title', value, expected: lineOf(base, 'title:') });
      const after = h.files.get(P)!;
      assert.deepEqual(h.errors(), [], `${style} ${JSON.stringify(value)}`);
      assert.equal(scalarOf(fileOf(after).fields, 'title'), value, `${style} ${JSON.stringify(value)}`);
      assertOnlyChanged(base, after, (t) => t.startsWith('title:') || isUpdated(t));
      assert.equal(lines(after).length, lines(base).length, 'one line per value');
    }
  }
  const refused = ['a\nb', 'a\rb', 'nul\u0000', 'bell\u0007', 'esc\u001b[31m', 'del\u007f', 'c1\u0085', 'c1\u009b', 'ls\u2028', 'ps\u2029', 'lone\uD800', 'lone\uDC00x', 'nonchar\uFFFF', 'x'.repeat(2001), ''];
  for (const value of refused) {
    const h = harness({ [P]: TASK });
    await h.handle({ type: 'setField', path: P, name: 'title', value, expected: 'title: Build it' });
    assert.equal(h.files.get(P), TASK, JSON.stringify(value));
    assert.equal(h.errors().length, 1, JSON.stringify(value));
  }
  // Section and comment text: the same characters are refused.
  for (const bad of ['nul\u0000', 'esc\u001b', 'lone\uD800', 'c1\u0090']) {
    const h = harness({ [P]: TASK });
    await h.handle({ type: 'setSection', path: P, section: 'notes', text: bad, expected: 'Some notes.' });
    await h.handle({ type: 'addComment', path: P, text: bad, seen: 0 });
    assert.equal(h.files.get(P), TASK, JSON.stringify(bad));
  }
});

// --- 9. List values ------------------------------------------------------------------------

test('9: list items with YAML specials read back exactly; duplicates are refused, blanks dropped', async () => {
  const values = ['a, b', '"q"', "it's", 'yes', 'null', '123', '@alice', '- dash', '#tag', 'k: v', '[x]', '{y}', '🙂', '한국어', 'x\ty'];
  for (const name of ['labels', 'assignee']) {
    const h = harness({ [P]: TASK });
    const expected = name === 'labels' ? 'labels:\n  - build' : 'assignee: []';
    await h.handle({ type: 'setList', path: P, name, values: ['', '   ', ...values, '  '].join('\n'), expected });
    const after = h.files.get(P)!;
    assert.deepEqual(h.errors(), [], name);
    assert.deepEqual(listOf(fileOf(after).fields, name), values, name);
  }
  for (const dup of ['a\na', 'a\nb\na', 'Bug\nbug']) {
    const h = harness({ [P]: TASK });
    await h.handle({ type: 'setList', path: P, name: 'labels', values: dup, expected: 'labels:\n  - build' });
    assert.equal(h.files.get(P), TASK, dup);
    assert.deepEqual(h.errors(), ['invalid'], dup);
  }
  // A repeat already in the file may stay (the list can still be shortened); adding another is refused.
  const repeated = TASK.replace('labels:\n  - build', 'labels:\n  - build\n  - Build\n  - ci');
  const r = harness({ [P]: repeated });
  await r.handle({ type: 'setList', path: P, name: 'labels', values: 'build\nBuild', expected: 'labels:\n  - build\n  - Build\n  - ci' });
  assert.deepEqual(r.errors(), []);
  assert.deepEqual(listOf(fileOf(r.files.get(P)!).fields, 'labels'), ['build', 'Build']);
  await r.handle({ type: 'setList', path: P, name: 'labels', values: 'build\nBuild\nBUILD', expected: 'labels:\n  - build\n  - Build' });
  assert.deepEqual(r.errors(), ['invalid']);
  for (const bad of ['nul\u0000', 'lone\uD800']) {
    const h = harness({ [P]: TASK });
    await h.handle({ type: 'setList', path: P, name: 'labels', values: bad, expected: 'labels:\n  - build' });
    assert.equal(h.files.get(P), TASK, JSON.stringify(bad));
  }
});

// --- 10. Byte-for-byte preservation ----------------------------------------------------------

const ODD = [
  '---',
  'id: TASK-1',
  '# a comment the CLI would drop',
  'title: Build it',
  'status: To Do',
  'custom:',
  '  nested: value',
  'tags: [a, "b, c"]',
  'notes: |',
  '  block',
  'weird:\t tabbed value',
  "created_date: '2026-10-01 10:00'",
  "updated_date: '2026-10-01 10:00'",
  'labels:',
  '  - build',
  'ordinal: 2000',
  '---',
  '',
  '## Description',
  '',
  '<!-- SECTION:DESCRIPTION:BEGIN -->',
  'Describe it.\t ',
  '<!-- SECTION:DESCRIPTION:END -->',
  '',
  '## Acceptance Criteria',
  '<!-- AC:BEGIN -->',
  '- [ ] #1 First',
  '- [ ] #2 Second',
  '<!-- AC:END -->',
  '',
  'Loose text the CLI does not know.  ',
  '',
  '## Implementation Notes',
  '',
  '<!-- SECTION:NOTES:BEGIN -->',
  'Some notes.',
  '<!-- SECTION:NOTES:END -->',
].join('\n');

test('10: unknown keys, comments, flow lists, tabs, CRLF, BOM and no final newline survive every operation', async () => {
  const variants: Record<string, string> = {
    lf: `${ODD}\n`,
    crlf: `${ODD.replaceAll('\n', '\r\n')}\r\n`,
    'bom+crlf': `\uFEFF${ODD.replaceAll('\n', '\r\n')}\r\n`,
    'no final newline': ODD,
    mixed: `${ODD}\n`.replace('title: Build it\n', 'title: Build it\r\n'),
  };
  for (const [variant, before] of Object.entries(variants)) {
    for (const { name, message } of operations(before)) {
      const h = harness({ [P]: before, [Q]: OTHER });
      await h.handle(message);
      const after = h.files.get(P)!;
      const label = `${variant} ${name}`;
      assert.deepEqual(h.errors(), [], label);
      assert.notEqual(after, before, label);
      // Lines the operation may touch; every other byte stays.
      const touched = (t: string) =>
        /^(status|title|updated_date|ordinal):/.test(t) || /^- \[[ x]\] #1 First$/.test(t) || /^labels:|^ {2}- (build|ci)$/.test(t) ||
        /notes\.$/i.test(t) || t === 'New notes.' || t === 'A comment' || /^created: |^---$|COMMENTS|^## Comments$/.test(t) || t === '' ||
        // The last line gains a line ending when a section is appended after it.
        (variant === 'no final newline' && t === '<!-- SECTION:NOTES:END -->');
      assertOnlyChanged(before, after, touched);
      // New lines use the file's line ending.
      if (variant === 'crlf' || variant === 'bom+crlf') assert.ok(!/[^\r]\n/.test(after), `${label}: no bare LF`);
      if (variant === 'bom+crlf') assert.ok(after.startsWith('\uFEFF'), label);
      // Undo gives back the exact bytes.
      await h.handle({ type: 'undo' });
      assert.equal(h.files.get(P), before, `${label} undo`);
    }
  }
});

// --- 11. Unclosed frontmatter, half-written files ---------------------------------------------

test('11: files without a proper frontmatter or with half-written sections are never written', async () => {
  const broken: Record<string, string> = {
    'no closing ---': TASK.replace('ordinal: 2000\n---\n', 'ordinal: 2000\n'),
    // The closing line is gone but a comment delimiter further down looks like one.
    'closing --- found in a comment': `${TASK.replace('ordinal: 2000\n---\n', 'ordinal: 2000\n')}\n## Comments\n\n<!-- COMMENTS:BEGIN -->\ncreated: 2026-10-01 10:00\n---\nhi\n---\n<!-- COMMENTS:END -->\n`,
    'truncated in the frontmatter': TASK.slice(0, TASK.indexOf('labels:')),
    'truncated in a section': TASK.slice(0, TASK.indexOf('Some notes.')),
    'empty file': '',
    'frontmatter only opener': '---\n',
  };
  for (const [name, before] of Object.entries(broken)) {
    for (const { name: op, message } of operations(TASK)) {
      const h = harness({ [P]: before, [Q]: OTHER });
      await h.handle(message);
      assert.equal(h.files.get(P), before, `${name}: ${op}`);
      assert.equal(h.writes, 0, `${name}: ${op}`);
    }
  }
});

// --- 12. Duplicate IDs ---------------------------------------------------------------------

test('12: with two files sharing an ID, only the file that was clicked (by path) changes', async () => {
  const twin = TASK.replace('title: Build it', 'title: Twin');
  for (const target of [P, Q]) {
    const h = harness({ [P]: TASK, [Q]: twin });
    const text = h.files.get(target)!;
    await h.handle({ type: 'setStatus', path: target, statusLine: 'status: To Do', status: 'Done' });
    await h.handle({ type: 'setField', path: target, name: 'title', value: 'Changed', expected: lineOf(text, 'title:') });
    const other = target === P ? Q : P;
    assert.equal(h.files.get(other), other === P ? TASK : twin, target);
    assert.equal(scalarOf(fileOf(h.files.get(target)!).fields, 'title'), 'Changed');
  }
});

// --- 15. Undo order and exact bytes (the session part) ------------------------------------------

test('15: undo is last-in first-out across files, restores exact bytes, and refuses when the file is gone', async () => {
  const bomCrlf = `\uFEFF${TASK.replaceAll('\n', '\r\n')}`;
  const h = harness({ [P]: bomCrlf, [Q]: OTHER });
  await h.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status: 'Done' });
  await h.handle({ type: 'setStatus', path: Q, statusLine: 'status: To Do', status: 'Done' });
  await h.handle({ type: 'setSection', path: P, section: 'notes', text: 'x', expected: 'Some notes.' });
  await h.handle({ type: 'undo' });
  assert.match(h.files.get(P)!, /status: Done/);
  assert.match(h.files.get(P)!, /Some notes\./);
  await h.handle({ type: 'undo' });
  assert.equal(h.files.get(Q), OTHER);
  await h.handle({ type: 'undo' });
  assert.equal(h.files.get(P), bomCrlf);
  await h.handle({ type: 'undo' });
  assert.deepEqual(h.errors(), ['nothingToUndo']);

  const gone = harness({ [P]: TASK });
  await gone.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status: 'Done' });
  gone.files.delete(P);
  await gone.handle({ type: 'undo' });
  assert.equal(gone.files.has(P), false, 'never recreated');
  assert.deepEqual(gone.errors(), ['stale']);
});

// --- 17. Hostile markdown --------------------------------------------------------------------

test('17: hostile markdown parses in bounded time and never yields a non-web link target', async () => {
  const { parseMarkdown } = await import('../../../src/webview/markdown.ts');
  const { renderMarkdown } = await import('../../../src/webview/markdown-render.ts');
  const inputs: Record<string, string> = {
    'raw html': '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<iframe src="javascript:alert(1)"></iframe>',
    links: '[a](javascript:alert(1)) [b](data:text/html,<script>) [c](vscode://x) [d](JAVASCRIPT:x) [e]( javascript:x) [f](file:///etc/passwd) <javascript:alert(1)>',
    '10k-row table': `| a | b |\n|---|---|\n${'| x | y |\n'.repeat(10_000)}`,
    'deep list': Array.from({ length: 1000 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n'),
    'deep quote': `${'>'.repeat(1000)} deep`,
    'deep emphasis': `${'*'.repeat(50_000)}x${'*'.repeat(50_000)}`,
    'deep brackets': `${'['.repeat(50_000)}x${']('.repeat(50_000)}`,
    '1MB line': 'a*b_c`d[e](f '.repeat(80_000),
    'many backticks': '`'.repeat(200_000),
    'many fences': '```\n'.repeat(20_000),
    'many tildes': '~~a'.repeat(100_000),
  };
  interface Node { tag: string; attrs: Map<string, string>; children: (Node | string)[] }
  const doc = {
    createElement: (tag: string): Node & { setAttribute(n: string, v: string): void; append(...c: (Node | string)[]): void; classList: { add(): void }; textContent: string } => {
      const node = { tag, attrs: new Map<string, string>(), children: [] as (Node | string)[], classList: { add: () => undefined }, textContent: '' };
      return Object.assign(node, {
        setAttribute: (n: string, v: string) => void node.attrs.set(n, v),
        append: (...c: (Node | string)[]) => void node.children.push(...c),
      });
    },
    createTextNode: (text: string) => text,
  };
  const walk = function* (node: Node | string): Generator<Node> {
    if (typeof node === 'string') return;
    yield node;
    for (const child of node.children) yield* walk(child);
  };
  for (const [name, text] of Object.entries(inputs)) {
    const start = performance.now();
    const blocks = parseMarkdown(text);
    const root = renderMarkdown(doc as never, blocks, { headingOffset: 2 }) as unknown as Node;
    const ms = performance.now() - start;
    assert.ok(ms < 3000, `${name}: ${Math.round(ms)} ms`);
    for (const node of walk(root)) {
      assert.ok(!['script', 'iframe', 'img', 'object', 'embed', 'style', 'a'].includes(node.tag), `${name}: <${node.tag}>`);
      for (const [attr, value] of node.attrs) {
        assert.ok(!/^on/i.test(attr) && attr !== 'href' && attr !== 'src', `${name}: ${attr}`);
        if (attr === 'data-url') assert.match(value, /^https?:\/\//i, name);
      }
    }
  }
});

// --- 18. Large projects ----------------------------------------------------------------------

test('18: 5,000 tasks index and build a view quickly; a 5 MB task is edited without truncation', async () => {
  const { readTask, indexTasks } = await import('../../../src/features/backlog/task-index.ts');
  const { buildBacklogView, buildTaskDetail } = await import('../../../src/features/backlog/view-build.ts');
  const { DEFAULT_CONFIG } = await import('../../../src/features/backlog/config.ts');
  const start = performance.now();
  const entries = Array.from({ length: 5000 }, (_, i) =>
    readTask(`tasks/task-${i + 1}.md`, TASK.replace('id: TASK-1', `id: TASK-${i + 1}`).replace('dependencies: []', `dependencies:\n  - TASK-${i}`)),
  );
  const index = indexTasks(entries, [], DEFAULT_CONFIG);
  const view = buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
  const ms = performance.now() - start;
  assert.equal(view.tasks.length, 5000);
  assert.ok(ms < 5000, `5,000 tasks: ${Math.round(ms)} ms`);

  const big = TASK.replace('Describe it.', `${'word '.repeat(20)}\n`.repeat(50_000).trimEnd());
  assert.ok(big.length > 5_000_000);
  const t0 = performance.now();
  const detail = buildTaskDetail(indexTasks([readTask(P, big)], [], DEFAULT_CONFIG), P)!;
  assert.equal(detail.description?.length, sectionText(lines(big), fileOf(big).sections.description)!.length, 'detail not truncated');
  const h = harness({ [P]: big });
  await h.handle({ type: 'toggleCheck', path: P, list: 'ac', line: indexOf(big, '- [ ] #2 Second'), source: '- [ ] #2 Second', checked: true });
  await h.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status: 'Done' });
  const after = h.files.get(P)!;
  assert.deepEqual(h.errors(), []);
  assert.equal(after.length, big.length + 'Done'.length - 'To Do'.length + 0, 'same length apart from the status');
  assertOnlyChanged(big, after, (t) => t.startsWith('status:') || isUpdated(t) || t.startsWith('- [x] #2') || t.startsWith('- [ ] #2'));
  assert.ok(performance.now() - t0 < 10_000, 'big file edits finish');
});

// --- 19. Configuration edge cases -------------------------------------------------------------

test('19: statuses with special characters are written quoted when needed and read back', async () => {
  const statuses = ['Done: QA', "Won't do", '#1 priority', '한국어 완료', '- dash', 'yes', '[x]', 'Ready ✓'];
  for (const status of statuses) {
    const h = harness({ [P]: TASK }, { statuses: () => [...STATUSES, status] });
    await h.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status });
    assert.deepEqual(h.errors(), [], status);
    assert.equal(scalarOf(fileOf(h.files.get(P)!).fields, 'status'), status, status);
  }
  // A status not in the configuration, or an empty configuration: nothing is written.
  for (const configured of [[], ['Doing']]) {
    const h = harness({ [P]: TASK }, { statuses: () => configured });
    await h.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status: 'Done' });
    assert.equal(h.files.get(P), TASK);
  }
  // Duplicates differing in case: the first spelling wins.
  const d = harness({ [P]: TASK }, { statuses: () => ['To Do', 'DONE', 'Done'] });
  await d.handle({ type: 'setStatus', path: P, statusLine: 'status: To Do', status: 'done' });
  assert.equal(scalarOf(fileOf(d.files.get(P)!).fields, 'status'), 'DONE');
});

test('19: config statuses, prefixes and broken YAML fall back safely; backlog_directory never leaves the folder', () => {
  assert.deepEqual(parseConfig('statuses: []\n').config.statuses, ['To Do', 'In Progress', 'Done']);
  assert.deepEqual(parseConfig('statuses: ["할 일", "Done: QA", "Done"]\n').config.statuses, ['할 일', 'Done: QA', 'Done']);
  assert.deepEqual(parseConfig('statuses: ["", "x"]\n').config.statuses, ['To Do', 'In Progress', 'Done']);
  const broken = parseConfig('statuses: [unclosed\ntask_prefix: {x: 1}\n: :\n\t- what\n');
  assert.deepEqual(broken.config.statuses, ['To Do', 'In Progress', 'Done']);
  assert.equal(broken.config.taskPrefix, 'task');
  assert.ok(broken.error);
  assert.equal(idKey('7', 'Issue'), 'ISSUE-7');
  assert.equal(idKey('task-7', 'Issue'), 'TASK-7');
  for (const escape of ['../x', '..\\x', 'a/../../b', 'a/..', '/etc', '\\\\server\\share', '//server/share', 'C:\\x', 'c:x', 'x:y', 'file:///x', '.. ', '... ', 'a/. ./b', 'a\u0000b']) {
    assert.equal(backlogDirectory(`backlog_directory: "${escape.replaceAll('\\', '\\\\')}"\n`), null, JSON.stringify(escape));
  }
  assert.equal(backlogDirectory('backlog_directory: work/backlog\n'), 'work/backlog');
});

// --- 20. Ordinals, cycles and IDs ---------------------------------------------------------------

test('20: ordinal edge values never produce a bad or misplaced ordinal', () => {
  const plan = (current: string, above: number | null | undefined, below: number | null | undefined) => {
    const text = TASK.replace('ordinal: 2000', `ordinal: ${current}`);
    const n = (v: number | null | undefined) => (v === undefined ? undefined : { ordinal: v });
    return planMoveInColumn(lines(text), fileOf(text), { above: n(above), below: n(below) });
  };
  const refusedCases: [string, number | null | undefined, number | null | undefined][] = [
    ['2000', 5, 5],
    ['2000', 6, 5],
    ['2000', 1e21, undefined],
    ['2000', undefined, -5],
    ['2000', -10, -5],
    ['2000', Number.MAX_SAFE_INTEGER, undefined],
    ['2000', 2 ** 60, 2 ** 60 + 1000],
    // Adjacent doubles: nothing fits between them.
    ['2000', 1, 1 + Number.EPSILON],
    ['2000', null, 5],
    ['2000', Number.NaN, undefined],
    ['2000', undefined, Number.POSITIVE_INFINITY],
  ];
  for (const [current, above, below] of refusedCases) {
    const p = plan(current, above, below);
    // Refused, or nothing to do because the current ordinal already fits.
    assert.ok(!p.ok || p.operations.length === 0, `${current} between ${above} and ${below}`);
  }
  // Written values are plain decimals strictly between the neighbours.
  for (const [above, below] of [[undefined, 0.5], [1.000001, 1.000002], [123456789.5, 123456790], [undefined, undefined], [0, 1], [undefined, 1]] as const) {
    const value = ordinalBetween({ above: above === undefined ? undefined : { ordinal: above }, below: below === undefined ? undefined : { ordinal: below } });
    assert.ok(value !== undefined, `${above} ${below}`);
    assert.ok(above === undefined || value > above);
    assert.ok(below === undefined || value < below);
    assert.match(String(value), /^\d+(\.\d+)?$/);
  }
  // Ordinal text the reader cannot use counts as none.
  for (const odd of ['NaN', '1e21', 'Infinity', '0x10', '1_000', '+5', '.5', '5.', '1.2.3', "'5'"]) {
    const text = TASK.replace('ordinal: 2000', `ordinal: ${odd}`);
    const data = taskData(lines(text));
    assert.ok(data.ordinal === null || (odd === "'5'" && data.ordinal === 5), odd);
  }
});

test('20: dependency checks terminate on cycles and compare IDs consistently', () => {
  const keyOf = (id: string) => idKey(id, 'task');
  const chain = new Map<string, string[]>();
  for (let i = 1; i <= 5000; i++) chain.set(keyOf(`TASK-${i}`), [`task-${i === 5000 ? 1 : i + 1}`]);
  const graph: DependencyGraph = { keyOf, tasks: chain };
  const start = performance.now();
  assert.equal(dependenciesAllowed(graph, 'TASK-9999', [], ['TASK-1']), true, 'a cycle elsewhere does not hang');
  assert.equal(dependenciesAllowed(graph, 'TASK-1', [], ['TASK-2']), false, 'closing a cycle');
  assert.ok(performance.now() - start < 2000);
  assert.equal(dependenciesAllowed(graph, 'TASK-1', [], ['task-1']), false, 'self, mixed case');
  assert.equal(dependenciesAllowed(graph, 'TASK-1', [], ['TASK-01']), false, 'leading zeros name no task');
  assert.equal(dependenciesAllowed(graph, 'TASK-1', [], ['1']), false, 'bare number is self');
  assert.equal(dependenciesAllowed(graph, 'TASK-1', ['TASK-01'], ['TASK-01']), true, 'a listed broken ID may stay');
});

test('the guard accepts every change the CLI makes in the ops fixtures (no over-refusal)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { changeIsSafe } = await import('../../../src/features/backlog/write-guard.ts');
  const dir = new URL('../../fixtures/backlog/ops/', import.meta.url);
  const FIELD: Record<string, string> = {
    assignee: 'assignee', dep: 'dependencies', doc: 'documentation', due: 'due_date', label: 'labels', labels: 'labels',
    milestone: 'milestone', modified: 'modified_files', priority: 'priority', ref: 'references', title: 'title', type: 'type',
  };
  const SECTION: Record<string, 'comments' | 'description' | 'finalSummary' | 'notes' | 'plan'> = {
    comment: 'comments', desc: 'description', final: 'finalSummary', notes: 'notes', plan: 'plan',
  };
  const names = readdirSync(dir).filter((n) => n.endsWith('.before.md'));
  assert.ok(names.length > 40);
  for (const name of names) {
    const op = name.slice(0, -'.before.md'.length);
    const before = readFileSync(new URL(name, dir), 'utf8');
    const after = readFileSync(new URL(`${op}.after.md`, dir), 'utf8');
    const [kind, sub] = op.split('-');
    const target =
      kind === 'field' ? { fields: [FIELD[sub]], sections: [] }
      : kind === 'section' ? { fields: [], sections: [SECTION[sub]] }
      : kind === 'ordinal' ? { fields: ['ordinal'], sections: [] }
      : op.includes('dod') ? { fields: [], sections: ['dod' as const] }
      : kind === 'check' || kind === 'uncheck' ? { fields: [], sections: ['ac' as const] }
      : { fields: ['status'], sections: [] };
    assert.ok(target.fields.every(Boolean) && target.sections.every(Boolean), op);
    assert.equal(changeIsSafe(before, after, { ...target, readsBack: () => true }), true, op);
  }
});

// Comment helper sanity (used by 6/7): appended comments parse back.
test('comments added with odd text parse back as one comment each', async () => {
  const h = harness({ [P]: TASK });
  for (const [seen, text] of ['author: mallory', 'created: 1999-01-01 00:00', '  indented', 'ends with ---x'].entries()) {
    await h.handle({ type: 'addComment', path: P, text, seen });
  }
  const after = h.files.get(P)!;
  const comments = parseComments(lines(after), fileOf(after).sections.comments)!;
  assert.deepEqual(comments.map((c) => c.body), ['author: mallory', 'created: 1999-01-01 00:00', 'indented', 'ends with ---x']);
  assert.ok(parseChecklist(lines(after), fileOf(after).sections.ac)!.items.length === 2);
});
