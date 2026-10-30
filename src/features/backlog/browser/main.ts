// Backlog webview entry (browser). Holds the last view and the UI state, draws through the
// DOM-free renderers and wires DOM events to messages by delegation. Text is never inserted
// as markup.
import { createElementFactory } from '../../../webview/dom.ts';
import { LIMITS, type ExtensionMessage } from '../messages.ts';
import type { BacklogView, TaskDetail, TaskSummary } from '../view.ts';
import {
  boardColumns,
  filterOptions,
  format,
  filterTasks,
  nextSort,
  restoreUiState,
  sortTasks,
  SORT_COLUMNS,
  type BoardColumn,
  type SortColumn,
  type UiState,
  withDefaultStrings,
  clampColumnWidth,
  columnKeyWidth,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from './filters.ts';
import {
  altSideArrow,
  altVerticalArrow,
  CompositionGuard,
  dropIndex,
  dropStatus,
  findCard,
  moveInColumnMessage,
  isOpenShortcut,
  isUndoShortcut,
  navigateBoard,
  navigateList,
  neighbourStatus,
  plainArrow,
  setStatusMessage,
  stepIndex,
  type OutgoingMessage,
} from './interactions.ts';
import { detailSize, dragDetailSize, splitterKey, splitterValues, storedShare, type DetailPosition } from './layout.ts';
import { renderBoard, renderNotices, renderSearch, renderToolbar } from './render-board.ts';
import { addChipValues, addCommentMessage, hasUnclosedFence, removeChipValue, setFieldMessage, setListMessage, setSectionMessage, type ScalarField } from './detail-edit.ts';
import { LIST_FIELDS, listValues, readOnlyText, renderDetail, sectionText, type DetailEditOptions, type EditSection, type ListField, type OpenEditor } from './render-detail.ts';
import { renderList } from './render-list.ts';

interface VsCodeApi {
  postMessage(message: OutgoingMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const el = createElementFactory(document);
const app = document.getElementById('app')!;

let view: BacklogView | undefined;
let state: UiState = restoreUiState(vscode.getState());
/**
 * The project's Backlog folder, from the page. Saved with the view state so that VS Code, after
 * a restart, gives it back and the panel shows the same project (backlog.md 4.1).
 */
const project = document.body.dataset['project'];
const saveState = (): void => vscode.setState(project === undefined ? state : { ...state, project });
let detail: TaskDetail | undefined;
/** What the content area shows now (for keyboard navigation and drops). */
let columns: BoardColumn[] = [];
/** The board's columns as drawn: each cut to its cards on screen (keyboard navigation). */
let shownColumns: BoardColumn[] = [];
/** List rows as drawn (keyboard navigation). */
let rows: TaskSummary[] = [];

/**
 * Render caps (backlog.md 4.2, 4.3): thousands of cards or rows take seconds to draw, on every
 * redraw. Beyond the cap a "Show all (M)" button draws the rest; the selected task and the one
 * about to get focus are always drawn. Moves and drops still work on the whole column.
 */
const BOARD_CAP = 300;
const LIST_CAP = 1000;
/** Columns (by status) and the list ('list') shown in full; cleared when search or filters change. */
const expanded = new Set<string>();

function visibleCount(id: string, tasks: readonly TaskSummary[], cap: number): number {
  if (expanded.has(id)) return tasks.length;
  let count = Math.min(cap, tasks.length);
  for (const path of [state.selected, pendingFocus]) {
    if (path === null || path === undefined) continue;
    const index = tasks.findIndex((t) => t.path === path);
    if (index >= count) count = index + 1;
  }
  return count;
}

const columnId = (column: BoardColumn): string => `column:${column.known ? column.status : ''}`;
/** Path to focus after the next content draw (after a status change or reload). */
let pendingFocus: string | undefined;
/** The card being dragged, as it was when the drag started. */
let drag: TaskSummary | undefined;
let firstRender = true;
/** The project behind the panel is gone until the next render ('unavailable'). */
let unavailable = false;
/** The draw-failure notice was shown (once per panel). */
let drawFailureShown = false;

const search = renderSearch(document, '', state.search) as HTMLInputElement;
/** Redrawn toolbar parts; replaced as a whole, so this always points at the live node. */
let toolbarParts: HTMLElement = el('div', { className: 'toolbar-parts' });
const toolbar = el('div', { className: 'toolbar' }, toolbarParts, search);
const errorHost = el('div', { className: 'notice error', attrs: { role: 'alert', hidden: '' } });
const noticeHost = el('div', { className: 'notices' });
const content = el('main', { className: 'content' });
const detailPane = el('aside', { className: 'detail-pane', attrs: { id: 'detail-pane', hidden: '' } });
/** Between the board/list and the detail (backlog.md 4.1): drag, arrows, double-click resets. */
const splitter = el('div', { className: 'splitter', attrs: { role: 'separator', tabindex: '0', 'aria-controls': 'detail-pane', hidden: '' } });
const layout = el('div', { className: 'layout position-bottom' }, content, splitter, detailPane);
app.append(toolbar, errorHost, noticeHost, layout);

/** This page load; the extension drops messages from an older one after a new 'ready'. */
const instance = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

function post(message: OutgoingMessage | undefined): void {
  if (message !== undefined) vscode.postMessage({ ...message, instance });
}

function update(change: Partial<UiState>, persist = true): void {
  // Another search or filter shows other tasks: the render caps apply again.
  if (['search', 'status', 'milestone', 'label', 'assignee'].some((k) => k in change && change[k as keyof UiState] !== state[k as keyof UiState])) {
    expanded.clear();
  }
  state = { ...state, ...change };
  saveState();
  if (persist && (change.columnWidths !== undefined || change.paneSizes !== undefined)) scheduleSaveLayout();
}

/** Column widths and pane sizes also go to the extension, which keeps them after the panel closes. */
let saveLayoutTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSaveLayout(): void {
  if (saveLayoutTimer !== undefined) clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => {
    saveLayoutTimer = undefined;
    const message: Record<string, unknown> = { type: 'saveLayout' };
    for (const [column, width] of Object.entries(state.columnWidths)) if (typeof width === 'number') message[column] = Math.round(width);
    for (const [pos, share] of Object.entries(state.paneSizes)) {
      if (typeof share === 'number') message[pos] = Math.min(999, Math.max(1, Math.round(share * 1000)));
    }
    post(message as unknown as OutgoingMessage);
  }, 300);
}

/** A fresh panel (no state of its own) starts from the layout the extension remembered. */
function adoptStoredLayout(stored: BacklogView['layout']): void {
  const change: { -readonly [K in keyof UiState]?: UiState[K] } = {};
  if (Object.keys(state.columnWidths).length === 0 && Object.keys(stored.columnWidths).length > 0) {
    change.columnWidths = stored.columnWidths as UiState['columnWidths'];
  }
  if (state.paneSizes.bottom === undefined && state.paneSizes.right === undefined) {
    const paneSizes: { bottom?: number; right?: number } = {};
    if (stored.paneSizes.bottom !== undefined) paneSizes.bottom = stored.paneSizes.bottom / 1000;
    if (stored.paneSizes.right !== undefined) paneSizes.right = stored.paneSizes.right / 1000;
    if (paneSizes.bottom !== undefined || paneSizes.right !== undefined) change.paneSizes = paneSizes;
  }
  if (Object.keys(change).length > 0) update(change, false);
}

/** Focus survives a redraw of `host` when an element with the same identity comes back. */
function focusIdentity(host: HTMLElement): string | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !host.contains(active)) return undefined;
  const attrs = ['data-action', 'data-filter', 'data-mode', 'data-position', 'data-column', 'data-path', 'data-list', 'data-line', 'data-url', 'data-field', 'data-section', 'data-editor'];
  const parts = attrs.filter((a) => active.hasAttribute(a)).map((a) => `[${a}="${CSS.escape(active.getAttribute(a)!)}"]`);
  if (active.classList.contains('help')) parts.push('.help');
  return parts.length > 0 ? `${active.tagName.toLowerCase()}${parts.join('')}` : undefined;
}

