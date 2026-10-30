// Task detail view (backlog.md 4.4) with a fake document: whitelisted elements only, no
// event attributes, every fixture value shown as text, the data-action contract for main.ts,
// and disabled states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { localDateTime, renderDetail, type DetailEditOptions } from '../../../src/features/backlog/browser/render-detail.ts';
import { taskData, type Checklist } from '../../../src/features/backlog/task-file.ts';
import { DEFAULT_STRINGS, type ChecklistView, type TaskDetail } from '../../../src/features/backlog/view.ts';

class FakeElement {
  readonly tagName: string;
  #text: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly children: (FakeElement | string)[] = [];
  readonly classList = { add: (...tokens: string[]) => void tokens.forEach((t) => this.classes.add(t)) };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string | null {
    return this.#text ?? this.children.map((c) => (typeof c === 'string' ? c : c.tagName === 'br' ? '\n' : c.textContent)).join('');
  }

  set textContent(value: string | null) {
    this.#text = value;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }

  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) if (typeof child !== 'string') yield* child.walk();
  }

  find(predicate: (e: FakeElement) => boolean): FakeElement[] {
    return [...this.walk()].filter(predicate);
  }

  byClass(name: string): FakeElement[] {
    return this.find((e) => e.classes.has(name));
  }

  byAction(action: string): FakeElement[] {
    return this.find((e) => e.attrs.get('data-action') === action);
  }
}

const doc = { createElement: (tag: string) => new FakeElement(tag) };
const STATUSES = ['To Do', 'In Progress', 'Done'];
const fixtures = new URL('../../fixtures/backlog/', import.meta.url);
const S = DEFAULT_STRINGS;

const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'select', 'option', 'button', 'section', 'label',
  'ul', 'ol', 'li', 'input', 'blockquote', 'pre', 'code', 'hr', 'br', 'strong', 'em', 's',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
const ALLOWED_ATTRS = new Set([
  'dir',
  'role', 'tabindex', 'title', 'type', 'disabled', 'checked', 'selected', 'value', 'start', 'aria-label', 'scope',
  'data-action', 'data-path', 'data-url', 'data-lang', 'data-status-line', 'data-list', 'data-line', 'data-source',
]);
const ACTIONS = new Set(['set-status', 'toggle-check', 'show-task', 'open-task', 'open-path', 'open-url', 'close-detail']);

function assertSafe(root: FakeElement): void {
  for (const element of root.walk()) {
    assert.ok(ALLOWED_TAGS.has(element.tagName), element.tagName);
    for (const [attr, value] of element.attrs) {
      assert.ok(ALLOWED_ATTRS.has(attr) && !attr.startsWith('on'), attr);
      if (attr === 'data-action') assert.ok(ACTIONS.has(value), value);
    }
  }
}

const checklistView = (list: Checklist | null, texts: readonly string[]): ChecklistView | null =>
  list === null ? null : { readOnly: list.readOnly, items: list.items.map((item) => ({ ...item, source: texts[item.line] })) };

/** A TaskDetail from a fixture file, standing in for the extension's view builder. */
const UPDATED_DATE = { reason: 'updatedDate', line: null } as const;
const ARCHIVED = { editable: false, readOnly: { reason: 'archived', line: null }, archived: true } as const;

