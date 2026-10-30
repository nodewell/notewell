import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from '../../../src/core/lines.ts';
import { applyEdits, type TextEdit } from '../../../src/core/patch.ts';
import type { ExtensionMessage } from '../../../src/features/kanban/messages.ts';
import { BoardSession, type BoardSettings, type CardTextRange, type ErrorStrings } from '../../../src/features/kanban/session.ts';
import { DEFAULT_STRINGS } from '../../../src/features/kanban/view.ts';

const ERRORS: ErrorStrings = { stale: 'E-stale', invalid: 'E-invalid', unsafe: 'E-unsafe', failed: 'E-failed', unreadable: 'E-unreadable', gone: 'E-gone', encoding: 'E-encoding', disabled: 'E-disabled' };
const BOARD = '---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] one\n- [ ] two\n\n## Done\n\n**Complete**\n';

function setup(
  text: string,
  settings: Partial<BoardSettings> = {},
  accept = true,
  confirmDelete?: (title: string) => Promise<boolean>,
) {
  const state = { text, version: 1, saves: 0, applied: [] as TextEdit[][] };
  const posts: ExtensionMessage[] = [];
  const links: string[] = [];
  const session = new BoardSession({
    document: {
      text: () => state.text,
      version: () => state.version,
      applyEdits: async (edits) => {
        if (!accept) return false;
        state.applied.push([...edits]);
        state.text = applyEdits(parseLines(state.text), edits);
        state.version++;
        return true;
      },
      save: async () => void state.saves++,
    },
    host: { post: (m) => void posts.push(m), openLink: async (t) => void links.push(t) },
    settings: () => ({ doneLanes: [], saveOnEdit: true, useTab: true, ...settings }),
    strings: DEFAULT_STRINGS,
    errors: ERRORS,
    today: () => '2026-10-14',
    ...(confirmDelete === undefined ? {} : { confirmDelete }),
  });
  return { state, posts, links, session };
}

const toggle = (version: number, firstLine = '- [ ] one') => ({ type: 'toggleCard', version, laneIndex: 0, cardIndex: 0, firstLine });

test('ready renders the current document with its version', async () => {
  const { posts, session } = setup(BOARD);
  await session.handle({ type: 'ready' });
  assert.equal(posts.length, 1);
  const render = posts[0];
  assert.ok(render?.type === 'render');
  assert.equal(render.version, 1);
  assert.deepEqual(render.view.lanes.map((l) => l.name), ['Todo', 'Done']);
  assert.equal(render.view.lanes[1]?.done, true);
});

test('a toggle becomes a one-character edit and is saved', async () => {
  const { state, posts, session } = setup(BOARD);
  await session.handle(toggle(1));
  assert.deepEqual(state.applied, [[{ range: { start: { line: 6, character: 3 }, end: { line: 6, character: 4 } }, newText: 'x' }]]);
  assert.equal(state.text, BOARD.replace('- [ ] one', '- [x] one'));
  assert.equal(state.saves, 1);
  // The redraw comes from the document change event (editor.ts), not from the session.
  assert.deepEqual(posts, []);
});

test('saveOnEdit=false leaves the document unsaved', async () => {
  const { state, session } = setup(BOARD, { saveOnEdit: false });
  await session.handle(toggle(1));
  assert.equal(state.version, 2);
  assert.equal(state.saves, 0);
});

test('an outdated version is refused: no edit, redraw, then the stale notice', async () => {
  const { state, posts, session } = setup(BOARD);
  state.version = 5;
  await session.handle(toggle(4));
  assert.deepEqual(state.applied, []);
  assert.deepEqual(posts.map((p) => p.type), ['render', 'error']);
  assert.equal(posts[0]?.type === 'render' && posts[0].version, 5);
  assert.deepEqual(posts[1], { type: 'error', reason: 'stale', message: 'E-stale' });
});

test('a changed card is refused as stale', async () => {
  const { state, posts, session } = setup(BOARD);
  await session.handle(toggle(1, '- [ ] uno'));
  assert.deepEqual(state.applied, []);
  assert.deepEqual(posts.map((p) => (p.type === 'error' ? p.reason : p.type)), ['render', 'stale']);
});

