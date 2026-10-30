// End-to-end: the payload the webview builds -> validateWebviewMessage -> BacklogSession -> panel
// ports (fake vscode) -> bytes on disk, compared with what Backlog.md 1.54.0 writes for the same
// operation (ops/*.after.md), on every write path (backlog.md 5.1). After each write the index
// must refresh and the next detail must show the new file.
import { test, mock } from 'node:test';
import { whenQuiet } from '../../../src/features/backlog/quiescence.ts';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';

const FAKE_VSCODE = new URL('./fake-vscode-panel.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./fake-vscode-panel.ts');
const { BacklogProjects } = await import('../../../src/features/backlog/project.ts');
const { BacklogPanels } = await import('../../../src/features/backlog/panel.ts');
const { validateWebviewMessage } = await import('../../../src/features/backlog/messages.ts');
const edit = await import('../../../src/features/backlog/browser/detail-edit.ts');
import type { TaskDetail } from '../../../src/features/backlog/view.ts';

const fixtures = new URL('../../fixtures/backlog/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, fixtures), 'utf8');
const ROOT = '/work/demo';
const PATH = 'backlog/tasks/target.md';
const FILE = `${ROOT}/${PATH}`;
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();

type WritePath = 'direct' | 'dirty editor' | 'clean editor (late reload, missed watcher)';
const PATHS: WritePath[] = ['direct', 'dirty editor', 'clean editor (late reload, missed watcher)'];

/** The fixture project, with `target` as the file under test (other files with its ID left out). */
function setupFiles(target: string): void {
  fake.files.clear();
  fake.textDocuments.length = 0;
  fake.log.length = 0;
  fake.panels.length = 0;
  fake.settings.clear();
  Object.assign(fake.editor, { refuse: false, writeFails: false, lateReload: false, watcherMisses: false });
  fake.written.clear();
  const id = /^id: (.*)$/m.exec(target)![1];
  fake.files.set(`${ROOT}/backlog/config.yml`, read('project/config.yml'));
  for (const name of readdirSync(new URL('project/milestones/', fixtures))) fake.files.set(`${ROOT}/backlog/milestones/${name}`, read(`project/milestones/${name}`));
  for (const name of readdirSync(new URL('project/tasks/', fixtures))) {
    const text = read(`project/tasks/${name}`);
    if (/^id: (.*)$/m.exec(text)![1] !== id) fake.files.set(`${ROOT}/backlog/tasks/${name}`, text);
  }
  fake.files.set(FILE, target);
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file(ROOT), name: 'demo', index: 0 }];
}

async function openPanel(target: string, path: WritePath) {
  setupFiles(target);
  if (path === 'dirty editor') {
    // The user has typed in the editor (nothing that changes the task), so the edit goes there.
    fake.openEditorDocument(FILE, target.replace(/^﻿/, ''));
  } else if (path !== 'direct') {
    fake.openEditorDocument(FILE);
    Object.assign(fake.editor, { lateReload: true, watcherMisses: true });
  }
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels[0];
  const send = async (message: unknown) => {
    assert.ok(validateWebviewMessage(message).ok, `invalid payload ${JSON.stringify(message)}`);
    panel.receive(message);
    await settle();
  };
  await send({ type: 'ready' });
  await send({ type: 'showTask', path: PATH });
  /** The detail the webview shows now (the last one posted for the task). */
  const detail = (): TaskDetail => {
    const last = panel.posted.filter((m) => (m as { type: string }).type === 'detail').at(-1) as { detail: TaskDetail };
    return last.detail;
  };
  const errors = () => panel.posted.filter((m) => (m as { type: string }).type === 'error');
  /** What the file holds now: the editor text on the dirty path, the disk bytes otherwise. */
  const fileText = (): string =>
    path === 'dirty editor' ? (fake.textDocuments.find((d) => d.uri.path === FILE)!.getText()) : fake.files.get(FILE)!;
  const done = () => {
    panels.dispose();
    projects.dispose();
  };
  return { panel, send, detail, errors, fileText, done };
}

