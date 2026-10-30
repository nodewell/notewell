// Task file parser (backlog.md 3.2-3.5, 8): sections, checklists and comments with line
// indexes, CLI parity on the Backlog.md 1.54.0 fixtures, and the hand-made variants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import {
  parseChecklist,
  parseComments,
  parseTaskFile,
  sectionText,
  taskData,
  type TaskData,
} from '../../../src/features/backlog/task-file.ts';

const fixtures = new URL('../../fixtures/backlog/', import.meta.url);
const readTexts = (path: string): string[] => lineTexts(parseLines(readFileSync(new URL(path, fixtures), 'utf8')));
const linesOf = (source: string): string[] => lineTexts(parseLines(source));

// --- Sections (3.3) ---

test('sections: marker lines, heading lines and trimmed text', () => {
  const texts = linesOf(
    [
      '---',
      'id: TASK-9',
      '---',
      '',
      '## Description',
      '',
      '<!-- SECTION:DESCRIPTION:BEGIN -->',
      '',
      'Text.',
      '',
      '<!-- SECTION:DESCRIPTION:END -->',
      '',
      '## Acceptance Criteria',
      '<!-- AC:BEGIN -->',
      '- [ ] #1 one',
      '<!-- AC:END -->',
      '',
    ].join('\n'),
  );
  const file = parseTaskFile(texts);
  assert.deepEqual(file.frontmatter, { openLine: 0, closeLine: 2 });
  assert.deepEqual(file.sections.description, { name: 'description', heading: 4, begin: 6, end: 10 });
  assert.deepEqual(file.sections.ac, { name: 'ac', heading: 12, begin: 13, end: 15 });
  assert.equal(sectionText(texts, file.sections.description), 'Text.');
  assert.equal(sectionText(texts, file.sections.plan), null);
  assert.equal(file.otherBody, '');
});

test('sections: all seven names; markers may carry extra spaces', () => {
  const names: [string, string][] = [
    ['SECTION:DESCRIPTION', 'description'],
    ['AC', 'ac'],
    ['DOD', 'dod'],
    ['SECTION:PLAN', 'plan'],
    ['SECTION:NOTES', 'notes'],
    ['COMMENTS', 'comments'],
    ['SECTION:FINAL_SUMMARY', 'finalSummary'],
  ];
  const texts = names.flatMap(([marker]) => [`<!--  ${marker}:BEGIN-->`, 'x', `  <!-- ${marker}:END -->`]);
  const file = parseTaskFile(texts);
  names.forEach(([, name], n) => {
    const section = file.sections[name as keyof typeof file.sections];
    assert.deepEqual(section && [section.begin, section.end, section.heading], [n * 3, n * 3 + 2, null], name);
  });
});

test('sections: a heading counts only directly before BEGIN (blank lines allowed)', () => {
  const texts = ['## Description', 'stray', '<!-- SECTION:DESCRIPTION:BEGIN -->', 'x', '<!-- SECTION:DESCRIPTION:END -->'];
  const file = parseTaskFile(texts);
  assert.equal(file.sections.description?.heading, null);
  assert.equal(file.otherBody, '## Description\nstray');
});

test('sections: markers inside code fences are not structure', () => {
  const texts = [
    '```',
    '<!-- SECTION:NOTES:BEGIN -->',
    '```',
    '<!-- SECTION:DESCRIPTION:BEGIN -->',
    '~~~',
    '<!-- SECTION:DESCRIPTION:END -->',
    '~~~',
    'after',
    '<!-- SECTION:DESCRIPTION:END -->',
    '<!-- SECTION:NOTES:END -->',
  ];
  const file = parseTaskFile(texts);
  assert.deepEqual(file.sections.description && [file.sections.description.begin, file.sections.description.end], [3, 8]);
  assert.equal(file.sections.notes, undefined, 'the fenced BEGIN does not open a section');
  assert.equal(sectionText(texts, file.sections.description), '~~~\n<!-- SECTION:DESCRIPTION:END -->\n~~~\nafter');
  assert.equal(file.otherBody, '```\n<!-- SECTION:NOTES:BEGIN -->\n```\n\n<!-- SECTION:NOTES:END -->');
});

