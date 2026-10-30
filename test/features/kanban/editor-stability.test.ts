// The board adapter against a fake `vscode` under hostile timing (kanban.md 4.3, 5): the board
// and a text editor on the same document, typing while a board request is applied, two boards
// on one document, and a file closed, moved or deleted while its board is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE_VSCODE = new URL('./editor-fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context)),
});

const fake = await import('./editor-fake-vscode.ts');
const { KanbanEditorProvider } = await import('../../../src/features/kanban/editor.ts');
const { hasKanbanFrontmatter } = await import('../../../src/features/kanban/detect.ts');

type VsUri = import('vscode').Uri;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const BOARD = '---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] one\n- [ ] two\n';
const EXT = fake.Uri.file('/ext') as unknown as VsUri;
const PATH = '/ws/board.md';

async function openPanel(doc: ReturnType<typeof fake.makeDocument>) {
  const panel = fake.makePanel();
  await new KanbanEditorProvider(EXT, { vaults: () => undefined }).resolveCustomTextEditor(doc as never, panel as never);
  return panel;
}

function setup(text = BOARD) {
  fake.reset();
  fake.state.existing.add(PATH);
  return fake.makeDocument(PATH, text);
}

const reasons = (panel: ReturnType<typeof fake.makePanel>) =>
  panel.posted.flatMap((m) => ((m as { type: string }).type === 'error' ? [(m as { reason: string }).reason] : []));
const toggleOne = (version: number) => ({ type: 'toggleCard', version, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' });

// 1. Board and text editor on one document.
test('case 1: typing in the text editor while a board request is being applied: the edit is not sent', async () => {
  const doc = setup();
  const panel = await openPanel(doc);
  // The text editor changes the document while the board computes its edit (each read sees a newer version).
  const read = doc.getText;
  doc.getText = () => {
    const text = read();
    doc.version++;
    return text;
  };
  panel.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 0, 'an edit computed for an older version is never applied');
  assert.equal(doc.saves, 0);
  assert.ok(reasons(panel).length === 1 && ['stale', 'failed'].includes(reasons(panel)[0]!));
});

test('case 1: two boards on the same document: the second request built on the old version is refused', async () => {
  const doc = setup();
  const a = await openPanel(doc);
  const b = await openPanel(doc);
  fake.state.acceptEdits = true;
  a.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 1);
  doc.version++; // the edit landed
  b.send({ type: 'deleteCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' });
  await settle();
  assert.equal(fake.state.applied.length, 1);
  assert.deepEqual(reasons(b), ['stale']);
});

// 3. File closed, moved or deleted while the board is open.
test('case 3: a closed document (file renamed or moved away) is never edited or saved again', async () => {
  const doc = setup();
  const panel = await openPanel(doc);
  (doc as { isClosed?: boolean }).isClosed = true;
  panel.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 0, 'no edit that would reopen the old path');
  assert.equal(doc.saves, 0, 'no save that would recreate it');
  assert.deepEqual(reasons(panel), ['gone']);
});

test('case 3: a file deleted on disk while its board is open is not recreated by a board request', async () => {
  const doc = setup();
  const panel = await openPanel(doc);
  fake.state.existing.delete(PATH);
  panel.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 0);
  assert.equal(doc.saves, 0);
  assert.deepEqual(reasons(panel), ['gone']);
});

test('case 3: only a real kanban-plugin key in the frontmatter makes a board', () => {
  const yes = [
    '---\nkanban-plugin: basic\n---\n',
    '---\r\nkanban-plugin: board\r\n---\r\n## A\r\n',
    '﻿---\nkanban-plugin: basic\n---\n',
    '---\ntitle: x\nkanban-plugin:   basic\n---\n',
  ];
  const no = [
    '# Note\n\nkanban-plugin: basic\n',
    '```\n---\nkanban-plugin: basic\n---\n```\n',
    'text\n---\nkanban-plugin: basic\n---\n',
    '---\nkanban-plugin: basic\n', // never closed
    '---\n  kanban-plugin: basic\n---\n',
    '---\n# kanban-plugin: basic\n---\n',
    '---\nkanban-plugin-x: basic\n---\n',
    '---\nnote: |\n  kanban-plugin: basic\n---\n',
    '---\nnotes: "kanban-plugin: basic"\n---\n',
    '',
    '---',
  ];
  for (const text of yes) assert.equal(hasKanbanFrontmatter(text), true, JSON.stringify(text));
  for (const text of no) assert.equal(hasKanbanFrontmatter(text), false, JSON.stringify(text));
});

// 6. Documents VS Code did not read as UTF-8 (files.encoding, autoGuessEncoding).
test('case 6: a board whose document was decoded with another encoding is never edited or saved', async () => {
  for (const encoding of ['cp949', 'euckr', 'shiftjis', 'gbk', 'windows1252', 'utf16le']) {
    const doc = setup();
    (doc as { encoding?: string }).encoding = encoding;
    const panel = await openPanel(doc);
    panel.send(toggleOne(1));
    await settle();
    assert.equal(fake.state.applied.length, 0, encoding);
    assert.equal(doc.saves, 0, encoding);
    assert.deepEqual(reasons(panel), ['encoding'], encoding);
  }
  for (const encoding of ['utf8', 'utf8bom']) {
    const doc = setup();
    (doc as { encoding?: string }).encoding = encoding;
    const panel = await openPanel(doc);
    panel.send(toggleOne(1));
    await settle();
    assert.equal(fake.state.applied.length, 1, encoding);
  }
});

// Round 6 case 2: the board closes while a request is pending (delete question open).
test('round 6: a board closed while its delete question is open: no crash, no message to the gone webview', async () => {
  const doc = setup();
  const panel = await openPanel(doc);
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => void rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const realWarning = fake.window.showWarningMessage;
  fake.window.showWarningMessage = async (...args: unknown[]) => {
    // The user closes the board tab while the modal is open; the webview is gone.
    panel.close();
    panel.webview.postMessage = () => {
      throw new Error('Webview is disposed');
    };
    return realWarning.apply(fake.window, args as never) as never;
  };
  fake.state.warningAnswer = 'Delete';
  try {
    panel.send({ type: 'deleteCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' });
    await settle(20);
    // A second request from the (now closed) board is ignored too.
    panel.send(toggleOne(1));
    await settle(20);
  } finally {
    fake.window.showWarningMessage = realWarning;
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, [], 'no unhandled rejection');
  assert.equal(fake.state.applied.length, 0, 'a closed board changes nothing');
});

// Round 10: settings changed while a board is open.
test('round 10: turning the board off (notewell.kanban.enabled) stops an open board from writing at once', async () => {
  const doc = setup();
  const panel = await openPanel(doc);
  fake.state.settings.set('notewell.kanban.enabled', false);
  panel.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 0);
  assert.equal(doc.saves, 0);
  assert.deepEqual(reasons(panel), ['disabled']);
  fake.state.settings.set('notewell.kanban.enabled', true);
  panel.send(toggleOne(1));
  await settle();
  assert.equal(fake.state.applied.length, 1, 'works again when turned back on');
});
