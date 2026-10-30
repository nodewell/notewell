// Detail edits as messages (backlog.md 5.4): expected sources, no-op detection, chip parsing
// and dependency checks. Every message passes the extension's validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addChipValues,
  addCommentMessage,
  hasUnclosedFence,
  removeChipValue,
  setFieldMessage,
  setListMessage,
  setSectionMessage,
} from '../../../src/features/backlog/browser/detail-edit.ts';
import { validateWebviewMessage } from '../../../src/features/backlog/messages.ts';
import { DEFAULT_STRINGS, type TaskDetail } from '../../../src/features/backlog/view.ts';

const DETAIL: TaskDetail = {
  path: 'backlog/tasks/task-2 - x.md',
  id: 'TASK-2',
  title: 'Render the board',
  status: 'To Do',
  statusLine: 'status: To Do',
  priority: 'low',
  type: null,
  project: null,
  reporter: null,
  assignees: [],
  labels: ['ui'],
  milestone: null,
  milestoneTitle: null,
  due: null,
  created: null,
  updated: null,
  parent: null,
  subtasks: [],
  dependencies: [{ id: 'TASK-1', path: 'backlog/tasks/task-1.md', title: 'Set up', status: 'To Do', archived: false }],
  blocks: [],
  references: [],
  documentation: [],
  modifiedFiles: [],
  description: 'A board.',
  plan: null,
  notes: null,
  finalSummary: null,
  ac: null,
  dod: null,
  comments: null,
  commentsRaw: null,
  otherBody: '',
  otherFields: [],
  editable: true,
  readOnly: null,
  archived: false,
  fieldSources: {
    title: 'title: Render the board',
    priority: 'priority: low',
    type: null,
    labels: 'labels:\n  - ui',
    dependencies: 'dependencies:\n  - TASK-1',
    assignee: 'assignee: []',
  },
  lockedFields: [],
  sectionSources: { description: 'A board.', plan: null },
};

const TASKS = [
  { id: 'TASK-1', title: 'Set up' },
  { id: 'TASK-2', title: 'Render the board' },
  { id: 'TASK-10', title: 'Later' },
];
const context = { tasks: TASKS, strings: DEFAULT_STRINGS };

test('setField: expected is the field source; omitted for an absent field; nothing for no change', () => {
  const title = setFieldMessage(DETAIL, 'title', 'New title');
  assert.deepEqual(title, { type: 'setField', path: DETAIL.path, name: 'title', value: 'New title', expected: 'title: Render the board' });
  assert.ok(validateWebviewMessage(title));
  const type = setFieldMessage(DETAIL, 'type', 'bug');
  assert.deepEqual(type, { type: 'setField', path: DETAIL.path, name: 'type', value: 'bug' });
  assert.ok(validateWebviewMessage(type));
  assert.deepEqual(setFieldMessage(DETAIL, 'priority', ''), { type: 'setField', path: DETAIL.path, name: 'priority', value: '', expected: 'priority: low' });
  assert.equal(setFieldMessage(DETAIL, 'priority', 'low'), undefined);
  assert.equal(setFieldMessage(DETAIL, 'title', 'Render the board'), undefined);
  assert.equal(setFieldMessage(DETAIL, 'due_date', ''), undefined, 'absent stays absent');
});

test('setList: all items one per line with the expected source', () => {
  const message = setListMessage(DETAIL, 'labels', ['ui', 'infra']);
  assert.deepEqual(message, { type: 'setList', path: DETAIL.path, name: 'labels', values: 'ui\ninfra', expected: 'labels:\n  - ui' });
  assert.ok(validateWebviewMessage(message));
  assert.deepEqual(setListMessage(DETAIL, 'labels', []), { type: 'setList', path: DETAIL.path, name: 'labels', values: '', expected: 'labels:\n  - ui' });
  assert.equal(setListMessage(DETAIL, 'labels', ['ui']), undefined);
  assert.deepEqual(setListMessage(DETAIL, 'references', ['https://a.test']), { type: 'setList', path: DETAIL.path, name: 'references', values: 'https://a.test' });
});