test('two requests built on the same version: the second is stale', async () => {
  const { state, posts, session } = setup(BOARD);
  await Promise.all([session.handle(toggle(1)), session.handle({ ...toggle(1), cardIndex: 1, firstLine: '- [ ] two' })]);
  assert.equal(state.applied.length, 1);
  assert.deepEqual(posts.map((p) => (p.type === 'error' ? p.reason : p.type)), ['render', 'stale']);
});

test('malformed messages and invalid requests are refused without edits', async () => {
  const { state, posts, session } = setup(BOARD);
  await session.handle({ type: 'toggleCard', version: 1 });
  await session.handle({ type: 'nope' });
  await session.handle('text');
  await session.handle({ type: 'editCardText', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one', text: '   ' });
  assert.deepEqual(state.applied, []);
  assert.deepEqual(posts.map((p) => p.type === 'error' && p.reason), ['invalid', 'invalid', 'invalid', 'invalid']);
});

test('unsafe requests are refused with their own reason', async () => {
  const { state, posts, session } = setup('## A\n- [ ] a\n## B\n- [ ] open\n\t```\n\tcode\n');
  await session.handle({ type: 'addCard', version: 1, laneIndex: 1, heading: '## B', title: 'x' });
  assert.deepEqual(state.applied, []);
  assert.deepEqual(posts, [{ type: 'error', reason: 'unsafe', message: 'E-unsafe' }]);
});

test('an edit the editor refuses is reported as failed after a redraw', async () => {
  const { posts, session, state } = setup(BOARD, {}, false);
  await session.handle(toggle(1));
  assert.equal(state.saves, 0);
  assert.deepEqual(posts.map((p) => (p.type === 'error' ? p.reason : p.type)), ['render', 'failed']);
});

test('a move to the same place changes nothing', async () => {
  const { state, posts, session } = setup(BOARD);
  await session.handle({ type: 'moveCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one', toLaneIndex: 0, toHeading: '## Todo', toIndex: 0 });
  assert.deepEqual(state.applied, []);
  assert.equal(state.saves, 0);
  assert.deepEqual(posts, []);
});

test('moving into the done lane checks the card; doneLanes setting is used', async () => {
  const { state, session } = setup(BOARD);
  await session.handle({ type: 'moveCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one', toLaneIndex: 1, toHeading: '## Done', toIndex: 0 });
  // Empty lane with a **Complete** line: right after it, so the mark stays before the list (kanban.md 4.1, 2.7).
  assert.ok(state.text.endsWith('## Done\n\n**Complete**\n- [x] one\n'));
  const named = setup('## A\n- [ ] a\n## 완료\n', { doneLanes: ['완료'] });
  await named.session.handle({ type: 'moveCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] a', toLaneIndex: 1, toHeading: '## 완료', toIndex: 0 });
  assert.equal(named.state.text, '## A\n## 완료\n\n- [x] a\n');
});

test('openLink goes to the host; nothing is edited', async () => {
  const { state, links, session } = setup(BOARD);
  await session.handle({ type: 'openLink', target: '폴더/노트' });
  assert.deepEqual(links, ['폴더/노트']);
  assert.deepEqual(state.applied, []);
});

test('a file without frontmatter or lanes still renders (empty board)', async () => {
  const { posts, session } = setup('just text\n');
  await session.handle({ type: 'ready' });
  const render = posts[0];
  assert.ok(render?.type === 'render');
  assert.equal(render.view.isBoard, false);
  assert.deepEqual(render.view.lanes, []);
});

// --- multi-line card edit (kanban.md 4.4) ---

const editMessage = (text: string) => ({ type: 'editCardText', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one', text });
test('editCardText goes through validation, plan, patch and save, with the vault useTab', async () => {
  const tabs = setup(BOARD);
  await tabs.session.handle(editMessage('one\nnew line'));
  assert.ok(tabs.state.text.includes('- [ ] one\n\tnew line\n- [ ] two'));
  assert.equal(tabs.state.saves, 1);
  const spaces = setup(BOARD, { useTab: false });
  await spaces.session.handle(editMessage('one\nnew line'));
  assert.ok(spaces.state.text.includes('- [ ] one\n    new line\n- [ ] two'));
  const empty = setup(BOARD);
  await empty.session.handle(editMessage('\nbody'));
  assert.deepEqual(empty.state.applied, []);
  assert.deepEqual(empty.posts.map((p) => p.type === 'error' && p.reason), ['invalid']);
});

// --- delete with confirmation, duplicate (kanban.md 4.6) ---

const del = (version: number, firstLine = '- [ ] one') => ({ type: 'deleteCard', version, laneIndex: 0, cardIndex: 0, firstLine });

test('delete asks with the card title and applies only after confirmation', async () => {
  const asked: string[] = [];
  const { state, posts, session } = setup(BOARD, {}, true, async (title) => {
    asked.push(title);
    return true;
  });
  await session.handle(del(1));
  assert.deepEqual(asked, ['one']);
  assert.equal(state.text, BOARD.replace('- [ ] one\n', ''));
  assert.equal(state.saves, 1);
  assert.deepEqual(posts, []);
});

test('cancelled delete changes nothing and sends nothing', async () => {
  const { state, posts, session } = setup(BOARD, {}, true, async () => false);
  await session.handle(del(1));
  assert.deepEqual(state.applied, []);
  assert.deepEqual(posts, []);
});

test('without a confirm port nothing is ever deleted', async () => {
  const { state, posts, session } = setup(BOARD);
  await session.handle(del(1));
  assert.deepEqual(state.applied, []);
  assert.deepEqual(posts, []);
});

test('a document change while the dialog is open makes the delete stale', async () => {
  let ctx: ReturnType<typeof setup> | undefined;
  ctx = setup(BOARD, {}, true, async () => {
    // Someone edits the file while the modal is up.
    ctx!.state.text = BOARD.replace('- [ ] two', '- [ ] zwei');
    ctx!.state.version = 2;
    return true;
  });
  await ctx.session.handle(del(1));
  assert.deepEqual(ctx.state.applied, []);
  assert.deepEqual(ctx.posts.map((p) => (p.type === 'error' ? p.reason : p.type)), ['render', 'stale']);
});

test('a stale card identity is refused before asking', async () => {
  let asked = 0;
  const { state, posts, session } = setup(BOARD, {}, true, async () => {
    asked++;
    return true;
  });
  await session.handle(del(1, '- [ ] uno'));
  assert.equal(asked, 0);
  assert.deepEqual(state.applied, []);
  assert.deepEqual(posts.map((p) => (p.type === 'error' ? p.reason : p.type)), ['render', 'stale']);
});

test('duplicate needs no confirmation and keeps the copied lines\' line endings', async () => {
  const mixed = '## A\n- [ ] one\r\n\t- body\r\n- [ ] two\n- [ ] three\n';
  const { state, session } = setup(mixed);
  await session.handle({ type: 'duplicateCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one' });
  assert.equal(state.text, '## A\n- [ ] one\r\n\t- body\r\n- [ ] one\r\n\t- body\r\n- [ ] two\n- [ ] three\n');
});

// --- open a card in text (kanban.md 4.7) ---

function setupOpenInText(text: string) {
  const opened: CardTextRange[] = [];
  const posts: ExtensionMessage[] = [];
  let version = 1;
  const session = new BoardSession({
    document: {
      text: () => text,
      version: () => version,
      applyEdits: async () => assert.fail('opening in text never edits'),
      save: async () => assert.fail('opening in text never saves'),
    },
    host: { post: (m) => void posts.push(m), openLink: async () => undefined, openInText: async (range) => void opened.push(range) },
    settings: () => ({ doneLanes: [], saveOnEdit: true, useTab: true }),
    strings: DEFAULT_STRINGS,
    errors: ERRORS,
    today: () => '2026-10-14',
  });
  return { opened, posts, session, bump: () => void version++ };
}

const BODIES = '---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] one\n\t- body a\n\n\t- body b\n- [x]two\n\n## Done\n\n- [ ] three\r\n    tail\r\n\n';
const openCard = (laneIndex: number, cardIndex: number, firstLine: string, version = 1) =>
  ({ type: 'openCardInText', version, laneIndex, cardIndex, firstLine });

test('open in text: the card range runs from the first line start to the end of its last body line', async () => {
  const { opened, posts, session } = setupOpenInText(BODIES);
  await session.handle(openCard(0, 0, '- [ ] one'));
  await session.handle(openCard(0, 1, '- [x]two'));
  await session.handle(openCard(1, 0, '- [ ] three'));
  assert.deepEqual(opened, [
    // Blank line between body lines included; the board's trailing blank line is not.
    { startLine: 6, endLine: 9, endCharacter: '\t- body b'.length },
    // No body: just the first line.
    { startLine: 10, endLine: 10, endCharacter: '- [x]two'.length },
    // CRLF: the line end is not part of the text.
    { startLine: 14, endLine: 15, endCharacter: '    tail'.length },
  ]);
  assert.deepEqual(posts, []);
});

test('open in text: a card that no longer matches is not opened and the board is redrawn', async () => {
  const { opened, posts, session } = setupOpenInText(BODIES);
  await session.handle(openCard(0, 0, '- [ ] renamed'));
  await session.handle(openCard(0, 5, '- [ ] one'));
  await session.handle(openCard(3, 0, '- [ ] one'));
  assert.deepEqual(opened, []);
  assert.deepEqual(posts.map((m) => (m.type === 'error' ? m.reason : m.type)), ['render', 'stale', 'render', 'stale', 'render', 'stale']);
});

test('open in text changes nothing, so only the card identity has to match a newer version', async () => {
  const { opened, posts, session, bump } = setupOpenInText(BODIES);
  bump();
  await session.handle(openCard(0, 1, '- [x]two', 1));
  assert.deepEqual(opened, [{ startLine: 10, endLine: 10, endCharacter: 8 }]);
  assert.deepEqual(posts, []);
});

test('open in text without the host port does nothing', async () => {
  const { posts, session } = setup(BOARD);
  await session.handle(openCard(0, 0, '- [ ] one'));
  assert.deepEqual(posts, []);
});

test('date picker: add, change and remove are one-line edits; a changed token is stale', async () => {
  const { state, posts, session } = setup(BOARD);
  await session.handle({ type: 'setCardDate', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one', date: '2026-10-20' });
  assert.equal(state.text, BOARD.replace('- [ ] one', '- [ ] one @{2026-10-20}'));
  assert.equal(state.saves, 1);
  const first = '- [ ] one @{2026-10-20}';
  await session.handle({ type: 'setCardDate', version: 2, laneIndex: 0, cardIndex: 0, firstLine: first, date: '2026-10-21', token: '@{2026-10-20}' });
  assert.equal(state.text, BOARD.replace('- [ ] one', '- [ ] one @{2026-10-21}'));
  // The board still showed the old token: refused, redrawn.
  const now = '- [ ] one @{2026-10-21}';
  await session.handle({ type: 'removeCardDate', version: 3, laneIndex: 0, cardIndex: 0, firstLine: now, token: '@{2026-10-20}' });
  assert.deepEqual(posts.map((p) => p.type), ['render', 'error']);
  assert.equal(posts[1]?.type === 'error' && posts[1].reason, 'stale');
  await session.handle({ type: 'removeCardDate', version: 3, laneIndex: 0, cardIndex: 0, firstLine: now, token: '@{2026-10-21}' });
  assert.equal(state.text, BOARD);
  assert.equal(state.applied.length, 3);
});

test('date picker: refused as invalid when the board writes dates as daily note links', async () => {
  const off = BOARD + '\n%% kanban:settings\n```\n{"link-date-to-daily-note":true}\n```\n%%\n';
  const { state, posts, session } = setup(off);
  await session.handle({ type: 'setCardDate', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] one', date: '2026-10-20' });
  assert.equal(state.text, off);
  assert.deepEqual(posts, [{ type: 'error', reason: 'invalid', message: 'E-invalid' }]);
  await session.handle({ type: 'ready' });
  const render = posts.find((p) => p.type === 'render');
  assert.equal(render?.type === 'render' && render.view.datePicker, false);
});
