// Board operations never corrupt a file (kanban.md 4, 7): stale views never hit another card or
// lane, text typed into the board cannot create structure, unreadable files are never written,
// large boards stay fast, and quick or interleaved requests keep the document valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, type TextEdit } from '../../../src/core/patch.ts';
import type { ExtensionMessage } from '../../../src/features/kanban/messages.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { BoardSession, type ErrorStrings } from '../../../src/features/kanban/session.ts';
import { DEFAULT_STRINGS } from '../../../src/features/kanban/view.ts';

const ERRORS: ErrorStrings = { stale: 'E-stale', invalid: 'E-invalid', unsafe: 'E-unsafe', failed: 'E-failed', unreadable: 'E-unreadable', gone: 'E-gone', encoding: 'E-encoding', disabled: 'E-disabled' };

const BOARD = [
  '---',
  'kanban-plugin: basic',
  '---',
  '',
  '## Todo',
  '',
  '- [ ] one',
  '- [ ] two',
  '\tbody of two',
  '',
  'interstitial text',
  '',
  '## Done',
  '',
  '**Complete**',
  '- [x] three',
  '',
  '***',
  '',
  '## Archive',
  '',
  '- [x] old',
  '',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"basic"}',
  '```',
  '%%',
  '',
].join('\n');

function setup(text = BOARD) {
  const state = { text, version: 1, applied: [] as TextEdit[][] };
  const posts: ExtensionMessage[] = [];
  const session = new BoardSession({
    document: {
      text: () => state.text,
      version: () => state.version,
      applyEdits: async (edits) => {
        state.applied.push([...edits]);
        state.text = applyEdits(parseLines(state.text), edits);
        state.version++;
        return true;
      },
      save: async () => undefined,
    },
    host: { post: (m) => void posts.push(m), openLink: async () => undefined },
    settings: () => ({ doneLanes: [], saveOnEdit: true, useTab: true }),
    strings: DEFAULT_STRINGS,
    errors: ERRORS,
    today: () => '2026-10-15',
    confirmDelete: async () => true,
  });
  /** An outside change (Obsidian, a script, undo): new text, new version. */
  const rewrite = (next: string): void => {
    state.text = next;
    state.version++;
  };
  const errors = (): string[] => posts.flatMap((p) => (p.type === 'error' ? [p.reason] : []));
  return { state, posts, session, rewrite, errors };
}

const card = (laneIndex: number, cardIndex: number, firstLine: string) => ({ laneIndex, cardIndex, firstLine });
const lane = (laneIndex: number, heading: string) => ({ laneIndex, heading });

/** One message of every operation kind, all built from BOARD. */
function everyOp(version: number) {
  return [
    { type: 'toggleCard', version, ...card(0, 0, '- [ ] one') },
    { type: 'editCardText', version, ...card(0, 1, '- [ ] two'), text: 'two edited\nbody' },
    { type: 'moveCard', version, ...card(0, 0, '- [ ] one'), toLaneIndex: 1, toHeading: '## Done', toIndex: 0 },
    { type: 'addCard', version, ...lane(0, '## Todo'), title: 'new' },
    { type: 'deleteCard', version, ...card(0, 1, '- [ ] two') },
    { type: 'duplicateCard', version, ...card(0, 0, '- [ ] one') },
    { type: 'renameLane', version, ...lane(0, '## Todo'), name: 'Doing' },
    { type: 'moveLane', version, ...lane(0, '## Todo'), toIndex: 1 },
  ];
}

/** The parts of a board an operation must never touch. */
function fixed(text: string) {
  const texts = lineTexts(parseLines(text));
  const board = parseBoard(texts);
  const slice = (r: { start: number; end: number } | null) => (r === null ? null : texts.slice(r.start, r.end));
  return {
    frontmatter: slice(board.frontmatter),
    archive: slice(board.archive),
    settings: slice(board.settingsBlock?.range ?? null),
    tail: slice(board.tail),
  };
}

function shape(text: string) {
  return parseBoard(lineTexts(parseLines(text))).lanes.map((l) => [l.name, l.cards.length]);
}

// 1. A file rewritten between render and request.
test('case 1: every request built on an older version is refused, the file untouched', async () => {
  for (const message of everyOp(1)) {
    const { state, session, rewrite, errors } = setup();
    // Obsidian swapped the two cards and renamed nothing else.
    rewrite(BOARD.replace('- [ ] one\n- [ ] two\n\tbody of two', '- [ ] two\n\tbody of two\n- [ ] one'));
    const before = state.text;
    await session.handle(message);
    assert.equal(state.text, before, message.type);
    assert.deepEqual(errors(), ['stale'], message.type);
  }
});

