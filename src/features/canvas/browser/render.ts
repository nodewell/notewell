// Draws the canvas view (canvas.md 4) as DOM elements. DOM-free like the other renderers, so it
// runs under node:test with a fake document: text goes in through textContent only, Markdown
// through the shared renderer, and positions and user colors through style.setProperty (CSSOM,
// allowed by the CSP; never style attributes). Edges are SVG paths built with createElementNS.
//
// Layers, bottom to top: groups (file order), edges, other cards (file order), edge labels.
// Groups always sit under the cards so a group's fill never covers the cards inside it.
import { createElementFactory, type DomDocument, type DomElement } from '../../../webview/dom.ts';
import { parseMarkdown } from '../../../webview/markdown.ts';
import { renderMarkdown } from '../../../webview/markdown-render.ts';
import { renderInlineTokens } from '../../../webview/inline-tokens.ts';
import type { CanvasView, EdgeView, NodeView, Notice, ViewStrings } from '../view.ts';
import { edgeGeometry, readingOrder } from './geometry.ts';

export interface CanvasElement<E> extends DomElement<E> {
  readonly style: { setProperty(name: string, value: string): void };
}

export interface CanvasDocument<E extends CanvasElement<E>> extends DomDocument<E> {
  createElementNS(namespace: string, tagName: string): E;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'polygon']);
const SVG_ATTRS = new Set(['class', 'd', 'points', 'width', 'height', 'aria-hidden', 'focusable', 'data-edge', 'data-edge-index']);
const HEX = /^#[0-9a-f]{6}$/;
const PRESET = /^[1-6]$/;
/** Markdown headings inside cards start at h3 (the list view uses h2 for card titles). */
const HEADING_OFFSET = 2;

/** The CSS value for a validated user color, or undefined (canvas.md 7). */
export function colorValue(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  if (PRESET.test(color)) return `var(--nw-color-${color})`;
  return HEX.test(color) ? color : undefined;
}

