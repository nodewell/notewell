// Canvas webview entry (browser), canvas.md 4 and 5. Draws the view the extension sends, and
// handles panning, zooming, selection, the keyboard, the list view and edits: moving and
// resizing (drag or keyboard), text card content and color. Edits are messages; the extension
// writes the file and sends the new view. Selection alone never sends anything (canvas.md 9.6).
import { createElementFactory } from '../../../webview/dom.ts';
import type { ExtensionMessage, WebviewMessage } from '../messages.ts';
import type { CanvasView, NodeView, ViewStrings } from '../view.ts';
import {
  canEdit,
  colorMessage,
  dropPosition,
  dropSize,
  editTextMessage,
  keyboardEdit,
  moveMessage,
  movingWith,
  passedThreshold,
  PendingKeyEdits,
  resizeMessage,
  textEditorKey,
  type ColorChoice,
} from './edit.ts';
import { bounds, ensureVisible, fitViewport, zoomAt, zoomTo, type Rect, type Viewport } from './geometry.ts';
import { keyAction, wheelAction } from './keys.ts';
import {
  renderCardBar,
  renderColorPicker,
  renderEdge,
  renderError,
  renderHelp,
  renderList,
  renderNotices,
  renderRefused,
  renderTextEditor,
  renderWorld,
  type CanvasDocument,
} from './render.ts';