function restoreFocus(host: HTMLElement, identity: string | undefined): void {
  if (identity !== undefined) host.querySelector<HTMLElement>(identity)?.focus();
}

function itemFor(path: string): HTMLElement | null {
  return content.querySelector<HTMLElement>(`[data-action="show-task"][data-path="${CSS.escape(path)}"]`);
}

function drawToolbarUnguarded(): void {
  if (!view) return;
  const identity = focusIdentity(toolbarParts);
  search.placeholder = view.strings.searchPlaceholder;
  search.setAttribute('aria-label', view.strings.searchPlaceholder);
  const fresh = renderToolbar(document, view, state, filterOptions(view, view.strings), position());
  toolbarParts.replaceWith(fresh);
  toolbarParts = fresh;
  restoreFocus(fresh, identity);
}

function drawContentUnguarded(): void {
  if (unavailable) {
    const strings = view?.strings ?? withDefaultStrings(undefined);
    content.replaceChildren(el('p', { className: 'empty', text: strings.projectUnavailable, attrs: { role: 'status' } }));
    columns = [];
    shownColumns = [];
    rows = [];
    return;
  }
  if (!view) return;
  const active = document.activeElement;
  if (pendingFocus === undefined && active instanceof HTMLElement && content.contains(active)) {
    pendingFocus = active.closest<HTMLElement>('[data-action="show-task"]')?.dataset['path'];
  }
  // A focused header control (sort button, width handle) comes back focused too.
  const identity = pendingFocus === undefined ? focusIdentity(content) : undefined;
  const scroll = { top: content.scrollTop, left: content.querySelector('.board')?.scrollLeft ?? 0 };
  // Rendered first and assigned after, so a renderer failure leaves the shown content as it was.
  if (state.mode === 'board') {
    const nextColumns = boardColumns(view, filterTasks(view, state, false));
    const limits = nextColumns.map((column) => visibleCount(columnId(column), column.tasks, BOARD_CAP));
    content.replaceChildren(renderBoard(document, view, nextColumns, { selected: state.selected, limits }));
    columns = nextColumns;
    shownColumns = nextColumns.map((column, i) => ({ ...column, tasks: column.tasks.slice(0, limits[i]) }));
    rows = [];
  } else {
    const nextRows = sortTasks(filterTasks(view, state, true), state.sort, view);
    const limit = visibleCount('list', nextRows, LIST_CAP);
    content.replaceChildren(renderList(document, view, nextRows, { sort: state.sort, selected: state.selected, limit }));
    rows = nextRows.slice(0, limit);
    columns = [];
    shownColumns = [];
    applyColumnWidths();
  }
  content.scrollTop = scroll.top;
  const board = content.querySelector('.board');
  if (board) board.scrollLeft = scroll.left;
  if (pendingFocus !== undefined) {
    const target = itemFor(pendingFocus);
    pendingFocus = undefined;
    target?.focus({ preventScroll: false });
  } else {
    restoreFocus(content, identity);
  }
}

function drawNoticesUnguarded(): void {
  if (view) noticeHost.replaceChildren(...renderNotices(document, view));
}

function drawDetailUnguarded(): void {
  const open = view !== undefined && detail !== undefined && detail.path === state.selected;
  layout.classList.toggle('with-detail', open);
  const wasOpen = !detailPane.hidden;
  detailPane.hidden = !open;
  applyLayout();
  // Opening the detail shrinks the board/list pane: bring the selected card or row back into view.
  if (open && !wasOpen) revealSelected();
  if (!open || !view || !detail) {
    detailPane.replaceChildren();
    return;
  }
  syncDrafts();
  const identity = focusIdentity(detailPane);
  const scrollTop = detailPane.scrollTop;
  detailPane.setAttribute('aria-label', `${detail.id} ${detail.title}`);
  detailPane.replaceChildren(renderDetail(document, detail, view.strings, view.statuses, editOptions(view)));
  detailPane.scrollTop = scrollTop;
  if (detailFocus !== undefined) {
    const target = detailPane.querySelector<HTMLElement>(detailFocus);
    detailFocus = undefined;
    target?.focus();
    if (target instanceof HTMLInputElement && target.type === 'text') target.select();
    if (target instanceof HTMLTextAreaElement) target.setSelectionRange(target.value.length, target.value.length);
  } else {
    restoreFocus(detailPane, identity);
  }
}

/**
 * Runs one part's draw. A failure keeps that part's previous content and the rest of the panel
 * working: it is logged, and a notice is shown once per panel.
 */
function guarded(part: string, draw: () => void): void {
  try {
    draw();
  } catch (error) {
    console.error(`Notewell Backlog: could not draw the ${part}.`, error);
    if (!drawFailureShown && view) {
      drawFailureShown = true;
      showError(view.strings.drawFailed);
    }
  }
}

function drawToolbar(): void {
  guarded('toolbar', drawToolbarUnguarded);
}

function drawContent(): void {
  guarded('board or list', drawContentUnguarded);
}

function drawNotices(): void {
  guarded('notices', drawNoticesUnguarded);
}

function drawDetail(): void {
  guarded('task details', drawDetailUnguarded);
}

function drawAll(): void {
  drawToolbar();
  drawNotices();
  drawContent();
  drawDetail();
}

