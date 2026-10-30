// Renders canvas views with a fake document: only allowed elements and attributes, text only as
// text, user colors only validated, positions only through style properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { colorValue, cssUrl, renderError, renderHelp, renderList, renderNode, renderNotices, renderWorld } from '../../../src/features/canvas/browser/render.ts';
import { readCanvas } from '../../../src/features/canvas/model.ts';
import { buildCanvasView, type CanvasView, type NodeView } from '../../../src/features/canvas/view.ts';
import { variants } from './support.ts';

class FakeElement {
  readonly tagName: string;
  readonly namespace: string | undefined;
  #text: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly styles = new Map<string, string>();
  readonly children: (FakeElement | string)[] = [];
  readonly classList = { add: (...tokens: string[]) => void tokens.forEach((t) => this.classes.add(t)) };
  readonly style = { setProperty: (name: string, value: string) => void this.styles.set(name, value) };

  constructor(tagName: string, namespace?: string) {
    this.tagName = tagName;
    this.namespace = namespace;
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
    return this.find((e) => e.classes.has(name));
  }
}

const doc = {
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (namespace: string, tag: string) => new FakeElement(tag, namespace),
};

const HTML_TAGS = new Set(['div', 'span', 'p', 'strong', 'em', 's', 'code', 'pre', 'br', 'img', 'ul', 'ol', 'li', 'input', 'blockquote', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'button', 'dl', 'dt', 'dd', 'kbd', 'mark']);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'polygon']);
const STYLE_PROPS = new Set(['left', 'top', 'width', 'height', '--nw-node-color', 'background-image']);

function shown(source: string, options = {}): Extract<CanvasView, { state: 'canvas' }> {
  const view = buildCanvasView(readCanvas(source), options);
  assert.equal(view.state, 'canvas');
  return view as Extract<CanvasView, { state: 'canvas' }>;
}