interface SavedState {
  readonly viewport?: Viewport;
  readonly mode?: 'canvas' | 'list';
}

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): SavedState | undefined;
  setState(state: SavedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
// SVG elements share what the renderer uses (style, classList, setAttribute, append).
const doc: CanvasDocument<HTMLElement> = {
  createElement: (tag: string) => document.createElement(tag),
  createElementNS: (namespace: string, tag: string) => document.createElementNS(namespace, tag) as unknown as HTMLElement,
};
const el = createElementFactory(document);
const app = document.getElementById('app')!;

const saved = vscode.getState() ?? {};
let viewport: Viewport | undefined = saved.viewport;
let mode: 'canvas' | 'list' = saved.mode === 'list' ? 'list' : 'canvas';
let current: Extract<CanvasView, { state: 'canvas' }> | undefined;
/** Document version of the view shown; every edit carries it. */
let version = 0;
let selected: number | undefined;
let spaceHeld = false;
let pan: { pointer: number; startX: number; startY: number; from: Viewport } | undefined;

// --- Skeleton --------------------------------------------------------------------------

const zoomOut = el('button', { className: 'tool', text: '−', attrs: { type: 'button', 'data-tool': 'zoom-out' } });
const zoomLevel = el('button', { className: 'tool zoom-level', text: '100%', attrs: { type: 'button', 'data-tool': 'zoom-reset' } });
const zoomIn = el('button', { className: 'tool', text: '+', attrs: { type: 'button', 'data-tool': 'zoom-in' } });
const fit = el('button', { className: 'tool tool-wide', attrs: { type: 'button', 'data-tool': 'fit' } });
const listToggle = el('button', { className: 'tool tool-wide', attrs: { type: 'button', 'data-tool': 'list', 'aria-pressed': 'false' } });
const helpButton = el('button', { className: 'tool', text: '?', attrs: { type: 'button', 'data-tool': 'help', 'aria-expanded': 'false', 'aria-controls': 'canvas-help' } });
const zoomTools = el('div', { className: 'tool-group', attrs: { role: 'group' } }, zoomOut, zoomLevel, zoomIn);
const divider = el('span', { className: 'tool-divider', attrs: { 'aria-hidden': 'true' } });
const viewTools = el('div', { className: 'tool-group', attrs: { role: 'group' } }, fit, listToggle, helpButton);
const toolbar = el('div', { className: 'toolbar', attrs: { role: 'toolbar' } }, zoomTools, divider, viewTools);
const help = el('div', { className: 'help', attrs: { id: 'canvas-help', hidden: '' } });
const notices = el('div', { className: 'notices', attrs: { role: 'status' } });
const refusedHost = el('div', { className: 'notices refused' });
// The refusal toast floats over the canvas (see canvas.css).
const world = el('div', { className: 'world' });
const viewportEl = el('div', { className: 'viewport', attrs: { tabindex: '0', role: 'region', 'aria-describedby': 'canvas-help' } }, world);
const empty = el('p', { className: 'empty', attrs: { hidden: '' } });
const listHost = el('div', { className: 'list-host', attrs: { hidden: '' } });
const errorHost = el('div', { className: 'error-host', attrs: { hidden: '' } });
/** Edit buttons and the color picker next to the selected card (screen coordinates). */
const cardBarHost = el('div', { className: 'card-bar-host', attrs: { hidden: '' } });
const main = el('div', { className: 'canvas-main' }, viewportEl, empty, listHost, cardBarHost, toolbar, help, refusedHost);
app.append(notices, main, errorHost);

function applyStrings(strings: ViewStrings, editable: boolean): void {
  const label = (button: HTMLElement, text: string): void => {
    button.setAttribute('aria-label', text);
    button.setAttribute('title', text);
  };
  label(zoomOut, strings.zoomOut);
  label(zoomIn, strings.zoomIn);
  zoomLevel.setAttribute('title', strings.zoomReset);
  zoomLabel();
  fit.textContent = strings.fit;
  fit.setAttribute('title', strings.fit);
  listToggle.textContent = mode === 'list' ? strings.showCanvas : strings.showList;
  listToggle.setAttribute('title', listToggle.textContent);
  label(helpButton, strings.keyboardHelpLabel);
  toolbar.setAttribute('aria-label', strings.toolbarLabel);
  zoomTools.setAttribute('aria-label', strings.zoomGroup);
  viewTools.setAttribute('aria-label', strings.viewGroup);
  viewportEl.setAttribute('aria-label', strings.canvasLabel);
  help.setAttribute('aria-label', strings.keyboardHelpLabel);
  help.replaceChildren(renderHelp(doc, strings, { editable }));
  empty.textContent = strings.emptyCanvas;
}

// --- Viewport ---------------------------------------------------------------------------

function paneSize(): { width: number; height: number } {
  return { width: viewportEl.clientWidth || window.innerWidth, height: viewportEl.clientHeight || window.innerHeight };
}

function save(): void {
  vscode.setState({ ...(viewport === undefined ? {} : { viewport }), mode });
}

/** The zoom button reads its value and what it does: "83%, Reset zoom to 100%". */
function zoomLabel(): void {
  const reset = zoomLevel.getAttribute('title') ?? '';
  zoomLevel.setAttribute('aria-label', `${zoomLevel.textContent ?? ''}, ${reset}`);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function applyViewport(next: Viewport): void {
  viewport = next;
  world.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
  // The dot grid follows the canvas; it is hidden when the dots would crowd together.
  const step = 20 * next.scale;
  viewportEl.classList.toggle('no-grid', step < 6);
  viewportEl.style.setProperty('background-size', `${step}px ${step}px`);
  viewportEl.style.setProperty('background-position', `${next.x}px ${next.y}px`);
  zoomLevel.textContent = `${Math.round(next.scale * 100)}%`;
  zoomLabel();
  // Focus rings, selection outlines and resize handles keep their on-screen size at every zoom.
  world.style.setProperty('--nw-ring', `${2 / next.scale}px`);
  world.style.setProperty('--nw-handle', `${12 / next.scale}px`);
  placeCardBar();
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 200);
}

function fitAll(): void {
  if (current === undefined) return;
  const { width, height } = paneSize();
  applyViewport(fitViewport(bounds(current.nodes), width, height));
}

function zoomBy(factor: number): void {
  if (viewport === undefined) return;
  const { width, height } = paneSize();
  applyViewport(zoomAt(viewport, factor, width / 2, height / 2));
}

function panBy(dx: number, dy: number): void {
  if (viewport !== undefined) applyViewport({ x: viewport.x - dx, y: viewport.y - dy, scale: viewport.scale });
}

// --- Drawing -----------------------------------------------------------------------------

function nodeOf(index: number): NodeView | undefined {
  return current?.nodes.find((n) => n.index === index);
}

function nodeElement(index: number): HTMLElement | null {
  return world.querySelector<HTMLElement>(`.node[data-index="${index}"]`);
}

function allows(index: number | undefined) {
  return canEdit(index === undefined ? undefined : nodeOf(index), current?.editable === true);
}

function select(index: number | undefined): void {
  if (selected !== undefined) nodeElement(selected)?.classList.remove('selected', 'raised');
  if (index !== selected) closePicker(false);
  selected = index;
  if (index !== undefined) nodeElement(index)?.classList.add('selected', 'raised');
  showCardBar();
}

function setMode(next: 'canvas' | 'list'): void {
  mode = next;
  listToggle.setAttribute('aria-pressed', String(mode === 'list'));
  if (current !== undefined) {
    listToggle.textContent = mode === 'list' ? current.strings.showCanvas : current.strings.showList;
    listToggle.setAttribute('title', listToggle.textContent);
  }
  viewportEl.hidden = mode === 'list' || current === undefined || current.nodes.length === 0;
  empty.hidden = mode === 'list' || current === undefined || current.nodes.length > 0;
  listHost.hidden = mode !== 'list';
  for (const tool of [zoomTools, divider, fit]) tool.hidden = mode === 'list';
  if (mode === 'list' && current !== undefined) listHost.replaceChildren(renderList(doc, current));
  else listHost.replaceChildren();
  showCardBar();
  save();
}

function draw(view: CanvasView): void {
  applyStrings(view.strings, view.state === 'canvas' && view.editable);
  if (view.state === 'error') {
    current = undefined;
    closeEditor();
    select(undefined);
    notices.replaceChildren();
    toolbar.hidden = true;
    main.hidden = true;
    errorHost.hidden = false;
    errorHost.replaceChildren(renderError(doc, view));
    return;
  }
  const first = current === undefined;
  const keep = selected === undefined ? undefined : nodeOf(selected)?.id;
  const active = document.activeElement;
  const hadFocus = selected !== undefined && active === nodeElement(selected);
  const pickerFocus = picker !== undefined && picker.contains(active);
  current = view;
  toolbar.hidden = false;
  main.hidden = false;
  errorHost.hidden = true;
  errorHost.replaceChildren();
  notices.replaceChildren(...renderNotices(doc, view.notices));
  const raised = keep === undefined ? undefined : view.nodes.find((n) => n.id === keep)?.index;
  const next = renderWorld(doc, view, raised === undefined ? {} : { selected: raised });
  world.replaceChildren(...Array.from(next.childNodes));
  if (selected !== undefined) selected = undefined;
  // Keep the selection when the same card is still there.
  if (keep !== undefined) {
    const again = view.nodes.find((n) => n.id === keep);
    if (again !== undefined) {
      selected = again.index;
      nodeElement(again.index)?.classList.add('selected', 'raised');
      if (hadFocus) nodeElement(again.index)?.focus({ preventScroll: true });
    } else closePicker(false);
  }
  restoreEditor();
  setMode(mode);
  if (first && viewport === undefined) fitAll();
  else if (viewport !== undefined) applyViewport(viewport);
  if (pickerFocus) picker?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
}

// --- Messages ----------------------------------------------------------------------------

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

/** True while an edit is on its way and its new view has not arrived yet. */
let inFlight = false;
const pendingKeys = new PendingKeyEdits();

function showRefused(text: string | undefined): void {
  if (text === undefined || current === undefined) refusedHost.replaceChildren();
  else refusedHost.replaceChildren(renderRefused(doc, text, current.strings));
}

function sendEdit(message: WebviewMessage | undefined): boolean {
  if (message === undefined) return false;
  showRefused(undefined);
  inFlight = true;
  post(message);
  return true;
}

function openNode(index: number): void {
  const node = nodeOf(index);
  if (node?.kind === 'file') post({ type: 'openFile', index: node.index, id: node.id });
  else if (node?.kind === 'link' && node.url !== undefined) post({ type: 'openUrl', url: node.url });
}

function act(target: Element | null): boolean {
  const action = target?.closest<HTMLElement>('[data-action]');
  if (!action) return false;
  switch (action.dataset['action']) {
    case 'open-url': {
      const url = action.dataset['url'];
      if (url) post({ type: 'openUrl', url });
      return true;
    }
    case 'open-link': {
      const target = action.dataset['target'];
      if (target) post({ type: 'openLink', target });
      return true;
    }
    case 'open-file': {
      const holder = action.closest<HTMLElement>('[data-index]');
      if (holder) openNode(Number(holder.dataset['index']));
      return true;
    }
    case 'open-as-text':
      post({ type: 'openAsText' });
      return true;
    case 'focus-item': {
      const entry = listHost.querySelector<HTMLElement>(`.list-item[data-index="${Number(action.dataset['target'])}"]`);
      entry?.focus();
      entry?.scrollIntoView({ block: 'nearest' });
      return true;
    }
  }
  return false;
}

// --- Previews (drag, keyboard) ----------------------------------------------------------

/** Shows cards at other positions or sizes until the next view arrives, edges included. */
function preview(changes: ReadonlyMap<number, Rect>): void {
  if (current === undefined) return;
  const view = current;
  const nodes = view.nodes.map((n) => {
    const change = changes.get(n.index);
    return change === undefined ? n : { ...n, ...change };
  });
  for (const [index, rect] of changes) {
    const element = nodeElement(index);
    if (!element) continue;
    element.style.setProperty('left', `${rect.x}px`);
    element.style.setProperty('top', `${rect.y}px`);
    element.style.setProperty('width', `${rect.width}px`);
    element.style.setProperty('height', `${rect.height}px`);
  }
  const touched = new Set([...changes.keys()].map((index) => view.nodes.findIndex((n) => n.index === index)));
  view.edges.forEach((edge, position) => {
    if (!touched.has(edge.from) && !touched.has(edge.to)) return;
    const drawn = renderEdge(doc, edge, nodes, position);
    if (drawn === undefined) return;
    world.querySelector(`.layer-edges [data-edge-index="${position}"]`)?.replaceWith(drawn.line);
    const label = world.querySelector(`.layer-labels [data-edge-index="${position}"]`);
    if (label && drawn.label) label.replaceWith(drawn.label);
  });
  placeCardBar(nodes);
}

/** The positions a move of `node` to (x, y) gives it and the cards it carries. */
function moveChanges(node: NodeView, x: number, y: number): Map<number, Rect> {
  const dx = x - node.x;
  const dy = y - node.y;
  const changes = new Map<number, Rect>();
  for (const n of movingWith(current?.nodes ?? [], node)) changes.set(n.index, { x: n.x + dx, y: n.y + dy, width: n.width, height: n.height });
  return changes;
}

// --- Dragging cards and corners ------------------------------------------------------------

interface CardDrag {
  readonly pointer: number;
  readonly kind: 'move' | 'resize';
  readonly node: NodeView;
  readonly startX: number;
  readonly startY: number;
  started: boolean;
  last?: { x: number; y: number } | { width: number; height: number };
}
let cardDrag: CardDrag | undefined;

function dragTarget(event: PointerEvent): CardDrag | undefined {
  const target = event.target as Element | null;
  const card = target?.closest<HTMLElement>('.node');
  if (!card || event.button !== 0 || spaceHeld || target?.closest('[data-action], .text-editor')) return undefined;
  const node = nodeOf(Number(card.dataset['index']));
  const can = allows(node?.index);
  const kind = target?.closest('[data-resize]') ? 'resize' : 'move';
  if (node === undefined || !(kind === 'resize' ? can.resize : can.move)) return undefined;
  return { pointer: event.pointerId, kind, node, startX: event.clientX, startY: event.clientY, started: false };
}

viewportEl.addEventListener('pointerdown', (event) => {
  const target = event.target as Element | null;
  if (target?.closest('.text-editor')) return;
  const card = target?.closest<HTMLElement>('.node');
  const panning = event.button === 1 || (event.button === 0 && (spaceHeld || !card));
  if (!panning) {
    if (card && event.button === 0 && !target?.closest('[data-action]')) {
      select(Number(card.dataset['index']));
      // Captured only once it becomes a drag, so clicks and double clicks reach the card.
      cardDrag = dragTarget(event);
    }
    return;
  }
  if (target?.closest('[data-action]') && !spaceHeld) return;
  if (viewport === undefined) return;
  event.preventDefault();
  if (!card) select(undefined);
  viewportEl.focus({ preventScroll: true });
  pan = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, from: viewport };
  viewportEl.setPointerCapture(event.pointerId);
  viewportEl.classList.add('panning');
});

