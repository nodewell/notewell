import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCardMessage,
  cleanCardText,
  cleanTitle,
  dropMessage,
  editTextMessage,
  editorKeyAction,
  finalIndex,
  keyboardMoveCard,
  keyboardMoveLane,
  moveCardMessage,
  moveLaneMessage,
  navigate,
  renameLaneMessage,
  toggleMessage,
} from '../../../src/features/kanban/browser/interactions.ts';
import { validateWebviewMessage } from '../../../src/features/kanban/messages.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView } from '../../../src/features/kanban/view.ts';

const texts = [
  '---', 'kanban-plugin: basic', '---',
  '## A', '- [ ] a0', '- [ ] a1', '- [ ] a2',
  '## B', '- [ ] b0',
  '## C',
];
const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
const V = 7;

/** Every produced message must pass the extension-side validator. */
function valid<T>(message: T): T {
  if (message !== undefined) {
    const result = validateWebviewMessage(message);
    assert.ok(result.ok, result.ok ? '' : result.error);
  }
  return message;
}

test('toggle, edit, rename and add carry version and identity', () => {
  assert.deepEqual(valid(toggleMessage(view, V, { lane: 0, card: 1 })), {
    type: 'toggleCard', version: V, laneIndex: 0, cardIndex: 1, firstLine: '- [ ] a1',
  });
  assert.deepEqual(valid(editTextMessage(view, V, { lane: 1, card: 0 }, '  new  ')), {
    type: 'editCardText', version: V, laneIndex: 1, cardIndex: 0, firstLine: '- [ ] b0', text: 'new',
  });
  assert.equal(editTextMessage(view, V, { lane: 1, card: 0 }, 'b0'), undefined, 'unchanged');
  assert.equal(editTextMessage(view, V, { lane: 1, card: 0 }, '   '), undefined, 'empty');
  assert.deepEqual(valid(renameLaneMessage(view, V, 2, 'Done')), {
    type: 'renameLane', version: V, laneIndex: 2, heading: '## C', name: 'Done',
  });
  assert.deepEqual(valid(addCardMessage(view, V, 2, 'first')), {
    type: 'addCard', version: V, laneIndex: 2, heading: '## C', title: 'first',
  });
  assert.equal(toggleMessage(view, V, { lane: 5, card: 0 }), undefined);
});

test('pasted line breaks become spaces before sending', () => {
  assert.equal(cleanTitle('a\nb\r\nc\u2028d'), 'a b c d');
  assert.equal(cleanTitle('\n'), undefined);
});

test('finalIndex follows the "list without the moved item" convention', () => {
  assert.equal(finalIndex(1, 0), 0);
  assert.equal(finalIndex(1, 1), 1);
  assert.equal(finalIndex(1, 2), 1);
  assert.equal(finalIndex(1, 3), 2);
  assert.equal(finalIndex(undefined, 3), 3);
});

test('drag a card: within a lane, across lanes, to an empty lane; no-ops are not sent', () => {
  const move = (lane: number, card: number, toLane: number, before: number) =>
    valid(moveCardMessage(view, V, { lane, card }, toLane, before));
  assert.equal(move(0, 0, 0, 3)?.type === 'moveCard' ? (move(0, 0, 0, 3) as { toIndex: number }).toIndex : -1, 2);
  assert.deepEqual(move(0, 2, 1, 0), {
    type: 'moveCard', version: V, laneIndex: 0, cardIndex: 2, firstLine: '- [ ] a2', toLaneIndex: 1, toHeading: '## B', toIndex: 0,
  });
  assert.equal((move(1, 0, 2, 0) as { toIndex: number }).toIndex, 0);
  assert.equal(move(0, 1, 0, 1), undefined, 'drop before itself');
  assert.equal(move(0, 1, 0, 2), undefined, 'drop right after itself');
  assert.equal((move(0, 0, 1, 99) as { toIndex: number }).toIndex, 1, 'clamped to the end');
});

test('drag a lane', () => {
  assert.deepEqual(valid(moveLaneMessage(view, V, 0, 3)), { type: 'moveLane', version: V, laneIndex: 0, heading: '## A', toIndex: 2 });
  assert.deepEqual(valid(moveLaneMessage(view, V, 2, 0)), { type: 'moveLane', version: V, laneIndex: 2, heading: '## C', toIndex: 0 });
  assert.equal(moveLaneMessage(view, V, 1, 1), undefined);
  assert.equal(moveLaneMessage(view, V, 1, 2), undefined);
});