function showError(message: string | undefined): void {
  errorHost.replaceChildren();
  errorHost.hidden = message === undefined;
  if (message === undefined || !view) return;
  errorHost.append(
    el('span', { className: 'notice-text', text: message }),
    el('button', { className: 'notice-dismiss', text: '×', attrs: { type: 'button', 'data-action': 'dismiss-error', 'aria-label': view.strings.closeDetail, title: view.strings.closeDetail } }),
  );
}

function openTask(path: string): void {
  let reopened = false;
  if (state.selected !== path) {
    if (state.selected !== null) stashDrafts(state.selected);
    detail = undefined;
    resetEditing();
    reopened = restoreDrafts(path);
  }
  update({ selected: path });
  post({ type: 'showTask', path });
  // A reopened draft editor takes the focus when its detail is drawn; otherwise the card or row.
  pendingFocus = reopened ? undefined : path;
  drawContent();
  drawDetail();
}

/** A task chosen from outside the panel (an editor or the explorer). */
let pendingSelect: string | undefined;

/**
 * Opens the task's detail and brings its card or row into view with focus; filters and search
 * stay as they are, so a hidden task still gets its detail.
 */
function selectTask(path: string): void {
  openTask(path);
  itemFor(path)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTask(): void {
  const path = state.selected;
  if (path === null) return;
  update({ selected: null });
  stashDrafts(path);
  detail = undefined;
  resetEditing();
  post({ type: 'hideTask' });
  pendingFocus = path;
  drawContent();
  drawDetail();
}

function taskAt(path: string | undefined): TaskSummary | undefined {
  return path === undefined ? undefined : view?.tasks.find((t) => t.path === path);
}

/** A key the panel handled: no browser default, and VS Code's keybindings never see it. */
function consume(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

// --- Messages from the extension ----------------------------------------------

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'render':
      unavailable = false;
      // Strings missing from an extension host of another build fall back to English.
      view = { ...message.view, strings: withDefaultStrings(message.view.strings) };
      // The setting the toolbar asked for has arrived (or another window changed it).
      if (positionOverride === view.detailPosition) positionOverride = undefined;
      if (firstRender) {
        firstRender = false;
        if (view.layout !== undefined) adoptStoredLayout(view.layout);
        // After a reload the detail pane comes back with its task.
        if (state.selected !== null) {
          post({ type: 'showTask', path: state.selected });
          pendingFocus = state.selected;
        }
      }
      drawAll();
      if (pendingSelect !== undefined) {
        const path = pendingSelect;
        pendingSelect = undefined;
        selectTask(path);
      }
      break;
    case 'select':
      // The panel was opened from a task file: show that task (before the first render, later).
      if (view === undefined) pendingSelect = message.path;
      else selectTask(message.path);
      break;
    case 'detail':
      if (message.path !== state.selected) break;
      if (message.detail !== null && submitted?.done(message.detail)) submitted = undefined;
      if (message.detail !== null && detail !== undefined && holdsDraft()) {
        // Keep what the user is typing; the newer detail is drawn when the editor closes.
        deferredDetail = message.detail;
        taskGone = false;
        break;
      }
      if (message.detail === null && (detail !== undefined || editor !== null) && holdsDraft()) {
        // The task went away (another tool moved or deleted it) while the user was typing: the
        // draft stays until the editor closes, so it can be copied.
        taskGone = true;
        if (view) showError(view.strings.taskGone);
        break;
      }
      taskGone = false;
      applyDetail(message.detail);
      break;
    case 'error':
      showError(message.message);
      restoreSubmitted();
      break;
    case 'unavailable': {
      // The project is gone (for now): the old board must not stay clickable. A draft in the
      // detail stays until its editor closes, as for a task that went away.
      unavailable = true;
      const strings = view?.strings ?? withDefaultStrings(undefined);
      if (state.selected !== null && holdsDraft()) {
        taskGone = true;
        showError(strings.projectUnavailable);
      } else {
        closeTask();
      }
      drawContent();
      break;
    }
  }
});

// --- Clicks and changes ---------------------------------------------------------

function runAction(action: HTMLElement): void {
  const data = action.dataset;
  switch (data['action']) {
    case 'set-mode':
      if (data['mode'] === 'board' || data['mode'] === 'list') {
        update({ mode: data['mode'] });
        drawToolbar();
        drawContent();
      }
      break;
    case 'show-task':
      if (data['path']) openTask(data['path']);
      break;
    case 'show-all':
      showAll(data['column']);
      break;
    case 'sort': {
      const column = data['column'] as SortColumn;
      if (SORT_COLUMNS.includes(column)) {
        update({ sort: nextSort(state.sort, column) });
        drawContent();
        content.querySelector<HTMLElement>(`button[data-column="${column}"]`)?.focus();
      }
      break;
    }
    case 'open-task':
      if (data['path']) post({ type: 'openTask', path: data['path'] });
      break;
    case 'open-path':
      if (data['path']) post({ type: 'openPath', path: data['path'] });
      break;
    case 'open-url':
      if (data['url']) post({ type: 'openUrl', url: data['url'] });
      break;
    case 'close-detail':
      closeTask();
      break;
    case 'set-detail-position': {
      const next = data['position'];
      if ((next === 'bottom' || next === 'right') && next !== position()) {
        positionOverride = next;
        post({ type: 'setDetailPosition', position: next });
        drawToolbar();
        applyLayout();
        revealSelected();
      }
      break;
    }
    case 'dismiss-error':
      showError(undefined);
      break;
    case 'edit-title':
      if (detail) openEditor({ kind: 'title', draft: detail.title });
      break;
    case 'edit-section':
    case 'add-section': {
      const name = data['section'];
      if (detail && isEditSection(name)) openEditor({ kind: 'section', name, draft: sectionText(detail, name) ?? '' });
      break;
    }
    case 'save-edit':
      saveEditor();
      break;
    case 'cancel-edit':
      closeEditor();
      break;
    case 'remove-item': {
      const field = data['field'] as ListField;
      if (detail && LIST_FIELDS.includes(field)) {
        submitList(field, removeChipValue(detail, field, Number(data['index'])), '');
        detailFocus = `input[data-action="chip-input"][data-field="${field}"]`;
      }
      break;
    }
    case 'add-comment':
      addComment();
      break;
  }
}

app.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  // Selects and checkboxes act on 'change'.
  if (target.closest('select, input')) return;
  const action = target.closest<HTMLElement>('[data-action]');
  if (action) runAction(action);
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  const data = target.dataset;
  if (target instanceof HTMLSelectElement && data['filter'] !== undefined) {
    const name = data['filter'];
    if (name === 'status' || name === 'milestone' || name === 'label' || name === 'assignee') {
      update({ [name]: target.value });
      drawContent();
    }
    return;
  }
  if ((target instanceof HTMLSelectElement || target instanceof HTMLInputElement) && data['action'] === 'set-field' && detail) {
    post(setFieldMessage(detail, data['field'] as ScalarField, target.value));
    return;
  }
  if (target instanceof HTMLSelectElement && data['action'] === 'set-status' && data['path']) {
    post({ type: 'setStatus', path: data['path'], statusLine: data['statusLine'] ?? '', status: target.value });
    return;
  }
  if (target instanceof HTMLInputElement && data['action'] === 'toggle-check' && data['path']) {
    const list = data['list'];
    if (list !== 'ac' && list !== 'dod') return;
    post({ type: 'toggleCheck', path: data['path'], list, line: Number(data['line']), source: data['source'] ?? '', checked: target.checked });
  }
});

