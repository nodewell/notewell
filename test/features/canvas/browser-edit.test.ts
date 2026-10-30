// Editing logic of the canvas webview (browser/edit.ts) and the editing elements it draws.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  canEdit,
  colorMessage,
  DRAG_THRESHOLD,
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
} from '../../../src/features/canvas/browser/edit.ts';
import { edgeGeometry } from '../../../src/features/canvas/browser/geometry.ts';
import { renderColorPicker, renderHelp, renderList, renderNode, renderRefused, renderTextEditor, renderWorld } from '../../../src/features/canvas/browser/render.ts';
import { validateWebviewMessage } from '../../../src/features/canvas/messages.ts';
import { readCanvas } from '../../../src/features/canvas/model.ts';
import { buildCanvasView, DEFAULT_STRINGS, type CanvasView, type NodeView } from '../../../src/features/canvas/view.ts';

class FakeElement {
  readonly tagName: string;
  #text: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly styles = new Map<string, string>();
  readonly children: (FakeElement | string)[] = [];
  readonly classList = { add: (...tokens: string[]) => void tokens.forEach((t) => this.classes.add(t)) };
  readonly style = { setProperty: (name: string, value: string) => void this.styles.set(name, value) };
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
  byClass(name: string): FakeElement[] {
    return this.find((e) => e.classes.has(name) || (e.attrs.get('class') ?? '').split(' ').includes(name));
  }
}
const doc = { createElement: (tag: string) => new FakeElement(tag), createElementNS: (_: string, tag: string) => new FakeElement(tag) };

function node(extra: Partial<NodeView> & { kind: NodeView['kind'] }): NodeView {
  return { index: 1, id: 'n', type: extra.kind, x: 100, y: 50, width: 200, height: 100, title: 'T', ...extra } as NodeView;
}

test('a press becomes a drag only past the threshold', () => {
  assert.equal(passedThreshold(0, 0), false);
  assert.equal(passedThreshold(DRAG_THRESHOLD - 1, 0), false);
  assert.equal(passedThreshold(3, 3), true);
});

test('drop positions and sizes: screen pixels over zoom, integers, grid, minimum size', () => {
  const n = node({ kind: 'text' });
  assert.deepEqual(dropPosition(n, 50, -25, 0.5, false), { x: 200, y: 0 });
  assert.deepEqual(dropPosition(n, 13, 7, 1, false), { x: 113, y: 57 });
  assert.deepEqual(dropPosition(n, 13, 7, 1, true), { x: 120, y: 60 });
  assert.deepEqual(dropPosition(n, 0.4, -0.4, 1, false), { x: 100, y: 50 });
  assert.deepEqual(dropSize(n, 33, -80, 1, false), { width: 233, height: 20 });
  assert.deepEqual(dropSize(n, -1000, 0, 2, false), { width: 20, height: 100 });
  // On the grid the far corner snaps: x 100 + 233 = 333 -> 340; y 50 + 100 = 150 -> 160.
  assert.deepEqual(dropSize(n, 33, 0, 1, true), { width: 240, height: 110 });
});

test('a group moves with every card fully inside it; other cards alone', () => {
  const group = node({ kind: 'group', index: 0, x: 0, y: 0, width: 500, height: 300 });
  const inside = node({ kind: 'text', index: 1, x: 10, y: 10, width: 50, height: 50 });
  const across = node({ kind: 'text', index: 2, x: 480, y: 10, width: 50, height: 50 });
  const nested = node({ kind: 'group', index: 3, x: 100, y: 100, width: 100, height: 100 });
  const nodes = [group, inside, across, nested];
  assert.deepEqual(movingWith(nodes, group).map((n) => n.index), [0, 1, 3]);
  assert.deepEqual(movingWith(nodes, inside).map((n) => n.index), [1]);
});

test('what a card allows: locked and read-only allow nothing; unknown types move and resize only', () => {
  assert.deepEqual(canEdit(node({ kind: 'text' }), true), { move: true, resize: true, text: true, color: true });
  assert.deepEqual(canEdit(node({ kind: 'file' }), true), { move: true, resize: true, text: false, color: true });
  assert.deepEqual(canEdit(node({ kind: 'unknown' }), true), { move: true, resize: true, text: false, color: false });
  assert.deepEqual(canEdit(node({ kind: 'text', locked: true }), true), { move: false, resize: false, text: false, color: false });
  assert.deepEqual(canEdit(node({ kind: 'text' }), false), { move: false, resize: false, text: false, color: false });
  assert.deepEqual(canEdit(undefined, true), { move: false, resize: false, text: false, color: false });
});

