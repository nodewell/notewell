import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, toBoardRequest, validateWebviewMessage } from '../../../src/features/kanban/messages.ts';

const card = { laneIndex: 1, cardIndex: 2, firstLine: '- [ ] 카드' };
const lane = { laneIndex: 0, heading: '## 할 일' };

function ok(raw: unknown) {
  const result = validateWebviewMessage(raw);
  assert.ok(result.ok, JSON.stringify(raw) + (result.ok ? '' : ` -> ${result.error}`));
  return result.message;
}

function bad(raw: unknown) {
  assert.equal(validateWebviewMessage(raw).ok, false, JSON.stringify(raw));
}

test('every operation message carries the version and target identity', () => {
  const cases: [unknown, unknown][] = [
    [{ type: 'toggleCard', version: 3, ...card }, { kind: 'toggleCard', card }],
    [{ type: 'deleteCard', version: 3, ...card }, { kind: 'deleteCard', card }],
    [{ type: 'duplicateCard', version: 3, ...card }, { kind: 'duplicateCard', card }],
    [{ type: 'editCardText', version: 3, ...card, text: '새 제목\n\t본문' }, { kind: 'editCardText', card, text: '새 제목\n\t본문' }],
    [
      { type: 'moveCard', version: 3, ...card, toLaneIndex: 0, toHeading: '## 할 일', toIndex: 4 },
      { kind: 'moveCard', card, toLane: lane, toIndex: 4 },
    ],
    [{ type: 'addCard', version: 3, ...lane, title: '추가' }, { kind: 'addCard', lane, title: '추가' }],
    [{ type: 'addCard', version: 3, ...lane, index: 0, title: '추가' }, { kind: 'addCard', lane, index: 0, title: '추가' }],
    [{ type: 'moveLane', version: 3, ...lane, toIndex: 2 }, { kind: 'moveLane', lane, toIndex: 2 }],
    [{ type: 'renameLane', version: 3, ...lane, name: '새 열' }, { kind: 'renameLane', lane, name: '새 열' }],
    [{ type: 'setShowCheckboxes', version: 3, value: true }, { kind: 'setShowCheckboxes', value: true }],
    [{ type: 'setShowCheckboxes', version: 3, value: false }, { kind: 'setShowCheckboxes', value: false }],
    [{ type: 'setLaneWidth', version: 3, value: 320 }, { kind: 'setLaneWidth', value: 320 }],
  ];
  for (const [raw, request] of cases) {
    assert.deepEqual(toBoardRequest(ok(raw)), { version: 3, request });
    // Dropping the version or any identity field invalidates the message.
    for (const key of Object.keys(raw as object)) {
      // Optional: the add position, and the width (absent: back to the default width).
      if (key === 'type' || key === 'index' || (key === 'value' && (raw as { type: string }).type === 'setLaneWidth')) continue;
      const { [key]: _omit, ...rest } = raw as Record<string, unknown>;
      bad(rest);
    }
  }
});

test('non-operation messages', () => {
  assert.equal(toBoardRequest(ok({ type: 'ready' })), undefined);
  assert.equal(toBoardRequest(ok({ type: 'openLink', target: '폴더/노트' })), undefined);
  bad({ type: 'openLink', target: '' });
  bad({ type: 'openLink', target: 'a\nb' });
  bad({ type: 'openLink', target: 'x'.repeat(LIMITS.linkTarget + 1) });
});

test('openCardInText: card identity and version, validated like operations, never a board edit', () => {
  const raw = { type: 'openCardInText', version: 3, ...card };
  assert.equal(toBoardRequest(ok(raw)), undefined);
  for (const key of Object.keys(raw)) {
    if (key === 'type') continue;
    const { [key]: _omit, ...rest } = raw as Record<string, unknown>;
    bad(rest);
  }
  bad({ ...raw, firstLine: '- [ ] a\nb' });
  bad({ ...raw, cardIndex: -1 });
  bad({ ...raw, line: 4 }); // no raw line numbers from the webview
});