/** A CSS url() for a webview resource URI, or undefined when it could end the string. */
export function cssUrl(uri: string): string | undefined {
  return /^[a-z][a-z0-9+.-]*:[^"'\\\s()]*$/i.test(uri) ? `url("${uri}")` : undefined;
}

export function kindLabel(node: NodeView, strings: ViewStrings): string {
  switch (node.kind) {
    case 'text':
      return strings.textCard;
    case 'file':
      return strings.fileCard;
    case 'link':
      return strings.linkCard;
    case 'group':
      return strings.groupCard;
    case 'unknown':
      return strings.unsupportedCard;
  }
}

/**
 * Card Markdown as Obsidian shows it (canvas.md 4): `==highlight==`, and `[[wikilinks]]` (open the
 * note) and `#tags` in the text. The list view passes `openLinks: false`.
 */
export function renderCardMarkdown<E extends CanvasElement<E>>(doc: CanvasDocument<E>, text: string, openLinks = true): E {
  return renderMarkdown(doc, parseMarkdown(text, { highlight: true }), {
    headingOffset: HEADING_OFFSET,
    text: (run) => renderInlineTokens(doc, run, { openLinks }),
  });
}

export interface NodeRenderOptions {
  /** The card can be moved and resized here: it gets a resize handle (canvas.md 5). */
  readonly editable?: boolean;
}

export function renderNode<E extends CanvasElement<E>>(doc: CanvasDocument<E>, node: NodeView, strings: ViewStrings, options: NodeRenderOptions = {}): E {
  const el = createElementFactory(doc);
  const label = `${kindLabel(node, strings)}: ${node.title}`;
  const root = el('div', {
    className: `node node-${node.kind}`,
    attrs: { tabindex: '0', role: 'group', 'aria-label': label, 'data-index': String(node.index), 'data-id': node.id },
  });
  root.style.setProperty('left', `${node.x}px`);
  root.style.setProperty('top', `${node.y}px`);
  root.style.setProperty('width', `${node.width}px`);
  root.style.setProperty('height', `${node.height}px`);
  const color = colorValue(node.color);
  if (color !== undefined) {
    root.classList.add('colored');
    root.style.setProperty('--nw-node-color', color);
  }
  switch (node.kind) {
    case 'text': {
      const body = el('div', { className: 'node-body' });
      body.append(renderCardMarkdown(doc, node.text ?? ''));
      root.append(body);
      break;
    }
    case 'file': {
      // The name sits above the card, as in Obsidian; it opens the file.
      if (node.caption !== undefined) {
        root.append(
          el('div', { className: 'node-caption', text: node.caption, attrs: { dir: 'auto', 'data-action': 'open-file', title: strings.openFile } }),
        );
      }
      if (node.image !== undefined && node.outside !== true && node.missing !== true) {
        const body = el('div', { className: 'node-body image-body' });
        body.append(el('img', { className: 'file-image', attrs: { src: node.image, alt: node.title, loading: 'lazy', decoding: 'async', draggable: 'false' } }));
        root.append(body);
        break;
      }
      if (node.note !== undefined && node.outside !== true && node.missing !== true) {
        const body = el('div', { className: 'node-body note-body' });
        body.append(renderCardMarkdown(doc, node.note));
        root.append(body);
        break;
      }
      const body = el('div', { className: 'node-body file-body' });
      const name = el('span', {
        className: 'file-name',
        text: node.title,
        attrs: { role: 'link', tabindex: '-1', 'data-action': 'open-file', title: strings.openFile },
      });
      body.append(name);
      const path = (node.file ?? '') + (node.subpath ?? '');
      if (path !== node.title) body.append(el('span', { className: 'file-path', text: path, attrs: { dir: 'auto' } }));
      if (node.outside === true) body.append(el('span', { className: 'file-state', text: strings.fileOutside }));
      else if (node.missing === true) body.append(el('span', { className: 'file-state', text: strings.fileMissing }));
      root.append(body);
      break;
    }
    case 'link': {
      if (node.caption !== undefined) root.append(el('div', { className: 'node-caption', text: node.caption, attrs: { dir: 'auto' } }));
      const body = el('div', { className: 'node-body link-body' });
      body.append(
        el('span', {
          className: 'link-url',
          text: node.url ?? '',
          attrs: { role: 'link', tabindex: '-1', 'data-action': 'open-url', 'data-url': node.url ?? '', title: strings.openLink },
        }),
      );
      root.append(body);
      break;
    }
    case 'group': {
      if (node.background !== undefined) {
        const url = cssUrl(node.background);
        if (url !== undefined) {
          const bg = el('div', { className: `group-bg bg-${node.backgroundStyle ?? 'cover'}`, attrs: { 'aria-hidden': 'true' } });
          bg.style.setProperty('background-image', url);
          root.append(bg);
        }
      }
      if (node.label !== undefined && node.label !== '') root.append(el('div', { className: 'group-label', text: node.label, attrs: { dir: 'auto' } }));
      break;
    }
    case 'unknown': {
      root.append(
        el('div', { className: 'node-body unsupported-body' }, el('strong', { text: strings.unsupportedCard }), el('code', { className: 'unsupported-type', text: node.type })),
      );
      break;
    }
  }
  if (options.editable === true) {
    root.classList.add('editable');
    // Pointer only; the keyboard resizes with Alt+arrows (help panel).
    root.append(el('div', { className: 'resize-handle', attrs: { 'aria-hidden': 'true', 'data-resize': '', title: strings.resizeHandle } }));
  }
  return root;
}

function svg<E extends CanvasElement<E>>(doc: CanvasDocument<E>, tag: string, attrs: Readonly<Record<string, string>> = {}): E {
  if (!SVG_TAGS.has(tag)) throw new Error(`SVG element not allowed: ${tag}`);
  const element = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (!SVG_ATTRS.has(name)) throw new Error(`SVG attribute not allowed: ${name}`);
    element.setAttribute(name, value);
  }
  return element;
}