test('keyboard: Alt+arrows move cards and lanes, plain arrows move focus', () => {
  const key = (lane: number, card: number, dir: 'up' | 'down' | 'left' | 'right') => {
    const result = keyboardMoveCard(view, V, { lane, card }, dir);
    if (result) valid(result.message);
    return result && { toLane: (result.message as { toLaneIndex: number }).toLaneIndex, toIndex: (result.message as { toIndex: number }).toIndex, focus: result.focus };
  };
  assert.deepEqual(key(0, 1, 'up'), { toLane: 0, toIndex: 0, focus: { lane: 0, card: 0 } });
  assert.deepEqual(key(0, 1, 'down'), { toLane: 0, toIndex: 2, focus: { lane: 0, card: 2 } });
  assert.equal(key(0, 0, 'up'), undefined);
  assert.equal(key(0, 2, 'down'), undefined);
  assert.deepEqual(key(0, 2, 'right'), { toLane: 1, toIndex: 1, focus: { lane: 1, card: 1 } });
  assert.deepEqual(key(1, 0, 'right'), { toLane: 2, toIndex: 0, focus: { lane: 2, card: 0 } });
  assert.deepEqual(key(1, 0, 'left'), { toLane: 0, toIndex: 0, focus: { lane: 0, card: 0 } });
  assert.equal(key(0, 0, 'left'), undefined);

  const lane = keyboardMoveLane(view, V, 0, 'right');
  assert.deepEqual(lane && valid(lane.message), { type: 'moveLane', version: V, laneIndex: 0, heading: '## A', toIndex: 1 });
  assert.equal(lane?.focus, 1);
  assert.equal(keyboardMoveLane(view, V, 0, 'left'), undefined);
  assert.equal(keyboardMoveLane(view, V, 2, 'right'), undefined);

  assert.deepEqual(navigate(view, { lane: 0, card: 2 }, 'right'), { lane: 1, card: 0 });
  assert.deepEqual(navigate(view, { lane: 1, card: 0 }, 'right'), undefined, 'skips empty lanes, none left');
  assert.deepEqual(navigate(view, { lane: 1, card: 0 }, 'left'), { lane: 0, card: 0 });
  assert.deepEqual(navigate(view, { lane: 0, card: 0 }, 'down'), { lane: 0, card: 1 });
  assert.equal(navigate(view, { lane: 0, card: 0 }, 'up'), undefined);
});

const multi = [
  '---', 'kanban-plugin: basic', '---',
  '## A', '- [ ] title', '\t- sub one', '\t\t- deeper', '- [ ] other',
];
const multiView = buildBoardView(multi, parseBoard(multi), { today: '2026-10-20' });

test('card editor text: whole card, body indentation decoded', () => {
  assert.equal(multiView.lanes[0]!.cards[0]!.editText, 'title\n- sub one\n\t- deeper');
  assert.equal(multiView.lanes[0]!.cards[1]!.editText, 'other');
});

test('cleanCardText: LF only, first line trimmed, trailing blank lines dropped, empty first line refused', () => {
  assert.equal(cleanCardText('  a  \r\nb\rc\n\n  \n'), 'a\nb\nc');
  assert.equal(cleanCardText(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x85)}c`), 'a\nb\nc');
  assert.equal(cleanCardText('a\n\n\tbody'), 'a\n\n\tbody', 'inner blank lines and indentation kept');
  assert.equal(cleanCardText('   \nbody'), undefined);
  assert.equal(cleanCardText(''), undefined);
});

test('editTextMessage sends the whole card text; unchanged text is not sent', () => {
  const ref = { lane: 0, card: 0 };
  assert.deepEqual(valid(editTextMessage(multiView, V, ref, 'title\n- sub one\n\t- deeper\nnew line\n')), {
    type: 'editCardText', version: V, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] title',
    text: 'title\n- sub one\n\t- deeper\nnew line',
  });
  assert.equal(editTextMessage(multiView, V, ref, 'title\n- sub one\n\t- deeper\n\n'), undefined);
  assert.equal(editTextMessage(multiView, V, ref, '\nrest'), undefined);
});

test('editor keys: Enter saves, Shift+Enter breaks the line, Escape cancels, IME composition is ignored', () => {
  const press = (key: string, shiftKey = false, isComposing = false, keyCode?: number) =>
    ({ key, shiftKey, isComposing, ...(keyCode === undefined ? {} : { keyCode }) });
  assert.equal(editorKeyAction(press('Enter')), 'save');
  assert.equal(editorKeyAction(press('Enter', true)), 'newline');
  assert.equal(editorKeyAction(press('Escape')), 'cancel');
  assert.equal(editorKeyAction(press('a')), 'none');
  assert.equal(editorKeyAction(press('Enter', false, true)), 'none', 'isComposing (Korean syllable)');
  assert.equal(editorKeyAction(press('Enter', false, false, 229)), 'none', 'keyCode 229 during composition');
  assert.equal(editorKeyAction(press('Enter'), true), 'none', 'between compositionstart and compositionend');
  assert.equal(editorKeyAction(press('Escape', false, true)), 'none', 'Escape cancels the composition, not the edit');
});

test('a drop uses the view and version the drag started from', () => {
  // The drag starts on a1 (lane A, index 1) at version 7.
  const session = { kind: 'card' as const, ref: { lane: 0, card: 1 }, view, version: V };
  // Meanwhile another tool reorders lane A; a newer view arrives at version 8.
  const reordered = ['---', 'kanban-plugin: basic', '---', '## A', '- [ ] a2', '- [ ] a0', '- [ ] a1', '## B', '- [ ] b0', '## C'];
  const newer = buildBoardView(reordered, parseBoard(reordered), { today: '2026-10-20' });
  assert.equal(newer.lanes[0]!.cards[1]!.id.firstLine, '- [ ] a0', 'index 1 is now a different card');

  const message = valid(dropMessage(session, 1, 0));
  assert.deepEqual(message, {
    type: 'moveCard', version: V, laneIndex: 0, cardIndex: 1, firstLine: '- [ ] a1',
    toLaneIndex: 1, toHeading: '## B', toIndex: 0,
  });
  // Old version + old identity: the extension refuses it as stale instead of moving a0.

  const laneSession = { kind: 'lane' as const, lane: 2, view, version: V };
  assert.deepEqual(valid(dropMessage(laneSession, 0, 0)), { type: 'moveLane', version: V, laneIndex: 2, heading: '## C', toIndex: 0 });
});