test('case 1: a current version with an identity that no longer matches is refused (never another card or lane)', async () => {
  const rewritten = BOARD.replace('- [ ] one\n- [ ] two\n\tbody of two', '- [ ] two\n\tbody of two\n- [ ] one').replace('## Todo', '## Todo!');
  for (const message of everyOp(2)) {
    const { state, session, rewrite, errors } = setup();
    rewrite(rewritten);
    await session.handle(message);
    assert.equal(state.text, rewritten, message.type);
    assert.deepEqual(errors(), ['stale'], message.type);
  }
});

// 2. Structure injection through typed text.
const INJECTIONS = [
  '## lane',
  '***',
  '%% kanban:settings',
  '%%',
  'a %% b',
  '<!-- open',
  '```',
  '~~~',
  '- [ ] card',
  '---',
  '**Complete**',
  'a\u0000b',
  'bell\u0007',
  'esc\u001b[31m',
  'del\u007f',
  'a\u2028b',
  'a\u2029b',
  'a\u0085b',
  'a\rb',
];

/** After any applied request: same fixed parts, no new control characters, structure as intended. */
function assertSafe(before: string, after: string, label: string, expectShape: (s: ReturnType<typeof shape>) => void) {
  assert.deepEqual(fixed(after), fixed(before), label);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(after), `control character written: ${label}`);
  assert.ok(!/\r(?!\n)/.test(after), `lone CR written: ${label}`);
  expectShape(shape(after));
}

for (const evil of INJECTIONS) {
  const label = JSON.stringify(evil);
  test(`case 2: ${label} typed as a title, body line or lane name cannot create structure`, async () => {
    const attempts = [
      { type: 'addCard', version: 1, ...lane(0, '## Todo'), title: `x ${evil}` },
      { type: 'addCard', version: 1, ...lane(0, '## Todo'), title: evil },
      { type: 'editCardText', version: 1, ...card(0, 0, '- [ ] one'), text: evil },
      { type: 'editCardText', version: 1, ...card(0, 0, '- [ ] one'), text: `one\n${evil}` },
      { type: 'editCardText', version: 1, ...card(0, 1, '- [ ] two'), text: `two\nbody of two\n${evil}\nmore` },
      { type: 'renameLane', version: 1, ...lane(0, '## Todo'), name: evil },
      { type: 'renameLane', version: 1, ...lane(1, '## Done'), name: `x ${evil}` },
    ];
    for (const message of attempts) {
      const { state, session } = setup();
      await session.handle(message);
      const what = `${message.type} ${JSON.stringify(message)}`;
      if (state.text === BOARD) continue; // refused
      assertSafe(BOARD, state.text, what, (s) => {
        const lanes = s.map(([name]) => name);
        if (message.type === 'renameLane') {
          assert.equal(lanes.length, 2, what);
        } else {
          assert.deepEqual(lanes, ['Todo', 'Done'], what);
          const cards = s.map(([, n]) => n);
          assert.deepEqual(cards, message.type === 'addCard' ? [3, 1] : [2, 1], what);
        }
      });
      // Obsidian reads an unclosed %% or <!-- as a comment to the end of the file: never written.
      const added = state.text.split('\n').filter((l) => !BOARD.split('\n').includes(l));
      for (const line of added) {
        assert.ok((line.match(/%%/g) ?? []).length % 2 === 0, `unbalanced %% written: ${what}`);
        assert.ok(!line.includes('<!--') || line.includes('-->'), `unclosed comment written: ${what}`);
      }
    }
  });
}

// 4. Files that cannot be written back safely; large boards.
test('case 4: a file that was not read as text (U+FFFD replacement or NUL) is never written', async () => {
  for (const bad of [BOARD.replace('one', 'on\ufffde'), BOARD.replace('interstitial', 'inter\u0000stitial')]) {
    for (const message of everyOp(1)) {
      const { state, session, errors } = setup(bad);
      await session.handle(message);
      assert.equal(state.text, bad, message.type);
      assert.deepEqual(errors(), ['unreadable'], message.type);
    }
  }
});