test('sections: unbalanced markers stay in otherBody', () => {
  const cases: Record<string, string[]> = {
    'BEGIN without END': ['<!-- AC:BEGIN -->', '- [ ] #1 a'],
    'END without BEGIN': ['- [ ] #1 a', '<!-- AC:END -->'],
    'END of another name': ['<!-- AC:BEGIN -->', '<!-- DOD:END -->'],
    'END only inside a fence opened after BEGIN': ['<!-- AC:BEGIN -->', '```', '<!-- AC:END -->', '```'],
  };
  for (const [label, texts] of Object.entries(cases)) {
    const file = parseTaskFile(texts);
    assert.equal(file.sections.ac, undefined, label);
    assert.ok(file.otherBody.includes('<!-- AC:'), label);
  }
});

test('sections: a BEGIN followed by another BEGIN is unbalanced; the second one pairs', () => {
  const texts = ['<!-- AC:BEGIN -->', '<!-- AC:BEGIN -->', '- [ ] #1 a', '<!-- AC:END -->'];
  const file = parseTaskFile(texts);
  assert.deepEqual(file.sections.ac, { name: 'ac', heading: null, begin: 1, end: 3 });
  assert.equal(file.otherBody, '<!-- AC:BEGIN -->');
});

test('sections: a second block of the same name is otherBody; unknown markers too', () => {
  const texts = [
    '<!-- SECTION:NOTES:BEGIN -->',
    'first',
    '<!-- SECTION:NOTES:END -->',
    '<!-- SECTION:NOTES:BEGIN -->',
    'second',
    '<!-- SECTION:NOTES:END -->',
    '<!-- SECTION:OTHER:BEGIN -->',
    '<!-- SECTION:OTHER:END -->',
  ];
  const file = parseTaskFile(texts);
  assert.equal(sectionText(texts, file.sections.notes), 'first');
  assert.equal(
    file.otherBody,
    '<!-- SECTION:NOTES:BEGIN -->\nsecond\n<!-- SECTION:NOTES:END -->\n<!-- SECTION:OTHER:BEGIN -->\n<!-- SECTION:OTHER:END -->',
  );
});

test('otherBody: chunks between sections, blank-trimmed, joined by one blank line', () => {
  const texts = ['---', 'id: X', '---', '', 'intro', '', '<!-- AC:BEGIN -->', '<!-- AC:END -->', '', '## Extra', 'tail', ''];
  assert.equal(parseTaskFile(texts).otherBody, 'intro\n\n## Extra\ntail');
});

// --- Checklists (3.4) ---

test('checklist: items with line, number, text and checked; [X] is checked', () => {
  const texts = ['<!-- AC:BEGIN -->', '- [ ] #1 first', '', '- [x] #2 second', '- [X] #3 third', '- [ ] #4', '<!-- AC:END -->'];
  const checklist = parseChecklist(texts, parseTaskFile(texts).sections.ac);
  assert.deepEqual(checklist, {
    items: [
      { line: 1, checked: false, number: 1, text: 'first' },
      { line: 3, checked: true, number: 2, text: 'second' },
      { line: 4, checked: true, number: 3, text: 'third' },
      { line: 5, checked: false, number: 4, text: '' },
    ],
    readOnly: false,
  });
});

test('checklist: any other line makes the block read only; items are still listed', () => {
  for (const odd of ['- [~] #2 partial', '- [ ] no number', '* [ ] #2 star', '  - [ ] #2 indented', 'prose', '- [ ]#2 tight']) {
    const texts = ['<!-- DOD:BEGIN -->', '- [ ] #1 fine', odd, '<!-- DOD:END -->'];
    const checklist = parseChecklist(texts, parseTaskFile(texts).sections.dod);
    assert.equal(checklist?.readOnly, true, odd);
    assert.deepEqual(
      checklist?.items.map((item) => item.number),
      [1],
      odd,
    );
  }
  assert.equal(parseChecklist([], undefined), null);
});

