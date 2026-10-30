// Date picker in the webview (kanban.md 4.8): menu entries, the messages it sends, its keys,
// the popup it draws, the pickable badge, and how main.ts wires it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardMenuAction, cardMenuEntries } from '../../../src/features/kanban/browser/card-menu.ts';
import {
  datePickerInitial,
  datePickerKeyAction,
  datePickerMode,
  isPickDateKey,
  removeDateMessage,
  renderDatePicker,
  setDateMessage,
} from '../../../src/features/kanban/browser/date-picker.ts';
import { renderBoard } from '../../../src/features/kanban/browser/render.ts';
import { renderCardPreview } from '../../../src/features/kanban/browser/preview.ts';
import { validateWebviewMessage } from '../../../src/features/kanban/messages.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView, DEFAULT_STRINGS } from '../../../src/features/kanban/view.ts';

class FakeElement {
  readonly tagName: string;
  #text: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly children: (FakeElement | string)[] = [];
  readonly classList = { add: (...tokens: string[]) => void tokens.forEach((t) => this.classes.add(t)) };
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  get textContent(): string | null {
    return this.#text ?? this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(value: string | null) {
    this.#text = value;
    this.children.length = 0;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }
  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) if (typeof child !== 'string') yield* child.walk();
  }
  find(predicate: (e: FakeElement) => boolean): FakeElement[] {
    return [...this.walk()].filter(predicate);
  }
}
const doc = { createElement: (tag: string) => new FakeElement(tag) };

const TEXTS = [
  '---', 'kanban-plugin: basic', '---', '',
  '## A', '',
  '- [ ] no date',
  '- [ ] due @{2026-10-25} and @{2026-10-26}',
  '- [ ] time @{09:30}',
  '- [ ] body',
  '\tline @{2026-10-27}',
  '',
];
const view = buildBoardView(TEXTS, parseBoard(TEXTS), { today: '2026-10-20' });
const OFF = [...TEXTS, '%% kanban:settings', '```', '{"link-date-to-daily-note":true}', '```', '%%'];
const offView = buildBoardView(OFF, parseBoard(OFF), { today: '2026-10-20' });
const V = 7;
const ids = (entries: ReturnType<typeof cardMenuEntries>) => entries.flatMap((e) => (e.kind === 'item' ? [e.id] : []));

function valid(message: unknown) {
  const result = validateWebviewMessage(message);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.message;
}

test('card menu: Add date without a token, Change/Remove date with one, after Open in text', () => {
  assert.deepEqual(ids(cardMenuEntries(view, { lane: 0, card: 0 }, view.strings)).slice(0, 4), ['edit', 'open-text', 'add-date', 'duplicate']);
  assert.deepEqual(ids(cardMenuEntries(view, { lane: 0, card: 1 }, view.strings)).slice(0, 5), ['edit', 'open-text', 'change-date', 'remove-date', 'duplicate']);
  // A time token is the card's date token too (Obsidian's rule), so it can be changed or removed.
  assert.deepEqual(ids(cardMenuEntries(view, { lane: 0, card: 2 }, view.strings)).slice(2, 4), ['change-date', 'remove-date']);
  assert.deepEqual(ids(cardMenuEntries(view, { lane: 0, card: 3 }, view.strings)).slice(2, 4), ['change-date', 'remove-date']);
  const labels = cardMenuEntries(view, { lane: 0, card: 1 }, view.strings).flatMap((e) => (e.kind === 'item' ? [e.label] : []));
  assert.ok(labels.includes(DEFAULT_STRINGS.changeDate) && labels.includes(DEFAULT_STRINGS.removeDate));
  // Off (daily note links): no date items at all.
  for (const card of [0, 1]) {
    const off = ids(cardMenuEntries(offView, { lane: 0, card }, offView.strings));
    assert.ok(!off.some((id) => id.endsWith('-date')), String(off));
  }
});