test('setSection and addComment', () => {
  const message = setSectionMessage(DETAIL, 'description', 'A better board.\n\n- with a list');
  assert.deepEqual(message, { type: 'setSection', path: DETAIL.path, section: 'description', text: 'A better board.\n\n- with a list', expected: 'A board.' });
  assert.ok(validateWebviewMessage(message));
  assert.equal(setSectionMessage(DETAIL, 'description', '  A board.\n'), undefined, 'whitespace-only change');
  const added = setSectionMessage(DETAIL, 'plan', '1. Do it');
  assert.deepEqual(added, { type: 'setSection', path: DETAIL.path, section: 'plan', text: '1. Do it' });
  assert.ok(validateWebviewMessage(added));
  assert.equal(setSectionMessage(DETAIL, 'plan', '  '), undefined, 'an empty new section is no change');
  assert.deepEqual(setSectionMessage(DETAIL, 'description', ''), { type: 'setSection', path: DETAIL.path, section: 'description', text: '', expected: 'A board.' });
  const comment = addCommentMessage(DETAIL, 'Looks **good**\nsecond line');
  assert.deepEqual(comment, { type: 'addComment', path: DETAIL.path, text: 'Looks **good**\nsecond line', seen: 0 });
  assert.ok(validateWebviewMessage(comment));
  assert.equal(addCommentMessage(DETAIL, '  \n '), undefined);
});

test('chips: commas split labels, assignees and dependencies; trimmed, deduplicated', () => {
  assert.deepEqual(addChipValues(DETAIL, 'labels', ' infra , UI,, docs ', context), { values: ['ui', 'infra', 'docs'] });
  assert.deepEqual(addChipValues(DETAIL, 'assignee', '@alice, @bob', context), { values: ['@alice', '@bob'] });
  assert.deepEqual(addChipValues(DETAIL, 'references', 'https://a.test/x?a=1,2', context), { values: ['https://a.test/x?a=1,2'] }, 'no split for URLs and paths');
  assert.deepEqual(removeChipValue(DETAIL, 'labels', 0), []);
});

test('chips: dependencies must be another existing task, spelled as its ID', () => {
  assert.deepEqual(addChipValues(DETAIL, 'dependencies', 'task-10', context), { values: ['TASK-1', 'TASK-10'] });
  assert.deepEqual(addChipValues(DETAIL, 'dependencies', 'TASK-1', context), { values: ['TASK-1'] }, 'already there');
  assert.deepEqual(addChipValues(DETAIL, 'dependencies', 'TASK-99', context), { error: 'There is no task with ID TASK-99.' });
  assert.deepEqual(addChipValues(DETAIL, 'dependencies', 'task-2', context), { error: DEFAULT_STRINGS.selfDependency });
  assert.deepEqual(addChipValues(DETAIL, 'dependencies', 'TASK-10, TASK-99', context), { error: 'There is no task with ID TASK-99.' }, 'all or nothing');
});

test('unclosed code fences are caught before sending (both markers, any length)', () => {
  assert.equal(hasUnclosedFence('Example:\n```ts\nconst x = 1;'), true);
  assert.equal(hasUnclosedFence('see\n~~~\nlog'), true);
  assert.equal(hasUnclosedFence('````\n```\nstill open'), true, 'a shorter run does not close a longer fence');
  assert.equal(hasUnclosedFence('```ts\nconst x = 1;\n```'), false);
  assert.equal(hasUnclosedFence('~~~\nok\n~~~~'), false);
  assert.equal(hasUnclosedFence('inline ``` is not a fence opener when text precedes it'), false);
  assert.equal(hasUnclosedFence('plain text'), false);
  assert.equal(hasUnclosedFence('```\nopen\n\n   '), true, 'trailing blank lines do not close it');
});