/** The minute the CLI wrote, so updated_date comes out the same. */
function cliNow(after: string): number {
  const match = /^updated_date: '(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})'$/m.exec(after);
  if (!match) return Date.UTC(2027, 0, 1);
  const [, y, mo, d, h, mi] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
}

type Build = (detail: TaskDetail) => unknown;
const check = (list: 'ac' | 'dod', number: number, checked: boolean): Build => (d) => {
  const item = d[list]!.items.find((i) => i.number === number)!;
  return { type: 'toggleCheck', path: d.path, list, line: item.line, source: item.source, checked };
};
const field = (name: Parameters<typeof edit.setFieldMessage>[1], value: string): Build => (d) => edit.setFieldMessage(d, name, value);
const list = (name: Parameters<typeof edit.setListMessage>[1], values: (d: TaskDetail) => string[]): Build => (d) => edit.setListMessage(d, name, values(d));
const section = (name: Parameters<typeof edit.setSectionMessage>[1], text: string): Build => (d) => edit.setSectionMessage(d, name, text);
const comment = (text: string): Build => (d) => edit.addCommentMessage(d, text);
const current = (d: TaskDetail, name: string): string[] => {
  const source = d.fieldSources[name];
  return source === null ? [] : source.split('\n').slice(1).map((line) => line.replace(/^\s*- /, '').replace(/^'(.*)'$/, '$1'));
};

/** Every CLI oracle pair with the webview payload for the same operation. */
const CASES: Record<string, Build> = {
  status: (d) => ({ type: 'setStatus', path: d.path, statusLine: d.statusLine, status: 'Done' }),
  noupdated: (d) => ({ type: 'setStatus', path: d.path, statusLine: d.statusLine, status: 'In Progress' }),
  check: check('ac', 2, true),
  uncheck: check('ac', 1, false),
  dod: check('dod', 1, true),
  'uncheck-dod': check('dod', 1, false),
  'field-title': field('title', 'New: title'),
  'field-title-plain': field('title', 'Parser v2'),
  'field-priority-add': field('priority', 'high'),
  'field-priority-change': field('priority', 'low'),
  'field-type-add': field('type', 'bug'),
  'field-type-clear': field('type', ''),
  'field-milestone-add': field('milestone', 'm-0'),
  'field-milestone-clear': field('milestone', ''),
  'field-due-add': field('due_date', '2026-12-01'),
  'field-due-change': field('due_date', '2027-01-15'),
  'field-due-clear': field('due_date', ''),
  'field-assignee-add': list('assignee', () => ['@carol']),
  'field-assignee-multi': list('assignee', (d) => [...current(d, 'assignee'), '@bob']),
  'field-assignee-clear': list('assignee', () => []),
  'field-label-add': list('labels', (d) => [...current(d, 'labels'), 'infra']),
  'field-label-remove': list('labels', (d) => current(d, 'labels').filter((l) => l !== 'build')),
  'field-labels-clear': list('labels', () => []),
  'field-label-first': list('labels', () => ['needs: review']),
  'field-dep-add': list('dependencies', () => ['TASK-1']),
  'field-dep-clear': list('dependencies', () => []),
  'field-ref-add': list('references', () => ['https://example.com/a']),
  'field-ref-remove': list('references', () => []),
  'field-doc-add': list('documentation', () => ['docs/a.md']),
  'field-doc-clear': list('documentation', () => []),
  'field-modified-add': list('modified_files', () => ['src/a.ts']),
  'section-desc-change': section('description', 'New description.'),
  'section-desc-multi': section('description', 'Line one\n\n- item\n\nLine two'),
  'section-desc-add': section('description', 'Fresh.'),
  'section-desc-before': section('description', 'Inserted before AC.'),
  'section-plan-add': section('plan', '1. Step'),
  'section-plan-change': section('plan', 'New plan'),
  'section-plan-empty': section('plan', ''),
  'section-notes-add': section('notes', 'Note.'),
  'section-notes-add-min': section('notes', 'N.'),
  'section-notes-change': section('notes', 'Changed'),
  'section-notes-empty': section('notes', ''),
  'section-notes-padded': section('notes', '\n\n  padded line  \n\nsecond\n\n'),
  'section-final-add': section('finalSummary', 'Done.'),
  'section-final-change': section('finalSummary', 'Shipped v2.'),
  'section-final-clear': section('finalSummary', ''),
  'section-comment-add-new': comment('Second'),
  'section-comment-first': comment('First'),
  'section-comment-multi': comment('a\n\nb'),
  'section-comment-padded': comment('\n  padded  \n\n'),
};