viewportEl.addEventListener('pointermove', (event) => {
  if (cardDrag !== undefined && event.pointerId === cardDrag.pointer && current !== undefined && viewport !== undefined) {
    const dx = event.clientX - cardDrag.startX;
    const dy = event.clientY - cardDrag.startY;
    if (!cardDrag.started) {
      if (!passedThreshold(dx, dy)) return;
      cardDrag.started = true;
      viewportEl.setPointerCapture(event.pointerId);
      nodeElement(cardDrag.node.index)?.classList.add('dragging', 'raised');
      viewportEl.classList.add('dragging-card');
      closePicker(false);
    }
    const node = cardDrag.node;
    if (cardDrag.kind === 'move') {
      const to = dropPosition(node, dx, dy, viewport.scale, current.snapToGrid);
      cardDrag.last = to;
      preview(moveChanges(node, to.x, to.y));
    } else {
      const size = dropSize(node, dx, dy, viewport.scale, current.snapToGrid);
      cardDrag.last = size;
      preview(new Map([[node.index, { x: node.x, y: node.y, ...size }]]));
    }
    return;
  }
  if (pan === undefined || event.pointerId !== pan.pointer) return;
  applyViewport({ x: pan.from.x + event.clientX - pan.startX, y: pan.from.y + event.clientY - pan.startY, scale: pan.from.scale });
});