function assertSafe(root: FakeElement): void {
  for (const element of root.walk()) {
    if (element.namespace === undefined) assert.ok(HTML_TAGS.has(element.tagName), element.tagName);
    else {
      assert.equal(element.namespace, 'http://www.w3.org/2000/svg');
      assert.ok(SVG_TAGS.has(element.tagName), element.tagName);
    }
    for (const attr of element.attrs.keys()) {
      assert.ok(!attr.startsWith('on') && attr !== 'style' && attr !== 'href' && attr !== 'srcdoc', attr);
    }
    for (const prop of element.styles.keys()) assert.ok(STYLE_PROPS.has(prop), prop);
    if (element.styles.has('--nw-node-color')) assert.match(element.styles.get('--nw-node-color')!, /^(var\(--nw-color-[1-6]\)|#[0-9a-f]{6})$/);
  }
}

test('every fixture variant renders with safe elements, attributes and styles only', () => {
  for (const { name, source } of variants()) {
    const view = shown(source);
    const world = renderWorld(doc, view) as unknown as FakeElement;
    assertSafe(world);
    assertSafe(renderList(doc, view) as unknown as FakeElement);
    assert.equal(world.byClass('node').length, view.nodes.length, name);
  }
});

const HOSTILE = '<img src=x onerror=alert(1)><script>alert(1)</script> "quotes" & \'more\'';

test('text from the file only ever becomes text', () => {
  const view = shown(
    JSON.stringify({
      nodes: [
        { id: 't', type: 'text', text: HOSTILE, x: 0, y: 0, width: 10, height: 10 },
        { id: 'f', type: 'file', file: HOSTILE, x: 0, y: 0, width: 10, height: 10 },
        { id: 'l', type: 'link', url: HOSTILE, x: 0, y: 0, width: 10, height: 10 },
        { id: 'g', type: 'group', label: HOSTILE, x: 0, y: 0, width: 10, height: 10 },
        { id: 'u', type: HOSTILE, x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e', fromNode: 't', toNode: 'f', label: HOSTILE }],
    }),
  );
  const world = renderWorld(doc, view) as unknown as FakeElement;
  assertSafe(world);
  assert.equal(world.find((e) => e.tagName === 'script' || e.tagName === 'img').length, 0);
  const text = world.textContent ?? '';
  // Each value appears as literal text (file name, URL, group label, type, edge label, text card).
  assert.ok(text.split(HOSTILE).length - 1 >= 5, text);
  assert.equal(world.byClass('edge-label')[0]!.textContent, HOSTILE);
});

function node(view: Partial<NodeView> & { kind: NodeView['kind'] }): NodeView {
  return { index: 0, id: 'n', type: view.kind, x: 10, y: -20, width: 300, height: 200, title: 'T', ...view } as NodeView;
}

const STRINGS = shown('{}').strings;

test('cards: position, size, accessible label, color presets and hex', () => {
  const card = renderNode(doc, node({ kind: 'text', text: '# Hi', color: '4' }), STRINGS) as unknown as FakeElement;
  assert.deepEqual(Object.fromEntries(card.styles), { left: '10px', top: '-20px', width: '300px', height: '200px', '--nw-node-color': 'var(--nw-color-4)' });
  assert.equal(card.attrs.get('aria-label'), 'Text card: T');
  assert.equal(card.attrs.get('tabindex'), '0');
  assert.ok(card.classes.has('colored') && card.classes.has('node-text'));
  // Headings start at h3 inside cards.
  assert.equal(card.find((e) => e.tagName === 'h3').length, 1);
  const hex = renderNode(doc, node({ kind: 'link', url: 'https://x', color: '#12ab9f' }), STRINGS) as unknown as FakeElement;
  assert.equal(hex.styles.get('--nw-node-color'), '#12ab9f');
  // Anything else is never applied (the view only sends validated colors; checked again here).
  for (const color of ['red', '#12ab9', '7', 'var(--x)', '#12ab9f;background:url(x)']) {
    const bad = renderNode(doc, node({ kind: 'text', text: '', color }), STRINGS) as unknown as FakeElement;
    assert.equal(bad.styles.has('--nw-node-color'), false, color);
    assert.equal(colorValue(color), undefined, color);
  }
});

test('file cards: name opens the file; path and state; image preview only from the view', () => {
  const plain = renderNode(doc, node({ kind: 'file', file: 'a/b.md', subpath: '#H', title: 'b.md' }), STRINGS) as unknown as FakeElement;
  const name = plain.byClass('file-name')[0]!;
  assert.deepEqual([name.textContent, name.attrs.get('data-action'), name.attrs.get('role')], ['b.md', 'open-file', 'link']);
  assert.equal(plain.byClass('file-path')[0]!.textContent, 'a/b.md#H');
  assert.equal(plain.find((e) => e.tagName === 'img').length, 0);
  const missing = renderNode(doc, node({ kind: 'file', file: 'm.md', title: 'm.md', missing: true }), STRINGS) as unknown as FakeElement;
  assert.equal(missing.byClass('file-state')[0]!.textContent, 'File not found');
  assert.equal(missing.byClass('file-path').length, 0, 'path equal to the title is not repeated');
  const outside = renderNode(doc, node({ kind: 'file', file: '../o.md', title: 'o.md', outside: true }), STRINGS) as unknown as FakeElement;
  assert.equal(outside.byClass('file-state')[0]!.textContent, 'Outside the vault');
  const image = renderNode(doc, node({ kind: 'file', file: 'p.png', title: 'p.png', image: 'https://res/p.png' }), STRINGS) as unknown as FakeElement;
  const img = image.find((e) => e.tagName === 'img')[0]!;
  assert.deepEqual([img.attrs.get('src'), img.attrs.get('alt')], ['https://res/p.png', 'p.png']);
});

test('link cards show the URL and open it through the extension', () => {
  const card = renderNode(doc, node({ kind: 'link', url: 'https://example.com/x' }), STRINGS) as unknown as FakeElement;
  const url = card.byClass('link-url')[0]!;
  assert.deepEqual([url.textContent, url.attrs.get('data-action'), url.attrs.get('data-url')], ['https://example.com/x', 'open-url', 'https://example.com/x']);
});

test('groups: label and a background image only from a safe URL', () => {
  const group = renderNode(doc, node({ kind: 'group', label: 'Week', background: 'https://res/bg.png', backgroundStyle: 'ratio' }), STRINGS) as unknown as FakeElement;
  assert.equal(group.byClass('group-label')[0]!.textContent, 'Week');
  const bg = group.byClass('group-bg')[0]!;
  assert.ok(bg.classes.has('bg-ratio'));
  assert.equal(bg.styles.get('background-image'), 'url("https://res/bg.png")');
  for (const uri of ['https://res/a").b', "https://res/a'", 'https://res/a b', 'https://res/a\\b', 'relative.png', 'https://res/a)']) {
    assert.equal(cssUrl(uri), undefined, uri);
    const unsafe = renderNode(doc, node({ kind: 'group', background: uri }), STRINGS) as unknown as FakeElement;
    assert.equal(unsafe.byClass('group-bg').length, 0, uri);
  }
});

test('unknown node types are grey "unsupported card" boxes with the type', () => {
  const card = renderNode(doc, node({ kind: 'unknown', type: 'embed', title: 'embed' }), STRINGS) as unknown as FakeElement;
  assert.ok(card.classes.has('node-unknown'));
  assert.equal(card.attrs.get('aria-label'), 'Unsupported card: embed');
  assert.equal(card.textContent, 'Unsupported cardembed');
});

const LAYERED = JSON.stringify({
  nodes: [
    { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 50 },
    { id: 'b', type: 'text', text: 'B', x: 300, y: 0, width: 100, height: 50, color: '2' },
    { id: 'g', type: 'group', label: 'G', x: -50, y: -50, width: 500, height: 200 },
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b', label: 'to b', color: '1' },
    { id: 'e2', fromNode: 'b', toNode: 'a', fromEnd: 'arrow', toEnd: 'none' },
  ],
});

test('layers: groups under edges under cards; labels on top; edges as SVG paths with arrows', () => {
  const world = renderWorld(doc, shown(LAYERED)) as unknown as FakeElement;
  // SVG elements get their class as an attribute.
  const layers = world.children.map((c) => [...(c as FakeElement).classes].join(' ') || (c as FakeElement).attrs.get('class'));
  assert.deepEqual(layers, ['layer layer-groups', 'layer-edges', 'layer layer-cards', 'layer layer-labels']);
  const [groups, edges, cards] = world.children as FakeElement[];
  assert.deepEqual(groups!.children.map((c) => (c as FakeElement).attrs.get('data-id')), ['g']);
  assert.deepEqual(cards!.children.map((c) => (c as FakeElement).attrs.get('data-id')), ['a', 'b']);
  const lines = edges!.children as FakeElement[];
  assert.deepEqual(lines.map((g) => g.attrs.get('data-edge')), ['e1', 'e2']);
  assert.equal(lines[0]!.styles.get('--nw-node-color'), 'var(--nw-color-1)');
  assert.deepEqual(lines.map((g) => g.find((e) => e.tagName === 'polygon').length), [1, 1]);
  assert.match(lines[0]!.find((e) => e.tagName === 'path')[0]!.attrs.get('d')!, /^M 100 25 C /);
  const label = world.byClass('edge-label')[0]!;
  assert.equal(label.textContent, 'to b');
  assert.deepEqual([label.styles.get('left'), label.styles.get('top')], ['193px', '25px'], 'the middle of the curve, which stops at the arrow');
});

test('list view: reading order, members nested under their group, titles not repeated', () => {
  const list = renderList(doc, shown(LAYERED)) as unknown as FakeElement;
  const top = (list.children[0] as FakeElement).children as FakeElement[];
  assert.deepEqual(top.map((i) => i.attrs.get('data-index')), ['2'], 'only the group at the top level');
  const members = top[0]!.byClass('list-members')[0]!.children as FakeElement[];
  assert.deepEqual(members.map((i) => i.attrs.get('data-index')), ['0', '1']);
  assert.equal(top[0]!.find((e) => e.tagName === 'h2')[0]!.textContent, 'Group: G');
  // Text cards without a heading: the kind only, then the text (no repeated title).
  assert.deepEqual(members.map((i) => i.find((e) => e.tagName === 'h3')[0]!.textContent), ['Text card', 'Text card']);
  assert.equal(members[0]!.byClass('md')[0]!.textContent, 'A');
  assert.deepEqual(members[0]!.byClass('list-links').map((p) => p.textContent), ['Links to: B (to b)', 'Linked from: B']);
  const target = members[0]!.byClass('list-target')[0]!;
  assert.deepEqual([target.tagName, target.attrs.get('data-action'), target.attrs.get('data-target')], ['button', 'focus-item', '1']);
  assert.equal(members[0]!.attrs.get('tabindex'), '-1', 'focusable from the link buttons');
  const empty = renderList(doc, shown('{}')) as unknown as FakeElement;
  assert.equal(empty.textContent, 'This canvas is empty.');
});

test('list view: a text card opening with a heading uses it as its title, once', () => {
  const list = renderList(doc, shown(JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: '# Goals\n\nbody', x: 0, y: 0, width: 10, height: 10 }] }))) as unknown as FakeElement;
  assert.equal(list.find((e) => e.tagName === 'h2')[0]!.textContent, 'Text card: Goals');
  assert.equal(list.byClass('md')[0]!.textContent, 'body');
  assert.equal(list.byClass('md-heading').length, 0);
});

