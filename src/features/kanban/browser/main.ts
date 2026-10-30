// Board webview entry (browser). Holds the last rendered view and wires DOM events
// to messages by delegation. All drawing goes through render.ts; text is never
// inserted as markup.
import { createElementFactory } from '../../../webview/dom.ts';
import type { ExtensionMessage, WebviewMessage } from '../messages.ts';
import type { BoardView } from '../view.ts';
import type { CardIdentity } from '../model.ts';
import type { LaneIdentity } from '../operations.ts';
import {
  cardTarget,
  laneTarget,
  locateEditor,
  restoreAdder,
  type AdderRestore,
  type AdderSnapshot,
  type EditorSnapshot,
  type EditorTarget,
  type PendingAdd,
} from './editor-state.ts';
import {
  addCardMessage,
  adderKeyAction,
  cleanTitle,
  closeFocus,
  CompositionEnterGuard,
  dropMessage,
  editTextMessage,
  editorKeyAction,
  isAddCardShortcut,
  keyboardMoveCard,
  keyboardMoveLane,
  navigate,
  renameLaneMessage,
  toggleMessage,
  type CardRef,
  type Direction,
  type DragSession,
} from './interactions.ts';
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
  openInTextMessage,
  placeMenu,
  type CardMenuEntry,
  type CardMenuItemId,
  type LaneChoice,
} from './card-menu.ts';
import {
  datePickerInitial,
  datePickerKeyAction,
  datePickerMode,
  isPickDateKey,
  renderDatePicker,
  setDateMessage,
} from './date-picker.ts';
import {
  bodyFoldShortcut,
  foldAll,
  isFolded,
  laneFoldAction,
  pruneFolds,
  restoreFolds,
  setFolded,
  setLaneFolded,
  storeFolds,
  type BodyFolds,
} from './body-folds.ts';
import { canPreview, chordStep, placePreview, PREVIEW_CLOSE_MS, PREVIEW_DELAY_MS, previewOnHover, renderCardPreview } from './preview.ts';
import { laneWidthText, renderBoard, renderCardEditor, renderCardMenu, renderLaneMenu } from './render.ts';
import { applyStyle } from './style.ts';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const el = createElementFactory(document);
const app = document.getElementById('app')!;

type EditField = HTMLInputElement | HTMLTextAreaElement;

let current: { version: number; view: BoardView } | undefined;
const collapsed = new Map<number, boolean>();
/**
 * Folded card bodies (kanban.md 3.2), kept in the webview state so they survive hiding the
 * tab and redraws; gone when the board is closed.
 */
let folds: BodyFolds = restoreFolds((vscode.getState() as { bodies?: unknown } | undefined)?.bodies);

function saveState(): void {
  vscode.setState({ bodies: storeFolds(folds) });
}
let pendingFocus: { kind: 'card'; ref: CardRef } | { kind: 'lane'; lane: number } | { kind: 'checkboxes' } | { kind: 'laneWidth' } | undefined;
/**
 * Width slider (kanban.md 4.10): the width the lanes show while it moves, until the extension
 * answers the write (`sent`). Written once it is let go, or once the keys pause.
 */
let widthDraft: { value: number; sent: boolean } | undefined;
let widthTimer: ReturnType<typeof setTimeout> | undefined;
const WIDTH_WRITE_DELAY_MS = 400;
/** The open inline editor. `awaiting` once submitted, until the extension answers. */
let editor: { field: EditField; target: EditorTarget; awaiting: boolean } | undefined;
/** A submitted editor removed by the render that precedes a 'stale' error; reopened then. */
let submitted: EditorSnapshot | undefined;
let drag: DragSession | undefined;

/** The open add-card input (kanban.md 4.4.1): stays open after Enter for the next card. */
interface Adder {
  readonly lane: LaneIdentity;
  readonly laneIndex: number;
  readonly input: HTMLInputElement;
  /** Insert position for "insert before/after" (kanban.md 4.6); undefined = end of the lane. */
  index?: number;
  /** Sent and not yet seen in a render; a second Enter waits for it. */
  pending?: PendingAdd;
  /** Last card added in this run, by identity (selected while the input stays open). */
  lastAdded?: CardIdentity;
  composing: boolean;
}
let adder: Adder | undefined;
/** True while draw() replaces the DOM, so blur from removed fields is ignored. */
let drawing = false;

const noticeHost = el('p', { className: 'notice error', attrs: { role: 'alert', hidden: '' } });
/** A draft whose card or lane disappeared, kept visible so the text is not lost. */
const draftHost = el('div', { className: 'notice orphan-draft', attrs: { hidden: '' } });

function showNotice(text: string | undefined): void {
  noticeHost.textContent = text ?? '';
  noticeHost.hidden = text === undefined;
}

function showDraft(draft: string | undefined): void {
  draftHost.replaceChildren();
  draftHost.hidden = draft === undefined;
  if (draft === undefined || !current) return;
  const area = el('textarea', {
    className: 'inline-edit',
    text: draft,
    attrs: { readonly: '', rows: String(Math.min(draft.split('\n').length, 8)), 'aria-label': current.view.strings.editCard },
  });
  draftHost.append(el('p', { text: current.view.strings.editorTargetChanged }), area);
}

/** Sends a message; returns whether anything was sent. */
function post(message: WebviewMessage | undefined): boolean {
  if (message === undefined) return false;
  submitted = undefined;
  showDraft(undefined);
  vscode.postMessage(message);
  return true;
}

function cardRefOf(node: Element | null): CardRef | undefined {
  const li = node?.closest<HTMLElement>('li.card');
  if (!li) return undefined;
  return { lane: Number(li.dataset['lane']), card: Number(li.dataset['card']) };
}

function laneOf(node: Element | null): number | undefined {
  const holder = node?.closest<HTMLElement>('[data-lane]');
  return holder ? Number(holder.dataset['lane']) : undefined;
}

function cardElement(ref: CardRef): HTMLElement | null {
  return app.querySelector<HTMLElement>(`li.card[data-lane="${ref.lane}"][data-card="${ref.card}"]`);
}

function snapshot(open: { field: EditField; target: EditorTarget }): EditorSnapshot {
  const { field, target } = open;
  return { target, draft: field.value, selectionStart: field.selectionStart ?? 0, selectionEnd: field.selectionEnd ?? 0 };
}