// --- Search -------------------------------------------------------------------

const composition = new CompositionGuard();
search.addEventListener('compositionstart', () => composition.start());
search.addEventListener('compositionend', () => composition.end(performance.now()));
/**
 * Each search keystroke redraws the board or list. With thousands of tasks one redraw takes long
 * enough to swallow keystrokes, so there it waits until typing pauses; Enter, ArrowDown and
 * Escape act on the current text at once.
 */
const SEARCH_DELAY_MS = 150;
const LARGE_PROJECT = 2000;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function flushSearch(): void {
  if (searchTimer === undefined) return;
  clearTimeout(searchTimer);
  searchTimer = undefined;
  drawContent();
}

search.addEventListener('input', () => {
  update({ search: search.value });
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = undefined;
  if ((view?.tasks.length ?? 0) <= LARGE_PROJECT) {
    drawContent();
    return;
  }
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    drawContent();
  }, SEARCH_DELAY_MS);
});

function focusFirstItem(): void {
  content.querySelector<HTMLElement>('[data-action="show-task"]')?.focus();
}

// --- Keyboard -----------------------------------------------------------------

function onSearchKey(event: KeyboardEvent): boolean {
  const { key } = event;
  if (key === 'Enter') {
    flushSearch();
    if (!composition.swallowEnter(event, performance.now())) focusFirstItem();
    consume(event);
    return true;
  }
  if (key === 'ArrowDown' && !event.isComposing) {
    flushSearch();
    focusFirstItem();
    consume(event);
    return true;
  }
  if (key === 'Escape' && search.value !== '' && !event.isComposing) {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
    search.value = '';
    update({ search: '' });
    drawContent();
    consume(event);
    return true;
  }
  if (key === 'Escape') return false;
  // Everything else (typing, Ctrl+Z, arrows) belongs to the text field, not to VS Code.
  event.stopPropagation();
  return true;
}

/**
 * Draws a capped column ('list' for the list) in full. Focus goes to the first card or row that
 * was hidden, so the keyboard continues where the button was.
 */
function showAll(column: string | undefined): void {
  if (column === undefined) return;
  const tasks = column === 'list' ? rows : shownColumns[Number(column)]?.tasks;
  const full = column === 'list' ? undefined : columns[Number(column)];
  if (tasks === undefined) return;
  expanded.add(column === 'list' ? 'list' : columnId(full!));
  const firstHidden = column === 'list' ? undefined : full!.tasks[tasks.length];
  const nextRow = tasks.length;
  drawContent();
  const target = firstHidden?.path ?? rows[nextRow]?.path;
  if (target !== undefined) itemFor(target)?.focus();
}

/** The "Show all" button under a capped column or list, if any. */
function showAllButton(column: string): HTMLElement | null {
  return content.querySelector<HTMLElement>(`[data-action="show-all"][data-column="${column}"]`);
}

function onCardKey(event: KeyboardEvent, card: HTMLElement): void {
  if (!view) return;
  const task = taskAt(card.dataset['path']);
  const from = task && findCard(columns, task.path);
  if (!task || !from) return;
  // A read-only card does not move (backlog.md 4.4); Alt+arrows say why instead.
  if (task.readOnly !== null && (altSideArrow(event) !== undefined || altVerticalArrow(event) !== undefined)) {
    showError(readOnlyText(task.readOnly, view.strings));
    consume(event);
    return;
  }
  const side = altSideArrow(event);
  if (side !== undefined) {
    const status = neighbourStatus(view.statuses, task, side);
    if (status !== undefined) {
      pendingFocus = task.path;
      post(setStatusMessage(task, status));
    }
    consume(event);
    return;
  }
  // Alt+Up/Down: reorder within the column (backlog.md 5.4).
  const vertical = altVerticalArrow(event);
  if (vertical !== undefined) {
    const column = columns[from.column]!;
    const index = stepIndex(column, task, vertical);
    const message = index === undefined ? undefined : moveInColumnMessage(column, task, index);
    if (message !== undefined) {
      pendingFocus = task.path;
      post(message);
    }
    consume(event);
    return;
  }
  const direction = plainArrow(event);
  if (direction !== undefined) {
    const shownFrom = findCard(shownColumns, task.path);
    const next = shownFrom && navigateBoard(shownColumns, shownFrom, direction);
    if (next) itemFor(shownColumns[next.column]!.tasks[next.card]!.path)?.focus();
    // Down from the last card drawn in a capped column reaches its "Show all" button.
    else if (direction === 'down' && shownFrom) showAllButton(String(shownFrom.column))?.focus();
    consume(event);
    return;
  }
  if (isOpenShortcut(event)) {
    openTask(task.path);
    consume(event);
  }
}

function onRowKey(event: KeyboardEvent, row: HTMLElement): void {
  const { key, altKey, ctrlKey, metaKey, shiftKey } = event;
  const index = rows.findIndex((t) => t.path === row.dataset['path']);
  if (index === -1) return;
  if (!altKey && !ctrlKey && !metaKey && !shiftKey) {
    const next = navigateList(rows.length, index, key);
    if (next !== undefined && next !== index) {
      itemFor(rows[next]!.path)?.focus();
      consume(event);
      return;
    }
    // Down from the last row drawn reaches the "Show all" button.
    const button = key === 'ArrowDown' && index === rows.length - 1 ? showAllButton('list') : null;
    if (button) {
      button.focus();
      consume(event);
      return;
    }
    if (next !== undefined) {
      consume(event);
      return;
    }
  }
  if (isOpenShortcut(event)) {
    openTask(rows[index]!.path);
    consume(event);
  }
}