/**
 * One edge between `nodes[edge.from]` and `nodes[edge.to]`. `position` is the edge's place in the
 * view's edge list (data-edge-index), so a drag can redraw the edges of the cards it moves.
 */
export function renderEdge<E extends CanvasElement<E>>(doc: CanvasDocument<E>, edge: EdgeView, nodes: readonly NodeView[], position = 0): { line: E; label: E | undefined } | undefined {
  const from = nodes[edge.from];
  const to = nodes[edge.to];
  if (from === undefined || to === undefined) return undefined;
  const geometry = edgeGeometry(from, to, edge);
  const group = svg(doc, 'g', { class: 'edge', 'data-edge': edge.id, 'data-edge-index': String(position) });
  const color = colorValue(edge.color);
  if (color !== undefined) {
    group.classList.add('colored');
    group.style.setProperty('--nw-node-color', color);
  }
  group.append(svg(doc, 'path', { class: 'edge-line', d: geometry.path }));
  for (const points of geometry.arrows) group.append(svg(doc, 'polygon', { class: 'edge-arrow', points }));
  let label: E | undefined;
  if (edge.label !== undefined && edge.label !== '') {
    const placement = geometry.labelPlacement === 'center' ? '' : ` label-${geometry.labelPlacement}`;
    label = createElementFactory(doc)('div', { className: `edge-label${placement}`, text: edge.label, attrs: { dir: 'auto', 'data-edge-index': String(position) } });
    label.style.setProperty('left', `${Math.round(geometry.middle.x)}px`);
    label.style.setProperty('top', `${Math.round(geometry.middle.y)}px`);
    if (color !== undefined) {
      label.classList.add('colored');
      label.style.setProperty('--nw-node-color', color);
    }
  }
  return { line: group, label };
}

/**
 * The whole canvas in canvas coordinates; main.ts moves and scales it. `selected`: the node index
 * drawn selected and raised above the other cards of its layer (view only, canvas.md 4).
 */
export function renderWorld<E extends CanvasElement<E>>(doc: CanvasDocument<E>, view: Extract<CanvasView, { state: 'canvas' }>, options: { readonly selected?: number } = {}): E {
  const el = createElementFactory(doc);
  const groups = el('div', { className: 'layer layer-groups' });
  const cards = el('div', { className: 'layer layer-cards' });
  const labels = el('div', { className: 'layer layer-labels', attrs: { 'aria-hidden': 'true' } });
  const lines = svg(doc, 'svg', { class: 'layer-edges', width: '1', height: '1', 'aria-hidden': 'true', focusable: 'false' });
  for (const node of view.nodes) {
    const editable = view.editable && node.locked !== true;
    const element = renderNode(doc, node, view.strings, { editable });
    if (node.index === options.selected) element.classList.add('selected', 'raised');
    (node.kind === 'group' ? groups : cards).append(element);
  }
  for (const [position, edge] of view.edges.entries()) {
    const drawn = renderEdge(doc, edge, view.nodes, position);
    if (drawn === undefined) continue;
    lines.append(drawn.line);
    if (drawn.label !== undefined) labels.append(drawn.label);
  }
  return el('div', { className: 'world' }, groups, lines, cards, labels);
}

/**
 * The canvas as text for screen readers (canvas.md 4 "list view"): every card in reading order
 * with its kind, content and connections; cards inside a group are listed under it. The
 * connection targets are buttons that move focus to that card's entry.
 */