function draw(): void {
  if (current === undefined) return;
  // An unsubmitted editor survives the redraw: reopened below if its target still matches.
  const keep = editor && !editor.awaiting ? snapshot(editor) : undefined;
  editor = undefined;
  // The add input survives redraws too, with its draft and the add it is waiting for.
  const keepAdder = adder ? snapshotAdder(adder) : undefined;
  adder = undefined;
  // The old DOM (and maybe the drag source) is gone; a drag cannot continue.
  drag = undefined;
  // An open card menu or date picker belongs to the old view: close it.
  closeCardMenu(false);
  closeDatePicker(false);
  // An open preview is drawn again for the same card (identity), or closed when it is gone.
  const keepPreview = preview && { id: preview.id, byKeyboard: preview.byKeyboard };
  closePreview();
  hovered = undefined;
  drawing = true;
  try {
    const view = current.view;
    app.replaceChildren(noticeHost, draftHost, renderBoard(document, view, { collapsed, folded: (card) => isFolded(folds, view, card) }));
  } finally {
    drawing = false;
  }
  wireHelp();
  showLaneWidth();
  if (keepPreview) {
    const location = locateEditor(current.view, { kind: 'card', id: keepPreview.id });
    if (location?.kind === 'card') openPreview(location.ref, keepPreview.byKeyboard);
  }
  const focus = pendingFocus;
  pendingFocus = undefined;
  if (keepAdder) {
    reopenAdder(keepAdder);
  } else if (keep) {
    reopen(keep);
  } else if (focus?.kind === 'card') {
    cardElement(focus.ref)?.focus();
  } else if (focus?.kind === 'lane') {
    app.querySelector<HTMLElement>(`section.lane[data-lane="${focus.lane}"] .lane-title`)?.focus();
  } else if (focus?.kind === 'checkboxes') {
    app.querySelector<HTMLElement>('button.board-checkboxes')?.focus();
  } else if (focus?.kind === 'laneWidth') {
    widthSlider()?.focus();
  }
}

function widthSlider(): HTMLInputElement | null {
  return app.querySelector<HTMLInputElement>('input.board-lane-width');
}

/**
 * Lane width (kanban.md 4.10): the slider's value while it moves or waits for the extension,
 * else the board's. A custom property on #app, which redraws keep, so CSP needs no inline style.
 */
function showLaneWidth(): void {
  if (!current) return;
  const width = widthDraft?.value ?? current.view.laneWidth;
  app.style.setProperty('--nw-lane-width', `${width}px`);
  const slider = widthSlider();
  if (!slider) return;
  if (widthDraft && slider.value !== String(widthDraft.value)) slider.value = String(widthDraft.value);
  for (const [name, value] of Object.entries(laneWidthText(current.view.strings, width))) slider.setAttribute(name, value);
}

function writeLaneWidth(): void {
  clearTimeout(widthTimer);
  widthTimer = undefined;
  if (!current || !widthDraft || widthDraft.sent) return;
  if (document.activeElement === widthSlider()) pendingFocus = { kind: 'laneWidth' };
  widthDraft.sent = true;
  post({ type: 'setLaneWidth', version: current.version, value: widthDraft.value });
}

/** Double-click: the board's own value goes, so the default width applies (Obsidian's reset). */
function resetLaneWidth(): void {
  clearTimeout(widthTimer);
  widthTimer = undefined;
  widthDraft = undefined;
  if (current?.view.laneWidthSet) {
    if (document.activeElement === widthSlider()) pendingFocus = { kind: 'laneWidth' };
    post({ type: 'setLaneWidth', version: current.version });
  } else {
    // Nothing to remove; the clicks may have moved the slider.
    const slider = widthSlider();
    if (slider && current) slider.value = String(current.view.laneWidth);
    showLaneWidth();
  }
}

/** Reopens an editor from a snapshot on the same card or lane, or keeps the draft visible. */
function reopen(snap: EditorSnapshot): void {
  const location = current && locateEditor(current.view, snap.target);
  if (location === undefined) {
    showDraft(snap.draft);
    return;
  }
  if (location.kind === 'card') editCard(location.ref, snap);
  else if (location.kind === 'lane') renameLane(location.lane, snap);
  else openAdder(location.lane, { lane: location.lane, draft: snap.draft, selectionStart: snap.selectionStart, selectionEnd: snap.selectionEnd });
}

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  if (message?.type === 'style') {
    // Token values only; no redraw, so an open editor and its draft stay as they are.
    applyStyle(document.documentElement, document.body, message);
    return;
  }
  if (message?.type === 'cardBodies') {
    // Collapse/Expand All Card Bodies: per-card states go, the board default changes.
    folds = foldAll(message.collapsed);
    saveState();
    keepFocusedCard();
    draw();
    return;
  }
  if (message?.type === 'render') {
    current = { version: message.version, view: message.view };
    // A sent width is answered by this render (or the error after it); a waiting one is kept.
    if (widthDraft?.sent) widthDraft = undefined;
    const pruned = pruneFolds(folds, message.view);
    if (pruned !== folds) {
      folds = pruned;
      saveState();
    }
    // Remember a submitted edit in case this render is followed by a 'stale' refusal.
    submitted = editor?.awaiting ? snapshot(editor) : undefined;
    showNotice(undefined);
    draw();
  } else if (message?.type === 'error' && current) {
    const strings = current.view.strings;
    if (widthDraft?.sent) {
      // Not written: the lanes go back to the board's width.
      widthDraft = undefined;
      const slider = widthSlider();
      if (slider) slider.value = String(current.view.laneWidth);
      showLaneWidth();
    }
    switch (message.reason) {
      case 'stale':
        // The fresh render came first. Give a refused edit back so it can be sent again
        // against the new version (only if its card or lane still matches).
        if (submitted) {
          const snap = submitted;
          submitted = undefined;
          reopen(snap);
        }
        restorePendingAdd();
        break;
      case 'invalid':
        showNotice(strings.invalidRequest);
        restorePendingAdd();
        if (editor?.awaiting) {
          // Keep the editor open so the text can be corrected.
          editor.awaiting = false;
          editor.field.readOnly = false;
          editor.field.focus();
        }
        break;
      case 'unsafe':
        showNotice(strings.unsafeRequest);
        restorePendingAdd();
        if (editor?.awaiting) closeEditor();
        break;
      case 'failed':
      case 'unreadable':
      case 'gone':
      case 'encoding':
      case 'disabled':
        showNotice(message.message);
        restorePendingAdd();
        if (editor?.awaiting) closeEditor();
        break;
    }
  }
});

function closeEditor(): void {
  editor = undefined;
  draw();
}

// Inline editing. Enter submits, Escape cancels; in the card editor Shift+Enter inserts a
// line break. Enter while an IME is composing (Korean input) only confirms the syllable.
// A submitted edit stays read-only until the extension answers with a render or an error.
function startEdit(
  host: HTMLElement,
  field: EditField,
  target: EditorTarget,
  commit: (text: string) => boolean,
  restore?: EditorSnapshot,
): void {
  const initial = field.value;
  if (restore) field.value = restore.draft;
  const open = { field, target, awaiting: false };
  editor = open;
  let composing = false;
  const imeEnter = new CompositionEnterGuard();
  const submit = (): void => {
    if (editor !== open || open.awaiting) return;
    if (commit(field.value)) {
      open.awaiting = true;
      field.readOnly = true;
    } else {
      closeEditor();
    }
  };
  field.addEventListener('compositionstart', () => {
    composing = true;
  });
  field.addEventListener('compositionend', () => {
    composing = false;
    imeEnter.compositionEnd(performance.now());
  });
  field.addEventListener('keyup', () => imeEnter.keyUp());
  field.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (imeEnter.swallow(event as KeyboardEvent, performance.now())) {
      // Korean IME: this Enter only confirmed the syllable; no save, no line break.
      event.preventDefault();
      return;
    }
    const action = editorKeyAction(event as KeyboardEvent, composing);
    if (action === 'save' || (action === 'newline' && field instanceof HTMLInputElement)) {
      event.preventDefault();
      submit();
    } else if (action === 'cancel') {
      event.preventDefault();
      if (editor === open) closeEditor();
    }
  });
  field.addEventListener('blur', () => {
    if (editor !== open || open.awaiting) return;
    if (field.value === initial) closeEditor();
    else submit();
  });
  field.addEventListener('click', (event) => event.stopPropagation());
  host.replaceChildren(field);
  field.focus();
  if (restore) field.setSelectionRange(restore.selectionStart, restore.selectionEnd);
  else field.select();
}

