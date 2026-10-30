// Adding several cards in a row (kanban.md 4.4.1): key decisions, finding the card just
// added after a redraw, and keeping the input's state across redraws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAddedCard, restoreAdder, type AdderSnapshot } from '../../../src/features/kanban/browser/editor-state.ts';
import {
  adderKeyAction,
  closeFocus,
  COMPOSITION_ENTER_WINDOW_MS,
  CompositionEnterGuard,
  isAddCardShortcut,
} from '../../../src/features/kanban/browser/interactions.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView } from '../../../src/features/kanban/view.ts';

const board = (lines: string[]) => buildBoardView(lines, parseBoard(lines), { today: '2026-10-20' });
const press = (key: string, shiftKey = false, isComposing = false) => ({ key, shiftKey, isComposing });

test('Enter adds and keeps going; Enter on an empty input or Escape closes', () => {
  assert.equal(adderKeyAction(press('Enter'), 'first card'), 'add');
  assert.equal(adderKeyAction(press('Enter', true), 'first card'), 'add', 'single-line: Shift+Enter adds too');
  assert.equal(adderKeyAction(press('Enter'), ''), 'close');
  assert.equal(adderKeyAction(press('Enter'), '   '), 'close');
  assert.equal(adderKeyAction(press('Escape'), 'typed'), 'close');
  assert.equal(adderKeyAction(press('a'), 'typed'), 'none');
});

test('IME composition: Enter confirms the syllable and adds nothing', () => {
  assert.equal(adderKeyAction(press('Enter', false, true), '카드'), 'none');
  assert.equal(adderKeyAction({ ...press('Enter'), keyCode: 229 }, '카드'), 'none');
  assert.equal(adderKeyAction(press('Enter'), '카드', true), 'none', 'between compositionstart and end');
  assert.equal(adderKeyAction(press('Escape', false, true), '카드'), 'none');
});

test('N without Ctrl/Alt/Meta is the add shortcut', () => {
  const mods = { altKey: false, ctrlKey: false, metaKey: false };
  assert.equal(isAddCardShortcut({ key: 'n', ...mods }), true);
  assert.equal(isAddCardShortcut({ key: 'N', ...mods }), true, 'Shift+N');
  assert.equal(isAddCardShortcut({ key: 'n', ...mods, ctrlKey: true }), false, 'Ctrl+N stays with VS Code');
  assert.equal(isAddCardShortcut({ key: 'n', ...mods, altKey: true }), false);
  assert.equal(isAddCardShortcut({ key: 'n', ...mods, metaKey: true }), false);
  assert.equal(isAddCardShortcut({ key: 'm', ...mods }), false);
});

test('closing focuses the last card added, or the lane when none was added', () => {
  assert.deepEqual(closeFocus(1, { lane: 1, card: 3 }), { kind: 'card', ref: { lane: 1, card: 3 } });
  assert.deepEqual(closeFocus(1), { kind: 'lane', lane: 1 });
});

const before = board(['## A', '- [ ] a0', '## B', '- [ ] b0']);
const lane = before.lanes[0]!.id;
const snap = (extra: Partial<AdderSnapshot> = {}): AdderSnapshot => ({ lane, draft: '', selectionStart: 0, selectionEnd: 0, ...extra });

test('after a render the card just added is found and selected; the input stays open', () => {
  const after = board(['## A', '- [ ] a0', '- [ ] new card', '## B', '- [ ] b0']);
  assert.deepEqual(findAddedCard(after, 0, { text: 'new card', index: 1 }), { lane: 0, card: 1 });
  const restored = restoreAdder(after, snap({ draft: 'next', selectionStart: 4, selectionEnd: 4, pending: { text: 'new card', index: 1 } }));
  assert.deepEqual(restored, {
    lane: 0,
    draft: 'next',
    selectionStart: 4,
    selectionEnd: 4,
    lastAdded: { laneIndex: 0, cardIndex: 1, firstLine: '- [ ] new card' },
    selected: { lane: 0, card: 1 },
  });
});