document.addEventListener('keydown', (event) => {
  const { key } = event;
  const target = event.target as HTMLElement;

  if (target === search && onSearchKey(event)) return;
  if (detailPane.contains(target) && onDetailKey(event, target)) return;

  // The search box keeps its own Ctrl+Z (onSearchKey); anywhere else it undoes the last change.
  if (isUndoShortcut(event)) {
    post({ type: 'undo' });
    consume(event);
    return;
  }

  if (key === 'Escape') {
    const help = toolbarParts.querySelector('.help');
    if (help && (help.matches(':hover') || help === document.activeElement)) {
      help.classList.add('dismissed');
      consume(event);
      return;
    }
    if (state.selected !== null) {
      closeTask();
      consume(event);
    }
    return;
  }

  if (target.dataset['action'] === 'resize-column') {
    const column = target.dataset['column'] as SortColumn;
    const width = columnKeyWidth(columnWidth(column), event);
    if (width !== undefined) {
      resizeColumn(column, width);
      consume(event);
    }
    return;
  }

  if (target === splitter) {
    const size = splitterKey(position(), event, currentSize, layoutTotal());
    if (size !== undefined) {
      setDetailSize(size);
      rememberSize();
      consume(event);
    }
    return;
  }

  // Native controls keep their own keys.
  if (target.closest('select, input, textarea, button')) return;

  // Links in the detail view and in markdown: Enter activates, as a click would.
  if (target.getAttribute('role') === 'link' && key === 'Enter' && target.dataset['action'] !== 'show-task') {
    runAction(target);
    consume(event);
    return;
  }

  if (target.matches('li.card')) onCardKey(event, target);
  else if (target.matches('tr.row')) onRowKey(event, target);
  else if (target.matches('[role="link"][data-action="show-task"]') && (key === 'Enter' || key === ' ')) {
    runAction(target);
    consume(event);
  }
});

// Keyboard help: Escape hides the tooltip (WCAG 1.4.13) until the pointer or focus leaves.
toolbar.addEventListener('mouseout', (event) => {
  const help = (event.target as HTMLElement).closest('.help');
  if (help && !help.contains(event.relatedTarget as Node | null)) help.classList.remove('dismissed');
});
toolbar.addEventListener('focusout', (event) => {
  (event.target as HTMLElement).closest('.help')?.classList.remove('dismissed');
});

// --- Detail editing (backlog.md 5.4) ------------------------------------------------

/** The open editor, unsent drafts and an inline validation message (drawn into the detail). */
let editor: OpenEditor | null = null;
let commentDraft = '';
let chipDrafts: Partial<Record<ListField, string>> = {};
let fieldError: { field: string; message: string } | null = null;
/** A detail that arrived while a draft was held; drawn once the draft is gone. */
let deferredDetail: TaskDetail | undefined;
/** Selector to focus after the next detail draw. */
let detailFocus: string | undefined;
/** The last edit sent: put back when the extension refuses it, dropped once a detail shows it applied. */
let submitted: { readonly done: (detail: TaskDetail) => boolean; readonly restore: () => void } | undefined;
const detailComposition = new CompositionGuard();
detailPane.addEventListener('compositionstart', () => detailComposition.start());
detailPane.addEventListener('compositionend', () => detailComposition.end(performance.now()));

const isEditSection = (name: string | undefined): name is EditSection =>
  name === 'description' || name === 'plan' || name === 'notes' || name === 'finalSummary';

/**
 * Text the extension would refuse for its size (messages.ts LIMITS): checked here so nothing is
 * sent and the editor keeps the draft, with the limit named.
 */
function tooLong(text: string, maxChars: number, maxLines: number): string | undefined {
  if (!view) return undefined;
  if (text.length <= maxChars && text.split('\n').length <= maxLines) return undefined;
  return format(view.strings.textTooLong, maxChars.toLocaleString('en-US'), maxLines.toLocaleString('en-US'));
}

/**
 * Unsaved text of tasks that are not shown (an open editor, the comment box, chip inputs), so
 * switching to another task, Escape or Close never throws typing away: it comes back with its
 * task. Kept for the life of the page, at most STASH_LIMIT tasks.
 */
const stashed = new Map<string, { editor: OpenEditor | null; commentDraft: string; chipDrafts: Partial<Record<ListField, string>> }>();
const STASH_LIMIT = 20;

function stashDrafts(path: string): void {
  syncDrafts();
  const chips = Object.fromEntries(Object.entries(chipDrafts).filter(([, v]) => v !== undefined && v !== ''));
  if (editor === null && commentDraft.trim() === '' && Object.keys(chips).length === 0) {
    stashed.delete(path);
    return;
  }
  stashed.delete(path);
  stashed.set(path, { editor, commentDraft, chipDrafts: chips });
  while (stashed.size > STASH_LIMIT) stashed.delete(stashed.keys().next().value!);
}

/** Puts back the task's unsaved text; true when an editor was reopened (it takes the focus). */
function restoreDrafts(path: string): boolean {
  const saved = stashed.get(path);
  if (saved === undefined) return false;
  stashed.delete(path);
  editor = saved.editor;
  commentDraft = saved.commentDraft;
  chipDrafts = saved.chipDrafts;
  if (editor !== null) detailFocus = editor.kind === 'title' ? '[data-editor="title"]' : '[data-editor="section"]';
  return editor !== null;
}

/** The shown task disappeared (moved, archived, deleted) while a draft was open: kept until the editor closes. */
let taskGone = false;

function resetEditing(): void {
  taskGone = false;
  editor = null;
  commentDraft = '';
  chipDrafts = {};
  fieldError = null;
  deferredDetail = undefined;
  submitted = undefined;
}

function editOptions(v: BacklogView): DetailEditOptions {
  const unique = (values: readonly string[]): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    taskTypes: v.taskTypes,
    priorities: v.priorities,
    milestones: v.milestones,
    labels: unique(v.tasks.flatMap((t) => t.labels)),
    assignees: unique(v.tasks.flatMap((t) => t.assignees)),
    tasks: v.tasks.map((t) => ({ id: t.id, title: t.title })),
    editor,
    commentDraft,
    chipDrafts,
    error: fieldError,
  };
}

/** Live editor values into the state, so a redraw shows them again. */
function syncDrafts(): void {
  const title = detailPane.querySelector<HTMLInputElement>('[data-editor="title"]');
  if (title && editor?.kind === 'title') editor = { kind: 'title', draft: title.value };
  const section = detailPane.querySelector<HTMLTextAreaElement>('[data-editor="section"]');
  if (section && editor?.kind === 'section') editor = { kind: 'section', name: editor.name, draft: section.value };
  const comment = detailPane.querySelector<HTMLTextAreaElement>('[data-editor="comment"]');
  if (comment) commentDraft = comment.value;
  for (const input of detailPane.querySelectorAll<HTMLInputElement>('input[data-action="chip-input"]')) {
    chipDrafts = { ...chipDrafts, [input.dataset['field'] as ListField]: input.value };
  }
}

/** An editor is open, or a text box in the detail has focus and text: a redraw would disturb it. */
function holdsDraft(): boolean {
  if (editor !== null) return true;
  const active = document.activeElement;
  // Only text entry holds a draft. A checkbox's value is "on" and a date input sends on change:
  // holding the detail back for them left stale lines in the DOM (an uncheck re-sent the old line).
  const typing =
    active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && (active.type === 'text' || active.type === 'search'));
  return typing && detailPane.contains(active) && active.value !== '';
}