function endCardDrag(event: PointerEvent, cancelled: boolean): void {
  if (cardDrag === undefined || event.pointerId !== cardDrag.pointer) return;
  const drag = cardDrag;
  cardDrag = undefined;
  viewportEl.classList.remove('dragging-card');
  nodeElement(drag.node.index)?.classList.remove('dragging');
  if (!drag.started || drag.last === undefined) return;
  // One drag = one write = one undo step (canvas.md 3.3).
  const message = cancelled
    ? undefined
    : 'x' in drag.last
      ? moveMessage(version, drag.node, drag.last.x, drag.last.y)
      : resizeMessage(version, drag.node, drag.last.width, drag.last.height);
  if (!sendEdit(message) && current !== undefined) draw(current);
}

const endPan = (event: PointerEvent): void => {
  if (pan === undefined || event.pointerId !== pan.pointer) return;
  pan = undefined;
  viewportEl.classList.remove('panning');
};
viewportEl.addEventListener('pointerup', (event) => {
  endCardDrag(event, false);
  endPan(event);
});
viewportEl.addEventListener('pointercancel', (event) => {
  endCardDrag(event, true);
  endPan(event);
});

/** Whether `target` sits in a card body that can still scroll in the wheel's direction. */
function scrollsInside(target: Element | null, dx: number, dy: number): boolean {
  for (let node = target; node && node !== viewportEl; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (!node.classList.contains('node-body') && !node.classList.contains('text-input')) continue;
    if (dy < 0 && node.scrollTop > 0) return true;
    if (dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
    if (dx < 0 && node.scrollLeft > 0) return true;
    if (dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
    return false;
  }
  return false;
}

viewportEl.addEventListener(
  'wheel',
  (event) => {
    if (viewport === undefined) return;
    const action = wheelAction(event);
    if (action.kind === 'pan' && scrollsInside(event.target as Element | null, action.dx, action.dy)) return;
    event.preventDefault();
    if (action.kind === 'zoom') {
      const box = viewportEl.getBoundingClientRect();
      applyViewport(zoomAt(viewport, action.factor, event.clientX - box.left, event.clientY - box.top));
    } else panBy(action.dx, action.dy);
  },
  { passive: false },
);

// Focus moving to a card (Tab, click) selects it and brings it into view. The browser may
// scroll the clipped pane to show the focused card; the pan replaces that scroll.
viewportEl.addEventListener('focusin', (event) => {
  const card = (event.target as Element | null)?.closest<HTMLElement>('.node');
  viewportEl.scrollTop = 0;
  viewportEl.scrollLeft = 0;
  if (!card) return;
  const index = Number(card.dataset['index']);
  if (index !== selected) select(index);
  const node = nodeOf(index);
  if (node !== undefined && viewport !== undefined && pan === undefined && cardDrag === undefined) {
    const { width, height } = paneSize();
    applyViewport(ensureVisible(viewport, node, width, height));
  }
});
viewportEl.addEventListener('scroll', () => {
  viewportEl.scrollTop = 0;
  viewportEl.scrollLeft = 0;
});

// --- Keyboard moves and resizes ------------------------------------------------------------

/** Moves or resizes the selected card by (dx, dy) canvas pixels: sent now or after the edit in flight. */
function keyEdit(kind: 'move' | 'resize', node: NodeView, dx: number, dy: number): void {
  if (inFlight) {
    if (!pendingKeys.add(kind, node.index, dx, dy)) return;
    const waiting = pendingKeys.peek()!;
    showKeyPreview(node, waiting.kind, waiting.dx, waiting.dy);
    return;
  }
  sendKeyEdit(kind, node, dx, dy);
}

function keyTarget(node: NodeView, kind: 'move' | 'resize', dx: number, dy: number) {
  if (kind === 'move') return dropPosition(node, dx, dy, 1, false);
  return dropSize(node, dx, dy, 1, false);
}

function showKeyPreview(node: NodeView, kind: 'move' | 'resize', dx: number, dy: number): void {
  const to = keyTarget(node, kind, dx, dy);
  preview('x' in to ? moveChanges(node, to.x, to.y) : new Map([[node.index, { x: node.x, y: node.y, ...to }]]));
}

function sendKeyEdit(kind: 'move' | 'resize', node: NodeView, dx: number, dy: number): void {
  const to = keyTarget(node, kind, dx, dy);
  const message = 'x' in to ? moveMessage(version, node, to.x, to.y) : resizeMessage(version, node, to.width, to.height);
  if (sendEdit(message)) showKeyPreview(node, kind, dx, dy);
}

/** After a new view: the keyboard change that waited for it goes out. */
function flushKeys(): void {
  const waiting = pendingKeys.take();
  if (waiting === undefined) return;
  const node = nodeOf(waiting.index);
  if (node !== undefined && (waiting.kind === 'move' ? allows(node.index).move : allows(node.index).resize)) {
    sendKeyEdit(waiting.kind, node, waiting.dx, waiting.dy);
  }
}

// --- Text editor ----------------------------------------------------------------------------

interface TextEditing {
  readonly index: number;
  readonly id: string;
  /** Version the text was opened on; a save on a changed document is refused (stale). */
  version: number;
  /** The card's text when the editor opened. */
  readonly original: string;
  readonly editor: HTMLElement;
  readonly field: HTMLTextAreaElement;
  /** Sent, waiting for the extension's answer. */
  awaiting?: string;
  /** Refused: the next view's version becomes the editor's (saving again is the user's choice). */
  retarget?: boolean;
}
let editing: TextEditing | undefined;

function openEditor(index: number): void {
  const node = nodeOf(index);
  if (node === undefined || node.kind !== 'text' || !allows(index).text || current === undefined) return;
  if (editing !== undefined && editing.index === index) {
    editing.field.focus();
    return;
  }
  closeEditor();
  closePicker(false);
  const editor = renderTextEditor(doc, node.text ?? '', current.strings);
  const field = editor.querySelector<HTMLTextAreaElement>('textarea')!;
  editing = { index, id: node.id, version, original: node.text ?? '', editor, field };
  restoreEditor();
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

/** Puts the open editor into its card again after a redraw (the draft is kept). */
function restoreEditor(): void {
  if (editing === undefined || current === undefined) return;
  const node = current.nodes.find((n) => n.id === editing!.id && n.kind === 'text');
  if (node === undefined) {
    // The card is gone: its draft is shown so it can be copied.
    const draft = editing.field.value;
    editing = undefined;
    showRefused(`${current.strings.textEditorLabel}: ${draft}`);
    return;
  }
  if (editing.awaiting !== undefined && node.text === editing.awaiting) {
    // Saved: the card shows the new text.
    const hadFocus = document.activeElement === editing.field;
    editing = undefined;
    if (hadFocus) nodeElement(node.index)?.focus({ preventScroll: true });
    return;
  }
  const card = nodeElement(node.index);
  const body = card?.querySelector<HTMLElement>('.node-body');
  if (!card || !body) return;
  const focused = document.activeElement === editing.field;
  const { selectionStart, selectionEnd } = editing.field;
  card.classList.add('editing');
  body.replaceChildren(editing.editor);
  editing.field.readOnly = editing.awaiting !== undefined;
  if (focused) {
    editing.field.focus({ preventScroll: true });
    editing.field.setSelectionRange(selectionStart, selectionEnd);
  }
}

function saveEditor(): void {
  if (editing === undefined || editing.awaiting !== undefined) return;
  const node = nodeOf(editing.index);
  if (node === undefined || node.id !== editing.id) return;
  const message = editTextMessage(editing.version, node, editing.field.value);
  if (message === undefined) {
    closeEditor(true);
    return;
  }
  editing.awaiting = message.text;
  editing.field.readOnly = true;
  sendEdit(message);
}

function closeEditor(refocus = false): void {
  if (editing === undefined) return;
  const index = editing.index;
  editing = undefined;
  if (current !== undefined) draw(current);
  if (refocus) nodeElement(index)?.focus({ preventScroll: true });
}

function editorKeys(event: KeyboardEvent): void {
  const action = textEditorKey(event);
  // Every other key stays in the text box (Enter breaks the line, Ctrl+Z is its own undo).
  event.stopPropagation();
  if (action === 'none') return;
  event.preventDefault();
  if (action === 'save') saveEditor();
  else closeEditor(true);
}

// --- Card bar and color picker --------------------------------------------------------------

let picker: HTMLElement | undefined;

function showCardBar(): void {
  const can = allows(selected);
  const visible = mode === 'canvas' && selected !== undefined && (can.text || can.color) && editing?.index !== selected;
  cardBarHost.hidden = !visible;
  if (!visible || current === undefined) {
    cardBarHost.replaceChildren();
    picker = undefined;
    return;
  }
  const bar = renderCardBar(doc, current.strings, can);
  cardBarHost.replaceChildren(bar);
  if (picker !== undefined) {
    const node = nodeOf(selected!);
    picker = renderColorPicker(doc, current.strings, node?.color);
    cardBarHost.append(picker);
    bar.querySelector('[data-edit="color"]')?.setAttribute('aria-expanded', 'true');
  }
  placeCardBar();
}

function placeCardBar(nodes?: readonly NodeView[]): void {
  if (cardBarHost.hidden || selected === undefined || viewport === undefined) return;
  const node = (nodes ?? current?.nodes)?.find((n) => n.index === selected);
  if (node === undefined) return;
  cardBarHost.style.setProperty('left', `${Math.round(node.x * viewport.scale + viewport.x)}px`);
  cardBarHost.style.setProperty('top', `${Math.round(node.y * viewport.scale + viewport.y)}px`);
}

function openPicker(): void {
  if (selected === undefined || !allows(selected).color || current === undefined) return;
  picker = el('div');
  showCardBar();
  picker?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
}

function closePicker(refocus: boolean): void {
  if (picker === undefined) return;
  picker = undefined;
  showCardBar();
  if (refocus && selected !== undefined) nodeElement(selected)?.focus({ preventScroll: true });
}

function chooseColor(color: ColorChoice): void {
  const node = selected === undefined ? undefined : nodeOf(selected);
  closePicker(true);
  if (node !== undefined) sendEdit(colorMessage(version, node, color));
}

cardBarHost.addEventListener('keydown', (event) => {
  const { key } = event;
  const swatch = (event.target as Element | null)?.closest<HTMLElement>('.swatch');
  if (key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePicker(true);
    return;
  }
  // The numbers on the swatches pick them; 0 removes the color.
  if (picker !== undefined && /^[0-6]$/.test(key)) {
    event.preventDefault();
    event.stopPropagation();
    chooseColor(key === '0' ? 'none' : (key as ColorChoice));
    return;
  }
  if (!swatch || picker === undefined) return;
  const swatches = [...picker.querySelectorAll<HTMLElement>('.swatch:not([disabled])')];
  const at = swatches.indexOf(swatch);
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (step !== 0 && at >= 0) {
    event.preventDefault();
    event.stopPropagation();
    swatches[(at + step + swatches.length) % swatches.length]?.focus();
  }
});

// --- Clicks ----------------------------------------------------------------------------------

app.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  if (act(target)) return;
  const swatch = target?.closest<HTMLElement>('.swatch[data-color]');
  if (swatch) {
    chooseColor(swatch.dataset['color'] as ColorChoice);
    return;
  }
  switch (target?.closest<HTMLElement>('[data-edit]')?.dataset['edit']) {
    case 'text':
      if (selected !== undefined) openEditor(selected);
      return;
    case 'color':
      if (picker === undefined) openPicker();
      else closePicker(true);
      return;
    case 'save':
      saveEditor();
      return;
    case 'cancel':
      closeEditor(true);
      return;
    case 'dismiss':
      showRefused(undefined);
      return;
  }
  const tool = target?.closest<HTMLElement>('[data-tool]')?.dataset['tool'];
  switch (tool) {
    case 'zoom-in':
      zoomBy(1.25);
      return;
    case 'zoom-out':
      zoomBy(1 / 1.25);
      return;
    case 'zoom-reset': {
      if (viewport === undefined) return;
      const { width, height } = paneSize();
      applyViewport(zoomTo(viewport, 1, width / 2, height / 2));
      return;
    }
    case 'fit':
      fitAll();
      return;
    case 'list':
      setMode(mode === 'list' ? 'canvas' : 'list');
      return;
    case 'help': {
      help.hidden = !help.hidden;
      helpButton.setAttribute('aria-expanded', String(!help.hidden));
      return;
    }
  }
});

viewportEl.addEventListener('dblclick', (event) => {
  const target = event.target as Element | null;
  if (target?.closest('.text-editor, [data-action]')) return;
  const card = target?.closest<HTMLElement>('.node-text');
  if (card) openEditor(Number(card.dataset['index']));
});

// --- Keys --------------------------------------------------------------------------------------

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

document.addEventListener('keydown', (event) => {
  const { key } = event;
  if (editing !== undefined && event.target === editing.field) {
    editorKeys(event);
    return;
  }
  if (isTyping(event.target)) return;
  const target = event.target as Element | null;
  // Links drawn as text (file names, URLs, Markdown links) open with Enter like real links.
  if (key === 'Enter' && target?.closest('[data-action]') && act(target)) {
    event.preventDefault();
    return;
  }
  if (current === undefined || mode === 'list') return;
  const inCanvas = target === document.body || target === viewportEl || viewportEl.contains(target);
  if (!inCanvas) return;
  if (key === ' ') {
    spaceHeld = true;
    viewportEl.classList.add('space-pan');
    event.preventDefault();
    return;
  }
  const card = target?.closest<HTMLElement>('.node');
  const node = card ? nodeOf(Number(card.dataset['index'])) : undefined;
  if (node !== undefined) {
    const can = allows(node.index);
    const change = keyboardEdit(event);
    if (change !== undefined) {
      if (change.kind === 'move' ? can.move : can.resize) {
        event.preventDefault();
        keyEdit(change.kind, node, change.dx, change.dy);
      }
      return;
    }
    if ((key === 'Enter' || key === 'F2') && !event.altKey && !event.ctrlKey && !event.metaKey && node.kind === 'text' && can.text) {
      event.preventDefault();
      openEditor(node.index);
      return;
    }
    if ((key === 'c' || key === 'C') && !event.altKey && !event.ctrlKey && !event.metaKey && can.color) {
      event.preventDefault();
      openPicker();
      return;
    }
  }
  const action = keyAction(event, card != null);
  if (action === undefined) return;
  event.preventDefault();
  switch (action.kind) {
    case 'pan':
      panBy(action.dx, action.dy);
      return;
    case 'zoom':
      zoomBy(action.factor);
      return;
    case 'zoomReset': {
      if (viewport === undefined) return;
      const { width, height } = paneSize();
      applyViewport(zoomTo(viewport, 1, width / 2, height / 2));
      return;
    }
    case 'fit':
      fitAll();
      return;
    case 'open':
      if (card) openNode(Number(card.dataset['index']));
      return;
    case 'clear':
      if (!help.hidden) {
        help.hidden = true;
        helpButton.setAttribute('aria-expanded', 'false');
      }
      select(undefined);
      viewportEl.focus({ preventScroll: true });
      return;
  }
});

document.addEventListener('keyup', (event) => {
  const { key } = event;
  if (key !== ' ') return;
  spaceHeld = false;
  viewportEl.classList.remove('space-pan');
});
window.addEventListener('blur', () => {
  spaceHeld = false;
  viewportEl.classList.remove('space-pan');
});

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  if (message?.type === 'render') {
    version = message.version;
    inFlight = false;
    if (editing !== undefined && message.view.state === 'canvas') {
      const open = editing;
      const node = message.view.nodes.find((n) => n.id === open.id);
      // Other edits (another card moved) do not outdate the open text while this card's text is
      // unchanged; after a refusal the next save is the user's choice.
      if (open.retarget === true || (open.awaiting === undefined && node?.text === open.original)) open.version = message.version;
      open.retarget = false;
    }
    draw(message.view);
    flushKeys();
  } else if (message?.type === 'refused') {
    inFlight = false;
    pendingKeys.take();
    if (editing !== undefined && editing.awaiting !== undefined) {
      // Not saved: the draft stays open; saving again writes it over the latest content.
      editing.awaiting = undefined;
      editing.field.readOnly = false;
      editing.retarget = true;
    }
    showRefused(message.message);
  }
});

post({ type: 'ready' });