// Not reproducible by design: Notewell writes no comment author, and keeps earlier comments as
// they are where CLI 1.54.0 rewrites them (section-ops.test.ts checks both); ordinal pairs come
// from `--ordinal`, which has no webview equivalent (moves are checked below).
const NOT_COVERED = new Set(['section-comment-author', 'section-comment-add','ordinal-add', 'ordinal-change', 'ordinal-decimal', 'ordinal-zero']);

test('every CLI oracle pair has an end-to-end case', () => {
  const names = [...new Set(readdirSync(new URL('ops/', fixtures)).map((n) => n.replace(/\.(before|after)\.md$/, '')))];
  assert.deepEqual(names.filter((n) => !NOT_COVERED.has(n)).sort(), Object.keys(CASES).sort());
});

for (const path of PATHS) {
  test(`end to end (${path}): every operation matches the CLI byte for byte, and the next detail shows it`, async () => {
    for (const [name, build] of Object.entries(CASES)) {
      const before = read(`ops/${name}.before.md`);
      const after = read(`ops/${name}.after.md`);
      mock.timers.enable({ apis: ['Date'], now: cliNow(after) + 30_000 });
      try {
        const run = await openPanel(before, path);
        const message = build(run.detail());
        assert.ok(message, `${name}: the webview builds a message`);
        await run.send(message);
        await settle(path === 'direct' ? 120 : 450);
        assert.deepEqual(run.errors(), [], `${name}: no error`);
        const expected = path === 'dirty editor' ? after.replace(/^﻿/, '') : after;
        assert.equal(run.fileText(), expected, `${name} (${path}): file content`);
        if (path !== 'dirty editor') assert.ok(!fake.log.some((l) => l.startsWith('save ')), `${name}: never document.save`);
        // The detail the user sees next is built from the new file.
        const shown = run.detail();
        const fresh = (await import('../../../src/features/backlog/task-file.ts')).taskData(
          (await import('../../../src/core/lines.ts')).lineTexts((await import('../../../src/core/lines.ts')).parseLines(after)),
        );
        assert.deepEqual(
          [shown.status, shown.title, shown.notes, shown.plan, shown.description, shown.ac?.items.map((i) => i.checked), shown.dod?.items.map((i) => i.checked), shown.labels],
          [fresh.status, fresh.title, fresh.notes, fresh.plan, fresh.description, fresh.ac?.items.map((i) => i.checked), fresh.dod?.items.map((i) => i.checked), fresh.labels],
          `${name} (${path}): the detail is refreshed`,
        );
        run.done();
      } finally {
        mock.timers.reset();
      }
    }
  });
}