function detailOf(path: string, overrides: Partial<TaskDetail> = {}): TaskDetail {
  const texts = lineTexts(parseLines(readFileSync(new URL(path, fixtures), 'utf8')));
  const data = taskData(texts);
  const statusLine = texts.find((text) => text.startsWith('status:')) ?? null;
  const ref = (id: string) => ({ id, path: `tasks/${id.toLowerCase()}.md`, title: `Title of ${id}`, status: 'To Do', archived: false });
  return {
    path: path.replace(/^.*\//, 'tasks/'),
    id: data.id ?? '',
    title: data.title,
    status: data.status ?? '',
    statusLine,
    priority: data.priority,
    type: data.type,
    project: data.project,
    reporter: data.reporter,
    assignees: data.assignees,
    labels: data.labels,
    milestone: data.milestone,
    milestoneTitle: data.milestone === 'm-0' ? 'v1 Launch' : null,
    due: data.due,
    created: data.created,
    updated: data.updated,
    parent: data.parent === null ? null : ref(data.parent),
    subtasks: [],
    dependencies: data.dependencies.map(ref),
    blocks: [],
    references: data.references,
    documentation: data.documentation,
    modifiedFiles: data.modifiedFiles,
    description: data.description,
    plan: data.plan,
    notes: data.notes,
    finalSummary: data.finalSummary,
    ac: checklistView(data.ac, texts),
    dod: checklistView(data.dod, texts),
    comments: data.comments,
    commentsRaw: data.commentsRaw,
    otherBody: data.otherBody,
    otherFields: data.otherFields,
    editable: !data.otherFields.some((field) => field.name === 'updated_date'),
    readOnly: data.otherFields.some((field) => field.name === 'updated_date') ? UPDATED_DATE : null,
    archived: false,
    fieldSources: {},
    lockedFields: [],
    sectionSources: {},
    ...overrides,
  };
}

const render = (detail: TaskDetail, statuses = STATUSES) => renderDetail(doc, detail, S, statuses) as unknown as FakeElement;
const allFiles = [
  ...readdirSync(new URL('project/tasks/', fixtures)).map((n) => `project/tasks/${n}`),
  ...readdirSync(new URL('variants/', fixtures)).map((n) => `variants/${n}`),
].filter((n) => n.endsWith('.md') && !n.endsWith('no-frontmatter.md'));

/** Whitespace-free text, so markdown markup removal and line breaks do not matter. */
const squash = (text: string): string => text.replace(/[\s*`_~#>[\]()-]/g, '');

test('every fixture renders with whitelisted elements and attributes only', () => {
  for (const path of allFiles) assertSafe(render(detailOf(path)));
});

test('every fixture value appears as text', () => {
  for (const path of allFiles) {
    const detail = detailOf(path);
    const text = squash(render(detail).textContent ?? '');
    const values = [
      detail.id, detail.title, ...detail.assignees, ...detail.labels, ...detail.references, ...detail.documentation, ...detail.modifiedFiles,
      detail.type, detail.description, detail.plan, detail.notes, detail.finalSummary, detail.otherBody,
      ...(detail.ac?.items ?? []).map((item) => item.text), ...(detail.dod?.items ?? []).map((item) => item.text),
      ...(detail.comments ?? []).flatMap((comment) => [comment.author, comment.body]),
      ...detail.otherFields.map((field) => field.source),
    ];
    for (const value of values) {
      if (value === null || value === '') continue;
      const withoutListNumbers = value.replace(/^[ \t]*\d+[.)][ \t]/gm, '');
      assert.ok(text.includes(squash(withoutListNumbers)), `${path}: ${value.slice(0, 60)}`);
    }
  }
});

test('HTML-like text stays text', () => {
  const root = render(detailOf('project/tasks/task-2 - Render-the-board.md'));
  assert.ok(root.textContent?.includes('A board with <b>HTML-like</b> text & symbols: < > " \''));
  assert.equal(root.find((e) => e.tagName === 'b').length, 0);
});

test('header: id, title, status select with the data contract, priority, updated in local time, buttons', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md');
  const root = render(detail);
  assert.equal(root.byClass('detail-id')[0].textContent, 'TASK-1');
  assert.equal(root.byClass('detail-title')[0].tagName, 'h1');
  assert.equal(root.byClass('detail-title')[0].textContent, 'Set up the build');
  const [select] = root.byAction('set-status');
  assert.equal(select.tagName, 'select');
  assert.equal(select.attrs.get('data-path'), detail.path);
  assert.equal(select.attrs.get('data-status-line'), 'status: In Progress');
  assert.equal(select.attrs.has('disabled'), false);
  const options = select.children as FakeElement[];
  assert.deepEqual(options.map((o) => o.attrs.get('value')), STATUSES);
  assert.deepEqual(options.filter((o) => o.attrs.has('selected')).map((o) => o.textContent), ['In Progress']);
  const [priority] = root.byClass('detail-priority');
  assert.equal(priority.textContent, 'High');
  assert.ok(priority.classes.has('detail-priority-high'));
  assert.equal(root.byClass('detail-updated')[0].byClass('detail-date')[0].textContent, localDateTime('2026-10-14 09:49'));
  const [open] = root.byAction('open-task');
  assert.equal(open.tagName, 'button');
  assert.equal(open.attrs.get('data-path'), detail.path);
  assert.equal(open.textContent, S.openFile);
  assert.equal(root.byAction('close-detail')[0].textContent, S.closeDetail);
});

test('status select: an unconfigured status is listed and selected; no status line disables it', () => {
  const root = render(detailOf('variants/other-status.md'));
  const options = root.byAction('set-status')[0].children as FakeElement[];
  assert.deepEqual(options.map((o) => o.textContent), [...STATUSES, 'Blocked']);
  assert.equal(options[3].attrs.has('selected'), true);
  const locked = render(detailOf('variants/other-status.md', { statusLine: null }));
  const [select] = locked.byAction('set-status');
  assert.equal(select.attrs.has('disabled'), true);
  assert.equal(select.attrs.has('data-status-line'), false);
});

test('localDateTime converts stored UTC to local time and keeps other values', () => {
  const expected = new Date(Date.UTC(2026, 9, 14, 9, 49));
  const pad = (n: number) => String(n).padStart(2, '0');
  assert.equal(
    localDateTime('2026-10-14 09:49'),
    `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())} ${pad(expected.getHours())}:${pad(expected.getMinutes())}`,
  );
  for (const value of ['2026-10-14', 'soon', '2026-10-14T09:49:00Z']) assert.equal(localDateTime(value), value);
});

test('fields: task links, missing tasks, urls and paths', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', {
    parent: { id: 'TASK-9', path: null, title: null, status: null, archived: false },
    subtasks: [{ id: 'TASK-1.1', path: 'tasks/task-1.1.md', title: 'Write the parser', status: 'To Do', archived: false }],
    blocks: [{ id: 'TASK-2', path: 'tasks/task-2.md', title: 'Render the board', status: 'To Do', archived: false }],
    dependencies: [{ id: 'TASK-0', path: null, title: null, status: null, archived: false }],
    documentation: ['docs/build.md', 'https://example.com/doc'],
  });
  const root = render(detail);
  const links = root.byAction('show-task');
  assert.deepEqual(links.map((e) => [e.attrs.get('data-path'), e.textContent, e.attrs.get('role')]), [
    ['tasks/task-1.1.md', 'TASK-1.1 Write the parser', 'link'],
    ['tasks/task-2.md', 'TASK-2 Render the board', 'link'],
  ]);
  assert.deepEqual(root.byClass('detail-task-missing').map((e) => e.textContent), [`TASK-9 (${S.taskNotFound})`, `TASK-0 (${S.taskNotFound})`]);
  assert.deepEqual(root.byAction('open-url').map((e) => e.attrs.get('data-url')), ['https://example.com/build', 'https://example.com/doc']);
  assert.deepEqual(root.byAction('open-path').map((e) => e.attrs.get('data-path')), ['docs/build.md', 'scripts/build.mjs']);
  const labels = root.find((e) => e.tagName === 'dt').map((e) => e.textContent);
  assert.deepEqual(labels, [
    S.fieldAssignee, S.fieldLabels, S.fieldMilestone, S.fieldType, S.fieldCreated, S.fieldParent, S.fieldSubtasks,
    S.fieldDependsOn, S.fieldBlocks, S.fieldReferences, S.fieldDocumentation, S.fieldModifiedFiles,
  ]);
  const milestone = root.find((e) => e.tagName === 'dd')[2];
  assert.equal(milestone.textContent, 'v1 Launch');
});

test('a javascript: or other non-web reference is a path, never a url action', () => {
  const root = render(detailOf('project/tasks/task-6 - Minimal.md', { references: ['javascript:alert(1)', 'ftp://x'] }));
  assert.equal(root.byAction('open-url').length, 0);
  assert.deepEqual(root.byAction('open-path').map((e) => e.attrs.get('data-path')), ['javascript:alert(1)', 'ftp://x']);
});

test('sections follow SECTION_ORDER with their titles; absent ones are left out', () => {
  const root = render(detailOf('project/tasks/task-1 - Set-up-the-build.md'));
  assert.deepEqual(root.byClass('detail-section-title').map((e) => e.textContent), [
    S.sectionDescription, S.sectionAcceptanceCriteria, S.sectionDefinitionOfDone, S.sectionPlan, S.sectionNotes, S.sectionComments,
  ]);
  assert.deepEqual(render(detailOf('project/tasks/task-6 - Minimal.md')).byClass('detail-section-title'), []);
  const done = render(detailOf('project/tasks/task-3 - Ship-it.md'));
  assert.deepEqual(done.byClass('detail-section-title').map((e) => e.textContent), [S.sectionDescription, S.sectionAcceptanceCriteria, S.sectionFinalSummary]);
  assert.ok(root.textContent?.includes('<!-- SECTION:DESCRIPTION:END --> inside a fence'), 'fenced marker text is content');
  assert.equal(root.find((e) => (e.textContent ?? '').includes('SECTION:PLAN:BEGIN')).length, 0, 'markers are hidden');
});

test('checklists: checkbox data contract, #n and inline markdown', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md');
  const root = render(detail);
  const boxes = root.byAction('toggle-check');
  assert.deepEqual(boxes.map((b) => [b.tagName, b.attrs.get('type'), b.attrs.get('data-path'), b.attrs.get('data-list'), b.attrs.get('data-line'), b.attrs.get('data-source'), b.attrs.has('checked'), b.attrs.has('disabled')]), [
    ['input', 'checkbox', detail.path, 'ac', '40', '- [x] #1 Build produces dist/', true, false],
    ['input', 'checkbox', detail.path, 'ac', '41', '- [ ] #2 Typecheck passes', false, false],
    ['input', 'checkbox', detail.path, 'dod', '46', '- [ ] #1 Docs updated', false, false],
  ]);
  assert.deepEqual(root.byClass('detail-check-number').map((e) => e.textContent), ['#1', '#2', '#1']);
  const code = render(detailOf('project/tasks/task-2 - Render-the-board.md')).byClass('detail-check-text')[0];
  assert.equal(code.find((e) => e.tagName === 'code')[0].textContent, 'code');
  assert.equal(code.find((e) => e.tagName === 'strong')[0].textContent, 'bold');
  assert.equal(root.byClass('detail-note').length, 0);
});

test('checklists: read-only lists are disabled with a note; the other list stays enabled', () => {
  const root = render(detailOf('variants/odd-check.md'));
  const boxes = root.byAction('toggle-check');
  assert.deepEqual(boxes.map((b) => [b.attrs.get('data-list'), b.attrs.has('disabled')]), [['ac', true], ['dod', false]]);
  assert.deepEqual(root.byClass('detail-note').map((e) => e.textContent), [S.checklistReadOnly]);
  assert.equal(boxes[1].attrs.has('checked'), true, '[X] shows checked');
});

test('a task that cannot be edited: notice, status and checkboxes disabled', () => {
  const root = render(detailOf('project/tasks/task-1 - Set-up-the-build.md', { editable: false, readOnly: UPDATED_DATE }));
  assert.deepEqual(root.byClass('detail-notice').map((e) => e.textContent), [S.readOnlyLabel + S.readOnlyUpdatedDate]);
  assert.ok(root.byClass('detail-notice')[0].classes.has('detail-read-only'));
  // Each reason has its own text; the line is filled in where the reason names one.
  const notice = (readOnly: TaskDetail['readOnly']) =>
    render(detailOf('project/tasks/task-1 - Set-up-the-build.md', { editable: false, readOnly })).byClass('detail-notice').map((e) => e.textContent);
  assert.deepEqual(notice({ reason: 'frontmatter', line: 6 }), [S.readOnlyLabel + S.readOnlyFrontmatter.replace('{0}', '6')]);
  assert.deepEqual(notice({ reason: 'markers', line: 12 }), [S.readOnlyLabel + S.readOnlyMarkers.replace('{0}', '12')]);
  assert.deepEqual(notice({ reason: 'fileSystem', line: null }), [S.readOnlyLabel + S.readOnlyFileSystem]);
  assert.ok(!notice({ reason: 'markers', line: 12 })[0]!.includes('{0}'));
  assert.deepEqual(render(detailOf('project/tasks/task-1 - Set-up-the-build.md')).byClass('detail-notice'), [], 'no notice when editable');
  assert.equal(root.byAction('set-status')[0].attrs.has('disabled'), true);
  assert.ok(root.byAction('toggle-check').every((b) => b.attrs.has('disabled')));
  assert.equal(root.byClass('detail-note').length, 0, 'the read-only list note is for unrecognised lines only');
  const unknown = render(detailOf('variants/updated-unknown.md'));
  assert.equal(unknown.byClass('detail-notice').length, 1);
});

test('comments: author, local created date and markdown body; raw comments as markdown', () => {
  const root = render(detailOf('project/tasks/task-1 - Set-up-the-build.md'));
  const [comment] = root.byClass('detail-comment');
  assert.equal(comment.byClass('detail-comment-author')[0].textContent, '@bob');
  assert.equal(comment.byClass('detail-date')[0].textContent, localDateTime('2026-10-14 09:49'));
  assert.ok(comment.textContent?.includes('Looks good so far'));
  const raw = render(detailOf('project/tasks/task-6 - Minimal.md', { comments: null, commentsRaw: 'free **text**' }));
  assert.equal(raw.byClass('detail-section-comments')[0].find((e) => e.tagName === 'strong')[0].textContent, 'text');
  const empty = render(detailOf('project/tasks/task-6 - Minimal.md', { comments: [] }));
  assert.equal(empty.byClass('detail-section-comments').length, 0);
});

test('other body and other fields are shown as written', () => {
  const unbalanced = render(detailOf('variants/unbalanced.md'));
  const other = unbalanced.byClass('detail-section-other')[0];
  assert.equal(other.byClass('detail-section-title')[0].textContent, S.sectionOther);
  assert.ok(other.textContent?.includes('<!-- AC:BEGIN -->'));
  const keys = render(detailOf('variants/unknown-keys.md'));
  const sources = keys.byClass('detail-other-field');
  assert.ok(sources.every((e) => e.tagName === 'pre'));
  assert.deepEqual(sources.map((e) => e.textContent), [
    'custom:\n  nested: value',
    'notes: |\n  multi\n  line',
    'priority: "high\\qvalue"',
    'assignee:\n  - plain\n    continued',
  ]);
  assert.equal(keys.byClass('detail-section-other-fields')[0].byClass('detail-section-title')[0].textContent, S.fieldOther);
});

// --- Editing (backlog.md 5.4) ---

const EDIT_TAGS = new Set([...ALLOWED_TAGS, 'textarea', 'datalist']);
const EDIT_ATTRS = new Set([
  ...ALLOWED_ATTRS, 'data-field', 'data-index', 'data-section', 'data-editor', 'data-hint', 'placeholder', 'spellcheck', 'autocomplete', 'list', 'id', 'rows',
  'aria-invalid', 'aria-describedby',
]);
const EDIT_ACTIONS = new Set([
  ...ACTIONS, 'edit-title', 'set-field', 'chip-input', 'remove-item', 'edit-section', 'add-section', 'save-edit', 'cancel-edit', 'add-comment',
]);

function assertEditSafe(root: FakeElement): void {
  for (const element of root.walk()) {
    assert.ok(EDIT_TAGS.has(element.tagName), element.tagName);
    for (const [attr, value] of element.attrs) {
      assert.ok(EDIT_ATTRS.has(attr) && !attr.startsWith('on'), attr);
      if (attr === 'data-action') assert.ok(EDIT_ACTIONS.has(value), value);
    }
  }
}

const EDIT: DetailEditOptions = {
  taskTypes: ['bug', 'feature', 'chore'],
  priorities: ['High', 'Medium', 'Low'],
  milestones: [{ id: 'm-0', title: 'v1 Launch' }],
  labels: ['build', 'infra', 'ui'],
  assignees: ['@alice', '@bob'],
  tasks: [{ id: 'TASK-1', title: 'Set up the build' }, { id: 'TASK-2', title: 'Render the board' }],
  editor: null,
  commentDraft: '',
  chipDrafts: {},
  error: null,
};

const ALL_SOURCES = {
  fieldSources: { title: 'title: x', priority: null, type: null, milestone: null, due_date: null, assignee: null, labels: null, dependencies: null, references: null, documentation: null, modified_files: null },
  sectionSources: { description: 'x', plan: null, notes: null, finalSummary: null },
};

const renderEdit = (detail: TaskDetail, edit: Partial<DetailEditOptions> = {}) =>
  renderDetail(doc, detail, S, STATUSES, { ...EDIT, ...edit }) as unknown as FakeElement;

test('edit mode: every fixture renders with whitelisted elements, attributes and actions', () => {
  for (const path of allFiles) assertEditSafe(renderEdit(detailOf(path, ALL_SOURCES)));
});

test('edit mode: title, priority, type, milestone and due date controls', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', ALL_SOURCES);
  const root = renderEdit(detail);
  const [title] = root.byAction('edit-title');
  assert.deepEqual([title.tagName, title.textContent, title.attrs.get('role'), title.attrs.get('tabindex'), title.attrs.get('data-hint')], ['h1', 'Set up the build', 'button', '0', S.editSection]);
  const select = (field: string) => root.find((e) => e.attrs.get('data-action') === 'set-field' && e.attrs.get('data-field') === field)[0];
  const options = (field: string) => (select(field).children as FakeElement[]).map((o) => [o.attrs.get('value'), o.textContent, o.attrs.has('selected')]);
  assert.deepEqual(options('priority'), [['', S.noPriority, false], ['high', 'High', true], ['medium', 'Medium', false], ['low', 'Low', false]]);
  assert.deepEqual(options('type'), [['', S.noType, false], ['bug', 'bug', false], ['feature', 'feature', true], ['chore', 'chore', false]]);
  assert.deepEqual(options('milestone'), [['', S.noMilestone, false], ['m-0', 'v1 Launch (m-0)', true]]);
  const due = select('due_date');
  assert.deepEqual([due.tagName, due.attrs.get('type'), due.attrs.get('value')], ['input', 'date', '']);
  assert.equal(root.byClass('detail-priority').length, 0, 'the select replaces the badge');
});

test('edit mode: priority choices are the configured priorities, in lower case; known ones translated', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', ALL_SOURCES);
  const options = (priorities: readonly string[], d = detail) =>
    ((renderEdit(d, { priorities }).find((e) => e.attrs.get('data-field') === 'priority' && e.tagName === 'select')[0].children as FakeElement[]).map((o) => [
      o.attrs.get('value'),
      o.textContent,
      o.attrs.has('selected'),
    ]));
  assert.deepEqual(options(['Urgent', 'HIGH', 'Some day']), [
    ['', S.noPriority, false],
    ['urgent', 'Urgent', false],
    ['high', 'High', true],
    ['some day', 'Some day', false],
  ]);
  // TASK-1 is `high`; a list without it still shows it, selected, at the end.
  assert.deepEqual(options(['Urgent', 'Normal']).at(-1), ['high', 'high', true]);
  assert.deepEqual(options([]), [['', S.noPriority, false], ['high', 'high', true]]);
});

test('edit mode: an unknown current value stays selectable', () => {
  const root = renderEdit(detailOf('project/tasks/task-6 - Minimal.md', { ...ALL_SOURCES, type: 'spike', milestone: 'm-9' }));
  const values = (field: string) =>
    (root.find((e) => e.attrs.get('data-field') === field && e.tagName === 'select')[0].children as FakeElement[]).map((o) => [o.attrs.get('value'), o.attrs.has('selected')]);
  assert.deepEqual(values('type').at(-1), ['spike', true]);
  assert.deepEqual(values('milestone').at(-1), ['m-9', true]);
});

test('edit mode: list fields as chips with remove buttons, an input and suggestions', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', ALL_SOURCES);
  const root = renderEdit(detail, { chipDrafts: { labels: 'do' } });
  const fields = root.byClass('detail-chips').map((c) => c.attrs.get('data-field'));
  assert.deepEqual(fields, ['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files']);
  const removes = root.byAction('remove-item').map((b) => [b.attrs.get('data-field'), b.attrs.get('data-index'), b.attrs.get('aria-label')]);
  assert.deepEqual(removes, [
    ['assignee', '0', 'Remove @alice'],
    ['labels', '0', 'Remove build'],
    ['labels', '1', 'Remove infra'],
    ['references', '0', 'Remove https://example.com/build'],
    ['documentation', '0', 'Remove docs/build.md'],
    ['modified_files', '0', 'Remove scripts/build.mjs'],
  ]);
  const inputs = root.byAction('chip-input');
  assert.equal(inputs.length, 6);
  const labels = inputs.find((i) => i.attrs.get('data-field') === 'labels')!;
  assert.deepEqual([labels.attrs.get('value'), labels.attrs.get('list'), labels.attrs.get('placeholder')], ['do', 'detail-options-labels', S.addItem]);
  const lists = root.find((e) => e.tagName === 'datalist');
  assert.deepEqual(lists.map((l) => l.attrs.get('id')), ['detail-options-assignee', 'detail-options-labels', 'detail-options-dependencies']);
  const deps = lists[2].children as FakeElement[];
  assert.deepEqual(deps.map((o) => [o.attrs.get('value'), o.textContent]), [['TASK-2', 'Render the board']], 'the task itself is not suggested');
  // Links keep working inside chips.
  assert.deepEqual(root.byAction('open-url').map((e) => e.attrs.get('data-url')), ['https://example.com/build']);
});

test('edit mode: dependencies chips keep their task links; errors show under the field', () => {
  const detail = detailOf('project/tasks/task-2 - Render-the-board.md', ALL_SOURCES);
  const root = renderEdit(detail, { error: { field: 'dependencies', message: 'There is no task with ID TASK-99.' } });
  const chips = root.find((e) => e.classes.has('detail-chips') && e.attrs.get('data-field') === 'dependencies')[0];
  assert.deepEqual(chips.byAction('show-task').map((e) => e.textContent), ['TASK-1 Title of TASK-1']);
  const [error] = root.byClass('detail-field-error');
  assert.deepEqual([error.textContent, error.attrs.get('role'), error.attrs.get('id')], ['There is no task with ID TASK-99.', 'alert', 'detail-error-dependencies']);
  const input = root.find((e) => e.attrs.get('data-action') === 'chip-input' && e.attrs.get('data-field') === 'dependencies')[0];
  assert.deepEqual([input.attrs.get('aria-invalid'), input.attrs.get('aria-describedby')], ['true', 'detail-error-dependencies']);
  const other = root.find((e) => e.attrs.get('data-action') === 'chip-input' && e.attrs.get('data-field') === 'labels')[0];
  assert.equal(other.attrs.has('aria-invalid'), false);
});

test('edit mode: open title editor with its draft and an inline error', () => {
  const root = renderEdit(detailOf('project/tasks/task-1 - Set-up-the-build.md', ALL_SOURCES), {
    editor: { kind: 'title', draft: '' },
    error: { field: 'title', message: S.emptyTitle },
  });
  const [input] = root.find((e) => e.attrs.get('data-editor') === 'title');
  assert.deepEqual([input.tagName, input.attrs.get('value'), input.attrs.get('type')], ['input', '', 'text']);
  assert.equal(root.byAction('edit-title').length, 0);
  assert.deepEqual(root.byAction('save-edit').map((b) => b.textContent), [S.save]);
  assert.deepEqual(root.byAction('cancel-edit').map((b) => b.textContent), [S.cancel]);
  assert.equal(root.byClass('detail-field-error')[0].textContent, S.emptyTitle);
});

test('edit mode: sections get Edit buttons, missing ones Add buttons; the open editor has its draft', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', ALL_SOURCES);
  const root = renderEdit(detail);
  assert.deepEqual(root.byAction('edit-section').map((b) => b.attrs.get('data-section')), ['description', 'plan', 'notes']);
  assert.deepEqual(root.byAction('add-section').map((b) => [b.attrs.get('data-section'), b.textContent]), [['finalSummary', 'Add Final Summary']]);

  const editing = renderEdit(detail, { editor: { kind: 'section', name: 'plan', draft: '1. Add script\n2. Wire CI\n3. More' } });
  const [area] = editing.find((e) => e.attrs.get('data-editor') === 'section');
  assert.deepEqual([area.tagName, area.textContent, area.attrs.get('data-section')], ['textarea', '1. Add script\n2. Wire CI\n3. More', 'plan']);
  assert.ok(editing.byClass('detail-section-plan')[0].classes.has('editing'));
  assert.deepEqual(editing.byAction('edit-section').map((b) => b.attrs.get('data-section')), ['description', 'notes']);
  assert.equal(editing.byClass('detail-edit-hint')[0].textContent, S.editHint);

  const adding = renderEdit(detail, { editor: { kind: 'section', name: 'finalSummary', draft: '' } });
  assert.equal(adding.byAction('add-section').length, 0);
  assert.equal(adding.byClass('detail-section-finalSummary').length, 1);
});

test('edit mode: an empty description cannot be saved; other sections can be emptied', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', ALL_SOURCES);
  const save = (name: 'description' | 'notes', draft: string) =>
    renderEdit(detail, { editor: { kind: 'section', name, draft } }).byAction('save-edit')[0].attrs.has('disabled');
  assert.equal(save('description', '  '), true);
  assert.equal(save('description', 'x'), false);
  assert.equal(save('notes', ''), false);
});

test('edit mode: comment composer keeps its draft', () => {
  const root = renderEdit(detailOf('project/tasks/task-6 - Minimal.md', ALL_SOURCES), { commentDraft: 'half **written**' });
  const [box] = root.find((e) => e.attrs.get('data-editor') === 'comment');
  assert.deepEqual([box.tagName, box.textContent, box.attrs.get('placeholder')], ['textarea', 'half **written**', S.commentPlaceholder]);
  assert.deepEqual(root.byAction('add-comment').map((b) => [b.textContent, b.attrs.has('disabled')]), [[S.addComment, false]]);
  const empty = renderEdit(detailOf('project/tasks/task-6 - Minimal.md', ALL_SOURCES));
  assert.equal(empty.byAction('add-comment')[0].attrs.has('disabled'), true, 'nothing to add yet');
  assert.equal(root.byClass('detail-section-comments').length, 1, 'shown even without comments');
});

test('edit mode: nothing is editable when the task is not; locked fields stay read-only', () => {
  const readOnly = renderEdit(detailOf('project/tasks/task-1 - Set-up-the-build.md', { ...ALL_SOURCES, editable: false, readOnly: UPDATED_DATE }));
  for (const action of ['edit-title', 'set-field', 'chip-input', 'remove-item', 'edit-section', 'add-section', 'add-comment']) {
    assert.equal(readOnly.byAction(action).length, 0, action);
  }
  assert.equal(readOnly.find((e) => e.tagName === 'textarea').length, 0);

  const locked = renderEdit(detailOf('variants/unknown-keys.md', { ...ALL_SOURCES, lockedFields: ['labels', 'priority', 'assignee'] }));
  const chipFields = locked.byClass('detail-chips').map((c) => c.attrs.get('data-field'));
  assert.ok(!chipFields.includes('labels') && !chipFields.includes('assignee'));
  assert.equal(locked.find((e) => e.attrs.get('data-field') === 'priority').length, 0);
  assert.deepEqual(locked.byClass('detail-label').map((e) => e.textContent), ['alpha', 'beta'], 'locked labels still shown');
});

test('edit mode: an unclosed fence error marks the section editor or the comment box', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', ALL_SOURCES);
  const section = renderEdit(detail, { editor: { kind: 'section', name: 'plan', draft: '```\nopen' }, error: { field: 'plan', message: S.unclosedFence } });
  const [area] = section.find((e) => e.attrs.get('data-editor') === 'section');
  assert.deepEqual([area.attrs.get('aria-invalid'), area.attrs.get('aria-describedby')], ['true', 'detail-error-plan']);
  assert.deepEqual(section.byClass('detail-field-error').map((e) => [e.textContent, e.attrs.get('id'), e.attrs.get('role')]), [[S.unclosedFence, 'detail-error-plan', 'alert']]);

  const comment = renderEdit(detail, { commentDraft: '~~~\nlog', error: { field: 'comment', message: S.unclosedFence } });
  const [box] = comment.find((e) => e.attrs.get('data-editor') === 'comment');
  assert.deepEqual([box.attrs.get('aria-invalid'), box.attrs.get('aria-describedby')], ['true', 'detail-error-comment']);
  assert.equal(comment.byClass('detail-comment-new')[0].byClass('detail-field-error')[0].textContent, S.unclosedFence);
  assert.equal(renderEdit(detail).find((e) => e.attrs.has('aria-invalid')).length, 0);
});

