// "New Kanban Board" against the fake vscode module (kanban.md 4.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE_VSCODE = new URL('./editor-fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./editor-fake-vscode.ts');
const { boardFileName, newBoard } = await import('../../../src/features/kanban/new-board.ts');
const { lineTexts, parseLines } = await import('../../../src/core/lines.ts');
const { parseBoard } = await import('../../../src/features/kanban/parser.ts');

const openWith = () => fake.state.executed.filter((c) => c[0] === 'vscode.openWith').map((c) => [(c[1] as { path: string }).path, c[2]]);

test('file names: .md added, folder separators and reserved names refused', () => {
  assert.equal(boardFileName('Kanban.md'), 'Kanban.md');
  assert.equal(boardFileName('  Sprint 3 '), 'Sprint 3.md');
  assert.equal(boardFileName('작업 보드'), '작업 보드.md');
  assert.equal(boardFileName('Plan.MD'), 'Plan.MD');
  for (const bad of ['', '   ', '.md', 'a/b', 'a\\b', '..', 'c:x', 'x?', 'a|b']) assert.equal(boardFileName(bad), undefined, bad);
});

test('from the explorer: one new file in that folder, opened as a board', async () => {
  fake.reset();
  fake.state.inputs = ['Kanban.md'];
  await newBoard(fake.Uri.file('/ws/projects'));
  assert.equal(fake.state.written.length, 1);
  assert.equal(fake.state.written[0]!.path, '/ws/projects/Kanban.md');
  const board = parseBoard(lineTexts(parseLines(fake.state.written[0]!.text)));
  assert.equal(board.isBoard, true);
  assert.deepEqual(board.lanes.map((l) => l.name), ['To Do', 'Doing', 'Done']);
  assert.deepEqual(openWith(), [['/ws/projects/Kanban.md', 'notewell.kanban']]);
  // Loaded as UTF-8 before the board opens it, whatever files.encoding says.
  assert.deepEqual(fake.state.openedDocuments, [{ path: '/ws/projects/Kanban.md', encoding: 'utf8' }]);
});

test('an existing name is never overwritten: the box rejects it and asks again', async () => {
  fake.reset();
  fake.state.existing.add('/ws/Kanban.md');
  fake.state.inputs = ['Kanban.md', 'Kanban 2'];
  await newBoard(fake.Uri.file('/ws'));
  assert.deepEqual(fake.state.validations, ['"Kanban.md" already exists. Choose another name.', undefined]);
  assert.deepEqual(fake.state.written.map((w) => w.path), ['/ws/Kanban 2.md']);
});

test('a file that appears between the check and the write is not overwritten either', async () => {
  fake.reset();
  fake.state.inputs = ['Race', 'Race 2'];
  // The first answer passes validation; the file then appears before the write.
  const original = fake.workspace.fs.stat;
  let calls = 0;
  fake.workspace.fs.stat = async (uri) => {
    calls++;
    if (uri.path === '/ws/Race.md' && calls === 2) fake.state.existing.add('/ws/Race.md');
    return original(uri);
  };
  try {
    await newBoard(fake.Uri.file('/ws'));
  } finally {
    fake.workspace.fs.stat = original;
  }
  assert.deepEqual(fake.state.written.map((w) => w.path), ['/ws/Race 2.md']);
  assert.equal(fake.state.warnings.length, 1);
});

test('invalid names are rejected in the box; cancel writes nothing', async () => {
  fake.reset();
  fake.state.inputs = ['../escape', undefined];
  await newBoard(fake.Uri.file('/ws'));
  assert.deepEqual(fake.state.validations, ['Enter a file name without folder separators or reserved characters.']);
  assert.deepEqual(fake.state.written, []);
  assert.deepEqual(openWith(), []);
});

test('from the palette: the active file\'s folder, else the first workspace folder, else a message', async () => {
  fake.reset();
  fake.window.activeTextEditor = { document: { uri: fake.Uri.file('/ws/notes/today.md') } };
  fake.state.inputs = ['Board'];
  try {
    await newBoard();
  } finally {
    fake.window.activeTextEditor = undefined;
  }
  assert.deepEqual(fake.state.written.map((w) => w.path), ['/ws/notes/Board.md']);

  fake.reset();
  fake.state.workspaceFolders = [{ uri: fake.Uri.file('/root') }];
  fake.state.inputs = ['Board'];
  await newBoard();
  assert.deepEqual(fake.state.written.map((w) => w.path), ['/root/Board.md']);

  fake.reset();
  await newBoard();
  assert.deepEqual(fake.state.written, []);
  assert.deepEqual(fake.state.info, ['Open a folder or workspace first to create a board.']);
});

test('works in an untrusted workspace; Korean lanes and the files.eol line ending', async () => {
  fake.reset();
  fake.state.workspaceTrusted = false;
  fake.env.language = 'ko';
  fake.state.settings.set('files.eol', '\r\n');
  fake.state.inputs = ['보드'];
  await newBoard(fake.Uri.file('/ws'));
  assert.equal(fake.state.written.length, 1);
  const text = fake.state.written[0]!.text;
  assert.ok(text.includes('## 할 일\r\n'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  const board = parseBoard(lineTexts(parseLines(text)));
  assert.deepEqual(board.lanes.map((l) => [l.name, l.done]), [['할 일', false], ['진행 중', false], ['완료', true]]);
});

test('round 4: Windows reserved names, trailing dots or spaces, hidden and overlong names are refused', () => {
  for (const name of ['CON', 'con.md', 'PRN', 'AUX.md', 'NUL', 'nul.txt', 'COM1', 'com9.md', 'LPT1', 'Lpt3.md', 'CONIN$', 'conout$.md', 'board.', 'board. ', '.hidden', '.kanban.md', 'x'.repeat(260)]) {
    assert.equal(boardFileName(name), undefined, JSON.stringify(name));
  }
  for (const name of ['Console', 'COM10', 'LPT', 'conference.md', 'my.board']) assert.notEqual(boardFileName(name), undefined, name);
});

test('round 5: a file created by another program between the last check and the write is never overwritten', async () => {
  fake.reset();
  fake.state.inputs = ['Race', 'Race 2'];
  // Every check finds the name free; the file appears just before the write.
  fake.state.beforeCreate = (path: string) => {
    if (path === '/ws/Race.md') {
      fake.state.existing.add(path);
      fake.state.written.push({ path, text: 'OBSIDIAN CONTENT' });
    }
  };
  await newBoard(fake.Uri.file('/ws'));
  assert.deepEqual(fake.state.written.filter((w) => w.path === '/ws/Race.md').map((w) => w.text), ['OBSIDIAN CONTENT'], 'never overwritten');
  assert.ok(fake.state.written.some((w) => w.path === '/ws/Race 2.md'), 'asked again and created the next name');
});