test('case 4: CRLF, BOM, no trailing newline and mixed endings survive every operation', async () => {
  const variants = {
    crlf: BOARD.replaceAll('\n', '\r\n'),
    bom: `\ufeff${BOARD}`,
    noTrailing: BOARD.replace(/\n$/, ''),
    mixed: BOARD.split('\n').map((l, i) => (i % 2 === 0 ? `${l}\r` : l)).join('\n').replace(/\r$/, ''),
  };
  for (const [name, text] of Object.entries(variants)) {
    for (const message of everyOp(1)) {
      const { state, session } = setup(text);
      await session.handle(message);
      assert.notEqual(state.text, text, `${name} ${message.type} applied`);
      assert.equal(state.text.startsWith('\ufeff'), text.startsWith('\ufeff'), `${name} ${message.type} BOM`);
      assert.equal(/\n$/.test(state.text), /\n$/.test(text), `${name} ${message.type} trailing newline`);
      if (name === 'crlf') assert.ok(!/(?<!\r)\n/.test(state.text), `${name} ${message.type}: only CRLF`);
      assert.deepEqual(fixed(state.text), fixed(text), `${name} ${message.type}`);
    }
  }
});

test('case 4: a 5,000-card board renders and takes every operation quickly', async () => {
  const cards = Array.from({ length: 5000 }, (_, i) => `- [ ] card ${i}${i % 10 === 0 ? '\n\tbody line\n\tmore' : ''}`).join('\n');
  const big = `---\nkanban-plugin: basic\n---\n\n## Todo\n\n${cards}\n\n## Done\n\n**Complete**\n`;
  const { state, session } = setup(big);
  let started = performance.now();
  session.render();
  assert.ok(performance.now() - started < 3000, `render ${performance.now() - started} ms`);
  for (const message of [
    { type: 'toggleCard', version: 1, ...card(0, 4999, '- [ ] card 4999') },
    { type: 'moveCard', version: 2, ...card(0, 0, '- [ ] card 0'), toLaneIndex: 1, toHeading: '## Done', toIndex: 0 },
    { type: 'editCardText', version: 3, ...card(0, 9, '- [ ] card 10'), text: 'card 10\nbody line\nmore\nadded' },
    { type: 'deleteCard', version: 4, ...card(0, 2500, '- [ ] card 2501') },
  ]) {
    started = performance.now();
    await session.handle(message);
    assert.ok(performance.now() - started < 3000, `${message.type} ${performance.now() - started} ms`);
  }
  assert.equal(state.version, 5, 'all four applied');
  assert.deepEqual(shape(state.text), [['Todo', 4998], ['Done', 1]]);
});

// 5. Quick and interleaved requests.
test('case 5: two drags before the first redraw: the second is refused, no card lost or doubled', async () => {
  const { state, session, errors } = setup();
  await Promise.all([
    session.handle({ type: 'moveCard', version: 1, ...card(0, 0, '- [ ] one'), toLaneIndex: 1, toHeading: '## Done', toIndex: 0 }),
    session.handle({ type: 'moveCard', version: 1, ...card(0, 0, '- [ ] one'), toLaneIndex: 1, toHeading: '## Done', toIndex: 1 }),
  ]);
  assert.deepEqual(shape(state.text), [['Todo', 1], ['Done', 2]]);
  assert.equal(state.text.split('\n').filter((l) => l.endsWith('] one')).length, 1);
  assert.deepEqual(errors(), ['stale']);
});

test('case 5: delete while an edit is open, rename while an edit is open: the late edit is refused', async () => {
  const { state, session, errors } = setup();
  await session.handle({ type: 'deleteCard', version: 1, ...card(0, 1, '- [ ] two') });
  await session.handle({ type: 'editCardText', version: 1, ...card(0, 1, '- [ ] two'), text: 'two changed' });
  await session.handle({ type: 'renameLane', version: 2, ...lane(0, '## Todo'), name: 'Doing' });
  await session.handle({ type: 'editCardText', version: 2, ...card(0, 0, '- [ ] one'), text: 'one changed' });
  assert.deepEqual(errors(), ['stale', 'stale']);
  assert.deepEqual(shape(state.text), [['Doing', 1], ['Done', 1]]);
  assert.ok(!state.text.includes('changed'));
});

test('case 5: undo and redo between board requests keep the document valid', async () => {
  const { state, session, rewrite, errors } = setup();
  await session.handle({ type: 'moveCard', version: 1, ...card(0, 0, '- [ ] one'), toLaneIndex: 1, toHeading: '## Done', toIndex: 1 });
  const moved = state.text;
  rewrite(BOARD); // undo
  await session.handle({ type: 'toggleCard', version: 2, ...card(0, 0, '- [ ] one') }); // built before the undo
  assert.deepEqual(errors(), ['stale']);
  rewrite(moved); // redo
  await session.handle({ type: 'toggleCard', version: 4, ...card(1, 1, '- [x] one') });
  assert.deepEqual(shape(state.text), [['Todo', 1], ['Done', 2]]);
  assert.ok(state.text.includes('- [ ] one'), 'unchecked after the redo');
  assert.deepEqual(fixed(state.text), fixed(BOARD));
});