function singleLineInput(initial: string, label: string): HTMLInputElement {
  const input = el('input', {
    className: 'inline-edit',
    attrs: { type: 'text', 'aria-label': label, maxlength: '2000' },
  }) as HTMLInputElement;
  input.value = initial;
  return input;
}

/** Grows a textarea with its content. */
function autoGrow(area: HTMLTextAreaElement): void {
  const fit = (): void => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  };
  area.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

/** Edits the whole card (title and body) as multi-line text (kanban.md 4.4). */
function editCard(ref: CardRef, restore?: EditorSnapshot): void {
  if (!current) return;
  const { version, view } = current;
  const host = cardElement(ref);
  const card = view.lanes[ref.lane]?.cards[ref.card];
  const target = cardTarget(view, ref);
  if (!host || !card || !target) return;
  pendingFocus = { kind: 'card', ref };
  closePreview();
  // Dragging would steal text selection inside the editor.
  host.setAttribute('draggable', 'false');
  host.classList.add('editing');
  const area = renderCardEditor(document, card, view.strings) as HTMLTextAreaElement;
  startEdit(host, area, target, (text) => post(editTextMessage(view, version, ref, text)), restore);
  autoGrow(area);
}

function renameLane(lane: number, restore?: EditorSnapshot): void {
  if (!current) return;
  const { version, view } = current;
  const host = app.querySelector<HTMLElement>(`section.lane[data-lane="${lane}"] .lane-title`);
  const l = view.lanes[lane];
  const target = laneTarget(view, 'lane', lane);
  if (!host || !l || !target) return;
  pendingFocus = { kind: 'lane', lane };
  startEdit(
    host,
    singleLineInput(l.name, view.strings.renameLane),
    target,
    (text) => post(renameLaneMessage(view, version, lane, text)),
    restore,
  );
}

// --- Add-card input (kanban.md 4.4.1) ---------------------------------------

function snapshotAdder(a: Adder): AdderSnapshot {
  return {
    lane: a.lane,
    draft: a.input.value,
    selectionStart: a.input.selectionStart ?? 0,
    selectionEnd: a.input.selectionEnd ?? 0,
    ...(a.index === undefined ? {} : { index: a.index }),
    ...(a.pending ? { pending: a.pending } : {}),
    ...(a.lastAdded ? { lastAdded: a.lastAdded } : {}),
  };
}

/** Reopens the add input after a redraw and marks the card just added as selected. */
function reopenAdder(snap: AdderSnapshot): void {
  const restore = current && restoreAdder(current.view, snap);
  if (restore === undefined) {
    // The lane is gone: keep what was typed (and an unconfirmed add) visible.
    const text = [snap.pending?.text, snap.draft].filter((t) => t).join('\n');
    if (text) showDraft(text);
    return;
  }
  if (restore.selected) {
    const card = cardElement(restore.selected);
    card?.classList.add('selected');
    card?.scrollIntoView({ block: 'nearest' });
  }
  openAdder(restore.lane, restore);
}

/**
 * Opens the add input at the end of a lane, or before card `index` (insert before/after),
 * expanding a collapsed lane first.
 */
function openAdder(lane: number, restore?: AdderRestore, at?: number): void {
  if (!current) return;
  const l = current.view.lanes[lane];
  if (!l) return;
  let button = app.querySelector<HTMLElement>(`button.add-card[data-lane="${lane}"]`);
  if (button?.hidden) {
    collapsed.set(lane, false);
    draw();
    button = app.querySelector<HTMLElement>(`button.add-card[data-lane="${lane}"]`);
  }
  if (!button) return;
  const index = restore?.index ?? at;
  const input = singleLineInput(restore?.draft ?? '', current.view.strings.addCardPlaceholder);
  if (index === undefined) {
    const host = el('div', { className: 'add-card-editor' });
    button.replaceWith(host);
    host.append(input);
  } else {
    // In place: a row in the card list, before the card that will follow the new one.
    const list = app.querySelector<HTMLElement>(`ul.cards[data-lane="${lane}"]`);
    if (!list) return;
    const row = el('li', { className: 'add-card-editor add-card-row' }, input);
    list.insertBefore(row, list.querySelector(`li.card[data-card="${index}"]`));
  }
  const a: Adder = {
    lane: l.id,
    laneIndex: lane,
    input,
    composing: false,
    ...(index === undefined ? {} : { index }),
    ...(restore?.pending ? { pending: restore.pending } : {}),
    ...(restore?.lastAdded ? { lastAdded: restore.lastAdded } : {}),
  };
  adder = a;
  const imeEnter = new CompositionEnterGuard();
  input.addEventListener('compositionstart', () => {
    a.composing = true;
  });
  input.addEventListener('compositionend', () => {
    a.composing = false;
    imeEnter.compositionEnd(performance.now());
  });
  input.addEventListener('keyup', () => imeEnter.keyUp());
  input.addEventListener('keydown', (event) => {
    // Keys typed here (N, Space, arrows) belong to the input, not the board or VS Code.
    event.stopPropagation();
    if (imeEnter.swallow(event, performance.now())) {
      // Korean IME: this Enter only confirmed the syllable; the next Enter adds the card.
      event.preventDefault();
      return;
    }
    const action = adderKeyAction(event, input.value, a.composing);
    if (action === 'add') {
      event.preventDefault();
      sendAdd(a);
    } else if (action === 'close') {
      event.preventDefault();
      closeAdder(a, true);
    }
  });
  input.addEventListener('blur', () => {
    // Removed by a redraw: the snapshot keeps it. Clicked elsewhere: add what was typed.
    if (drawing || adder !== a) return;
    if (cleanTitle(input.value) !== undefined && !a.pending) sendAdd(a);
    closeAdder(a, false);
  });
  input.addEventListener('click', (event) => event.stopPropagation());
  input.focus();
  if (restore) input.setSelectionRange(restore.selectionStart, restore.selectionEnd);
}