test('messages carry version, identity and the values shown; no change sends nothing; all validate', () => {
  const text = node({ kind: 'text', text: 'old', color: '#aabbcc' });
  const messages = [
    moveMessage(4, text, 110, 60),
    resizeMessage(4, text, 300, 100),
    editTextMessage(4, text, 'new\r\nline'),
    colorMessage(4, text, '3'),
    colorMessage(4, text, 'none'),
  ];
  assert.deepEqual(messages[0], { type: 'move', version: 4, index: 1, id: 'n', x: 110, y: 60, fromX: 100, fromY: 50 });
  assert.deepEqual(messages[1], { type: 'resize', version: 4, index: 1, id: 'n', width: 300, height: 100, fromWidth: 200, fromHeight: 100 });
  assert.deepEqual(messages[2], { type: 'editText', version: 4, index: 1, id: 'n', text: 'new\nline' });
  assert.deepEqual(messages[3], { type: 'setColor', version: 4, index: 1, id: 'n', color: '3', from: '#aabbcc' });
  for (const message of messages) assert.ok(validateWebviewMessage(message).ok, JSON.stringify(message));
  assert.equal(moveMessage(4, text, 100, 50), undefined);
  assert.equal(resizeMessage(4, text, 200, 100), undefined);
  assert.equal(editTextMessage(4, text, 'old'), undefined);
  assert.equal(editTextMessage(4, node({ kind: 'file' }), 'x'), undefined);
  assert.equal(colorMessage(4, node({ kind: 'text', color: '3' }), '3'), undefined);
  assert.equal(colorMessage(4, node({ kind: 'text' }), 'none'), undefined);
});

test('text editor keys: Ctrl/Cmd+Enter saves, Escape cancels, nothing while composing', () => {
  const key = (k: string, extra = {}) => ({ key: k, ctrlKey: false, metaKey: false, isComposing: false, ...extra });
  assert.equal(textEditorKey(key('Enter', { ctrlKey: true })), 'save');
  assert.equal(textEditorKey(key('Enter', { metaKey: true })), 'save');
  assert.equal(textEditorKey(key('Enter')), 'none', 'Enter breaks the line');
  assert.equal(textEditorKey(key('Escape')), 'cancel');
  assert.equal(textEditorKey(key('Enter', { ctrlKey: true, isComposing: true })), 'none');
  assert.equal(textEditorKey(key('Escape', { isComposing: true })), 'none');
  assert.equal(textEditorKey(key('Enter', { ctrlKey: true, keyCode: 229 })), 'none', 'IME process key');
});

test('arrow keys move the selected card 10 px (Shift 50); Alt resizes; Ctrl/Cmd are left alone', () => {
  const k = (name: string, extra = {}) => ({ key: name, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });
  assert.deepEqual(keyboardEdit(k('ArrowRight')), { kind: 'move', dx: 10, dy: 0 });
  assert.deepEqual(keyboardEdit(k('ArrowUp', { shiftKey: true })), { kind: 'move', dx: 0, dy: -50 });
  assert.deepEqual(keyboardEdit(k('ArrowLeft', { altKey: true })), { kind: 'resize', dx: -10, dy: 0 });
  assert.deepEqual(keyboardEdit(k('ArrowDown', { altKey: true, shiftKey: true })), { kind: 'resize', dx: 0, dy: 50 });
  assert.equal(keyboardEdit(k('ArrowDown', { ctrlKey: true })), undefined);
  assert.equal(keyboardEdit(k('a')), undefined);
});

test('keyboard changes made while an edit is on its way add up into one', () => {
  const pending = new PendingKeyEdits();
  assert.equal(pending.take(), undefined);
  assert.ok(pending.add('move', 1, 10, 0));
  assert.ok(pending.add('move', 1, 10, -50));
  assert.equal(pending.add('resize', 1, 10, 0), false, 'another kind waits');
  assert.equal(pending.add('move', 2, 10, 0), false, 'another card waits');
  assert.deepEqual(pending.peek(), { kind: 'move', index: 1, dx: 20, dy: -50 });
  assert.deepEqual(pending.take(), { kind: 'move', index: 1, dx: 20, dy: -50 });
  assert.equal(pending.size, 0);
});