test('archived tasks (backlog.md 3.1): links carry an archived tag; their detail says how to edit them', () => {
  const detail = detailOf('project/tasks/task-1 - Set-up-the-build.md', {
    dependencies: [
      { id: 'TASK-30', path: 'backlog/archive/tasks/task-30.md', title: 'Shipped', status: 'Done', archived: true },
      { id: 'TASK-2', path: 'tasks/task-2.md', title: 'Render the board', status: 'To Do', archived: false },
    ],
  });
  const root = render(detail);
  const [archived] = root.byClass('detail-task-archived');
  assert.deepEqual(archived.byAction('show-task').map((e) => [e.attrs.get('data-path'), e.textContent]), [['backlog/archive/tasks/task-30.md', 'TASK-30 Shipped']]);
  assert.deepEqual(archived.byClass('detail-archived-tag').map((e) => e.textContent), [`(${S.archivedTask})`]);
  assert.equal(root.byClass('detail-archived-tag').length, 1, 'board tasks have no tag');
  const own = render(detailOf('project/tasks/task-1 - Set-up-the-build.md', ARCHIVED));
  assert.deepEqual(own.byClass('detail-notice').map((e) => e.textContent), [S.readOnlyLabel + S.archivedNotice]);
  assert.equal(own.byAction('set-status')[0].attrs.has('disabled'), true);
  assert.ok(own.byAction('toggle-check').every((b) => b.attrs.has('disabled')));
  const editing = renderEdit(detailOf('project/tasks/task-1 - Set-up-the-build.md', { ...ALL_SOURCES, ...ARCHIVED }));
  assert.deepEqual(editing.find((e) => ['set-field', 'edit-section', 'add-section', 'add-comment', 'edit-title'].includes(e.attrs.get('data-action') ?? '')), [], 'no edit controls');
});