/** Sends the typed card and clears the input for the next one. */
function sendAdd(a: Adder): void {
  // One add at a time: a second Enter waits for the render that shows the first card.
  if (!current || a.pending) return;
  const text = cleanTitle(a.input.value);
  if (text === undefined) return;
  const { view, version } = current;
  const index = a.index ?? view.lanes[a.laneIndex]?.cards.length ?? 0;
  if (post(addCardMessage(view, version, a.laneIndex, a.input.value, a.index))) {
    a.pending = { text, index };
    a.input.value = '';
    // Inserting in place: the next card goes right after this one.
    if (a.index !== undefined) a.index = index + 1;
  }
}

/** Closes the input; with `focus`, the last added card (or the lane) gets the focus. */
function closeAdder(a: Adder, focus: boolean): void {
  if (adder !== a) return;
  adder = undefined;
  if (focus && current) {
    const last = a.lastAdded ? locateEditor(current.view, { kind: 'card', id: a.lastAdded }) : undefined;
    pendingFocus = closeFocus(a.laneIndex, last?.kind === 'card' ? last.ref : undefined);
  }
  draw();
}

/** A refused add: put its text back into the input so it can be sent again. */
function restorePendingAdd(): void {
  const a = adder;
  if (!a?.pending) return;
  if (a.input.value === '') a.input.value = a.pending.text;
  if (a.index !== undefined) a.index = a.pending.index;
  a.pending = undefined;
  a.input.focus();
  a.input.select();
}

// --- Card menu (kanban.md 4.6) ----------------------------------------------
// Drawn in the webview (the lane list is dynamic). Opened by right-click, the ⋯ button or
// Shift+F10 / the context menu key; driven with arrows, Home/End, Enter, Esc and
// Right/Left for the lane list. Closing returns focus to the card.

interface MenuLevel {
  readonly root: HTMLElement;
  readonly items: HTMLElement[];
  readonly enabled: boolean[];
  active: number;
}

interface OpenMenu {
  readonly ref: CardRef;
  readonly view: BoardView;
  readonly version: number;
  readonly entries: CardMenuEntry[];
  readonly main: MenuLevel;
  sub?: MenuLevel & { readonly choices: LaneChoice[]; readonly parent: number };
}
let menu: OpenMenu | undefined;

function menuLevel(root: HTMLElement): MenuLevel {
  const items = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  return { root, items, enabled: items.map((i) => i.getAttribute('aria-disabled') !== 'true'), active: -1 };
}

/** Index of the menu item under an event target, or -1. */
function itemIndex(level: MenuLevel, target: EventTarget | null): number {
  const item = (target as HTMLElement | null)?.closest<HTMLElement>('[role="menuitem"]');
  return item ? level.items.indexOf(item) : -1;
}

/** Places a menu at `anchor`, flipped to stay inside the viewport. */
function placeAt(root: HTMLElement, anchor: { x: number; y: number }): void {
  const rect = root.getBoundingClientRect();
  const { x, y } = placeMenu(anchor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight });
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
}

function setActive(level: MenuLevel, index: number): void {
  level.items[level.active]?.classList.remove('active');
  level.active = index;
  const item = level.items[index];
  if (!item) return;
  item.classList.add('active');
  item.focus();
}

/** Hover moves the highlight (as the arrows do); a click runs the item. */
function wireLevel(level: MenuLevel, run: (index: number) => void, hovered?: (index: number) => void): void {
  level.root.addEventListener('mousemove', (event) => {
    const i = itemIndex(level, event.target);
    if (i >= 0 && i !== level.active && level.enabled[i]) {
      setActive(level, i);
      hovered?.(i);
    }
  });
  level.root.addEventListener('click', (event) => {
    const i = itemIndex(level, event.target);
    if (i >= 0 && level.enabled[i]) run(i);
  });
}

function openCardMenu(ref: CardRef, anchor?: { x: number; y: number }): void {
  closeCardMenu(false);
  closePreview();
  if (!current) return;
  const card = cardElement(ref);
  if (!card || !current.view.lanes[ref.lane]?.cards[ref.card]) return;
  const { view, version } = current;
  const entries = cardMenuEntries(view, ref, view.strings);
  const root = renderCardMenu(document, entries, view.strings.cardMenu) as HTMLElement;
  document.body.append(root);
  const rect = card.getBoundingClientRect();
  placeAt(root, anchor ?? { x: rect.right - 24, y: rect.top + 24 });
  card.classList.add('menu-open');
  const open: OpenMenu = { ref, view, version, entries, main: menuLevel(root) };
  menu = open;
  root.addEventListener('keydown', (event) => onMenuKey(open, event, false));
  wireLevel(open.main, (i) => activateMain(open, i), (i) => hoverMain(open, i));
  setActive(open.main, firstEnabled(open.main.enabled));
}

// Resting the pointer on "Move to lane" opens the lane list after a short delay, as
// native menus do; moving to another item closes it.
const SUBMENU_DELAY_MS = 250;
let submenuTimer: ReturnType<typeof setTimeout> | undefined;

function hoverMain(open: OpenMenu, i: number): void {
  clearTimeout(submenuTimer);
  const entry = entryAt(open, i);
  if (entry?.kind === 'item' && entry.submenu) {
    if (open.sub?.parent === i) return;
    submenuTimer = setTimeout(() => {
      if (menu === open && open.main.active === i) openLaneMenu(open, i, false);
    }, SUBMENU_DELAY_MS);
  } else if (open.sub) {
    closeLaneMenu(open, false);
  }
}

/** Entry for the i-th menu item (`data-index` counts separators too). */
function entryAt(open: OpenMenu, i: number): CardMenuEntry | undefined {
  const index = Number(open.main.items[i]?.dataset['index']);
  return open.entries[index];
}

function activateMain(open: OpenMenu, i: number): void {
  const entry = entryAt(open, i);
  if (!entry || entry.kind !== 'item' || !open.main.enabled[i]) return;
  if (entry.submenu) openLaneMenu(open, i);
  else perform(open, entry.id);
}

/** Opens the lane list; `focusFirst` is false when the pointer opened it (focus stays put). */
function openLaneMenu(open: OpenMenu, parent: number, focusFirst = true): void {
  closeLaneMenu(open, false);
  const choices = laneChoices(open.view, open.ref);
  const root = renderLaneMenu(document, choices, open.view.strings.moveToLane, open.view.strings.done) as HTMLElement;
  document.body.append(root);
  const item = open.main.items[parent]!;
  const rect = item.getBoundingClientRect();
  // Beside the item; to its left when the right side has no room.
  placeAt(root, { x: rect.right + 2, y: rect.top - 5 });
  if (root.getBoundingClientRect().left < rect.right) {
    const width = root.getBoundingClientRect().width;
    placeAt(root, { x: Math.max(4, rect.left - 2 - width), y: rect.top - 5 });
  }
  item.setAttribute('aria-expanded', 'true');
  const sub = { ...menuLevel(root), choices, parent };
  open.sub = sub;
  root.addEventListener('keydown', (event) => onMenuKey(open, event, true));
  wireLevel(sub, (i) => perform(open, 'move-to', sub.choices[i]!.lane));
  if (focusFirst) setActive(sub, firstEnabled(sub.enabled));
}