test('help: one row per key with kbd elements', () => {
  const help = renderHelp(doc, STRINGS) as unknown as FakeElement;
  assertSafe(help);
  assert.deepEqual(help.find((e) => e.tagName === 'h3').map((h) => h.textContent), ['View']);
  assert.equal(help.find((e) => e.tagName === 'dt').length, help.find((e) => e.tagName === 'dd').length);
  assert.deepEqual(help.find((e) => e.tagName === 'dt')[2]!.find((e) => e.tagName === 'kbd').map((k) => k.textContent), ['+', '-']);
});

test('notices carry their kind', () => {
  const [info, warning] = renderNotices(doc, [{ kind: 'info', text: 'i' }, { kind: 'warning', text: 'w' }]) as unknown as FakeElement[];
  assert.ok(info!.classes.has('notice-info') && warning!.classes.has('notice-warning'));
  assert.equal(warning!.textContent, 'w');
});

test('labels of short edges move off the line; long edges keep them centered', () => {
  const near = JSON.stringify({
    nodes: [
      { id: 'a', type: 'text', text: '', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', type: 'text', text: '', x: 160, y: 0, width: 100, height: 50 },
      { id: 'c', type: 'text', text: '', x: 0, y: 110, width: 100, height: 50 },
      { id: 'd', type: 'text', text: '', x: 1000, y: 0, width: 100, height: 50 },
    ],
    edges: [
      { id: 'h', fromNode: 'a', toNode: 'b', label: 'h' },
      { id: 'v', fromNode: 'a', toNode: 'c', label: 'v' },
      { id: 'l', fromNode: 'a', toNode: 'd', label: 'l' },
    ],
  });
  const labels = (renderWorld(doc, shown(near)) as unknown as FakeElement).byClass('edge-label');
  assert.deepEqual(labels.map((l) => [...l.classes].join(' ')), ['edge-label label-above', 'edge-label label-beside', 'edge-label']);
});

test('error view: message, reason and an Open as Text button', () => {
  const view = buildCanvasView(readCanvas('{"nodes": 1}'));
  assert.equal(view.state, 'error');
  if (view.state !== 'error') return;
  const root = renderError(doc, view) as unknown as FakeElement;
  assertSafe(root);
  assert.equal(root.attrs.get('role'), 'alert');
  assert.equal(root.byClass('error-title')[0]!.textContent, 'This canvas cannot be read (line 1).');
  const button = root.find((e) => e.tagName === 'button')[0]!;
  assert.deepEqual([button.textContent, button.attrs.get('data-action')], ['Open as Text', 'open-as-text']);
});

test('a thousand cards render quickly', () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, type: 'text', text: `## Card ${i}\n\n- a\n- b`, x: (i % 40) * 300, y: Math.floor(i / 40) * 200, width: 250, height: 150 }));
  const edges = Array.from({ length: 999 }, (_, i) => ({ id: `e${i}`, fromNode: `n${i}`, toNode: `n${i + 1}` }));
  const source = JSON.stringify({ nodes, edges });
  const started = performance.now();
  const world = renderWorld(doc, shown(source)) as unknown as FakeElement;
  const elapsed = performance.now() - started;
  assert.equal(world.byClass('node').length, 1000);
  assert.ok(elapsed < 2000, `${elapsed} ms`);
});