test('values are range-, length- and newline-checked', () => {
  bad({ type: 'toggleCard', version: -1, ...card });
  bad({ type: 'toggleCard', version: 1.5, ...card });
  bad({ type: 'toggleCard', version: 1, ...card, cardIndex: LIMITS.index + 1 });
  bad({ type: 'toggleCard', version: 1, ...card, laneIndex: '0' });
  bad({ type: 'editCardTitle', version: 1, ...card, title: 'x' }); // replaced by editCardText
  bad({ type: 'toggleCard', version: 1, ...card, firstLine: '- [ ] a\r\n' });
  ok({ type: 'toggleCard', version: 1, ...card, firstLine: '- [ ] ' + '긴 제목 '.repeat(2000) });
  bad({ type: 'renameLane', version: 1, ...lane, name: 'a\u2028b' });
  bad({ type: 'toggleCard', version: 1, ...card, extra: true });
  bad({ type: 'archiveCard', version: 1, ...card }); // not offered (kanban.md 4.6)
  bad({ type: 'toggleCard', version: 1, card });
});

test('editCardText: LF allowed; CR, other separators, length and line count refused', () => {
  const edit = (text: string) => ({ type: 'editCardText', version: 1, ...card, text });
  ok(edit('title\n\tbody\n\n\tmore'));
  ok(edit('x'.repeat(LIMITS.cardText)));
  ok(edit(Array.from({ length: LIMITS.cardLines }, () => 'l').join('\n')));
  bad(edit(''));
  bad(edit('title\r\nbody'));
  bad(edit('title\rbody'));
  bad(edit(`a${String.fromCharCode(0x2028)}b`));
  bad(edit(`a${String.fromCharCode(0x85)}b`));
  bad(edit('x'.repeat(LIMITS.cardText + 1)));
  bad(edit(Array.from({ length: LIMITS.cardLines + 1 }, () => 'l').join('\n')));
  // Line breaks stay refused everywhere else.
  bad({ type: 'renameLane', version: 1, laneIndex: 0, heading: '## A', name: 'a\nb' });
  bad({ type: 'addCard', version: 1, laneIndex: 0, heading: '## A', title: 'a\nb' });
});

test('date picker messages (kanban.md 4.8): ISO date, optional token for add, token required to remove', () => {
  assert.deepEqual(toBoardRequest(ok({ type: 'setCardDate', version: 3, ...card, date: '2026-10-20' })), {
    version: 3,
    request: { kind: 'setCardDate', card, date: '2026-10-20' },
  });
  assert.deepEqual(toBoardRequest(ok({ type: 'setCardDate', version: 3, ...card, date: '2026-10-20', token: '@{2026-10-01}' })), {
    version: 3,
    request: { kind: 'setCardDate', card, date: '2026-10-20', token: '@{2026-10-01}' },
  });
  assert.deepEqual(toBoardRequest(ok({ type: 'removeCardDate', version: 3, ...card, token: '@{x}' })), {
    version: 3,
    request: { kind: 'removeCardDate', card, token: '@{x}' },
  });
  bad({ type: 'setCardDate', version: 3, ...card });
  bad({ type: 'setCardDate', version: 3, ...card, date: '2026-1-2' });
  bad({ type: 'setCardDate', version: 3, ...card, date: '2026-10-200' });
  bad({ type: 'setCardDate', version: 3, ...card, date: 20261020 });
  bad({ type: 'setCardDate', version: 3, ...card, date: '2026-10\n20' });
  bad({ type: 'setCardDate', version: 3, ...card, date: '2026-10-20', token: '@{}' });
  bad({ type: 'setCardDate', version: 3, ...card, date: '2026-10-20', token: '@{a}\n' });
  bad({ type: 'removeCardDate', version: 3, ...card });
  bad({ type: 'removeCardDate', version: 3, ...card, token: '' });
  bad({ type: 'removeCardDate', version: 3, laneIndex: 1, cardIndex: 2, token: '@{x}' });
  bad({ type: 'removeCardDate', version: 3, ...card, token: 'x'.repeat(LIMITS.sourceLine + 1) });
  // The date is checked again by the operation (a real day, kanban.md 4.8).
});

test('setShowCheckboxes takes a boolean only', () => {
  for (const value of ['true', 1, null, undefined]) bad({ type: 'setShowCheckboxes', version: 3, value });
});

test('setLaneWidth takes an integer in the slider range, or nothing for the default width', () => {
  assert.deepEqual(toBoardRequest(ok({ type: 'setLaneWidth', version: 3 })), { version: 3, request: { kind: 'setLaneWidth' } });
  for (const value of [LIMITS.laneWidthMin, LIMITS.laneWidthMax]) ok({ type: 'setLaneWidth', version: 3, value });
  for (const value of [LIMITS.laneWidthMin - 1, LIMITS.laneWidthMax + 1, 300.5, '300', null, true]) bad({ type: 'setLaneWidth', version: 3, value });
  bad({ type: 'setLaneWidth', value: 300 });
});