function shown(source: string, options = {}): Extract<CanvasView, { state: 'canvas' }> {
  const view = buildCanvasView(readCanvas(source), options);
  assert.equal(view.state, 'canvas');
  return view as Extract<CanvasView, { state: 'canvas' }>;
}

const SOURCE = JSON.stringify({
  nodes: [
    { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 50 },
    { id: 'd', type: 'text', text: 'D', x: 300, y: 0, width: 100, height: 50 },
    { id: 'd', type: 'text', text: 'E', x: 600, y: 0, width: 100, height: 50 },
    { id: 'g', type: 'group', label: 'Empty', x: 0, y: 500, width: 100, height: 100 },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'd', label: 'L' }],
});

test('editable cards get a resize handle; locked cards and read-only views do not', () => {
  const world = renderWorld(doc, shown(SOURCE)) as unknown as FakeElement;
  const handles = (id: string) => world.find((e) => e.attrs.get('data-id') === id)[0]!.byClass('resize-handle').length;
  assert.deepEqual([handles('a'), handles('d'), handles('g')], [1, 0, 1]);
  const handle = world.byClass('resize-handle')[0]!;
  assert.deepEqual([handle.attrs.get('aria-hidden'), handle.attrs.get('title')], ['true', 'Resize']);
  const readOnly = renderWorld(doc, shown(SOURCE, { editable: false })) as unknown as FakeElement;
  assert.equal(readOnly.byClass('resize-handle').length, 0);
  assert.equal((renderNode(doc, node({ kind: 'text', text: '' }), DEFAULT_STRINGS) as unknown as FakeElement).byClass('resize-handle').length, 0);
  // Edges and their labels carry their position, so a drag can redraw them.
  assert.equal(world.byClass('edge')[0]!.attrs.get('data-edge-index'), '0');
  assert.equal(world.byClass('edge-label')[0]!.attrs.get('data-edge-index'), '0');
});

test('color picker: none and six presets, the current one pressed; a hex color shows as a kept custom swatch', () => {
  const picker = renderColorPicker(doc, DEFAULT_STRINGS, '3') as unknown as FakeElement;
  const swatches = picker.byClass('swatch');
  assert.deepEqual(swatches.map((s) => s.attrs.get('data-color')), ['none', '1', '2', '3', '4', '5', '6']);
  assert.deepEqual(swatches.map((s) => s.attrs.get('aria-pressed')), ['false', 'false', 'false', 'true', 'false', 'false', 'false']);
  assert.deepEqual(swatches.map((s) => s.attrs.get('aria-label')), ['No color', 'Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Purple']);
  assert.equal(swatches[1]!.styles.get('--nw-node-color'), 'var(--nw-color-1)');
  const none = renderColorPicker(doc, DEFAULT_STRINGS, undefined) as unknown as FakeElement;
  assert.equal(none.byClass('swatch')[0]!.attrs.get('aria-pressed'), 'true');
  const hex = renderColorPicker(doc, DEFAULT_STRINGS, '#12ab9f') as unknown as FakeElement;
  const custom = hex.byClass('swatch-custom')[0]!;
  assert.deepEqual([custom.attrs.has('disabled'), custom.attrs.get('aria-pressed'), custom.styles.get('--nw-node-color')], [true, 'true', '#12ab9f']);
  assert.equal(hex.byClass('swatch').filter((s) => s.attrs.get('aria-pressed') === 'true').length, 1);
  const bad = renderColorPicker(doc, DEFAULT_STRINGS, '#12ab9f;x') as unknown as FakeElement;
  assert.equal(bad.byClass('swatch-custom').length, 0);
});

test('text editor: the text as a textarea value, hint, save and cancel buttons', () => {
  const editor = renderTextEditor(doc, '<b>raw</b>\nline', DEFAULT_STRINGS) as unknown as FakeElement;
  const area = editor.find((e) => e.tagName === 'textarea')[0]!;
  assert.equal(area.textContent, '<b>raw</b>\nline');
  assert.equal(area.attrs.get('aria-label'), 'Card text');
  assert.deepEqual(editor.find((e) => e.tagName === 'button').map((b) => b.attrs.get('data-edit')), ['cancel', 'save']);
  assert.equal(editor.find((e) => e.attrs.get('data-edit') === undefined && e.tagName === 'b').length, 0);
});