test('text cards: ==highlight==, [[wikilinks]] that open the note, #tags (canvas.md 4)', () => {
  const card = renderNode(doc, node({ kind: 'text', text: '**b** ==hi== [[Note#H|shown]] #tag `[[code]]`' }), STRINGS) as unknown as FakeElement;
  assertSafe(card);
  assert.equal(card.find((e) => e.tagName === 'mark')[0]!.textContent, 'hi');
  const link = card.byClass('md-wikilink')[0]!;
  assert.deepEqual([link.textContent, link.attrs.get('data-action'), link.attrs.get('data-target')], ['shown', 'open-link', 'Note#H']);
  assert.equal(card.byClass('md-tag')[0]!.textContent, '#tag');
  assert.equal(card.byClass('md-wikilink').length, 1, 'not inside code');
  // The list view shows them too, without opening anything.
  const list = renderList(doc, shown(JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: 'x [[N]]', x: 0, y: 0, width: 1, height: 1 }] }))) as unknown as FakeElement;
  const inert = list.byClass('md-wikilink')[0]!;
  assert.deepEqual([inert.textContent, inert.attrs.get('data-action')], ['N', undefined]);
});

test('file cards: the caption above opens the file; a note shows its Markdown; an image only itself', () => {
  const note = renderNode(doc, node({ kind: 'file', file: 'a/b.md', title: 'b.md', caption: 'b', note: '# B\n\n[[C]] text' }), STRINGS) as unknown as FakeElement;
  assertSafe(note);
  const caption = note.byClass('node-caption')[0]!;
  assert.deepEqual([caption.textContent, caption.attrs.get('data-action')], ['b', 'open-file']);
  assert.equal(note.byClass('note-body').length, 1);
  assert.equal(note.find((e) => e.tagName === 'h3')[0]!.textContent, 'B', 'headings start at h3 as in text cards');
  assert.equal(note.byClass('md-wikilink')[0]!.attrs.get('data-target'), 'C');
  assert.equal(note.byClass('file-name').length, 0, 'the name is the caption only');
  const image = renderNode(doc, node({ kind: 'file', file: 'p.png', title: 'p.png', caption: 'p.png', image: 'https://res/p.png' }), STRINGS) as unknown as FakeElement;
  assert.deepEqual(image.byClass('image-body')[0]!.children.map((c) => (c as FakeElement).tagName), ['img']);
  // Drawn as large as fits the card, ratio kept and centered: small images grow (canvas.md 4).
  const css = readFileSync(new URL('../../../src/features/canvas/browser/canvas.css', import.meta.url), 'utf8');
  const start = css.indexOf('\n.file-image {');
  const rule = css.slice(start, css.indexOf('}', start));
  for (const declaration of ['width: 100%;', 'height: 100%;', 'object-fit: contain;', 'object-position: center;']) assert.ok(rule.includes(declaration), declaration);
  // Missing notes keep the name and the state in the card.
  const gone = renderNode(doc, node({ kind: 'file', file: 'g.md', title: 'g.md', caption: 'g', missing: true, note: 'stale' }), STRINGS) as unknown as FakeElement;
  assert.deepEqual([gone.byClass('note-body').length, gone.byClass('file-state').length], [0, 1]);
  const link = renderNode(doc, node({ kind: 'link', url: 'https://example.com/x', caption: 'example.com/x' }), STRINGS) as unknown as FakeElement;
  assert.deepEqual([link.byClass('node-caption')[0]!.textContent, link.byClass('node-caption')[0]!.attrs.get('data-action')], ['example.com/x', undefined]);
});