export function renderList<E extends CanvasElement<E>>(doc: CanvasDocument<E>, view: Extract<CanvasView, { state: 'canvas' }>): E {
  const el = createElementFactory(doc);
  const { strings } = view;
  if (view.nodes.length === 0) return el('div', { className: 'list-view' }, el('p', { className: 'list-empty', text: strings.emptyCanvas }));
  const byIndex = new Map(view.nodes.map((n, position) => [n.index, { node: n, position }]));
  const children = new Map<number | undefined, NodeView[]>();
  for (const node of readingOrder(view.nodes)) {
    const parent = node.group !== undefined && byIndex.has(node.group) ? node.group : undefined;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }

  const targets = (label: string, edges: readonly EdgeView[], other: (e: EdgeView) => number): E => {
    const line = el('p', { className: 'list-links' }, `${label}: `);
    edges.forEach((edge, i) => {
      const target = view.nodes[other(edge)];
      if (target === undefined) return;
      if (i > 0) line.append(', ');
      line.append(
        el('button', {
          className: 'list-target',
          text: target.title,
          attrs: { type: 'button', 'data-action': 'focus-item', 'data-target': String(target.index), title: strings.focusCard, dir: 'auto' },
        }),
      );
      if (edge.label !== undefined && edge.label !== '') line.append(` (${edge.label})`);
    });
    return line;
  };

  const item = (node: NodeView, depth: number, seen: ReadonlySet<number>): E => {
    const entry = el('li', { className: `list-item list-${node.kind}`, attrs: { 'data-index': String(node.index), tabindex: '-1' } });
    const heading = `h${Math.min(2 + depth, 6)}`;
    const kind = kindLabel(node, strings);
    let blocks = node.kind === 'text' ? parseMarkdown(node.text ?? '', { highlight: true }) : [];
    if (node.kind === 'text') {
      // The card's own first heading is its title; any other text is not repeated as a title.
      if (blocks[0]?.kind === 'heading') {
        entry.append(el(heading, { className: 'list-title' }, el('span', { className: 'list-kind', text: `${kind}: ` }), el('span', { text: node.title, attrs: { dir: 'auto' } })));
        blocks = blocks.slice(1);
      } else entry.append(el(heading, { className: 'list-title' }, el('span', { className: 'list-kind', text: kind })));
    } else {
      entry.append(el(heading, { className: 'list-title' }, el('span', { className: 'list-kind', text: `${kind}: ` }), el('span', { text: node.title, attrs: { dir: 'auto' } })));
    }
    switch (node.kind) {
      case 'text':
        if (blocks.length > 0) {
          entry.append(renderMarkdown(doc, blocks, { headingOffset: Math.min(HEADING_OFFSET + depth, 5), text: (run) => renderInlineTokens(doc, run, { openLinks: false }) }));
        }
        break;
      case 'file': {
        const path = (node.file ?? '') + (node.subpath ?? '');
        entry.append(el('p', {}, el('span', { className: 'file-name', text: path, attrs: { role: 'link', tabindex: '0', 'data-action': 'open-file', title: strings.openFile } })));
        if (node.outside === true) entry.append(el('p', { className: 'file-state', text: strings.fileOutside }));
        else if (node.missing === true) entry.append(el('p', { className: 'file-state', text: strings.fileMissing }));
        break;
      }
      case 'link':
        entry.append(
          el('p', {}, el('span', { className: 'link-url', text: node.url ?? '', attrs: { role: 'link', tabindex: '0', 'data-action': 'open-url', 'data-url': node.url ?? '', title: strings.openLink } })),
        );
        break;
      case 'unknown':
        entry.append(el('p', {}, el('code', { text: node.type })));
        break;
      case 'group':
        if (!seen.has(node.index) && (children.get(node.index) ?? []).length === 0) entry.append(el('p', { className: 'list-empty-group', text: strings.emptyGroup }));
        break;
    }
    const position = byIndex.get(node.index)!.position;
    const outgoing = view.edges.filter((e) => e.from === position && e.to !== position);
    const incoming = view.edges.filter((e) => e.to === position && e.from !== position);
    if (outgoing.length > 0) entry.append(targets(strings.linksTo, outgoing, (e) => e.to));
    if (incoming.length > 0) entry.append(targets(strings.linkedFrom, incoming, (e) => e.from));
    const members = node.kind === 'group' && !seen.has(node.index) ? (children.get(node.index) ?? []) : [];
    if (members.length > 0) {
      const inner = new Set(seen).add(node.index);
      entry.append(el('ul', { className: 'list-items list-members' }, ...members.map((m) => item(m, depth + 1, inner))));
    }
    return entry;
  };

  return el('div', { className: 'list-view' }, el('ul', { className: 'list-items' }, ...(children.get(undefined) ?? []).map((n) => item(n, 0, new Set()))));
}