function closeLaneMenu(open: OpenMenu, focusParent: boolean): void {
  const sub = open.sub;
  if (!sub) return;
  open.sub = undefined;
  sub.root.remove();
  open.main.items[sub.parent]?.setAttribute('aria-expanded', 'false');
  if (focusParent) setActive(open.main, sub.parent);
}

function closeCardMenu(returnFocus: boolean): void {
  clearTimeout(submenuTimer);
  const open = menu;
  if (!open) return;
  menu = undefined;
  closeLaneMenu(open, false);
  open.main.root.remove();
  const card = cardElement(open.ref);
  card?.classList.remove('menu-open');
  if (returnFocus) card?.focus();
}

function onMenuKey(open: OpenMenu, event: KeyboardEvent, inSub: boolean): void {
  // Menu keys never reach the board handler or VS Code.
  event.stopPropagation();
  const level = inSub ? open.sub : open.main;
  if (!level) return;
  const action = menuKeyAction(event);
  if (action === 'none') return;
  event.preventDefault();
  switch (action) {
    case 'next':
    case 'prev':
      setActive(level, moveSelection(level.enabled, level.active, action === 'next' ? 1 : -1));
      break;
    case 'first':
      setActive(level, firstEnabled(level.enabled));
      break;
    case 'last':
      setActive(level, lastEnabled(level.enabled));
      break;
    case 'activate':
      if (!level.enabled[level.active]) break;
      if (open.sub && inSub) perform(open, 'move-to', open.sub.choices[level.active]!.lane);
      else activateMain(open, level.active);
      break;
    case 'open-submenu': {
      const entry = entryAt(open, level.active);
      if (!inSub && entry?.kind === 'item' && entry.submenu) activateMain(open, level.active);
      break;
    }
    case 'close-submenu':
      if (inSub) closeLaneMenu(open, true);
      break;
    case 'close': {
      // Escape steps back one level; Tab leaves the menu.
      const { key } = event;
      if (inSub && key === 'Escape') closeLaneMenu(open, true);
      else closeCardMenu(true);
      break;
    }
  }
}

function focusAfter(focus: CardRef | { readonly lane: number }): void {
  pendingFocus = 'card' in focus ? { kind: 'card', ref: focus } : { kind: 'lane', lane: focus.lane };
}

/** Runs a menu item: closes the menu, then edits, opens the add input or sends a request. */
function perform(open: OpenMenu, id: CardMenuItemId, toLane?: number): void {
  const action = cardMenuAction(open.view, open.version, open.ref, id, toLane);
  closeCardMenu(action.kind === 'none' || action.kind === 'message' || action.kind === 'request');
  switch (action.kind) {
    case 'edit':
      editCard(action.ref);
      break;
    case 'pick-date':
      openDatePicker(action.ref);
      break;
    case 'add-at':
      openAdder(action.lane, undefined, action.index);
      break;
    case 'message':
      focusAfter(action.focus);
      post(action.message);
      break;
    case 'request':
      post(action.message);
      break;
    case 'none':
      break;
  }
}

/** Delete on a selected card: the extension asks for confirmation before deleting. */
function requestDelete(ref: CardRef): void {
  if (!current) return;
  const action = cardMenuAction(current.view, current.version, ref, 'delete');
  if (action.kind !== 'message') return;
  focusAfter(action.focus);
  post(action.message);
}

// --- Date picker (kanban.md 4.8) ---------------------------------------------
// A small dialog next to the card with the browser's date field and OK / Cancel. Opened from
// the card menu or the card's first date badge (click, Enter or Space). Enter confirms,
// Escape cancels, a press outside cancels; a redraw or a drag closes it. While it is open the
// card shows no preview. The extension writes the date in the board's format.

interface OpenDatePicker {
  readonly ref: CardRef;
  readonly view: BoardView;
  readonly version: number;
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
}
let datePicker: OpenDatePicker | undefined;

function openDatePicker(ref: CardRef, anchor?: HTMLElement): void {
  closeDatePicker(false);
  closeCardMenu(false);
  closePreview();
  if (!current?.view.datePicker) return;
  const { view, version } = current;
  const card = view.lanes[ref.lane]?.cards[ref.card];
  const host = cardElement(ref);
  if (!card || !host || host.classList.contains('editing')) return;
  const root = renderDatePicker(document, view.strings, datePickerMode(card), datePickerInitial(view, card)) as HTMLElement;
  document.body.append(root);
  // Below the badge (or the card's first line), flipped to stay inside the window.
  const rect = (anchor ?? host).getBoundingClientRect();
  placeAt(root, { x: rect.left, y: (anchor ? rect.bottom : rect.top + 24) + 2 });
  host.classList.add('date-open');
  const input = root.querySelector<HTMLInputElement>('input.date-picker-input')!;
  const open: OpenDatePicker = { ref, view, version, root, input };
  datePicker = open;
  root.addEventListener('keydown', (event) => {
    // Keys in the picker never reach the board handler or VS Code.
    event.stopPropagation();
    const action = datePickerKeyAction(event);
    if (action === 'none') return;
    // Enter on a button presses it (the browser default); elsewhere it confirms.
    if (action === 'confirm' && (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    if (action === 'confirm') confirmDatePicker(open);
    else closeDatePicker(true);
  });
  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-picker]');
    if (button?.dataset['picker'] === 'ok') confirmDatePicker(open);
    else if (button?.dataset['picker'] === 'cancel') closeDatePicker(true);
  });
  // Tab out of the picker cancels it, as a press outside does.
  root.addEventListener('focusout', (event) => {
    const to = event.relatedTarget as Node | null;
    if (to !== null && datePicker === open && !root.contains(to)) closeDatePicker(false);
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  input.focus();
}

/** Sends the picked date; an empty or invalid field keeps the picker open. */
function confirmDatePicker(open: OpenDatePicker): void {
  if (datePicker !== open) return;
  const message = setDateMessage(open.view, open.version, open.ref, open.input.value);
  if (message === undefined) {
    open.input.setAttribute('aria-invalid', 'true');
    open.input.focus();
    return;
  }
  // The card keeps the focus: now (no redraw follows an unchanged date) and after the redraw.
  closeDatePicker(true);
  pendingFocus = { kind: 'card', ref: open.ref };
  post(message);
}

function closeDatePicker(returnFocus: boolean): void {
  const open = datePicker;
  if (!open) return;
  datePicker = undefined;
  open.root.remove();
  const card = cardElement(open.ref);
  card?.classList.remove('date-open');
  if (returnFocus) card?.focus();
}

// A press outside an open menu or date picker closes it (the press itself sets the focus).
document.addEventListener(
  'mousedown',
  (event) => {
    const target = event.target as Node;
    if (datePicker && !datePicker.root.contains(target)) closeDatePicker(false);
    if (!menu) return;
    if (menu.main.root.contains(target) || menu.sub?.root.contains(target)) return;
    closeCardMenu(false);
  },
  true,
);
window.addEventListener('blur', () => {
  // The date picker stays: the browser's calendar may take the window focus.
  closeCardMenu(false);
  closePreview();
  pointerDown = false;
});
window.addEventListener('resize', () => {
  closeCardMenu(false);
  closeDatePicker(false);
  closePreview();
});

// --- Card preview (kanban.md 3.3) --------------------------------------------
// Opens when the pointer rests 500ms on a card with a body, or with Ctrl+K Ctrl+I on a
// selected card; not while a button is held, during a drag, or while that card's editor or
// menu is open. Closes 150ms after the pointer has left both card and popup, on Escape (the
// focus stays on the card), on a scroll outside the popup, when a drag starts, and when a
// redraw removes the card. One at a time. Read-only: nothing in it takes keyboard focus;
// wikilinks open the note as on the board.

interface OpenPreview {
  readonly ref: CardRef;
  readonly id: CardIdentity;
  readonly root: HTMLElement;
  readonly byKeyboard: boolean;
}
let preview: OpenPreview | undefined;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewCloseTimer: ReturnType<typeof setTimeout> | undefined;
/** The card under the pointer; the open timer belongs to it. */
let hovered: HTMLElement | undefined;
let pointerDown = false;
const PREVIEW_ID = 'card-preview';

const sameRef = (a: CardRef | undefined, b: CardRef | undefined): boolean =>
  a !== undefined && b !== undefined && a.lane === b.lane && a.card === b.card;

function openPreview(ref: CardRef, byKeyboard: boolean): void {
  clearTimeout(previewTimer);
  if (!current) return;
  const view = current.view;
  const card = view.lanes[ref.lane]?.cards[ref.card];
  const host = cardElement(ref);
  if (!host || !canPreview(view, card)) return;
  if (!previewOnHover(isFolded(folds, view, card), byKeyboard)) return;
  // Not over an editor, an open menu or date picker, or a drag; a held button only stops the pointer route.
  if (drag || datePicker || host.classList.contains('editing') || host.classList.contains('menu-open') || (!byKeyboard && pointerDown)) return;
  closePreview();
  const root = renderCardPreview(document, view, card, PREVIEW_ID) as HTMLElement;
  document.body.append(root);
  const rect = host.getBoundingClientRect();
  const size = root.getBoundingClientRect();
  const { x, y } = placePreview(rect, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight });
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  host.setAttribute('aria-describedby', PREVIEW_ID);
  const open: OpenPreview = { ref, id: card.id, root, byKeyboard };
  preview = open;
  // The pointer may cross over to the popup (to click a link or scroll) without closing it.
  root.addEventListener('mouseenter', () => clearTimeout(previewCloseTimer));
  root.addEventListener('mouseleave', (event) => {
    if (!cardElement(open.ref)?.contains(event.relatedTarget as Node | null)) schedulePreviewClose();
  });
  root.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-action="open-link"]');
    if (link) post({ type: 'openLink', target: link.dataset['target'] ?? '' });
  });
}

