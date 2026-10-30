// Card menu (kanban.md 4.6): items, what each one sends, keyboard driving and placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardMenuAction,
  cardMenuEntries,
  firstEnabled,
  isCardMenuShortcut,
  isDeleteShortcut,
  isOpenInTextShortcut,
  laneChoices,
  lastEnabled,
  menuKeyAction,
  moveSelection,
  placeMenu,
  type CardMenuEntry,
} from '../../../src/features/kanban/browser/card-menu.ts';
import { validateWebviewMessage } from '../../../src/features/kanban/messages.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView } from '../../../src/features/kanban/view.ts';

const texts = [
  '---', 'kanban-plugin: basic', '---',
  '## A', '- [ ] a0', '- [ ] a1', '- [ ] a2',
  '## B', '- [ ] b0',
  '## Done', '**Complete**', '- [x] d0',
];
const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
const V = 3;

function items(entries: CardMenuEntry[]) {
  return entries.flatMap((e) => (e.kind === 'item' ? [e] : []));
}

function message(action: ReturnType<typeof cardMenuAction>) {
  assert.equal(action.kind, 'message');
  if (action.kind !== 'message') throw new Error('unreachable');
  const result = validateWebviewMessage(action.message);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return action;
}

test('items in spec order with two separators; delete is the danger item', () => {
  const entries = cardMenuEntries(view, { lane: 0, card: 1 }, view.strings);
  assert.deepEqual(
    entries.map((e) => (e.kind === 'item' ? e.id : '-')),
    ['edit', 'open-text', 'add-date', 'duplicate', 'insert-before', 'insert-after', '-', 'move-top', 'move-bottom', 'move-to', '-', 'delete'],
  );
  assert.equal(items(entries).find((e) => e.id === 'open-text')!.label, view.strings.openInText);
  assert.equal(items(entries).find((e) => e.id === 'open-text')!.keybinding, 'Ctrl+Enter');
  assert.deepEqual(items(entries).filter((e) => e.danger).map((e) => e.id), ['delete']);
  assert.deepEqual(items(entries).filter((e) => e.submenu).map((e) => e.id), ['move-to']);
  assert.deepEqual(items(entries).filter((e) => e.disabled), []);
  assert.equal(items(entries).find((e) => e.id === 'delete')!.label, view.strings.deleteCard);
});

test('moves that change nothing are disabled', () => {
  const first = items(cardMenuEntries(view, { lane: 0, card: 0 }, view.strings));
  assert.deepEqual(first.filter((e) => e.disabled).map((e) => e.id), ['move-top']);
  const last = items(cardMenuEntries(view, { lane: 0, card: 2 }, view.strings));
  assert.deepEqual(last.filter((e) => e.disabled).map((e) => e.id), ['move-bottom']);
  const only = items(cardMenuEntries(view, { lane: 1, card: 0 }, view.strings));
  assert.deepEqual(only.filter((e) => e.disabled).map((e) => e.id), ['move-top', 'move-bottom']);

  const single = ['---', 'kanban-plugin: basic', '---', '## A', '- [ ] a'];
  const one = buildBoardView(single, parseBoard(single), { today: '2026-10-20' });
  const lonely = items(cardMenuEntries(one, { lane: 0, card: 0 }, one.strings));
  assert.ok(lonely.find((e) => e.id === 'move-to')!.disabled, 'no other lane to move to');
});

test('lane list: own lane disabled, done lanes marked', () => {
  assert.deepEqual(laneChoices(view, { lane: 1, card: 0 }), [
    { lane: 0, name: 'A', done: false, current: false },
    { lane: 1, name: 'B', done: false, current: true },
    { lane: 2, name: 'Done', done: true, current: false },
  ]);
});

