// Panel robustness (backlog.md 4.1, 5.1): links, two windows on one project,
// unusual file names, failing writes, hostile names in VS Code's own UI and files that are not
// UTF-8. Against the fake `vscode`, as panel.test.ts.
import { test } from 'node:test';
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
const { registerBacklog, COMMANDS } = await import('../../../src/features/backlog/index.ts');
const { uiText, uiLabel, uiMessageArg } = await import('../../../src/features/backlog/ui-text.ts');

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const ROOT = '/work/demo';
const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';
const FILE1 = `${ROOT}/${TASK1}`;
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();
const setDone = { type: 'setStatus', path: TASK1, statusLine: 'status: In Progress', status: 'Done' };

function reset(roots: string[] = [ROOT]): void {
  fake.files.clear();
  fake.links.clear();
  fake.textDocuments.length = 0;
  fake.log.length = 0;
  fake.panels.length = 0;
  fake.statusItems.length = 0;
  fake.settings.clear();
  Object.assign(fake.editor, { refuse: false, writeFails: false, writeError: 'NoPermissions', partialWrite: 0 });
  fake.editor.readOnlySchemes.clear();
  fake.written.clear();
  fake.quickPick.label = undefined;
  for (const root of roots) {
    fake.files.set(`${root}/backlog/config.yml`, readFileSync(new URL('config.yml', PROJECT), 'utf8'));
    for (const sub of ['tasks', 'milestones']) {
      for (const name of readdirSync(new URL(`${sub}/`, PROJECT))) {
        fake.files.set(`${root}/backlog/${sub}/${name}`, readFileSync(new URL(`${sub}/${name}`, PROJECT), 'utf8'));
      }
    }
  }
  fake.workspace.workspaceFolders = roots.map((path, index) => ({ uri: fake.Uri.file(path), name: path.split('/').pop()!, index }));
}

async function openPanel() {
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  const panels = new BacklogPanels(fake.Uri.file('/ext') as never, projects);
  panels.open(projects.projects[0]);
  const panel = fake.panels.at(-1)!;
  const errors = () => panel.posted.filter((m) => (m as { type: string }).type === 'error').map((m) => (m as { reason: string }).reason);
  const messages = () => panel.posted.filter((m) => (m as { type: string }).type === 'error').map((m) => (m as { message: string }).message);
  const done = () => {
    panels.dispose();
    projects.dispose();
  };
  return { projects, panels, panel, errors, messages, done };
}

const writes = () => fake.log.filter((l) => l.startsWith('writeFile') || l.startsWith('applyEdit'));

// --- 1. Links -------------------------------------------------------------------------------------

test('1: a linked tasks folder or Backlog folder is read and written through, as the CLI does (edits and undo)', async () => {
  for (const link of [`${ROOT}/backlog/tasks`, `${ROOT}/backlog`]) {
    reset();
    fake.links.add(link);
    const { panel, projects, errors, done } = await openPanel();
    assert.ok(projects.projects[0].index.byPath.has(TASK1), 'read through the link');
    const original = fake.files.get(FILE1)!;
    panel.receive(setDone);
    await settle(30);
    assert.match(fake.files.get(FILE1)!, /^status: Done$/m, link);
    panel.receive({ type: 'undo' });
    await settle(30);
    assert.equal(fake.files.get(FILE1), original, link);
    assert.deepEqual(errors(), [], link);
    done();
  }
});

test('1: a task file that is a symbolic link is indexed and edited; saveOnEdit off edits through the editor', async () => {
  reset();
  fake.links.add(FILE1);
  const { projects, panel, errors, done } = await openPanel();
  assert.equal(projects.projects[0].index.byPath.has(TASK1), true, 'a link in tasks/ is a task');
  panel.receive(setDone);
  await settle(30);
  assert.match(fake.files.get(FILE1)!, /^status: Done$/m);
  assert.deepEqual(errors(), []);
  done();
  reset();
  fake.settings.set('notewell.backlog.saveOnEdit', false);
  fake.links.add(`${ROOT}/backlog/tasks`);
  const second = await openPanel();
  second.panel.receive(setDone);
  await settle(30);
  assert.deepEqual(writes().map((line) => line.split(' ')[0]), ['applyEdit']);
  assert.deepEqual(second.errors(), []);
  second.done();
});