/** Closes the open preview and cancels a pending one (redraw, drag, editor, key). */
function closePreview(): void {
  clearTimeout(previewTimer);
  removePreview();
}

/** Closes the open preview only. */
function removePreview(): void {
  clearTimeout(previewCloseTimer);
  const open = preview;
  if (!open) return;
  preview = undefined;
  open.root.remove();
  cardElement(open.ref)?.removeAttribute('aria-describedby');
}

/**
 * The grace close after the pointer left card and popup. It must not cancel the timer of the
 * card the pointer moved on to, or that card would never open its preview.
 */
function schedulePreviewClose(): void {
  clearTimeout(previewCloseTimer);
  previewCloseTimer = setTimeout(removePreview, PREVIEW_CLOSE_MS);
}

app.addEventListener('mouseover', (event) => {
  const card = (event.target as HTMLElement).closest<HTMLElement>('li.card') ?? undefined;
  // Moving between the parts of one card changes nothing.
  if (card === hovered) return;
  hovered = card;
  clearTimeout(previewTimer);
  const ref = card && cardRefOf(card);
  if (!ref) return;
  if (preview && sameRef(preview.ref, ref)) {
    clearTimeout(previewCloseTimer);
    return;
  }
  previewTimer = setTimeout(() => {
    if (hovered === card && card?.isConnected) openPreview(ref, false);
  }, PREVIEW_DELAY_MS);
});

app.addEventListener('mouseout', (event) => {
  const card = (event.target as HTMLElement).closest<HTMLElement>('li.card');
  const to = event.relatedTarget as Node | null;
  if (!card || card.contains(to)) return;
  if (hovered === card) {
    hovered = undefined;
    clearTimeout(previewTimer);
  }
  if (preview && sameRef(preview.ref, cardRefOf(card)) && !preview.root.contains(to)) schedulePreviewClose();
});

// A preview opened from the keyboard closes when the focus leaves its card.
app.addEventListener('focusout', (event) => {
  if (!preview?.byKeyboard) return;
  const to = event.relatedTarget as Node | null;
  const card = cardElement(preview.ref);
  if (card && !card.contains(to) && !preview.root.contains(to)) closePreview();
});

document.addEventListener(
  'mousedown',
  () => {
    pointerDown = true;
    clearTimeout(previewTimer);
  },
  true,
);
document.addEventListener('mouseup', () => void (pointerDown = false), true);
// Scrolling the board or a lane moves the card away from its popup; the popup scrolls itself.
document.addEventListener(
  'scroll',
  (event) => {
    if (preview && !preview.root.contains(event.target as Node)) closePreview();
    // The date picker is placed at its card; a scroll moves the card away from it.
    if (datePicker && !datePicker.root.contains(event.target as Node)) closeDatePicker(false);
  },
  true,
);

/**
 * Ctrl+K held back on a card for the Ctrl+K Ctrl+I chord (kanban.md 3.3). When another key
 * follows, VS Code gets the Ctrl+K first (replayed on the window, where its webview host
 * listens and forwards keys by key, code and keyCode) and then that key, so its own Ctrl+K
 * chords still work from a selected card. Forgotten after 5s, as VS Code leaves a chord.
 */
let chordStart: { ctrlKey: boolean; metaKey: boolean } | undefined;
let chordTimer: ReturnType<typeof setTimeout> | undefined;
const CHORD_TIMEOUT_MS = 5000;

function replayChordStart(start: { ctrlKey: boolean; metaKey: boolean }): void {
  const replay = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: start.ctrlKey, metaKey: start.metaKey, bubbles: true, cancelable: true });
  // KeyboardEvent init cannot set keyCode, which VS Code reads on Windows.
  Object.defineProperty(replay, 'keyCode', { value: 75 });
  window.dispatchEvent(replay);
}

// Keyboard help: Escape hides the tooltip (WCAG 1.4.13) until the pointer or focus leaves.
function wireHelp(): void {
  const help = app.querySelector<HTMLElement>('.board-help');
  if (!help) return;
  const reset = (): void => help.classList.remove('dismissed');
  help.addEventListener('mouseleave', reset);
  help.addEventListener('blur', reset);
}