// --- Comments (3.5) ---

test('comments: author / created / --- body --- blocks', () => {
  const texts = [
    '<!-- COMMENTS:BEGIN -->',
    'author: @bob',
    'created: 2026-10-14 09:49',
    '---',
    'First',
    '',
    'second paragraph',
    '---',
    '',
    'author: @carol',
    '---',
    'Reply',
    '---',
    '<!-- COMMENTS:END -->',
  ];
  assert.deepEqual(parseComments(texts, parseTaskFile(texts).sections.comments), [
    { author: '@bob', created: '2026-10-14 09:49', body: 'First\n\nsecond paragraph' },
    { author: '@carol', created: null, body: 'Reply' },
  ]);
  const empty = ['<!-- COMMENTS:BEGIN -->', '', '<!-- COMMENTS:END -->'];
  assert.deepEqual(parseComments(empty, parseTaskFile(empty).sections.comments), []);
  assert.equal(parseComments([], undefined), null);
});

test('comments: the CLI 1.54.0 shape (blank lines around the rules) and a mix with the 1.53.0 shape', () => {
  // As `backlog task edit --comment` 1.54.0 writes them (test/fixtures/backlog/ops/section-comment-*).
  const texts = [
    '<!-- COMMENTS:BEGIN -->',
    'author: @bob',
    'created: 2026-10-14 09:49',
    '',
    '---',
    '',
    'First',
    '',
    'second paragraph',
    '',
    '---',
    '',
    'created: 2026-10-17 09:19',
    '---',
    'Old shape',
    '---',
    '',
    '',
    'created: 2026-10-17 09:20',
    '',
    '',
    '---',
    '',
    '',
    'Many blanks',
    '',
    '---',
    '',
    '---',
    'No metadata',
    '---',
    '<!-- COMMENTS:END -->',
  ];
  assert.deepEqual(parseComments(texts, parseTaskFile(texts).sections.comments), [
    { author: '@bob', created: '2026-10-14 09:49', body: 'First\n\nsecond paragraph' },
    { author: null, created: '2026-10-17 09:19', body: 'Old shape' },
    { author: null, created: '2026-10-17 09:20', body: 'Many blanks' },
    { author: null, created: null, body: 'No metadata' },
  ]);
  for (const name of ['add', 'add-new', 'first', 'multi', 'padded', 'author']) {
    const after = lineTexts(parseLines(readFileSync(new URL(`../../fixtures/backlog/ops/section-comment-${name}.after.md`, import.meta.url), 'utf8')));
    assert.notEqual(taskData(after).comments, null, name);
  }
});

test('comments: another shape is null and taskData keeps it as raw text', () => {
  for (const body of [['free text'], ['author: @a', '---', 'never closed'], ['author: @a', 'body without rule'], ['author: @a', '', 'text', '---', 'b', '---'], ['created: x', '', '---', 'unclosed']]) {
    const texts = ['<!-- COMMENTS:BEGIN -->', ...body, '<!-- COMMENTS:END -->'];
    assert.equal(parseComments(texts, parseTaskFile(texts).sections.comments), null, body.join('|'));
    const data = taskData(texts);
    assert.equal(data.comments, null);
    assert.equal(data.commentsRaw, body.join('\n'));
  }
});

// --- CLI parity (8): taskData vs `backlog task view <ID> --json` ---

interface CliItem {
  index: number;
  text: string;
  checked: boolean;
}