for (const path of PATHS) {
  test(`user sequence (${path}): check then uncheck the same item with the detail open; two notes edits; undo`, async () => {
    const source = read('project/tasks/task-1 - Set-up-the-build.md');
    const run = await openPanel(source, path);
    const wait = () => settle(path === 'direct' ? 120 : 450);
    await run.send(check('ac', 2, true)(run.detail()));
    await wait();
    assert.equal(run.detail().ac!.items[1].checked, true, 'checked shows');
    await run.send(check('ac', 2, false)(run.detail()));
    await wait();
    assert.deepEqual(run.errors(), []);
    assert.equal(run.detail().ac!.items[1].checked, false, 'unchecked shows');
    assert.match(run.fileText(), /\n- \[ \] #2 Typecheck passes\n/, 'the file is unchecked');
    for (const text of ['First notes edit', 'Second notes edit']) {
      await run.send(section('notes', text)(run.detail()));
      await wait();
      assert.equal(run.detail().notes, text, `the detail shows "${text}"`);
    }
    assert.deepEqual(run.errors(), []);
    for (let i = 0; i < 4; i++) {
      await run.send({ type: 'undo' });
      await wait();
    }
    assert.deepEqual(run.errors(), []);
    assert.equal(run.fileText(), path === 'dirty editor' ? source : source);
    assert.equal(run.detail().notes, 'Started with esbuild.');
    run.done();
  });
}

test('move in column (direct): only the ordinal changes and the board shows the new order', async () => {
  const source = read('project/tasks/task-6 - Minimal.md');
  const run = await openPanel(source, 'direct');
  const render = () => (run.panel.posted.filter((m) => (m as { type: string }).type === 'render').at(-1) as { view: { tasks: { path: string; status: string; ordinal: number | null }[] } }).view;
  const todo = () => render().tasks.filter((t) => t.status === 'To Do');
  const order = todo().map((t) => t.path);
  assert.equal(order.at(-1), PATH);
  await run.send({ type: 'moveInColumn', path: PATH, fromStatus: 'To Do', beforePath: order[0] });
  await settle();
  assert.deepEqual(run.errors(), []);
  assert.equal(todo()[0].path, PATH, 'moved to the top');
  const changed = run.fileText().split('\n').filter((line, i) => line !== source.split('\n')[i]);
  assert.equal(changed.length, 1);
  assert.match(changed[0], /^ordinal: /);
  run.done();
});

test('archived tasks (backlog.md 3.1): the detail opens read-only, Open File works, forged writes change nothing', async () => {
  const run = await openPanel(read('project/tasks/task-6 - Minimal.md'), 'direct');
  const ARCHIVED = 'backlog/archive/tasks/task-40 - Old.md';
  const source = read('project/tasks/task-1 - Set-up-the-build.md').replace(/^id: TASK-1$/m, 'id: TASK-40');
  fake.files.set(`${ROOT}/${ARCHIVED}`, source);
  // A (re)loaded page rescans the project: the new archived file is read.
  await run.send({ type: 'ready' });
  await run.send({ type: 'showTask', path: ARCHIVED });
  const shown = run.detail();
  assert.deepEqual([shown.path, shown.id, shown.archived, shown.editable, shown.statusLine], [ARCHIVED, 'TASK-40', true, false, null]);
  await run.send({ type: 'openTask', path: ARCHIVED });
  assert.ok(fake.log.includes(`showTextDocument ${ROOT}/${ARCHIVED} preview=false`), 'Open File opens the archived file');
  // A webview that ignored `editable` (or a forged message) still cannot write the file.
  const item = shown.ac!.items[0];
  const forged: unknown[] = [
    { type: 'setStatus', path: ARCHIVED, statusLine: 'status: In Progress', status: 'Done' },
    { type: 'toggleCheck', path: ARCHIVED, list: 'ac', line: item.line, source: item.source, checked: !item.checked },
    edit.setFieldMessage(shown, 'title', 'Renamed'),
    edit.setSectionMessage(shown, 'notes', 'Changed'),
    edit.addCommentMessage(shown, 'Hello'),
  ];
  for (const message of forged) await run.send(message);
  assert.equal(fake.files.get(`${ROOT}/${ARCHIVED}`), source, 'the archived file is unchanged');
  assert.equal(run.errors().length, forged.length, 'each write is refused with an error');
  assert.deepEqual(fake.written.size, 0);
  run.done();
});