document.addEventListener('keydown', (event) => {
  const { key } = event;
  if (key === 'Escape') {
    app.querySelector('.board-help')?.classList.add('dismissed');
    // The preview closes; the focus stays where it is (the card).
    closePreview();
  }
});

/**
 * The redraw replaces the collapse button, so its icon would jump to the new angle.
 * Start the new one at the old state and flip it on the next style pass so the
 * rotation runs (kanban.css; none with reduced motion). Focus stays on the button.
 */
function turnCollapseIcon(lane: number, focus: boolean): void {
  turnIcon(app.querySelector<HTMLElement>(`section.lane[data-lane="${lane}"] button.lane-collapse`), focus);
}

function turnIcon(button: HTMLElement | null, focus: boolean): void {
  if (!button) return;
  button.classList.add('turn-from');
  void button.offsetWidth;
  button.classList.remove('turn-from');
  if (focus) button.focus();
}

/** The focused card keeps the focus across the next redraw. */
function keepFocusedCard(): void {
  const ref = cardRefOf(document.activeElement);
  if (ref && document.activeElement?.matches('li.card')) pendingFocus = { kind: 'card', ref };
}

/** Folds or unfolds a card body (kanban.md 3.2); `folded` undefined toggles. Focus goes to the card. */
function foldBody(ref: CardRef, folded?: boolean): void {
  if (!current) return;
  const view = current.view;
  const card = view.lanes[ref.lane]?.cards[ref.card];
  if (!card || card.body.length === 0) return;
  const now = isFolded(folds, view, card);
  const next = folded ?? !now;
  if (next === now) return;
  folds = setFolded(folds, view, card, next);
  saveState();
  pendingFocus = { kind: 'card', ref };
  draw();
  turnIcon(cardElement(ref)?.querySelector<HTMLElement>('button.body-toggle') ?? null, false);
}

/**
 * Lane fold toggle (kanban.md 3.2): folds every card body of the lane when any is expanded,
 * else unfolds them all; kept per card. A focused toggle keeps the focus across the redraw.
 */
function foldLane(lane: number, hadFocus: boolean): void {
  if (!current) return;
  const view = current.view;
  const laneView = view.lanes[lane];
  if (!laneView) return;
  folds = setLaneFolded(folds, view, laneView, laneFoldAction(folds, view, laneView) === 'fold');
  saveState();
  draw();
  if (hadFocus) app.querySelector<HTMLElement>(`section.lane[data-lane="${lane}"] button.lane-bodies`)?.focus();
}

app.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>('[data-action]');
  if (!current || !action) return;
  const lane = laneOf(action);
  switch (action.dataset['action']) {
    case 'open-link':
      post({ type: 'openLink', target: action.dataset['target'] ?? '' });
      break;
    case 'collapse':
      if (lane !== undefined) {
        const isCollapsed = collapsed.get(lane) ?? current.view.lanes[lane]?.collapsed ?? false;
        collapsed.set(lane, !isCollapsed);
        const hadFocus = document.activeElement === action;
        draw();
        turnCollapseIcon(lane, hadFocus);
      }
      break;
    case 'add-card':
      if (lane !== undefined) openAdder(lane);
      break;
    case 'toggle-checkboxes':
      if (document.activeElement === action) pendingFocus = { kind: 'checkboxes' };
      post({ type: 'setShowCheckboxes', version: current.version, value: !current.view.showCheckboxes });
      break;
    case 'toggle-lane-bodies':
      if (lane !== undefined) foldLane(lane, document.activeElement === action);
      break;
    case 'toggle-body': {
      const ref = cardRefOf(action);
      if (ref) foldBody(ref);
      break;
    }
    case 'pick-date': {
      const ref = cardRefOf(action);
      if (ref) openDatePicker(ref, action);
      break;
    }
    case 'card-menu': {
      const ref = cardRefOf(action);
      if (ref) {
        const rect = action.getBoundingClientRect();
        cardElement(ref)?.focus();
        openCardMenu(ref, { x: rect.left, y: rect.bottom + 2 });
      }
      break;
    }
  }
});

// Right-click on a card opens its menu instead of the browser one. VS Code's own webview
// context menu skips events that are already defaultPrevented.
app.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea')) return;
  const card = target.closest<HTMLElement>('li.card');
  // A card being edited keeps the browser menu (cut, copy, paste).
  if (!card || card.classList.contains('editing')) return;
  const ref = cardRefOf(card);
  if (!ref) return;
  event.preventDefault();
  card.focus();
  openCardMenu(ref, { x: event.clientX, y: event.clientY });
});

// Width slider (kanban.md 4.10): the lanes follow every move; `change` (let go, or each key)
// schedules the write, so a drag or a run of keys is one edit.
app.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;
  if (!(target instanceof HTMLInputElement) || !target.matches('input.board-lane-width')) return;
  clearTimeout(widthTimer);
  widthTimer = undefined;
  widthDraft = { value: Number(target.value), sent: false };
  showLaneWidth();
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (target.matches('input.board-lane-width')) {
    clearTimeout(widthTimer);
    widthTimer = setTimeout(writeLaneWidth, WIDTH_WRITE_DELAY_MS);
    return;
  }
  const ref = cardRefOf(target);
  if (current && ref && target.matches('input.card-check')) {
    pendingFocus = { kind: 'card', ref };
    post(toggleMessage(current.view, current.version, ref));
  }
});

app.addEventListener('dblclick', (event) => {
  const target = event.target as HTMLElement;
  if (target.matches('input.board-lane-width')) {
    resetLaneWidth();
    return;
  }
  // Links, fields and buttons (a quick second click on the fold toggle) do not open the editor.
  if (target.closest('[data-action="open-link"], [data-action="toggle-body"], [data-action="pick-date"], input, textarea, button')) return;
  if (target.closest('.lane-title')) {
    const lane = laneOf(target);
    if (lane !== undefined) renameLane(lane);
    return;
  }
  const ref = cardRefOf(target);
  if (ref) editCard(ref);
});

const ARROWS: Readonly<Record<string, Direction>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * A key the board handled: stop the browser default and keep the event from reaching
 * the window. VS Code's webview host listens for keydown on the window (bubble phase) and
 * forwards every event to the workbench keybindings without checking defaultPrevented
 * (webview/browser/pre/index.html, handleInnerKeydown), so Alt+Left would also run
 * 'Go Back'. Keys the board does not handle still bubble to VS Code as usual.
 */