/** taskData in the field names and empty values of the saved CLI JSON. */
function asCli(data: TaskData): Record<string, unknown> {
  const items = (list: TaskData['ac']): CliItem[] =>
    (list?.items ?? []).map((item) => ({ index: item.number, text: item.text, checked: item.checked }));
  return {
    id: data.id,
    title: data.title,
    status: data.status,
    type: data.type,
    priority: data.priority,
    assignees: data.assignees,
    labels: data.labels,
    milestone: data.milestone,
    parentTaskId: data.parent,
    references: data.references,
    modifiedFiles: data.modifiedFiles,
    documentation: data.documentation,
    dependencies: data.dependencies,
    ordinal: data.ordinal,
    dueDate: data.due,
    description: data.description,
    acceptanceCriteria: items(data.ac),
    definitionOfDone: items(data.dod),
    implementationPlan: data.plan,
    implementationNotes: data.notes,
    comments: (data.comments ?? []).map((comment) => ({ author: comment.author, body: comment.body })),
    finalSummary: data.finalSummary,
  };
}

const taskFiles = readdirSync(new URL('project/tasks/', fixtures)).filter((name) => name.endsWith('.md'));

test('CLI parity: every fixture task has saved JSON', () => {
  assert.equal(taskFiles.length, readdirSync(new URL('json/', fixtures)).length);
  assert.ok(taskFiles.length >= 7);
});

for (const name of taskFiles) {
  test(`CLI parity: ${name}`, () => {
    const data = taskData(readTexts(`project/tasks/${name}`));
    const cli = JSON.parse(readFileSync(new URL(`json/${data.id}.json`, fixtures), 'utf8')) as Record<string, unknown>;
    cli.comments = (cli.comments as { author: string; body: string }[]).map(({ author, body }) => ({ author, body }));
    assert.deepEqual(asCli(data), cli);
    assert.deepEqual(data.otherFields, [], 'the CLI writes only known shapes');
    assert.equal(data.otherBody, '', 'the CLI writes only marked sections');
    assert.equal(data.ac?.readOnly ?? false, false);
    assert.equal(data.dod?.readOnly ?? false, false);
  });
}

test('CLI parity: scalars the JSON leaves out', () => {
  const data = taskData(readTexts('project/tasks/task-1 - Set-up-the-build.md'));
  assert.equal(data.created, '2026-10-14 09:49');
  assert.equal(data.updated, '2026-10-14 09:49');
  assert.deepEqual(data.comments, [{ author: '@bob', created: '2026-10-14 09:49', body: 'Looks good so far' }]);
  assert.equal(taskData(readTexts('project/tasks/task-1.1 - Write-the-parser.md')).updated, null);
});

// --- Hand-made variants (8) ---

const variantFiles = readdirSync(new URL('variants/', fixtures)).filter((name) => name.endsWith('.md'));
const variant = (name: string): TaskData => taskData(readTexts(`variants/${name}`));

test('variants: every file parses without throwing', () => {
  assert.ok(variantFiles.length >= 11);
  for (const name of variantFiles) assert.doesNotThrow(() => variant(name), name);
});

test('variants: CRLF, BOM and no trailing newline read like the LF originals', () => {
  assert.deepEqual(variant('crlf.md'), taskData(readTexts('project/tasks/task-1 - Set-up-the-build.md')));
  const korean = taskData(readTexts('project/tasks/task-5 - 한국어-작업.md'));
  assert.deepEqual(variant('bom.md'), korean);
  assert.deepEqual(variant('no-trailing-newline.md'), korean);
});

test('variants: unknown-keys keeps unknown shapes as other fields with their source', () => {
  const data = variant('unknown-keys.md');
  assert.deepEqual(data.labels, ['alpha', 'beta'], 'a flow list is read');
  assert.equal(data.priority, null);
  assert.deepEqual(data.assignees, []);
  assert.equal(data.ordinal, 9000);
  assert.equal(data.description, 'Body.');
  assert.deepEqual(data.otherFields, [
    { name: 'custom', source: 'custom:\n  nested: value' },
    { name: 'notes', source: 'notes: |\n  multi\n  line' },
    { name: 'priority', source: 'priority: "high\\qvalue"' },
    { name: 'assignee', source: 'assignee:\n  - plain\n    continued' },
  ]);
  const file = parseTaskFile(readTexts('variants/unknown-keys.md'));
  const labels = file.fields.find((field) => field.name === 'labels');
  assert.equal(labels?.value.kind === 'list' && labels.value.flow, true, 'flow lists are marked so writers refuse them');
});