/** A help row: keys in <kbd>, everything else (gestures, joining words) as plain text. */
type HelpPart = { readonly kbd: string } | string;

/** The keyboard help: one row per key or gesture. */
export function renderHelp<E extends CanvasElement<E>>(doc: CanvasDocument<E>, strings: ViewStrings, options: { readonly editable?: boolean } = {}): E {
  const el = createElementFactory(doc);
  const k = (name: string): HelpPart => ({ kbd: name });
  const rows: [readonly HelpPart[], string][] = [
    [[k('Tab'), ' / ', k('Shift'), '+', k('Tab')], strings.helpTabAction],
    [[strings.helpArrowsKey], strings.helpArrowsAction],
    [[k('+'), ' / ', k('-')], strings.helpZoomAction],
    [[k('0')], strings.helpZoomResetAction],
    [[k('Shift'), '+', k('1')], strings.helpFitAction],
    [[k('Enter')], strings.helpEnterAction],
    [[k('Esc')], strings.helpEscapeAction],
    [[strings.helpDragGesture, ' / ', k('Space'), ` + ${strings.helpSpaceDragGesture}`], strings.helpDragAction],
    [[k('Ctrl'), ` + ${strings.helpWheelGesture}`], strings.helpWheelAction],
  ];
  const edits: [readonly HelpPart[], string][] = [];
  if (options.editable === true) {
    edits.push(
      [[strings.helpArrowsKey, ' (', k('Shift'), ')'], strings.helpMoveAction],
      [[k('Alt'), ' + ', strings.helpArrowsKey], strings.helpResizeAction],
      [[k('C')], strings.helpColorAction],
      [[k('Ctrl'), '+', k('Enter')], strings.helpSaveAction],
      [[k('Esc')], strings.helpCancelAction],
      [[strings.helpDragCardGesture], strings.helpDragCardAction],
    );
  }
  const section = (heading: string, list: readonly [readonly HelpPart[], string][]): E[] => {
    const keys = el('dl', { className: 'help-keys' });
    for (const [parts, action] of list) {
      const term = el('dt');
      for (const part of parts) term.append(typeof part === 'string' ? part : el('kbd', { text: part.kbd }));
      keys.append(term, el('dd', { text: action }));
    }
    return [el('h3', { className: 'help-heading', text: heading }), keys];
  };
  const root = el('div', { className: 'help-sections' }, ...section(strings.viewGroup, rows));
  if (edits.length > 0) root.append(...section(strings.helpEditHeading, edits));
  return root;
}

/** A canvas that cannot be read (canvas.md 2): the message, the reason and "Open as Text". */
export function renderError<E extends CanvasElement<E>>(doc: CanvasDocument<E>, view: Extract<CanvasView, { state: 'error' }>): E {
  const el = createElementFactory(doc);
  return el(
    'div',
    { className: 'error-view', attrs: { role: 'alert' } },
    el('p', { className: 'error-title', text: view.message }),
    el('p', { className: 'error-reason', text: view.reason }),
    el('button', { className: 'open-as-text', text: view.strings.openAsText, attrs: { type: 'button', 'data-action': 'open-as-text' } }),
  );
}

export function renderNotices<E extends CanvasElement<E>>(doc: CanvasDocument<E>, notices: readonly Notice[]): E[] {
  const el = createElementFactory(doc);
  return notices.map((notice) => el('p', { className: `notice notice-${notice.kind === 'warning' ? 'warning' : 'info'}`, text: notice.text }));
}

/** An edit the extension did not apply (canvas.md 3.3): shown until dismissed or the next edit. */
export function renderRefused<E extends CanvasElement<E>>(doc: CanvasDocument<E>, text: string, strings: ViewStrings): E {
  const el = createElementFactory(doc);
  return el(
    'div',
    { className: 'notice notice-error', attrs: { role: 'alert' } },
    el('span', { className: 'notice-text', text }),
    el('button', { className: 'notice-dismiss', text: '×', attrs: { type: 'button', 'data-edit': 'dismiss', 'aria-label': strings.dismiss, title: strings.dismiss } }),
  );
}