function consume(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

app.addEventListener('keydown', (event) => {
  if (!current) return;
  const { key, altKey } = event;
  const target = event.target as HTMLElement;
  const { version, view } = current;
  const direction = ARROWS[key];

  // Ctrl+K Ctrl+I on a selected card: the card preview (kanban.md 3.3).
  const chord = chordStep(chordStart !== undefined, event, target.matches('li.card'));
  if (chord === 'start') {
    chordStart = { ctrlKey: event.ctrlKey, metaKey: event.metaKey };
    clearTimeout(chordTimer);
    chordTimer = setTimeout(() => void (chordStart = undefined), CHORD_TIMEOUT_MS);
    consume(event);
    return;
  }
  if (chord === 'wait') return;
  if (chord === 'open' || chord === 'replay') {
    const start = chordStart!;
    chordStart = undefined;
    clearTimeout(chordTimer);
    if (chord === 'replay') {
      // Not ours: VS Code gets Ctrl+K, then this key bubbles on as the chord's second key.
      replayChordStart(start);
      return;
    }
    const ref = cardRefOf(target);
    if (ref && target.matches('li.card')) openPreview(ref, true);
    consume(event);
    return;
  }

  if (target.matches('[data-action="open-link"]') && key === 'Enter') {
    post({ type: 'openLink', target: target.dataset['target'] ?? '' });
    consume(event);
    return;
  }
  // The card's first date badge is a button: Enter or Space opens the date picker (kanban.md 4.8).
  if (target.matches('[data-action="pick-date"]') && isPickDateKey(event)) {
    const ref = cardRefOf(target);
    if (ref) openDatePicker(ref, target);
    consume(event);
    return;
  }

  // N on a selected card or lane title: add cards at the end of that lane (kanban.md 4.4.1).
  if (isAddCardShortcut(event) && (target.matches('li.card') || target.matches('.lane-title'))) {
    const lane = laneOf(target);
    if (lane !== undefined) openAdder(lane);
    consume(event);
    return;
  }

  // Card menu and Delete on a selected card (kanban.md 4.6).
  if (target.matches('li.card') && isCardMenuShortcut(event)) {
    const ref = cardRefOf(target);
    if (ref) openCardMenu(ref);
    consume(event);
    return;
  }
  // Fold or unfold the selected card's body (kanban.md 3.2).
  const fold = target.matches('li.card') ? bodyFoldShortcut(event) : undefined;
  if (fold !== undefined) {
    const ref = cardRefOf(target);
    if (ref) foldBody(ref, fold === 'fold');
    consume(event);
    return;
  }
  // Ctrl+Enter: the card's lines in a text editor beside the board (kanban.md 4.7).
  if (target.matches('li.card') && isOpenInTextShortcut(event)) {
    const ref = cardRefOf(target);
    const card = ref && view.lanes[ref.lane]?.cards[ref.card];
    if (card) post(openInTextMessage(version, card.id));
    consume(event);
    return;
  }
  if (target.matches('li.card') && isDeleteShortcut(event)) {
    const ref = cardRefOf(target);
    if (ref) requestDelete(ref);
    consume(event);
    return;
  }

  if (target.matches('.lane-title')) {
    const lane = laneOf(target);
    if (lane === undefined) return;
    if ((key === 'F2' || key === 'Enter') && !altKey) {
      renameLane(lane);
      consume(event);
    } else if (altKey && (direction === 'left' || direction === 'right')) {
      const move = keyboardMoveLane(view, version, lane, direction);
      if (move) {
        pendingFocus = { kind: 'lane', lane: move.focus };
        post(move.message);
      }
      consume(event);
    }
    return;
  }

  const ref = target.matches('li.card') ? cardRefOf(target) : undefined;
  if (!ref) return;
  if (direction !== undefined && altKey) {
    const move = keyboardMoveCard(view, version, ref, direction);
    if (move) {
      pendingFocus = { kind: 'card', ref: move.focus };
      post(move.message);
    }
    consume(event);
  } else if (direction !== undefined) {
    const next = navigate(view, ref, direction);
    if (next) cardElement(next)?.focus();
    consume(event);
  } else if (key === ' ') {
    pendingFocus = { kind: 'card', ref };
    post(toggleMessage(view, version, ref));
    consume(event);
  } else if (key === 'F2' || key === 'Enter') {
    editCard(ref);
    consume(event);
  }
});

// Drag and drop: cards between/within lanes, lanes by their header. The drag keeps the
// view and version it started from (see DragSession); a redraw ends it.

function clearDropMarks(): void {
  for (const node of app.querySelectorAll('.drop-before, .drop-after, .drop-into')) {
    node.classList.remove('drop-before', 'drop-after', 'drop-into');
  }
}

/** Where a drop at this point would go: lane index and "before" position in the drag's view. */
function dropPoint(event: DragEvent): { lane: number; before: number; mark: Element; cls: string } | undefined {
  const target = event.target as HTMLElement;
  if (drag?.kind === 'card') {
    const li = target.closest<HTMLElement>('li.card');
    if (li) {
      const rect = li.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const card = Number(li.dataset['card']);
      return { lane: Number(li.dataset['lane']), before: after ? card + 1 : card, mark: li, cls: after ? 'drop-after' : 'drop-before' };
    }
    const section = target.closest<HTMLElement>('section.lane');
    if (section) {
      const lane = Number(section.dataset['lane']);
      return { lane, before: drag.view.lanes[lane]?.cards.length ?? 0, mark: section, cls: 'drop-into' };
    }
  } else if (drag?.kind === 'lane') {
    const section = target.closest<HTMLElement>('section.lane');
    if (section) {
      const rect = section.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      const lane = Number(section.dataset['lane']);
      return { lane, before: after ? lane + 1 : lane, mark: section, cls: after ? 'drop-after' : 'drop-before' };
    }
  }
  return undefined;
}

app.addEventListener('dragstart', (event) => {
  drag = undefined;
  closePreview();
  closeDatePicker(false);
  if (!current) return;
  const { version, view } = current;
  const target = event.target as HTMLElement;
  if (target.matches('li.card')) {
    const ref = cardRefOf(target);
    if (ref) drag = { kind: 'card', ref, view, version };
  } else if (target.matches('header.lane-header')) {
    const lane = laneOf(target);
    if (lane !== undefined) drag = { kind: 'lane', lane, view, version };
  }
  if (!drag) return;
  (drag.kind === 'lane' ? target.closest('section.lane') : target)?.classList.add('dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Some hosts need data for a drag to start; it is never read back.
    event.dataTransfer.setData('text/plain', '');
  }
});

app.addEventListener('dragover', (event) => {
  const point = dropPoint(event);
  if (!point) return;
  event.preventDefault();
  clearDropMarks();
  point.mark.classList.add(point.cls);
});

app.addEventListener('drop', (event) => {
  const point = dropPoint(event);
  clearDropMarks();
  const session = drag;
  drag = undefined;
  if (!point || !session) return;
  event.preventDefault();
  const message = dropMessage(session, point.lane, point.before);
  if (message?.type === 'moveCard') pendingFocus = { kind: 'card', ref: { lane: point.lane, card: message.toIndex } };
  post(message);
});

app.addEventListener('dragend', () => {
  drag = undefined;
  clearDropMarks();
  for (const node of app.querySelectorAll('.dragging')) node.classList.remove('dragging');
});

post({ type: 'ready' });
