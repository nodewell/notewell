// Date picker (kanban.md 4.8): what it sends, its first value, its keys and how it is drawn.
// DOM-free so it can be unit tested; main.ts opens it next to the card and wires the events.
// The picker is the browser's own date field (no dependency); it never edits the card text
// itself, the extension writes the date in the board format.
import { createElementFactory, type DomDocument, type DomElement } from '../../../webview/dom.ts';
import { isIsoDate } from '../dates.ts';
import type { WebviewMessage } from '../messages.ts';
import type { BoardView, CardView, ViewStrings } from '../view.ts';
import type { CardRef } from './interactions.ts';

function cardAt(view: BoardView, ref: CardRef): CardView | undefined {
  return view.lanes[ref.lane]?.cards[ref.card];
}

/** 'change' for a card with a date token, else 'add'. */
export function datePickerMode(card: CardView): 'add' | 'change' {
  return card.date === undefined ? 'add' : 'change';
}

/** The first value: the card's date (change) or today (add, or a token that is not a date). */
export function datePickerInitial(view: BoardView, card: CardView): string {
  return card.date?.iso ?? view.today;
}

/**
 * Adds the date, or changes the card's first date token (named so the extension can refuse
 * when it changed meanwhile). Undefined for a value the date field reports as incomplete or
 * invalid (it reports those as '') and when the board's date picker is off.
 */
export function setDateMessage(view: BoardView, version: number, ref: CardRef, iso: string): WebviewMessage | undefined {
  const card = cardAt(view, ref);
  if (card === undefined || !view.datePicker || !isIsoDate(iso)) return undefined;
  return { type: 'setCardDate', version, ...card.id, date: iso, ...(card.date === undefined ? {} : { token: card.date.token }) };
}

/** Removes the card's first date token; undefined when it has none or the picker is off. */
export function removeDateMessage(view: BoardView, version: number, ref: CardRef): WebviewMessage | undefined {
  const card = cardAt(view, ref);
  if (card?.date === undefined || !view.datePicker) return undefined;
  return { type: 'removeCardDate', version, ...card.id, token: card.date.token };
}

export interface DatePickerKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
}

const plain = ({ shiftKey, altKey, ctrlKey, metaKey }: DatePickerKey): boolean => !shiftKey && !altKey && !ctrlKey && !metaKey;

/** Enter confirms, Escape cancels (on any part of the picker); other keys do their usual thing. */
export function datePickerKeyAction(event: DatePickerKey): 'confirm' | 'cancel' | 'none' {
  const { key, isComposing } = event;
  if (isComposing === true) return 'none';
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter' && plain(event)) return 'confirm';
  return 'none';
}

/** Enter or Space on a focused date badge opens the picker (it is a button). */
export function isPickDateKey(event: DatePickerKey): boolean {
  const { key } = event;
  return plain(event) && (key === 'Enter' || key === ' ');
}

/**
 * The picker popup: a dialog with the browser's date field and OK / Cancel. `value` goes in
 * as the field's value attribute (YYYY-MM-DD only); the year is kept to four digits, the
 * range the board writes and reads.
 */
export function renderDatePicker<E extends DomElement<E>>(
  doc: DomDocument<E>,
  strings: ViewStrings,
  mode: 'add' | 'change',
  value: string,
): E {
  const el = createElementFactory(doc);
  const label = mode === 'add' ? strings.addDate : strings.changeDate;
  return el(
    'div',
    { className: 'date-picker', attrs: { role: 'dialog', 'aria-label': label } },
    el('input', {
      className: 'date-picker-input',
      attrs: {
        type: 'date',
        'aria-label': label,
        min: '0001-01-01',
        max: '9999-12-31',
        required: '',
        ...(isIsoDate(value) ? { value } : {}),
      },
    }),
    el(
      'div',
      { className: 'date-picker-buttons' },
      el('button', { className: 'date-picker-ok', text: strings.dateConfirm, attrs: { type: 'button', 'data-picker': 'ok' } }),
      el('button', { className: 'date-picker-cancel', text: strings.dateCancel, attrs: { type: 'button', 'data-picker': 'cancel' } }),
    ),
  );
}