/** The text editor that replaces a text card's body while editing (canvas.md 5). */
export function renderTextEditor<E extends CanvasElement<E>>(doc: CanvasDocument<E>, text: string, strings: ViewStrings): E {
  const el = createElementFactory(doc);
  return el(
    'div',
    { className: 'text-editor' },
    el('textarea', {
      className: 'text-input',
      text,
      attrs: { 'aria-label': strings.textEditorLabel, 'aria-describedby': 'canvas-editor-hint', spellcheck: 'true' },
    }),
    el(
      'div',
      { className: 'text-editor-bar' },
      el('span', { className: 'text-editor-hint', text: strings.textEditorHint, attrs: { id: 'canvas-editor-hint' } }),
      el('button', { className: 'secondary', text: strings.cancel, attrs: { type: 'button', 'data-edit': 'cancel' } }),
      el('button', { text: strings.save, attrs: { type: 'button', 'data-edit': 'save' } }),
    ),
  );
}

/** Buttons shown next to the selected card: edit text (text cards) and color. */
export function renderCardBar<E extends CanvasElement<E>>(doc: CanvasDocument<E>, strings: ViewStrings, allows: { readonly text: boolean; readonly color: boolean }): E {
  const el = createElementFactory(doc);
  const bar = el('div', { className: 'card-bar', attrs: { role: 'toolbar', 'aria-label': strings.toolbarLabel } });
  if (allows.text) bar.append(el('button', { className: 'tool', text: strings.editText, attrs: { type: 'button', 'data-edit': 'text', title: `${strings.editText} (Enter)` } }));
  if (allows.color) {
    bar.append(
      el('button', {
        className: 'tool',
        text: strings.color,
        attrs: { type: 'button', 'data-edit': 'color', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'canvas-colors', title: `${strings.color} (C)` },
      }),
    );
  }
  return bar;
}

const COLOR_NAMES = ['color1', 'color2', 'color3', 'color4', 'color5', 'color6'] as const;

/**
 * The color picker (canvas.md 5): six presets and none, the current one pressed. A hex color
 * from the file shows as a seventh, inactive swatch; it is kept until another color is chosen.
 */
export function renderColorPicker<E extends CanvasElement<E>>(doc: CanvasDocument<E>, strings: ViewStrings, current: string | undefined): E {
  const el = createElementFactory(doc);
  const picker = el('div', { className: 'color-picker', attrs: { id: 'canvas-colors', role: 'group', 'aria-label': strings.color } });
  // Presets show their number too (some look alike); the name is the tooltip and accessible name.
  const swatch = (value: string, name: string, color: string | undefined): E => {
    const button = el('button', {
      className: `swatch${color === undefined ? ' swatch-none' : ''}`,
      ...(color === undefined ? {} : { text: value }),
      attrs: { type: 'button', 'data-color': value, 'aria-label': name, title: name, 'aria-pressed': String((current ?? 'none') === value) },
    });
    if (color !== undefined) button.style.setProperty('--nw-node-color', color);
    return button;
  };
  picker.append(swatch('none', strings.colorNone, undefined));
  COLOR_NAMES.forEach((name, i) => picker.append(swatch(String(i + 1), strings[name], `var(--nw-color-${i + 1})`)));
  const custom = current !== undefined && !PRESET.test(current) ? colorValue(current) : undefined;
  if (custom !== undefined) {
    const button = el('button', {
      className: 'swatch swatch-custom',
      attrs: { type: 'button', disabled: '', 'aria-label': `${strings.colorCustom}: ${current}`, title: `${strings.colorCustom}: ${current}`, 'aria-pressed': 'true' },
    });
    button.style.setProperty('--nw-node-color', custom);
    picker.append(button);
  }
  return picker;
}