test('the next render keeps the last added card selected during continuous input', () => {
  const after = board(['## A', '- [ ] a0', '- [ ] one', '## B']);
  const lastAdded = { laneIndex: 0, cardIndex: 1, firstLine: '- [ ] one' };
  assert.deepEqual(restoreAdder(after, snap({ lastAdded }))?.selected, { lane: 0, card: 1 });
});

test('a pending add not in the view (render before a stale refusal) stays pending', () => {
  const unchanged = board(['## A', '- [ ] a0', '## B', '- [ ] b0']);
  const restored = restoreAdder(unchanged, snap({ draft: '', pending: { text: 'lost', index: 1 } }));
  assert.deepEqual(restored?.pending, { text: 'lost', index: 1 });
  assert.equal(restored?.selected, undefined);
});

test('another tool reordering the lane: the added card is found by title', () => {
  const after = board(['## A', '- [ ] new card', '- [ ] a0', '## B']);
  assert.deepEqual(findAddedCard(after, 0, { text: 'new card', index: 1 }), { lane: 0, card: 0 });
});

test('the input closes (draft kept elsewhere) when its lane no longer matches', () => {
  const renamed = board(['## A2', '- [ ] a0', '## B']);
  assert.equal(restoreAdder(renamed, snap({ draft: 'typed' })), undefined);
});

// --- Korean IME: Enter that ends a composition (Windows, Chromium) ---

const enter = { key: 'Enter', shiftKey: false };

test('compositionend then Enter (isComposing false) in the same press: ignored; the next Enter acts', () => {
  const guard = new CompositionEnterGuard();
  // compositionstart -> compositionend -> keydown Enter (same press)
  guard.compositionEnd(1000);
  assert.equal(guard.swallow(enter, 1002), true, 'confirms the syllable only');
  guard.keyUp();
  // A second, separate Enter press adds or saves.
  assert.equal(guard.swallow(enter, 1400), false);
  assert.equal(adderKeyAction({ ...enter, isComposing: false }, '한글 카드'), 'add');
});

test('Enter without any composition (English input) acts immediately', () => {
  const guard = new CompositionEnterGuard();
  assert.equal(guard.swallow(enter, 10), false);
  assert.equal(guard.swallow(enter, 20), false);
});

test('a composition ended by something else does not swallow a later Enter', () => {
  const byKey = new CompositionEnterGuard();
  byKey.compositionEnd(1000); // ended by Space or a punctuation key ...
  byKey.keyUp(); // ... whose keyup arrives before the Enter press
  assert.equal(byKey.swallow(enter, 1050), false);

  const byClick = new CompositionEnterGuard();
  byClick.compositionEnd(1000); // ended by a click: no keyup follows
  assert.equal(byClick.swallow(enter, 1000 + COMPOSITION_ENTER_WINDOW_MS + 1), false, 'outside the window');
});

test('only one Enter is swallowed per composition', () => {
  const guard = new CompositionEnterGuard();
  guard.compositionEnd(1000);
  assert.equal(guard.swallow(enter, 1001), true);
  assert.equal(guard.swallow(enter, 1003), false, 'a key repeat without keyup acts');
});

test('Shift+Enter after a composition still inserts its line break; other keys pass', () => {
  const guard = new CompositionEnterGuard();
  guard.compositionEnd(1000);
  assert.equal(guard.swallow({ key: 'Enter', shiftKey: true }, 1001), false);
  assert.equal(guard.swallow(enter, 1002), false, 'the shifted press consumed the composition end');

  const other = new CompositionEnterGuard();
  other.compositionEnd(1000);
  assert.equal(other.swallow({ key: 'a', shiftKey: false }, 1001), false);
  assert.equal(other.swallow(enter, 1002), true, 'a non-Enter key does not clear it before keyup');
});