test('edit and insert before/after', () => {
  const ref = { lane: 0, card: 1 };
  assert.deepEqual(cardMenuAction(view, V, ref, 'edit'), { kind: 'edit', ref });
  assert.deepEqual(cardMenuAction(view, V, ref, 'insert-before'), { kind: 'add-at', lane: 0, index: 1 });
  assert.deepEqual(cardMenuAction(view, V, ref, 'insert-after'), { kind: 'add-at', lane: 0, index: 2 });
});

test('open in text sends the card identity and version, without a focus change (kanban.md 4.7)', () => {
  const card = view.lanes[0]!.cards[1]!.id;
  assert.deepEqual(cardMenuAction(view, V, { lane: 0, card: 1 }, 'open-text'), {
    kind: 'request',
    message: { type: 'openCardInText', version: V, ...card },
  });
  assert.deepEqual(cardMenuAction(view, V, { lane: 0, card: 9 }, 'open-text'), { kind: 'none' });
});

test('duplicate and delete send the card identity; focus lands on the copy or the neighbour', () => {
  const card = view.lanes[0]!.cards[1]!.id;
  const dup = message(cardMenuAction(view, V, { lane: 0, card: 1 }, 'duplicate'));
  assert.deepEqual(dup.message, { type: 'duplicateCard', version: V, ...card });
  assert.deepEqual(dup.focus, { lane: 0, card: 2 });

  const del = message(cardMenuAction(view, V, { lane: 0, card: 1 }, 'delete'));
  assert.deepEqual(del.message, { type: 'deleteCard', version: V, ...card });
  assert.deepEqual(del.focus, { lane: 0, card: 1 }, 'the next card moves up');
  assert.deepEqual(message(cardMenuAction(view, V, { lane: 0, card: 2 }, 'delete')).focus, { lane: 0, card: 1 }, 'last: the previous card');
  assert.deepEqual(message(cardMenuAction(view, V, { lane: 1, card: 0 }, 'delete')).focus, { lane: 1 }, 'only card: the lane');
});

test('move to top, bottom and another lane', () => {
  const top = message(cardMenuAction(view, V, { lane: 0, card: 2 }, 'move-top'));
  assert.equal(top.message.type, 'moveCard');
  assert.deepEqual(top.focus, { lane: 0, card: 0 });
  const bottom = message(cardMenuAction(view, V, { lane: 0, card: 0 }, 'move-bottom'));
  assert.deepEqual(bottom.focus, { lane: 0, card: 2 });
  const across = message(cardMenuAction(view, V, { lane: 0, card: 1 }, 'move-to', 2));
  assert.deepEqual(across.focus, { lane: 2, card: 1 }, 'end of the target lane');
  assert.equal(cardMenuAction(view, V, { lane: 0, card: 1 }, 'move-to', 0).kind, 'none', 'own lane');
  assert.equal(cardMenuAction(view, V, { lane: 0, card: 1 }, 'move-to').kind, 'none');
  assert.equal(cardMenuAction(view, V, { lane: 0, card: 9 }, 'delete').kind, 'none', 'card gone');
});

test('menu keys', () => {
  const k = (key: string) => menuKeyAction({ key });
  assert.equal(k('ArrowDown'), 'next');
  assert.equal(k('ArrowUp'), 'prev');
  assert.equal(k('Home'), 'first');
  assert.equal(k('End'), 'last');
  assert.equal(k('Enter'), 'activate');
  assert.equal(k(' '), 'activate');
  assert.equal(k('Escape'), 'close');
  assert.equal(k('Tab'), 'close');
  assert.equal(k('ArrowRight'), 'open-submenu');
  assert.equal(k('ArrowLeft'), 'close-submenu');
  assert.equal(k('a'), 'none');
});

test('selection skips disabled items and wraps', () => {
  const enabled = [true, false, true, true, false];
  assert.equal(moveSelection(enabled, 0, 1), 2);
  assert.equal(moveSelection(enabled, 3, 1), 0, 'wraps past the disabled end');
  assert.equal(moveSelection(enabled, 0, -1), 3);
  assert.equal(moveSelection([false, false], 0, 1), -1);
  assert.equal(firstEnabled([false, true, true]), 1);
  assert.equal(lastEnabled([true, true, false]), 1);
});