test('variants: no-markers is all otherBody', () => {
  const data = variant('no-markers.md');
  assert.equal(data.id, 'TASK-21');
  assert.equal(data.description, null);
  assert.equal(data.ac, null);
  assert.equal(data.otherBody, 'Some text written by hand.\n\n## Acceptance Criteria\n- [ ] #1 not inside markers');
});

test('variants: unbalanced markers are otherBody', () => {
  const data = variant('unbalanced.md');
  assert.equal(data.ac, null);
  assert.equal(data.notes, null);
  assert.deepEqual(parseTaskFile(readTexts('variants/unbalanced.md')).sections, {});
  assert.equal(
    data.otherBody,
    '## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 never closed\n\n## Notes\n<!-- SECTION:NOTES:END -->',
  );
});

test('variants: odd-check makes AC read only; [X] in DoD is checked', () => {
  const data = variant('odd-check.md');
  assert.equal(data.ac?.readOnly, true);
  assert.deepEqual(
    data.ac?.items.map((item) => [item.number, item.checked]),
    [[1, false]],
  );
  assert.deepEqual(data.dod, { items: [{ line: 16, checked: true, number: 1, text: 'upper-case check' }], readOnly: false });
});

test('variants: no-frontmatter has no fields and no id', () => {
  const file = parseTaskFile(readTexts('variants/no-frontmatter.md'));
  assert.equal(file.frontmatter, null);
  assert.deepEqual(file.fields, []);
  const data = variant('no-frontmatter.md');
  assert.equal(data.id, null);
  assert.equal(data.title, '');
  assert.equal(data.otherBody, '# Just a note\n\nNo frontmatter here.');
});

test('variants: other-status is read as is', () => {
  assert.equal(variant('other-status.md').status, 'Blocked');
});

test('variants: updated-unknown has no updated date and shows the field as other', () => {
  const data = variant('updated-unknown.md');
  assert.equal(data.updated, null);
  assert.equal(data.created, '2026-10-01 10:00');
  assert.deepEqual(data.otherFields, [{ name: 'updated_date', source: 'updated_date:\n  - 2026-10-01' }]);
});

test('variants: quoted-status keeps the double-quote style', () => {
  assert.equal(variant('quoted-status.md').status, 'To Do');
  const status = parseTaskFile(readTexts('variants/quoted-status.md')).fields.find((field) => field.name === 'status');
  assert.deepEqual(status?.value, { kind: 'scalar', value: 'To Do', style: 'double' });
});

test('taskData: ordinal must be a number; empty scalars are null', () => {
  const data = taskData(['---', 'id: X', 'ordinal: soon', 'status:', "priority: ''", '---']);
  assert.equal(data.ordinal, null);
  assert.equal(data.status, null);
  assert.equal(data.priority, null);
  assert.equal(taskData(['---', 'ordinal: -2.5', '---']).ordinal, -2.5);
});

test('taskData: unknown keys with known shapes are other fields too', () => {
  const data = taskData(['---', 'id: X', 'estimate: 3', 'tags:', '  - a', '---']);
  assert.deepEqual(data.otherFields, [
    { name: 'estimate', source: 'estimate: 3' },
    { name: 'tags', source: 'tags:\n  - a' },
  ]);
});

test('taskData: a list in a scalar field is other; a scalar in a list field is one item', () => {
  const data = taskData(['---', 'status:', '  - To Do', "assignee: '@me'", 'labels: [a]', '---']);
  assert.equal(data.status, null);
  assert.deepEqual(data.assignees, ['@me']);
  assert.deepEqual(data.labels, ['a']);
  assert.deepEqual(data.otherFields, [{ name: 'status', source: 'status:\n  - To Do' }]);
});