function applyDetail(next: TaskDetail | null): void {
  deferredDetail = undefined;
  if (next === null) {
    update({ selected: null });
    detail = undefined;
    resetEditing();
    drawContent();
  } else {
    detail = next;
  }
  drawDetail();
}

/** Draws a detail held back while the user was typing. */
function releaseDeferred(): void {
  if (holdsDraft()) return;
  if (taskGone) applyDetail(null);
  else if (deferredDetail !== undefined) applyDetail(deferredDetail);
}

function openEditor(next: OpenEditor): void {
  syncDrafts();
  editor = next;
  fieldError = null;
  detailFocus = next.kind === 'title' ? '[data-editor="title"]' : '[data-editor="section"]';
  drawDetail();
}

function closeEditor(): void {
  const closed = editor;
  editor = null;
  fieldError = null;
  if (closed?.kind === 'title') detailFocus = '[data-action="edit-title"]';
  else if (closed?.kind === 'section') {
    detailFocus = `[data-action="edit-section"][data-section="${closed.name}"], [data-action="add-section"][data-section="${closed.name}"]`;
  }
  if (taskGone) applyDetail(null);
  else if (deferredDetail !== undefined) applyDetail(deferredDetail);
  else drawDetail();
}

function saveEditor(): void {
  syncDrafts();
  if (!detail || !view || editor === null) return;
  const open = editor;
  if (open.kind === 'title') {
    const title = open.draft.trim();
    if (title === '') {
      fieldError = { field: 'title', message: view.strings.emptyTitle };
      drawDetail();
      return;
    }
    const long = tooLong(title, LIMITS.value, 1);
    if (long !== undefined) {
      fieldError = { field: 'title', message: long };
      drawDetail();
      return;
    }
    const message = setFieldMessage(detail, 'title', title);
    if (message) submitted = { done: (d) => d.title === title, restore: () => void (editor ??= open) };
    post(message);
  } else {
    // The description cannot be emptied (the extension refuses it); Save is disabled then.
    if (open.name === 'description' && open.draft.trim() === '') return;
    const problem = tooLong(open.draft, LIMITS.text, LIMITS.textLines) ?? (hasUnclosedFence(open.draft) ? view.strings.unclosedFence : undefined);
    if (problem !== undefined) {
      fieldError = { field: open.name, message: problem };
      detailFocus = '[data-editor="section"]';
      drawDetail();
      return;
    }
    const message = setSectionMessage(detail, open.name, open.draft);
    if (message) {
      submitted = { done: (d) => (sectionText(d, open.name) ?? '').trim() === open.draft.trim(), restore: () => void (editor ??= open) };
    }
    post(message);
  }
  closeEditor();
}

function addComment(): void {
  syncDrafts();
  if (!detail || !view) return;
  const text = commentDraft;
  const problem = tooLong(text, LIMITS.text, LIMITS.textLines) ?? (hasUnclosedFence(text) ? view.strings.unclosedFence : undefined);
  if (problem !== undefined) {
    fieldError = { field: 'comment', message: problem };
    detailFocus = '[data-editor="comment"]';
    drawDetail();
    return;
  }
  const message = addCommentMessage(detail, text);
  if (!message) return;
  const count = detail.comments?.length ?? 0;
  submitted = {
    done: (d) => (d.comments?.length ?? 0) > count,
    restore: () => {
      if (commentDraft === '') commentDraft = text;
    },
  };
  post(message);
  commentDraft = '';
  const box = detailPane.querySelector<HTMLTextAreaElement>('[data-editor="comment"]');
  if (box) box.value = '';
  const add = detailPane.querySelector<HTMLButtonElement>('[data-action="add-comment"]');
  if (add) add.disabled = true;
  releaseDeferred();
}

function submitList(field: ListField, values: readonly string[], typed: string): void {
  if (!detail) return;
  // The setList message holds every item on its own line (messages.ts: values).
  const long = tooLong(values.join('\n'), LIMITS.value * 10, 500);
  if (long !== undefined) {
    if (typed !== '') chipDrafts = { ...chipDrafts, [field]: typed };
    fieldError = { field, message: long };
    drawDetail();
    return;
  }
  const message = setListMessage(detail, field, values);
  if (!message) return;
  const joined = values.join('\n');
  submitted = {
    done: (d) => listValues(d, field).join('\n') === joined,
    restore: () => {
      if (typed !== '' && !chipDrafts[field]) chipDrafts = { ...chipDrafts, [field]: typed };
    },
  };
  post(message);
}

function addChips(input: HTMLInputElement): void {
  if (!detail || !view) return;
  const field = input.dataset['field'] as ListField;
  const typed = input.value;
  if (typed.trim() === '') return;
  const result = addChipValues(detail, field, typed, { tasks: view.tasks, strings: view.strings });
  if ('error' in result) {
    fieldError = { field, message: result.error };
    // Back to the same box (its text selected) so the user can correct it; Esc then clears it.
    detailFocus = `input[data-action="chip-input"][data-field="${field}"]`;
    drawDetail();
    return;
  }
  fieldError = null;
  input.value = '';
  chipDrafts = { ...chipDrafts, [field]: '' };
  submitList(field, result.values, typed);
  releaseDeferred();
}

function restoreSubmitted(): void {
  if (submitted === undefined) return;
  const restore = submitted.restore;
  submitted = undefined;
  restore();
  if (editor !== null) detailFocus = editor.kind === 'title' ? '[data-editor="title"]' : '[data-editor="section"]';
  drawDetail();
}

