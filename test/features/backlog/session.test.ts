// Backlog panel session (backlog.md 5, 9 #2) with fake ports: edits, undo byte for byte,
// stale handling, queue order and message validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOM, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, type TextEdit } from '../../../src/core/patch.ts';
import type { ErrorReason, ExtensionMessage } from '../../../src/features/backlog/messages.ts';
import { BacklogSession, dependenciesAllowed, restoreEdit, UNDO_LIMIT, type BacklogPorts, type DependencyGraph } from '../../../src/features/backlog/session.ts';
import { idKey } from '../../../src/features/backlog/task-index.ts';
import { DEFAULT_STRINGS, type BacklogView, type TaskDetail } from '../../../src/features/backlog/view.ts';

const fixtures = new URL('../../fixtures/backlog/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, fixtures), 'utf8');

const graphOf = (deps: Record<string, string[]>): DependencyGraph => {
  const keyOf = (id: string) => idKey(id, 'task');
  return { keyOf, tasks: new Map(Object.entries(deps).map(([id, list]) => [keyOf(id), list])) };
};
/** The fixture project's dependencies: TASK-2 depends on TASK-1. */
const FIXTURE_GRAPH = graphOf({ 'TASK-1': [], 'TASK-1.1': [], 'TASK-2': ['TASK-1'], 'TASK-3': [], 'TASK-4': [], 'TASK-5': [], 'TASK-6': [] });

const TASK1 = 'tasks/task-1.md';
const TASK3 = 'tasks/task-3.md';
const NOW = new Date(Date.UTC(2026, 9, 14, 11, 22));
const ERRORS: Record<ErrorReason, string> = {
  stale: 'E-stale',
  invalid: 'E-invalid',
  unsafe: 'E-unsafe',
  failed: 'E-failed',
  nothingToUndo: 'E-nothing',
  readOnly: 'E-readOnly',
  encoding: 'E-encoding',
};

const VIEW: BacklogView = {
  project: 'demo',
  statuses: ['To Do', 'In Progress', 'Done'],
  doneStatus: 'Done',
  tasks: [],
  archived: [],
  unreadable: [],
  milestones: [],
  taskTypes: ['bug', 'feature'],
  priorities: ['High', 'Medium', 'Low'],
  detailPosition: 'bottom',
  layout: { columnWidths: {}, paneSizes: {} },
  strings: DEFAULT_STRINGS,
};

interface Fake {
  readonly session: BacklogSession;
  readonly files: Map<string, { text: string; version: number }>;
  readonly posted: ExtensionMessage[];
  readonly calls: string[];
  /** What the write port answers after checking `before` (default: written). */
  writeResult: 'written' | 'failed';
  noView: boolean;
}

function fake(files: Record<string, string>, overrides: Partial<BacklogPorts> = {}): Fake {
  const state: Fake = {
    session: undefined as unknown as BacklogSession,
    files: new Map(Object.entries(files).map(([path, text]) => [path, { text, version: 1 }])),
    posted: [],
    calls: [],
    writeResult: 'written',
    noView: false,
  };
  const ports: BacklogPorts = {
    view: () => (state.noView ? undefined : VIEW),
    detail: (path) => (state.files.has(path) ? ({ path, title: state.files.get(path)!.text.length } as unknown as TaskDetail) : null),
    readTask: async (path) => {
      const file = state.files.get(path);
      return file && { ...file };
    },
    write: async (path, { before, after, edits }) => {
      state.calls.push(`write ${path}`);
      const file = state.files.get(path);
      if (file === undefined || file.text !== before) return 'stale';
      if (state.writeResult === 'failed') return 'failed';
      // `after` and `edits` must describe the same change.
      assert.equal(applyEdits(parseLines(before), edits as TextEdit[]), after);
      state.files.set(path, { text: after, version: file.version + 1 });
      return state.writeResult;
    },
    statuses: () => VIEW.statuses,
    post: (message) => {
      state.posted.push(message);
    },
    openTask: async (path) => {
      state.calls.push(`openTask ${path}`);
    },
    openPath: async (path) => {
      state.calls.push(`openPath ${path}`);
    },
    openUrl: async (url) => {
      state.calls.push(`openUrl ${url}`);
    },
    now: () => NOW,
    errors: ERRORS,
    dependencies: () => FIXTURE_GRAPH,
    saveLayout: async (layout) => {
      state.calls.push(`layout ${JSON.stringify(layout)}`);
    },
    setDetailPosition: async (position) => {
      state.calls.push(`setDetailPosition ${position}`);
    },
    ...overrides,
  };
  (state as { session: BacklogSession }).session = new BacklogSession(ports);
  return state;
}

const types = (posted: readonly ExtensionMessage[]): string[] =>
  posted.map((m) => (m.type === 'error' ? `error:${m.reason}` : m.type === 'detail' ? `detail:${m.path}` : m.type));

const setStatus = (path: string, statusLine: string, status: string) => ({ type: 'setStatus', path, statusLine, status });

test('ready renders; showTask posts the detail and later renders follow it', async () => {
  const f = fake({ [TASK1]: read('project/tasks/task-1 - Set-up-the-build.md') });
  await f.session.handle({ type: 'ready' });
  assert.deepEqual(types(f.posted), ['render']);
  await f.session.handle({ type: 'showTask', path: TASK1 });
  f.session.render();
  assert.deepEqual(types(f.posted), ['render', `detail:${TASK1}`, 'render', `detail:${TASK1}`]);
});

test('hideTask clears the selection: later renders send no detail', async () => {
  const f = fake({ [TASK1]: read('project/tasks/task-1 - Set-up-the-build.md') });
  await f.session.handle({ type: 'showTask', path: TASK1 });
  await f.session.handle({ type: 'hideTask' });
  f.session.render();
  assert.deepEqual(types(f.posted), [`detail:${TASK1}`, 'render']);
});

test('board setStatus: empty statusLine with fromStatus uses the file status line', async () => {
  const source = read('variants/quoted-status.md');
  const f = fake({ q: source, c: 'x' });
  await f.session.handle({ type: 'setStatus', path: 'q', statusLine: '', status: 'Done', fromStatus: 'to do' });
  assert.match(f.files.get('q')!.text, /\nstatus: "Done"\n/);
  assert.deepEqual(types(f.posted), []);
  await f.session.handle({ type: 'undo' });
  assert.equal(f.files.get('q')!.text, source);
});

test('board setStatus: refusals', async () => {
  const f = fake({
    [TASK3]: read('project/tasks/task-3 - Ship-it.md'),
    list: '---\nstatus:\n  - To Do\nupdated_date: x\n---\n',
    none: '---\nid: X\n---\n',
  });
  await f.session.handle({ type: 'setStatus', path: TASK3, statusLine: '', status: 'To Do' });
  await f.session.handle({ type: 'setStatus', path: TASK3, statusLine: '', status: 'To Do', fromStatus: 'In Progress' });
  await f.session.handle({ type: 'setStatus', path: 'list', statusLine: '', status: 'Done', fromStatus: 'To Do' });
  await f.session.handle({ type: 'setStatus', path: 'none', statusLine: '', status: 'Done', fromStatus: 'To Do' });
  await f.session.handle({ type: 'setStatus', path: TASK3, statusLine: '', status: 'Nope', fromStatus: 'Done' });
  assert.deepEqual(types(f.posted), ['error:invalid', 'render', 'error:stale', 'error:unsafe', 'error:unsafe', 'error:invalid']);
  assert.deepEqual(f.calls, []);
});

test('detail setStatus with a statusLine ignores fromStatus', async () => {
  const f = fake({ [TASK3]: read('project/tasks/task-3 - Ship-it.md') });
  await f.session.handle({ type: 'setStatus', path: TASK3, statusLine: 'status: Done', status: 'To Do', fromStatus: 'Other' });
  assert.match(f.files.get(TASK3)!.text, /\nstatus: To Do\n/);
});

test('a task that disappeared posts a null detail once and is deselected', async () => {
  const f = fake({});
  await f.session.handle({ type: 'showTask', path: 'tasks/gone.md' });
  f.session.render();
  assert.deepEqual(types(f.posted), ['detail:tasks/gone.md', 'render']);
  assert.equal((f.posted[0] as { detail: unknown }).detail, null);
});

test('no project: render says the project is unavailable, and nothing else', async () => {
  const f = fake({ [TASK1]: read('project/tasks/task-1 - Set-up-the-build.md') });
  await f.session.handle({ type: 'showTask', path: TASK1 });
  f.posted.length = 0;
  f.noView = true;
  f.session.render();
  assert.deepEqual(types(f.posted), ['unavailable']);
});

test('setStatus edits, saves and undo restores the bytes exactly', async () => {
  for (const [label, source] of [
    ['LF', read('project/tasks/task-1 - Set-up-the-build.md')],
    ['CRLF', read('variants/crlf.md')],
    ['BOM', `${BOM}${read('project/tasks/task-1 - Set-up-the-build.md')}`],
    ['no updated_date', read('project/tasks/task-6 - Minimal.md')],
    ['no trailing newline', read('variants/no-trailing-newline.md')],
  ]) {
    const f = fake({ [TASK1]: source });
    const line = source.split(/\r?\n/).find((text) => text.startsWith('status:'))!;
    await f.session.handle(setStatus(TASK1, line, 'Done'));
    const edited = f.files.get(TASK1)!.text;
    assert.notEqual(edited, source, label);
    assert.ok(edited.includes("updated_date: '2026-10-14 11:22'"), label);
    assert.match(edited, /status: Done/, label);
    await f.session.handle({ type: 'undo' });
    assert.equal(f.files.get(TASK1)!.text, source, `${label}: undo restores the bytes`);
    assert.deepEqual(f.calls, [`write ${TASK1}`, `write ${TASK1}`], label);
    assert.deepEqual(types(f.posted), [], `${label}: no errors`);
  }
});

test('toggleCheck edits; undo after several edits goes back one at a time across files', async () => {
  const task1 = read('project/tasks/task-1 - Set-up-the-build.md');
  const task3 = read('project/tasks/task-3 - Ship-it.md');
  const f = fake({ [TASK1]: task1, [TASK3]: task3 });
  await f.session.handle({ type: 'toggleCheck', path: TASK1, list: 'ac', line: 41, source: '- [ ] #2 Typecheck passes', checked: true });
  const afterFirst = f.files.get(TASK1)!.text;
  assert.match(afterFirst, /- \[x\] #2 Typecheck passes/);
  await f.session.handle(setStatus(TASK3, 'status: Done', 'To Do'));
  await f.session.handle({ type: 'toggleCheck', path: TASK1, list: 'dod', line: 46, source: '- [ ] #1 Docs updated', checked: true });
  await f.session.handle({ type: 'undo' });
  assert.equal(f.files.get(TASK1)!.text, afterFirst);
  await f.session.handle({ type: 'undo' });
  assert.equal(f.files.get(TASK3)!.text, task3);
  await f.session.handle({ type: 'undo' });
  assert.equal(f.files.get(TASK1)!.text, task1);
  await f.session.handle({ type: 'undo' });
  assert.deepEqual(types(f.posted), ['error:nothingToUndo']);
  assert.equal((f.posted[0] as { message: string }).message, 'E-nothing');
});

test('undo is refused as stale when the file changed since; the entry is dropped', async () => {
  const source = read('project/tasks/task-3 - Ship-it.md');
  const f = fake({ [TASK3]: source });
  await f.session.handle(setStatus(TASK3, 'status: Done', 'To Do'));
  const file = f.files.get(TASK3)!;
  f.files.set(TASK3, { text: `${file.text}extra\n`, version: file.version + 1 });
  await f.session.handle({ type: 'undo' });
  assert.deepEqual(types(f.posted), ['render', 'error:stale']);
  await f.session.handle({ type: 'undo' });
  assert.deepEqual(types(f.posted), ['render', 'error:stale', 'error:nothingToUndo']);
});

test('the undo stack keeps the last UNDO_LIMIT changes', async () => {
  const f = fake({ [TASK3]: read('project/tasks/task-3 - Ship-it.md') });
  for (let i = 0; i < UNDO_LIMIT + 5; i++) {
    const current = f.files.get(TASK3)!.text.match(/^status: .*$/m)![0];
    await f.session.handle(setStatus(TASK3, current, current === 'status: Done' ? 'To Do' : 'Done'));
  }
  for (let i = 0; i < UNDO_LIMIT; i++) await f.session.handle({ type: 'undo' });
  assert.deepEqual(types(f.posted), []);
  await f.session.handle({ type: 'undo' });
  assert.deepEqual(types(f.posted), ['error:nothingToUndo']);
});

test('stale requests redraw then report; missing files too', async () => {
  const f = fake({ [TASK3]: read('project/tasks/task-3 - Ship-it.md') });
  await f.session.handle(setStatus(TASK3, 'status: To Do', 'In Progress'));
  await f.session.handle({ type: 'toggleCheck', path: TASK3, list: 'ac', line: 20, source: '- [ ] #1 Tagged', checked: true });
  await f.session.handle(setStatus('tasks/missing.md', 'status: To Do', 'Done'));
  assert.deepEqual(types(f.posted), ['render', 'error:stale', 'render', 'error:stale', 'render', 'error:stale']);
  assert.deepEqual(f.calls, []);
});

test('unsafe and invalid plans are reported without redraw; nothing is applied', async () => {
  const f = fake({ u: read('variants/updated-unknown.md'), o: read('variants/odd-check.md') });
  await f.session.handle(setStatus('u', 'status: To Do', 'Done'));
  await f.session.handle(setStatus('u', 'status: To Do', 'Blocked'));
  await f.session.handle({ type: 'toggleCheck', path: 'o', list: 'ac', line: 10, source: '- [ ] #1 fine', checked: true });
  assert.deepEqual(types(f.posted), ['error:unsafe', 'error:invalid', 'error:unsafe']);
  assert.deepEqual(f.calls, []);
});

test('no-op requests apply nothing and keep the undo stack empty', async () => {
  const f = fake({ [TASK3]: read('project/tasks/task-3 - Ship-it.md') });
  await f.session.handle(setStatus(TASK3, 'status: Done', 'done'));
  await f.session.handle({ type: 'undo' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(types(f.posted), ['error:nothingToUndo']);
});

test('a refused write redraws, reports failed and is not undoable', async () => {
  const f = fake({ [TASK3]: read('project/tasks/task-3 - Ship-it.md') });
  f.writeResult = 'failed';
  await f.session.handle(setStatus(TASK3, 'status: Done', 'To Do'));
  await f.session.handle({ type: 'undo' });
  assert.deepEqual(types(f.posted), ['render', 'error:failed', 'error:nothingToUndo']);
});

test('the file changing between read and write is stale: redraw, nothing written, not undoable', async () => {
  const source = read('project/tasks/task-3 - Ship-it.md');
  const f = fake({ [TASK3]: source }, {
    // Someone saves the file after it was read.
    readTask: async () => ({ text: source, version: 1 }),
  });
  f.files.set(TASK3, { text: `${source}x\n`, version: 2 });
  await f.session.handle(setStatus(TASK3, 'status: Done', 'To Do'));
  await f.session.handle({ type: 'undo' });
  assert.deepEqual(types(f.posted), ['render', 'error:stale', 'error:nothingToUndo']);
  assert.equal(f.files.get(TASK3)!.text, `${source}x\n`);
});

test('messages are handled in order: the second edit sees the first', async () => {
  const f = fake({ [TASK3]: read('project/tasks/task-3 - Ship-it.md') });
  const first = f.session.handle(setStatus(TASK3, 'status: Done', 'To Do'));
  const second = f.session.handle(setStatus(TASK3, 'status: To Do', 'In Progress'));
  const third = f.session.handle(setStatus(TASK3, 'status: Done', 'To Do'));
  await Promise.all([first, second, third]);
  assert.match(f.files.get(TASK3)!.text, /status: In Progress/);
  assert.deepEqual(types(f.posted), ['render', 'error:stale'], 'the third was built before the others ran');
});

test('a throwing port is reported as failed and the queue keeps going', async () => {
  let fail = true;
  const f = fake({}, {
    openTask: async () => {
      if (fail) throw new Error('boom');
    },
  });
  await f.session.handle({ type: 'openTask', path: 'a' });
  fail = false;
  await f.session.handle({ type: 'ready' });
  assert.deepEqual(types(f.posted), ['error:failed', 'render']);
});

test('invalid messages are rejected before anything runs', async () => {
  const f = fake({ [TASK3]: read('project/tasks/task-3 - Ship-it.md') });
  for (const raw of [
    null,
    'ready',
    { type: 'nope' },
    { type: 'setStatus', path: TASK3, statusLine: 'status: Done' },
    { type: 'setStatus', path: TASK3, statusLine: 'status: Done', status: 'To Do', extra: 1 },
    { type: 'toggleCheck', path: TASK3, list: 'other', line: 20, source: 'x', checked: true },
    { type: 'toggleCheck', path: TASK3, list: 'ac', line: -1, source: 'x', checked: true },
    { type: 'showTask', path: '' },
    { type: 'setStatus', path: TASK3, statusLine: 'a\nb', status: 'To Do' },
  ]) {
    await f.session.handle(raw);
  }
  assert.deepEqual(types(f.posted), Array(9).fill('error:invalid'));
  assert.deepEqual(f.calls, []);
});

test('openUrl passes only http(s); openTask and openPath pass through', async () => {
  const f = fake({});
  for (const url of ['https://example.com/a', 'http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'command:x', 'not a url']) {
    await f.session.handle({ type: 'openUrl', url });
  }
  await f.session.handle({ type: 'openTask', path: TASK1 });
  await f.session.handle({ type: 'openPath', path: 'docs/build.md' });
  assert.deepEqual(f.calls, ['openUrl https://example.com/a', 'openUrl http://example.com', `openTask ${TASK1}`, 'openPath docs/build.md']);
  assert.deepEqual(types(f.posted), Array(4).fill('error:invalid'));
});

test('restoreEdit: one edit gives the target bytes', () => {
  const cases: [string, string][] = [
    ['a\nb\nc\n', 'a\nB\nc\n'],
    ['a\nb\nc\n', 'a\nc\n'],
    ['a\nc\n', 'a\nb\nc\n'],
    ['a\r\nb\r\n', 'a\r\nb\n'],
    ['a\nb', 'a\nb\n'],
    ['a\nb\n', 'a\nb'],
    ['', 'x\n'],
    ['x\n', ''],
    ['same\n', 'same\n'],
    [`${BOM}a\nb\n`, `${BOM}a\nc\n`],
  ];
  for (const [from, to] of cases) {
    const edit = restoreEdit(from, to);
    assert.ok(edit);
    assert.equal(applyEdits(parseLines(from), [edit]), to, JSON.stringify([from, to]));
  }
  assert.equal(restoreEdit(`${BOM}a\n`, 'a\n'), undefined);
});

// --- Stage 2 (backlog.md 5.4) ---

const TASK1_SOURCE = () => read('project/tasks/task-1 - Set-up-the-build.md');

test('setField: change, remove with an empty value, stale expectation; undo restores', async () => {
  const source = TASK1_SOURCE();
  const f = fake({ [TASK1]: source });
  await f.session.handle({ type: 'setField', path: TASK1, name: 'priority', value: 'low', expected: 'priority: high' });
  assert.match(f.files.get(TASK1)!.text, /\npriority: low\n/);
  await f.session.handle({ type: 'setField', path: TASK1, name: 'milestone', value: '', expected: 'milestone: m-0' });
  assert.doesNotMatch(f.files.get(TASK1)!.text, /milestone:/);
  await f.session.handle({ type: 'setField', path: TASK1, name: 'reporter', value: '@r' });
  assert.match(f.files.get(TASK1)!.text, /\nassignee:\n {2}- '@alice'\nreporter: '@r'\ncreated_date:/);
  await f.session.handle({ type: 'setField', path: TASK1, name: 'type', value: 'bug', expected: 'type: chore' });
  assert.deepEqual(types(f.posted), ['render', 'error:stale']);
  for (let i = 0; i < 3; i++) await f.session.handle({ type: 'undo' });
  assert.equal(f.files.get(TASK1)!.text, source);
});

test('setList: one item per line, blank lines dropped, empty clears; expected is the field source', async () => {
  const f = fake({ [TASK1]: TASK1_SOURCE() });
  await f.session.handle({ type: 'setList', path: TASK1, name: 'labels', values: 'build\n  ci  \n\n', expected: 'labels:\n  - build\n  - infra' });
  assert.match(f.files.get(TASK1)!.text, /\nlabels:\n {2}- build\n {2}- ci\nmilestone:/);
  await f.session.handle({ type: 'setList', path: TASK1, name: 'assignee', values: '', expected: "assignee:\n  - '@alice'" });
  assert.match(f.files.get(TASK1)!.text, /\nassignee: \[\]\n/);
  await f.session.handle({ type: 'setList', path: TASK1, name: 'references', values: 'x', expected: 'references: []' });
  await f.session.handle({ type: 'setList', path: TASK1, name: 'documentation', values: 'a\nb' });
  assert.deepEqual(types(f.posted), ['render', 'error:stale', 'render', 'error:stale']);
});

test('setSection and addComment edit the body; undo restores the bytes', async () => {
  const source = TASK1_SOURCE();
  const f = fake({ [TASK1]: source });
  await f.session.handle({ type: 'setSection', path: TASK1, section: 'notes', text: 'Rewritten\n\nnotes', expected: 'Started with esbuild.' });
  await f.session.handle({ type: 'setSection', path: TASK1, section: 'finalSummary', text: 'All done.' });
  await f.session.handle({ type: 'addComment', path: TASK1, text: 'Another comment', seen: 1 });
  const text = f.files.get(TASK1)!.text;
  assert.match(text, /<!-- SECTION:NOTES:BEGIN -->\nRewritten\n\nnotes\n<!-- SECTION:NOTES:END -->/);
  assert.match(text, /\n---\n\ncreated: 2026-10-14 11:22\n\n---\n\nAnother comment\n\n---\n<!-- COMMENTS:END -->\n\n## Final Summary\n/);
  await f.session.handle({ type: 'setSection', path: TASK1, section: 'plan', text: 'x', expected: 'old plan' });
  await f.session.handle({ type: 'addComment', path: TASK1, text: 'a\n---\nb', seen: 2 });
  assert.deepEqual(types(f.posted), ['render', 'error:stale', 'error:invalid']);
  for (let i = 0; i < 3; i++) await f.session.handle({ type: 'undo' });
  assert.equal(f.files.get(TASK1)!.text, source);
});

test('stage 2 edits are refused on files they cannot write', async () => {
  const f = fake({ u: read('variants/updated-unknown.md'), k: read('variants/unknown-keys.md') });
  await f.session.handle({ type: 'setField', path: 'u', name: 'priority', value: 'low' });
  await f.session.handle({ type: 'setField', path: 'k', name: 'priority', value: 'low', expected: 'priority: "high\\qvalue"' });
  await f.session.handle({ type: 'setList', path: 'k', name: 'labels', values: 'alpha', expected: 'labels: [alpha, beta]' });
  await f.session.handle({ type: 'addComment', path: 'u', text: 'x', seen: 0 });
  assert.deepEqual(types(f.posted), ['error:unsafe', 'error:unsafe', 'error:unsafe', 'error:unsafe']);
  assert.deepEqual(f.calls, []);
});

const NL = String.fromCharCode(10);
const summary = (path: string, status: string, ordinal: number | null) => ({ path, status, ordinal }) as unknown as BacklogView['tasks'][number];

/** The board shows `tasks`; each one without a given file gets one that says what the board shows. */
function boardFake(tasks: BacklogView['tasks'], files: Record<string, string>) {
  const all = { ...files };
  for (const t of tasks) {
    all[t.path] ??= ['---', `id: ${t.path}`, `status: ${t.status}`, ...(t.ordinal === null ? [] : [`ordinal: ${t.ordinal}`]), '---', ''].join(NL);
  }
  return fake(all, { view: () => ({ ...VIEW, tasks }) });
}

const MOVED = 'tasks/task-1.1.md';
const movedSource = () => read('project/tasks/task-1.1 - Write-the-parser.md');
const ordinalOf = (text: string): number => Number(/^ordinal: (.*)$/m.exec(text)![1]);

test('moveInColumn: new ordinal between the neighbours, updated_date untouched, undo restores', async () => {
  const source = movedSource();
  const tasks = [summary('a', 'To Do', 1000), summary('b', 'To Do', 1500), summary(MOVED, 'To Do', 2000)];
  const f = boardFake(tasks, { [MOVED]: source });
  await f.session.handle({ type: 'moveInColumn', path: MOVED, fromStatus: 'to do', afterPath: 'a', beforePath: 'b' });
  const moved = f.files.get(MOVED)!.text;
  assert.ok(ordinalOf(moved) > 1000 && ordinalOf(moved) < 1500, String(ordinalOf(moved)));
  assert.doesNotMatch(moved, /updated_date/, 'ordinal moves do not touch updated_date');
  assert.deepEqual(types(f.posted), []);
  await f.session.handle({ type: 'undo' });
  assert.equal(f.files.get(MOVED)!.text, source);
  await f.session.handle({ type: 'moveInColumn', path: MOVED, fromStatus: 'To Do', beforePath: 'a' });
  assert.ok(ordinalOf(f.files.get(MOVED)!.text) < 1000, 'top of the column');
});

test('moveInColumn: stale and invalid requests', async () => {
  const tasks = [summary('a', 'To Do', 1000), summary('c', 'Done', 500), summary(MOVED, 'To Do', 2000)];
  const f = boardFake(tasks, { [MOVED]: movedSource() });
  await f.session.handle({ type: 'moveInColumn', path: MOVED, fromStatus: 'Done', afterPath: 'a' });
  await f.session.handle({ type: 'moveInColumn', path: MOVED, fromStatus: 'To Do', afterPath: 'c' });
  await f.session.handle({ type: 'moveInColumn', path: MOVED, fromStatus: 'To Do', afterPath: 'missing' });
  await f.session.handle({ type: 'moveInColumn', path: 'tasks/unknown.md', fromStatus: 'To Do', afterPath: 'a' });
  await f.session.handle({ type: 'moveInColumn', path: MOVED, fromStatus: 'To Do', afterPath: MOVED });
  assert.deepEqual(types(f.posted), ['render', 'error:stale', 'render', 'error:stale', 'render', 'error:stale', 'render', 'error:stale', 'error:invalid']);
  assert.deepEqual(f.calls, []);

  // The board still shows To Do but the file was changed to In Progress meanwhile.
  const changed = boardFake(tasks, { [MOVED]: movedSource().replace('status: To Do', 'status: In Progress') });
  await changed.session.handle({ type: 'moveInColumn', path: MOVED, fromStatus: 'To Do', afterPath: 'a' });
  assert.deepEqual(types(changed.posted), ['render', 'error:stale']);
});

// --- Dependency checks (backlog.md 5.4) ---

test('dependenciesAllowed: self, unknown IDs and cycles are refused for added IDs only', () => {
  // A -> B -> C (A depends on B, B on C); D has a broken dependency on X.
  const graph = graphOf({ 'TASK-1': ['TASK-2'], 'TASK-2': ['TASK-3'], 'TASK-3': [], 'TASK-4': ['TASK-99'] });
  assert.equal(dependenciesAllowed(graph, 'TASK-4', ['TASK-99'], ['TASK-99', 'TASK-1']), true, 'a new dependency without a path back');
  assert.equal(dependenciesAllowed(graph, 'TASK-3', [], ['TASK-1']), false, 'TASK-1 reaches TASK-3: a cycle');
  assert.equal(dependenciesAllowed(graph, 'TASK-3', [], ['task-1']), false, 'IDs compare case-insensitively');
  assert.equal(dependenciesAllowed(graph, 'TASK-3', [], ['1']), false, 'a bare number means the prefixed ID');
  assert.equal(dependenciesAllowed(graph, 'TASK-2', [], ['TASK-2']), false, 'itself');
  assert.equal(dependenciesAllowed(graph, 'TASK-2', [], ['TASK-77']), false, 'unknown ID');
  assert.equal(dependenciesAllowed(graph, 'TASK-4', ['TASK-99'], []), true, 'removing is always allowed');
  assert.equal(dependenciesAllowed(graph, 'TASK-4', ['TASK-99'], ['TASK-99']), true, 'a broken dependency already listed stays');
  const cyclic = graphOf({ 'TASK-1': ['TASK-2'], 'TASK-2': ['TASK-1'], 'TASK-3': [] });
  assert.equal(dependenciesAllowed(cyclic, 'TASK-1', ['TASK-2'], ['TASK-2', 'TASK-3']), true, 'an existing cycle does not block other changes');
  assert.equal(dependenciesAllowed(cyclic, 'TASK-3', [], ['TASK-1']), true, 'a cycle elsewhere is not followed forever');
});

test('setList dependencies: cycles and unknown IDs are refused, valid additions written', async () => {
  const f = fake({ [TASK1]: TASK1_SOURCE(), t6: read('project/tasks/task-6 - Minimal.md') });
  await f.session.handle({ type: 'setList', path: TASK1, name: 'dependencies', values: 'TASK-2', expected: 'dependencies: []' });
  await f.session.handle({ type: 'setList', path: TASK1, name: 'dependencies', values: 'TASK-1', expected: 'dependencies: []' });
  await f.session.handle({ type: 'setList', path: TASK1, name: 'dependencies', values: 'TASK-42', expected: 'dependencies: []' });
  assert.deepEqual(types(f.posted), ['error:invalid', 'error:invalid', 'error:invalid']);
  assert.deepEqual(f.calls, []);
  await f.session.handle({ type: 'setList', path: 't6', name: 'dependencies', values: 'task-1\nTASK-2', expected: 'dependencies: []' });
  assert.match(f.files.get('t6')!.text, /\ndependencies:\n {2}- task-1\n {2}- TASK-2\n/);
  assert.equal(types(f.posted).length, 3, 'no new error');
});

test('setDetailPosition goes to the port; anything else is invalid', async () => {
  const f = fake({});
  await f.session.handle({ type: 'setDetailPosition', position: 'right' });
  await f.session.handle({ type: 'setDetailPosition', position: 'bottom' });
  assert.deepEqual(f.calls, ['setDetailPosition right', 'setDetailPosition bottom']);
  assert.deepEqual(types(f.posted), []);
  await f.session.handle({ type: 'setDetailPosition', position: 'left' });
  assert.deepEqual(f.calls.length, 2);
  assert.deepEqual(types(f.posted), ['error:invalid']);
});

test('saveLayout passes column widths and pane shares to the port; bad values are rejected', async () => {
  const f = fake({});
  await f.session.handle({ type: 'saveLayout', title: 320, id: 90, bottom: 450 });
  assert.deepEqual(f.calls.filter((c) => c.startsWith('layout')), ['layout {"columnWidths":{"id":90,"title":320},"paneSizes":{"bottom":450}}']);
  await f.session.handle({ type: 'saveLayout', title: 5 });
  assert.equal(f.calls.filter((c) => c.startsWith('layout')).length, 1);
});