test('refused edits: an alert with the message and a dismiss button', () => {
  const notice = renderRefused(doc, 'Not applied.', DEFAULT_STRINGS) as unknown as FakeElement;
  assert.equal(notice.attrs.get('role'), 'alert');
  assert.ok(notice.classes.has('notice-error'));
  assert.equal(notice.byClass('notice-text')[0]!.textContent, 'Not applied.');
  assert.equal(notice.find((e) => e.tagName === 'button')[0]!.attrs.get('data-edit'), 'dismiss');
});

test('help: only keys in kbd; edit rows only when editable', () => {
  const read = renderHelp(doc, DEFAULT_STRINGS) as unknown as FakeElement;
  const edit = renderHelp(doc, DEFAULT_STRINGS, { editable: true }) as unknown as FakeElement;
  const kbds = (root: FakeElement) => root.find((e) => e.tagName === 'kbd').map((k) => k.textContent);
  assert.ok(!kbds(read).includes(DEFAULT_STRINGS.helpArrowsKey), 'arrow keys are described, not a key cap');
  assert.ok(kbds(read).includes('Space'));
  const dragRow = read.find((e) => e.tagName === 'dt').find((dt) => dt.textContent!.includes('Space'))!;
  assert.equal(dragRow.textContent, 'Drag the background / Space + drag');
  assert.equal(edit.find((e) => e.tagName === 'dt').length, read.find((e) => e.tagName === 'dt').length + 6);
  assert.ok(kbds(edit).includes('Alt') && kbds(edit).includes('C'));
});

test('list view: an empty group says so', () => {
  const list = renderList(doc, shown(SOURCE)) as unknown as FakeElement;
  assert.deepEqual(list.byClass('list-empty-group').map((p) => p.textContent), ['(no cards)']);
});

test('labels sit on the curve clear of both cards when there is room', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  // A card inside a larger one (the edge runs over the larger card): the label moves along the curve.
  const big = { x: -50, y: -50, width: 400, height: 400 };
  const g = edgeGeometry(a, { x: 600, y: 0, width: 100, height: 100 }, { fromEnd: 'none', toEnd: 'arrow' });
  assert.deepEqual(g.middle, { x: 343, y: 50 });
  const overlapping = edgeGeometry(big, { x: 600, y: 100, width: 100, height: 100 }, { fromEnd: 'none', toEnd: 'arrow' });
  assert.ok(overlapping.middle.x > 350 + 24 || overlapping.middle.x < 600 - 24, JSON.stringify(overlapping.middle));
});

test('the selected card is raised above the other cards of its layer, in the view only', () => {
  const view = shown(SOURCE);
  const world = renderWorld(doc, view, { selected: 1 }) as unknown as FakeElement;
  const raised = world.byClass('raised');
  assert.deepEqual(raised.map((e) => e.attrs.get('data-id')), ['d']);
  assert.ok(raised[0]!.classes.has('selected'));
  // Still in file order within its layer: raising is a stacking rule, not a reorder.
  const cards = world.byClass('layer-cards')[0]!.children as FakeElement[];
  assert.deepEqual(cards.map((c) => c.attrs.get('data-index')), ['0', '1', '2']);
  assert.equal(renderWorld(doc, view).find((e) => e.classes.has('raised')).length, 0);
  // The stylesheet: every card and layer stacks on its own; a raised card above its neighbours.
  const css = readFileSync(new URL('../../../src/features/canvas/browser/canvas.css', import.meta.url), 'utf8');
  const zIndex = (selector: string): number => {
    const start = css.indexOf(`\n${selector} {`);
    const rule = start < 0 ? '' : css.slice(start, css.indexOf('}', start));
    const at = rule.indexOf('z-index: ');
    return at < 0 ? Number.NaN : Number.parseInt(rule.slice(at + 'z-index: '.length), 10);
  };
  assert.equal(zIndex('.node'), 0);
  assert.equal(zIndex('.node.raised'), 1);
  assert.ok(zIndex('.layer-cards') > zIndex('.layer-edges') && zIndex('.layer-edges') > zIndex('.layer'));
  assert.ok(zIndex('.layer-labels') > zIndex('.layer-cards'));
});