/** Keys inside the detail pane. True when handled here (or kept from VS Code). */
function onDetailKey(event: KeyboardEvent, target: HTMLElement): boolean {
  const { key, ctrlKey, metaKey, altKey, shiftKey, isComposing } = event;
  const plain = !ctrlKey && !metaKey && !altKey;
  const kind = target.dataset['editor'];
  if (kind === 'title') {
    if (key === 'Enter' && plain && !shiftKey) {
      if (!detailComposition.swallowEnter(event, performance.now())) saveEditor();
      consume(event);
    } else if (key === 'Escape' && !isComposing) {
      closeEditor();
      consume(event);
    } else {
      event.stopPropagation();
    }
    return true;
  }
  if (kind === 'section' || kind === 'comment') {
    if (key === 'Enter' && (ctrlKey || metaKey) && !isComposing) {
      if (kind === 'section') saveEditor();
      else addComment();
      consume(event);
    } else if (key === 'Escape' && !isComposing) {
      if (kind === 'section') closeEditor();
      else target.blur();
      consume(event);
    } else {
      // Enter inserts a line break; Ctrl+Z is the text box's own undo.
      event.stopPropagation();
    }
    return true;
  }
  if (target instanceof HTMLInputElement && target.dataset['action'] === 'chip-input') {
    const field = target.dataset['field'] as ListField;
    const commaField = field === 'assignee' || field === 'labels' || field === 'dependencies';
    if ((key === 'Enter' || (key === ',' && commaField)) && plain) {
      if (!detailComposition.swallowEnter(event, performance.now()) && !isComposing) addChips(target);
      consume(event);
    } else if (key === 'Backspace' && plain && target.value === '' && detail) {
      const values = listValues(detail, field);
      if (values.length > 0) submitList(field, values.slice(0, -1), '');
      consume(event);
    } else if (key === 'Escape' && !isComposing && target.value !== '') {
      target.value = '';
      chipDrafts = { ...chipDrafts, [field]: '' };
      fieldError = null;
      consume(event);
    } else if (key === 'Escape') {
      // An empty box: Escape closes the detail as elsewhere.
      return false;
    } else {
      event.stopPropagation();
    }
    return true;
  }
  if (target.dataset['action'] === 'edit-title' && (key === 'Enter' || key === 'F2' || key === ' ') && plain) {
    if (detail) openEditor({ kind: 'title', draft: detail.title });
    consume(event);
    return true;
  }
  return false;
}

detailPane.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;
  // The description cannot be emptied: Save follows the text.
  if (target instanceof HTMLTextAreaElement && target.dataset['editor'] === 'section' && editor?.kind === 'section' && editor.name === 'description') {
    const save = target.closest('section')?.querySelector<HTMLButtonElement>('[data-action="save-edit"]');
    if (save) save.disabled = target.value.trim() === '';
  }
  if (target instanceof HTMLTextAreaElement && target.dataset['editor'] === 'comment') {
    const add = target.closest('.detail-comment-new')?.querySelector<HTMLButtonElement>('[data-action="add-comment"]');
    if (add) add.disabled = target.value.trim() === '';
  }
  const errorField = target.dataset['field'] ?? target.dataset['section'] ?? (target.dataset['editor'] === 'comment' ? 'comment' : undefined);
  if (fieldError !== null && errorField === fieldError.field) {
    fieldError = null;
    target.removeAttribute('aria-invalid');
    target.removeAttribute('aria-describedby');
    target.closest('.detail-field-edit, .detail-section, .detail-comment-new')?.querySelector('.detail-field-error')?.remove();
  }
});

// Leaving a text box lets a held-back detail through (its draft is kept in the redraw).
detailPane.addEventListener('focusout', () => {
  setTimeout(releaseDeferred, 0);
});

// --- Drag and drop (board) ------------------------------------------------------

function clearDropMarks(): void {
  for (const node of content.querySelectorAll('.drop-target, .drop-before, .drop-after')) {
    node.classList.remove('drop-target', 'drop-before', 'drop-after');
  }
}

/**
 * What a drop at this point does. Into another configured column: a status change. Within the
 * dragged card's own column: a new position, from the pointer against the card under it
 * (upper half = before it, lower half = after it; empty space = the end).
 */
type DropPoint =
  | { readonly kind: 'status'; readonly status: string; readonly mark: HTMLElement }
  | { readonly kind: 'order'; readonly column: BoardColumn; readonly before: number; readonly mark: HTMLElement; readonly cls: 'drop-before' | 'drop-after' | 'drop-target' };

function dropPoint(event: DragEvent, task: TaskSummary): DropPoint | undefined {
  const target = event.target as HTMLElement;
  const section = target.closest<HTMLElement>('section.column');
  const column = section ? columns[Number(section.dataset['column'])] : undefined;
  if (!section || !column) return undefined;
  if (!column.tasks.some((t) => t.path === task.path)) {
    const status = dropStatus(column, task);
    return status === undefined ? undefined : { kind: 'status', status, mark: section };
  }
  if (!column.known) return undefined;
  const card = target.closest<HTMLElement>('li.card');
  if (card) {
    const index = column.tasks.findIndex((t) => t.path === card.dataset['path']);
    if (index === -1) return undefined;
    const rect = card.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    return { kind: 'order', column, before: after ? index + 1 : index, mark: card, cls: after ? 'drop-after' : 'drop-before' };
  }
  // Empty space (or the "Show all" button) of a capped column: after the last card drawn.
  const shownCount = shownColumns[Number(section.dataset['column'])]?.tasks.length ?? column.tasks.length;
  return { kind: 'order', column, before: shownCount, mark: section, cls: 'drop-target' };
}

/** The message for a drop, or undefined when nothing would change. */
function dropMessage(point: DropPoint, task: TaskSummary): OutgoingMessage | undefined {
  if (point.kind === 'status') return setStatusMessage(task, point.status);
  return moveInColumnMessage(point.column, task, dropIndex(point.column, task, point.before));
}

content.addEventListener('dragstart', (event) => {
  const card = (event.target as HTMLElement).closest<HTMLElement>('li.card');
  drag = taskAt(card?.dataset['path']);
  // Read-only cards are not draggable (backlog.md 4.4); a drag from inside one does not move it either.
  if (drag !== undefined && drag.readOnly !== null) {
    event.preventDefault();
    drag = undefined;
  }
  if (!card || !drag) return;
  card.classList.add('dragging');
  content.classList.add('dragging-card');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Some hosts need data for a drag to start; it is never read back.
    event.dataTransfer.setData('text/plain', '');
  }
});

content.addEventListener('dragover', (event) => {
  clearDropMarks();
  const point = drag && dropPoint(event, drag);
  if (!drag || !point) return;
  // Accept the drop even when it would not change anything, so the card does not snap back
  // with the "not allowed" cursor while it passes over its own place.
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  point.mark.classList.add(point.kind === 'status' ? 'drop-target' : point.cls);
});

content.addEventListener('drop', (event) => {
  const task = drag;
  const point = task && dropPoint(event, task);
  clearDropMarks();
  drag = undefined;
  if (!task || !point) return;
  event.preventDefault();
  const message = dropMessage(point, task);
  if (message === undefined) return;
  pendingFocus = task.path;
  post(message);
});

content.addEventListener('dragend', () => {
  drag = undefined;
  clearDropMarks();
  content.classList.remove('dragging-card');
  for (const node of content.querySelectorAll('.dragging')) node.classList.remove('dragging');
});

// --- Detail position and splitter (backlog.md 4.1) ---------------------------------

/** The position asked for from the toolbar, shown until a render carries the new setting. */
let positionOverride: DetailPosition | undefined;
/** The detail pane's current size along the split (px). */
let currentSize = 0;
let dragging: number | undefined;

function position(): DetailPosition {
  return positionOverride ?? view?.detailPosition ?? 'bottom';
}