test('card menu actions: add/change open the picker, remove sends removeCardDate', () => {
  assert.deepEqual(cardMenuAction(view, V, { lane: 0, card: 0 }, 'add-date'), { kind: 'pick-date', ref: { lane: 0, card: 0 } });
  assert.deepEqual(cardMenuAction(view, V, { lane: 0, card: 1 }, 'change-date'), { kind: 'pick-date', ref: { lane: 0, card: 1 } });
  const remove = cardMenuAction(view, V, { lane: 0, card: 1 }, 'remove-date');
  assert.equal(remove.kind, 'message');
  if (remove.kind !== 'message') return;
  assert.deepEqual(valid(remove.message), { type: 'removeCardDate', version: V, laneIndex: 0, cardIndex: 1, firstLine: TEXTS[7], token: '@{2026-10-25}' });
  assert.deepEqual(remove.focus, { lane: 0, card: 1 });
  assert.deepEqual(cardMenuAction(view, V, { lane: 0, card: 0 }, 'remove-date'), { kind: 'none' });
  assert.deepEqual(cardMenuAction(offView, V, { lane: 0, card: 0 }, 'add-date'), { kind: 'none' });
});

test('messages: add carries no token, change carries the first token; invalid dates send nothing', () => {
  assert.deepEqual(valid(setDateMessage(view, V, { lane: 0, card: 0 }, '2026-10-30')), {
    type: 'setCardDate', version: V, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] no date', date: '2026-10-30',
  });
  assert.deepEqual(valid(setDateMessage(view, V, { lane: 0, card: 3 }, '2026-10-30')), {
    type: 'setCardDate', version: V, laneIndex: 0, cardIndex: 3, firstLine: '- [ ] body', date: '2026-10-30', token: '@{2026-10-27}',
  });
  // The date field reports an incomplete or impossible date as ''.
  assert.equal(setDateMessage(view, V, { lane: 0, card: 0 }, ''), undefined);
  assert.equal(setDateMessage(view, V, { lane: 0, card: 0 }, '2026-02-30'), undefined);
  assert.equal(setDateMessage(view, V, { lane: 0, card: 0 }, '12026-01-01'), undefined);
  assert.equal(setDateMessage(view, V, { lane: 9, card: 0 }, '2026-10-30'), undefined);
  assert.equal(setDateMessage(offView, V, { lane: 0, card: 0 }, '2026-10-30'), undefined);
  assert.equal(removeDateMessage(offView, V, { lane: 0, card: 1 }), undefined);
});

test('initial value: the card date for change, today for add or a token that is not a date', () => {
  const cards = view.lanes[0]!.cards;
  assert.equal(datePickerMode(cards[0]!), 'add');
  assert.equal(datePickerInitial(view, cards[0]!), '2026-10-20');
  assert.equal(datePickerMode(cards[1]!), 'change');
  assert.equal(datePickerInitial(view, cards[1]!), '2026-10-25');
  assert.equal(datePickerInitial(view, cards[2]!), '2026-10-20');
  assert.equal(datePickerInitial(view, cards[3]!), '2026-10-27');
});

test('keys: Enter confirms, Escape cancels; Enter or Space opens the picker from the badge', () => {
  const k = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({
    key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods,
  });
  assert.equal(datePickerKeyAction(k('Enter')), 'confirm');
  assert.equal(datePickerKeyAction(k('Escape')), 'cancel');
  assert.equal(datePickerKeyAction(k('Enter', { ctrlKey: true })), 'none');
  assert.equal(datePickerKeyAction(k('Enter', { isComposing: true })), 'none');
  assert.equal(datePickerKeyAction(k('ArrowUp')), 'none');
  assert.equal(isPickDateKey(k('Enter')), true);
  assert.equal(isPickDateKey(k(' ')), true);
  assert.equal(isPickDateKey(k('Enter', { altKey: true })), false);
  assert.equal(isPickDateKey(k('a')), false);
});