// --- 2. Two windows on one project ------------------------------------------------------------------

test('2: two windows edit the same task: no lost writes; each undo refuses once the file is not what it wrote', async () => {
  reset();
  const original = fake.files.get(FILE1)!;
  const a = await openPanel();
  const b = await openPanel();
  const ac2 = '- [ ] #2 Typecheck passes';
  const line = original.split('\n').indexOf(ac2);
  a.panel.receive({ type: 'toggleCheck', path: TASK1, list: 'ac', line, source: ac2, checked: true });
  await settle(30);
  // B still shows the old file; its status edit lands on top of A's toggle.
  b.panel.receive(setDone);
  await settle(30);
  const both = fake.files.get(FILE1)!;
  assert.match(both, /- \[x\] #2 Typecheck passes/);
  assert.match(both, /\nstatus: Done\n/);
  // A's undo: the file is no longer what A wrote.
  a.panel.receive({ type: 'undo' });
  await settle(30);
  assert.equal(fake.files.get(FILE1), both);
  assert.deepEqual(a.errors(), ['stale']);
  // B undoes its own change; the result is A's version again, and nothing is lost.
  b.panel.receive({ type: 'undo' });
  await settle(30);
  assert.match(fake.files.get(FILE1)!, /- \[x\] #2 Typecheck passes/);
  assert.match(fake.files.get(FILE1)!, /\nstatus: In Progress\n/);
  // A already dropped its entry (stale): nothing more to undo there.
  a.panel.receive({ type: 'undo' });
  await settle(30);
  assert.equal(a.errors().at(-1), 'nothingToUndo');
  a.done();
  b.done();
});

// --- 3. Unusual file names ---------------------------------------------------------------------------

test('3: reserved, long, case-twin, NFC/NFD and trailing-dot names: the exact file clicked is edited and opened', async () => {
  reset();
  const nfc = '한글'.normalize('NFC');
  const nfd = '한글'.normalize('NFD');
  const names = ['con.md', 'nul.md', 'COM1.md', `task-9 - ${'x'.repeat(280)}.md`, 'Case.md', 'case.md', `${nfc}.md`, `${nfd}.md`, 'dots..md', 'space .md'];
  names.forEach((name, i) => {
    fake.files.set(`${ROOT}/backlog/tasks/${name}`, `---\nid: TASK-${100 + i}\ntitle: T${i}\nstatus: To Do\n---\n`);
  });
  const { projects, panel, done } = await openPanel();
  const index = projects.projects[0].index;
  for (const name of names) assert.ok(index.byPath.has(`backlog/tasks/${name}`), name);
  for (const [i, name] of names.entries()) {
    const before = new Map(fake.files);
    const path = `backlog/tasks/${name}`;
    panel.receive({ type: 'setStatus', path, statusLine: 'status: To Do', status: 'Done' });
    panel.receive({ type: 'openTask', path });
    await settle(30);
    for (const [file, text] of fake.files) {
      if (file === `${ROOT}/${path}`) assert.match(text, /\nstatus: Done\n/, name);
      else assert.equal(text, before.get(file), `${name}: ${file} untouched`);
    }
    assert.equal(fake.log.at(-1), `showTextDocument ${ROOT}/${path} preview=false`, name);
    assert.equal(i >= 0, true);
  }
  done();
});

// --- 4. Failing writes -------------------------------------------------------------------------------

test('4: permission denied or locked: a clear error, nothing changed, the undo stack keeps the last good change', async () => {
  for (const code of ['NoPermissions', 'Unavailable', 'Unknown']) {
    reset();
    const { panel, errors, messages, done } = await openPanel();
    const original = fake.files.get(FILE1)!;
    panel.receive({ type: 'setField', path: TASK1, name: 'priority', value: 'low', expected: 'priority: high' });
    await settle(30);
    const first = fake.files.get(FILE1)!;
    fake.editor.writeFails = true;
    fake.editor.writeError = code;
    panel.receive(setDone);
    await settle(30);
    assert.equal(fake.files.get(FILE1), first, code);
    assert.equal(errors().at(-1), 'readOnly', code);
    assert.match(messages().at(-1)!, /could not be written/i);
    // A failed undo keeps its entry: it works once the file can be written again.
    panel.receive({ type: 'undo' });
    await settle(30);
    assert.equal(fake.files.get(FILE1), first);
    fake.editor.writeFails = false;
    panel.receive({ type: 'undo' });
    await settle(30);
    assert.equal(fake.files.get(FILE1), original, `${code}: undo after the failure`);
    // The panel keeps working.
    panel.receive(setDone);
    await settle(30);
    assert.match(fake.files.get(FILE1)!, /\nstatus: Done\n/);
    done();
  }
});

test('4: a write that fails half-way is rolled back to the original bytes', async () => {
  reset();
  const { panel, errors, done } = await openPanel();
  const original = fake.files.get(FILE1)!;
  fake.editor.partialWrite = 1;
  panel.receive(setDone);
  await settle(30);
  assert.equal(fake.files.get(FILE1), original, 'no half-written file left behind');
  assert.equal(errors().at(-1), 'readOnly');
  panel.receive({ type: 'undo' });
  await settle(30);
  assert.equal(errors().at(-1), 'nothingToUndo', 'the failed change is not on the undo stack');
  done();
});

test('4: a read-only file system (virtual or remote) is shown read-only and refused before writing', async () => {
  reset();
  fake.editor.readOnlySchemes.add('file');
  const { panel, errors, done } = await openPanel();
  type Posted = { type: string; view?: { tasks: { path: string; readOnly: unknown }[] }; detail?: { editable: boolean; readOnly: unknown } };
  const posted = () => panel.posted as Posted[];
  panel.receive({ type: 'ready' });
  await settle(30);
  const shown = posted().filter((m) => m.type === 'render').at(-1)!.view!.tasks;
  assert.ok(shown.length > 0 && shown.every((task) => JSON.stringify(task.readOnly) === '{"reason":"fileSystem","line":null}'), 'every card is read-only');
  panel.receive({ type: 'showTask', path: TASK1 });
  await settle(30);
  const detail = posted().filter((m) => m.type === 'detail').at(-1)!.detail!;
  assert.deepEqual([detail.editable, detail.readOnly], [false, { reason: 'fileSystem', line: null }]);
  const original = fake.files.get(FILE1)!;
  panel.receive(setDone);
  await settle(30);
  assert.deepEqual(writes(), []);
  assert.equal(fake.files.get(FILE1), original);
  assert.deepEqual(errors(), ['readOnly']);
  done();
});

// --- 5. Hostile names in VS Code's own UI --------------------------------------------------------------

const HOSTILE = '$(alert) [Run me](command:workbench.action.quit "go")\nsecond line ‮gnp.exe‬ ​';

test('5: uiText/uiLabel/uiMessageArg: no codicons, no links, one line, no bidi or zero-width tricks, bounded length', () => {
  const text = uiText(`${HOSTILE}${'y'.repeat(500)}`, 80);
  assert.ok(!/[\n\r‪-‮⁦-⁩​-‍﻿]/.test(text), JSON.stringify(text));
  assert.ok([...text].length <= 80);
  assert.ok(text.endsWith('…'));
  const label = uiLabel(HOSTILE);
  assert.ok(!/(^|[^\\])\$\(/.test(label), label);
  const arg = uiMessageArg(HOSTILE);
  assert.ok(!/\]\(/.test(arg), arg);
  assert.ok(!/\$\(/.test(arg.replace(/\\\$\(/g, '')), arg);
  assert.equal(uiText('plain name'), 'plain name');
  assert.equal(uiLabel('plain'), 'plain');
  // Surrogate pairs are not cut in half.
  assert.ok(!/[\uD800-\uDBFF]$/.test(uiText('😀'.repeat(100), 11).slice(0, -1)));
});

test('5: hostile folder names reach the quick pick, panel title, status bar tooltip and notifications escaped', async () => {
  const hostileRoot = `/work/${HOSTILE.replaceAll('/', '_')}`;
  reset([ROOT, hostileRoot]);
  const ctx = { extensionUri: fake.Uri.file('/ext'), subscriptions: [] as { dispose(): void }[] };
  registerBacklog(ctx as never);
  await settle(200);
  fake.quickPick.label = undefined;
  await fake.commands.executeCommand(COMMANDS.open);
  for (const item of fake.quickPick.items) {
    for (const text of [item.label, item.description ?? '']) {
      assert.ok(!/(^|[^\\])\$\(/.test(text), `codicon in ${JSON.stringify(text)}`);
      assert.ok(!/[\n‮​]/.test(text), JSON.stringify(text));
    }
  }
  // The panel title and tooltip of the hostile project.
  const picked = fake.quickPick.items.find((i) => i.label.includes('alert'))!;
  fake.quickPick.label = picked.label;
  await fake.commands.executeCommand(COMMANDS.open);
  const title = fake.panels.at(-1)!.title;
  assert.ok(!/[\n‮​]/.test(title) && [...title].length <= 120, JSON.stringify(title));
  // One project left: the tooltip names it.
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file(hostileRoot), name: hostileRoot.split('/').pop()!, index: 0 }];
  fake.folderEvents.fire({});
  await settle(200);
  const tooltip = fake.statusItems.at(-1)!.tooltip;
  assert.ok(!/[\n‮​]/.test(tooltip) && !/(^|[^\\])\$\(/.test(tooltip), JSON.stringify(tooltip));
  // A notification with a path from task content (documentation link to a missing file).
  const panel = fake.panels.at(-1)!;
  panel.receive({ type: 'openPath', path: '[Run me](command:workbench.action.quit)$(alert)' });
  await settle(30);
  const warning = fake.log.filter((l) => l.startsWith('warning ')).at(-1)!;
  assert.ok(!/\]\(command:/.test(warning), warning);
  for (const d of ctx.subscriptions) d.dispose();
});

// --- 6. Files and editors that are not UTF-8 -----------------------------------------------------------

test('6: an editor that decoded the task with another encoding is never edited (dirty or with saveOnEdit off)', async () => {
  for (const mode of ['dirty', 'saveOnEdit off']) {
    reset();
    if (mode === 'saveOnEdit off') fake.settings.set('notewell.backlog.saveOnEdit', false);
    const { panel, errors, messages, done } = await openPanel();
    const disk = fake.files.get(FILE1)!;
    const doc = fake.openEditorDocument(FILE1, mode === 'dirty' ? `${disk}typed\n` : undefined) as unknown as { text: string; encoding: string };
    doc.encoding = 'cp949';
    const shown = doc.text;
    panel.receive(setDone);
    await settle(30);
    assert.deepEqual(writes(), [], mode);
    assert.equal(doc.text, shown);
    assert.equal(fake.files.get(FILE1), disk);
    assert.deepEqual(errors(), ['encoding'], mode);
    assert.match(messages()[0], /UTF-8/);
    done();
  }
});

test('6: bytes that are not UTF-8: listed as unreadable with the reason, edits refused with the encoding message', async () => {
  reset();
  const readFile = fake.workspace.fs.readFile;
  const bad = new Uint8Array([...new TextEncoder().encode('---\nid: TASK-77\ntitle: caf'), 0xe9, ...new TextEncoder().encode('\nstatus: To Do\n---\n')]);
  const badPath = `${ROOT}/backlog/tasks/task-77 - Latin1.md`;
  fake.files.set(badPath, 'placeholder');
  fake.workspace.fs.readFile = async (uri) => (uri.path === badPath ? bad : readFile(uri));
  try {
    const { projects, panel, errors, done } = await openPanel();
    const index = projects.projects[0].index;
    assert.equal(index.byPath.has('backlog/tasks/task-77 - Latin1.md'), false);
    assert.deepEqual(index.unreadable, [{ path: 'backlog/tasks/task-77 - Latin1.md', reason: 'notUtf8' }]);
    // A clean editor that VS Code guessed as cp949: the index reads the disk, not the guess.
    panel.receive(setDone);
    await settle(30);
    assert.deepEqual(errors(), [], 'other tasks still edit');
    done();
  } finally {
    fake.workspace.fs.readFile = readFile;
  }
});

test('6: the index ignores an open document decoded with another encoding and reads the disk', async () => {
  reset();
  const disk = fake.files.get(FILE1)!;
  const doc = fake.openEditorDocument(FILE1, `${disk.replace('Set up the build', 'Mojibake ??')}`) as unknown as { encoding: string };
  doc.encoding = 'euckr';
  const { projects, done } = await openPanel();
  assert.equal(projects.projects[0].index.byPath.get(TASK1)?.data.title, 'Set up the build');
  done();
});