/** Space shared by the two panes along the split, without the splitter itself. */
function layoutTotal(): number {
  const rect = layout.getBoundingClientRect();
  return position() === 'bottom' ? rect.height - splitter.offsetHeight : rect.width - splitter.offsetWidth;
}

function setDetailSize(size: number): void {
  currentSize = size;
  detailPane.style.flexBasis = `${size}px`;
  const { now, min, max } = splitterValues(size, layoutTotal());
  splitter.setAttribute('aria-valuenow', String(now));
  splitter.setAttribute('aria-valuemin', String(min));
  splitter.setAttribute('aria-valuemax', String(max));
}

/** Scrolls the selected card or row into the board/list pane (it may have become smaller). */
function revealSelected(): void {
  if (state.selected !== null) itemFor(state.selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Remembers the current size for the current position (panel state). */
function rememberSize(): void {
  const share = storedShare(currentSize, layoutTotal());
  update({ paneSizes: { ...state.paneSizes, [position()]: share } });
}

/** Position classes, splitter orientation and the detail size (clamped to the minimums). */
function applyLayout(): void {
  const pos = position();
  layout.classList.toggle('position-bottom', pos === 'bottom');
  layout.classList.toggle('position-right', pos === 'right');
  const open = !detailPane.hidden;
  splitter.hidden = !open;
  if (view) splitter.setAttribute('aria-label', view.strings.splitter);
  splitter.setAttribute('aria-orientation', pos === 'bottom' ? 'horizontal' : 'vertical');
  if (!open) {
    detailPane.style.flexBasis = '';
    return;
  }
  setDetailSize(detailSize(pos, layoutTotal(), state.paneSizes[pos]));
}

splitter.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = event.pointerId;
  splitter.setPointerCapture(event.pointerId);
  layout.classList.add('resizing');
  splitter.focus();
  event.preventDefault();
});

splitter.addEventListener('pointermove', (event) => {
  if (dragging !== event.pointerId) return;
  const rect = layout.getBoundingClientRect();
  const bottom = position() === 'bottom';
  const thickness = bottom ? splitter.offsetHeight : splitter.offsetWidth;
  setDetailSize(dragDetailSize(bottom ? event.clientY : event.clientX, bottom ? rect.bottom : rect.right, thickness, layoutTotal()));
});

function endDrag(event: PointerEvent): void {
  if (dragging !== event.pointerId) return;
  dragging = undefined;
  if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  layout.classList.remove('resizing');
  rememberSize();
  revealSelected();
}
splitter.addEventListener('pointerup', endDrag);
splitter.addEventListener('pointercancel', endDrag);

// Double-click: back to the default size for this position.
splitter.addEventListener('dblclick', () => {
  const { [position()]: _, ...rest } = state.paneSizes;
  update({ paneSizes: rest });
  applyLayout();
});

// A field reached with Tab must not end up behind the sticky detail header (below, tall panes).
detailPane.addEventListener('focusin', (event) => {
  const header = detailPane.querySelector<HTMLElement>('.detail-header');
  const target = event.target as HTMLElement;
  if (!header || header.contains(target) || getComputedStyle(header).position !== 'sticky') return;
  const covered = header.getBoundingClientRect().bottom + 8 - target.getBoundingClientRect().top;
  if (covered > 0) detailPane.scrollTop -= covered;
});

// Window size changes: keep both panes above their minimums.
window.addEventListener('resize', () => applyLayout());

// The project is in the state from the start, even if nothing else is ever changed.
saveState();
post({ type: 'ready' });

// --- List column widths (backlog.md 4.3) ---------------------------------------------

/**
 * Widths are applied through <col> elements with a fixed table layout. Until the first resize
 * the table sizes itself; the first resize freezes every column at its current width.
 */
function applyColumnWidths(): void {
  const table = content.querySelector<HTMLTableElement>('table.task-table');
  if (!table) return;
  const widths = state.columnWidths;
  const sized = SORT_COLUMNS.every((column) => widths[column] !== undefined);
  table.classList.toggle('sized', sized);
  let total = 0;
  for (const col of table.querySelectorAll<HTMLElement>('col[data-col]')) {
    const width = widths[col.dataset['col'] as SortColumn];
    col.style.width = sized && width !== undefined ? `${width}px` : '';
    total += width ?? 0;
  }
  table.style.width = sized ? `${total}px` : '';
  for (const handle of table.querySelectorAll<HTMLElement>('[data-action="resize-column"]')) {
    const width = columnWidth(handle.dataset['column'] as SortColumn);
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuemin', String(MIN_COLUMN_WIDTH));
    handle.setAttribute('aria-valuemax', String(MAX_COLUMN_WIDTH));
  }
}

function headerFor(column: SortColumn): HTMLElement | null {
  return content.querySelector<HTMLElement>(`th.col-${column}`);
}

function columnWidth(column: SortColumn): number {
  return state.columnWidths[column] ?? Math.round(headerFor(column)?.getBoundingClientRect().width ?? 120);
}

function resizeColumn(column: SortColumn, width: number): void {
  const widths: Partial<Record<SortColumn, number>> = {};
  for (const c of SORT_COLUMNS) widths[c] = clampColumnWidth(c === column ? width : columnWidth(c));
  update({ columnWidths: widths });
  applyColumnWidths();
}

let columnDrag: { column: SortColumn; startX: number; startWidth: number; pointer: number } | undefined;

content.addEventListener('pointerdown', (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-action="resize-column"]');
  if (!handle || event.button !== 0) return;
  const column = handle.dataset['column'] as SortColumn;
  columnDrag = { column, startX: event.clientX, startWidth: columnWidth(column), pointer: event.pointerId };
  handle.setPointerCapture(event.pointerId);
  handle.focus();
  content.classList.add('resizing-column');
  event.preventDefault();
});

content.addEventListener('pointermove', (event) => {
  if (!columnDrag || event.pointerId !== columnDrag.pointer) return;
  // A redraw mid-drag drops the pointer capture, so the release may land outside the panel.
  if ((event.buttons & 1) === 0) {
    endColumnDrag(event);
    return;
  }
  resizeColumn(columnDrag.column, columnDrag.startWidth + event.clientX - columnDrag.startX);
});

function endColumnDrag(event: PointerEvent): void {
  if (!columnDrag || event.pointerId !== columnDrag.pointer) return;
  columnDrag = undefined;
  content.classList.remove('resizing-column');
}
content.addEventListener('pointerup', endColumnDrag);
content.addEventListener('pointercancel', endColumnDrag);

content.addEventListener('dblclick', (event) => {
  if (!(event.target as HTMLElement).closest('[data-action="resize-column"]')) return;
  update({ columnWidths: {} });
  applyColumnWidths();
});