test('popup: a labelled dialog with the browser date field and OK / Cancel, text only', () => {
  const root = renderDatePicker(doc, DEFAULT_STRINGS, 'change', '2026-10-25');
  assert.equal(root.attrs.get('role'), 'dialog');
  assert.equal(root.attrs.get('aria-label'), DEFAULT_STRINGS.changeDate);
  const [input] = root.find((e) => e.tagName === 'input');
  assert.equal(input!.attrs.get('type'), 'date');
  assert.equal(input!.attrs.get('value'), '2026-10-25');
  assert.equal(input!.attrs.get('aria-label'), DEFAULT_STRINGS.changeDate);
  assert.equal(input!.attrs.get('max'), '9999-12-31');
  const buttons = root.find((e) => e.tagName === 'button');
  assert.deepEqual(buttons.map((b) => [b.textContent, b.attrs.get('data-picker'), b.attrs.get('type')]), [
    ['OK', 'ok', 'button'],
    ['Cancel', 'cancel', 'button'],
  ]);
  assert.equal(renderDatePicker(doc, DEFAULT_STRINGS, 'add', '2026-10-20').attrs.get('aria-label'), DEFAULT_STRINGS.addDate);
  // Only a real ISO date goes into the value attribute.
  const odd = renderDatePicker(doc, DEFAULT_STRINGS, 'add', '"><b>');
  assert.equal(odd.find((e) => e.tagName === 'input')[0]!.attrs.has('value'), false);
});

test('render: only the first date token badge is a button that opens the picker', () => {
  const root = renderBoard(doc, view, { collapsed: new Map() });
  const dates = root.find((e) => e.classes.has('date'));
  const picks = dates.filter((e) => e.attrs.get('data-action') === 'pick-date');
  assert.deepEqual(picks.map((e) => e.textContent), ['2026-10-25', '2026-10-27']);
  for (const pick of picks) {
    assert.equal(pick.attrs.get('role'), 'button');
    assert.equal(pick.attrs.get('tabindex'), '0');
    assert.equal(pick.attrs.get('aria-haspopup'), 'dialog');
    assert.equal(pick.attrs.get('title'), DEFAULT_STRINGS.changeDate);
    assert.ok(pick.classes.has('date-pick'));
  }
  const second = dates.find((e) => e.textContent === '2026-10-26')!;
  assert.equal(second.attrs.has('data-action'), false);
  assert.equal(second.attrs.has('tabindex'), false);
  // Off: no pickable badge; the preview never has one.
  assert.deepEqual(renderBoard(doc, offView, { collapsed: new Map() }).find((e) => e.attrs.get('data-action') === 'pick-date'), []);
  const popup = renderCardPreview(doc, view, view.lanes[0]!.cards[3]!, 'p');
  assert.deepEqual(popup.find((e) => e.attrs.get('data-action') === 'pick-date'), []);
});

test('main.ts: picker keys stay inside, outside press / redraw / drag / resize close it, preview waits', () => {
  const main = readFileSync(new URL('../../../src/features/kanban/browser/main.ts', import.meta.url), 'utf8');
  const fn = (name: string) => {
    const body = new RegExp(`function ${name}\\([^)]*\\): void \\{([\\s\\S]*?)\\n\\}`).exec(main)?.[1];
    assert.ok(body, name);
    return body;
  };
  const open = fn('openDatePicker');
  assert.match(open, /event\.stopPropagation\(\);/);
  assert.match(open, /datePickerKeyAction\(event\)/);
  assert.match(open, /closePreview\(\);/);
  assert.match(open, /closeCardMenu\(false\);/);
  assert.match(open, /input\.focus\(\);/);
  assert.match(fn('confirmDatePicker'), /setDateMessage\(/);
  assert.match(fn('draw'), /closeDatePicker\(false\);/);
  assert.match(main, /if \(datePicker && !datePicker\.root\.contains\(target\)\) closeDatePicker\(false\);/);
  assert.match(main, /app\.addEventListener\('dragstart', \(event\) => \{\n  drag = undefined;\n  closePreview\(\);\n  closeDatePicker\(false\);/);
  assert.match(main, /window\.addEventListener\('resize', \(\) => \{[\s\S]*?closeDatePicker\(false\);/);
  assert.match(main, /if \(datePicker && !datePicker\.root\.contains\(event\.target as Node\)\) closeDatePicker\(false\);/, 'a scroll closes it');
  assert.match(main, /case 'pick-date': \{\n      const ref = cardRefOf\(action\);\n      if \(ref\) openDatePicker\(ref, action\);/);
  assert.match(main, /target\.matches\('\[data-action="pick-date"\]'\) && isPickDateKey\(event\)/);
});