test('shortcuts: Shift+F10, the context menu key and plain Delete', () => {
  const mods = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  assert.ok(isCardMenuShortcut({ ...mods, key: 'ContextMenu' }));
  assert.ok(isCardMenuShortcut({ ...mods, key: 'F10', shiftKey: true }));
  assert.ok(!isCardMenuShortcut({ ...mods, key: 'F10' }));
  assert.ok(!isCardMenuShortcut({ ...mods, key: 'F10', shiftKey: true, ctrlKey: true }));
  assert.ok(isDeleteShortcut({ ...mods, key: 'Delete' }));
  assert.ok(!isDeleteShortcut({ ...mods, key: 'Delete', shiftKey: true }));
  assert.ok(!isDeleteShortcut({ ...mods, key: 'Backspace' }));
});

test('shortcut: Ctrl+Enter (Cmd+Enter) opens in text; Enter, Shift/Alt and both modifiers do not', () => {
  const mods = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  assert.ok(isOpenInTextShortcut({ ...mods, key: 'Enter', ctrlKey: true }));
  assert.ok(isOpenInTextShortcut({ ...mods, key: 'Enter', metaKey: true }));
  assert.ok(!isOpenInTextShortcut({ ...mods, key: 'Enter' }), 'Enter edits on the board');
  assert.ok(!isOpenInTextShortcut({ ...mods, key: 'Enter', ctrlKey: true, shiftKey: true }));
  assert.ok(!isOpenInTextShortcut({ ...mods, key: 'Enter', ctrlKey: true, altKey: true }));
  assert.ok(!isOpenInTextShortcut({ ...mods, key: 'Enter', ctrlKey: true, metaKey: true }));
  assert.ok(!isOpenInTextShortcut({ ...mods, key: 'F2', ctrlKey: true }));
  // Not taken by the other card shortcuts.
  assert.ok(!isDeleteShortcut({ ...mods, key: 'Enter', ctrlKey: true }));
  assert.ok(!isCardMenuShortcut({ ...mods, key: 'Enter', ctrlKey: true }));
});

test('placement flips at the viewport edges and stays inside', () => {
  const size = { width: 200, height: 300 };
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(placeMenu({ x: 100, y: 100 }, size, viewport), { x: 100, y: 100 });
  assert.deepEqual(placeMenu({ x: 700, y: 100 }, size, viewport), { x: 500, y: 100 }, 'flips left');
  assert.deepEqual(placeMenu({ x: 100, y: 500 }, size, viewport), { x: 100, y: 200 }, 'flips up');
  assert.deepEqual(placeMenu({ x: 150, y: 250 }, size, { width: 300, height: 400 }), { x: 4, y: 4 }, 'flipped, then kept inside the margin');
});

test('a card dated by a daily note link (@[[...]]) gets no date items (kanban.md 4.8)', () => {
  const linked = ['---', 'kanban-plugin: basic', '---', '', '## A', '', '- [ ] Linked @[[2026-10-18]]', '- [ ] Both @[[2026-10-18]] @{2026-10-19}', ''];
  const v = buildBoardView(linked, parseBoard(linked), { today: '2026-10-20' });
  assert.equal(v.lanes[0]!.cards[0]!.linkDate, true);
  const first = items(cardMenuEntries(v, { lane: 0, card: 0 }, v.strings)).map((e) => e.id);
  assert.ok(!first.includes('add-date') && !first.includes('change-date') && !first.includes('remove-date'));
  // A card that also has an @{...} date keeps "Change date" for it, as Obsidian edits that one.
  assert.equal(v.lanes[0]!.cards[1]!.linkDate, undefined);
  assert.ok(items(cardMenuEntries(v, { lane: 0, card: 1 }, v.strings)).map((e) => e.id).includes('change-date'));
});
