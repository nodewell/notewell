// Draws parsed markdown (markdown.ts) as DOM elements for webviews. DOM-free like the kanban
// renderer, so it runs under node:test with a fake document. All source text goes in as text
// nodes or textContent; only http(s) links get the open-url hook (data-action="open-url",
// data-url), which the webview wires to its host, and the host validates the URL again before
// opening it. Elements carry md-* classes; each webview styles them in its own stylesheet.
import { createElementFactory, type DomDocument, type DomElement } from './dom.ts';
import type { Block, Inline, ListItem } from './markdown.ts';

const WEB_URL = /^https?:\/\/\S/i;

export interface MarkdownRenderOptions<E = unknown> {
  /**
   * Levels added to each heading, so body headings nest under the page's own titles
   * (2 draws # as h3). Clamped to h6. Default 0.
   */
  readonly headingOffset?: number;
  /**
   * Draws a run of plain text outside code and links (a webview's own tokens, e.g. kanban
   * tags and dates). It must build elements with the same document and never parse markup.
   * Default: the text as a text node.
   */
  readonly text?: (text: string) => readonly (E | string)[];
  /** false: no link gets the open-url hook; every link is inert text with its URL as title. Default true. */
  readonly openLinks?: boolean;
}

export function renderMarkdown<E extends DomElement<E>>(doc: DomDocument<E>, blocks: readonly Block[], options: MarkdownRenderOptions<E> = {}): E {
  const headingOffset = Math.max(0, Math.trunc(options.headingOffset ?? 0));
  const openLinks = options.openLinks !== false;
  const text = options.text;
  const el = createElementFactory(doc);
  /** Appends in slices: spreading 100k+ nodes into one call overflows the stack. */
  const fill = (element: E, children: readonly (E | string)[]): E => {
    for (let i = 0; i < children.length; i += 1000) element.append(...children.slice(i, i + 1000));
    return element;
  };

  /** Inline nodes in order; inside a link the text hook is not used (the link text stays plain). */
  const inlines = (list: readonly Inline[], inLink = false): (E | string)[] => {
    const out: (E | string)[] = [];
    for (const node of list) {
      if (node.kind === 'text' && text !== undefined && !inLink) {
        for (const part of text(node.text)) out.push(part);
      } else {
        out.push(inline(node, inLink));
      }
    }
    return out;
  };

  const inline = (node: Inline, inLink: boolean): E | string => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'break':
        return el('br');
      case 'code':
        return el('code', { className: 'md-code-span', text: node.text });
      case 'strong':
        return fill(el('strong'), inlines(node.children, inLink));
      case 'em':
        return fill(el('em'), inlines(node.children, inLink));
      case 'strike':
        return fill(el('s'), inlines(node.children, inLink));
      case 'highlight':
        return fill(el('mark', { className: 'md-highlight' }), inlines(node.children, inLink));
      case 'link': {
        const title = node.title === null ? node.url : `${node.title}\n${node.url}`;
        if (openLinks && WEB_URL.test(node.url)) {
          return fill(
            el('span', { className: 'md-link', attrs: { role: 'link', tabindex: '0', 'data-action': 'open-url', 'data-url': node.url, title } }),
            inlines(node.children, true),
          );
        }
        return fill(el('span', { className: 'md-link-inert', attrs: { title } }), inlines(node.children, true));
      }
      case 'image':
        // Never loaded: the alt text stands in (or the source when there is none).
        return el('span', { className: 'md-image', text: node.alt !== '' ? node.alt : node.src, attrs: { title: node.src } });
    }
  };

  const item = (entry: ListItem): E => {
    const li = el('li', { className: 'md-item' });
    if (entry.checked !== null) {
      li.classList.add('md-task');
      if (entry.checked) li.classList.add('md-task-checked');
      const attrs: Record<string, string> = { type: 'checkbox', disabled: '' };
      if (entry.checked) attrs.checked = '';
      li.append(el('input', { className: 'md-checkbox', attrs }));
    }
    fill(li, [fill(el('span', { className: 'md-item-text', attrs: { dir: 'auto' } }), inlines(entry.content)), ...entry.blocks.map(block)]);
    return li;
  };

  const block = (node: Block): E => {
    switch (node.kind) {
      case 'heading':
        return fill(el(`h${Math.min(node.level + headingOffset, 6)}`, { className: `md-heading md-h${node.level}`, attrs: { dir: 'auto' } }), inlines(node.content));
      case 'paragraph':
        // dir=auto per block: right-to-left paragraphs align and order on their own.
        return fill(el('p', { className: 'md-paragraph', attrs: { dir: 'auto' } }), inlines(node.content));
      case 'list': {
        const attrs: Record<string, string> = node.ordered && node.start !== 1 ? { start: String(node.start) } : {};
        return fill(el(node.ordered ? 'ol' : 'ul', { className: 'md-list', attrs }), node.items.map(item));
      }
      case 'quote':
        return fill(el('blockquote', { className: 'md-quote' }), node.blocks.map(block));
      case 'rule':
        return el('hr', { className: 'md-rule' });
      case 'code': {
        const parts: E[] = [];
        if (node.lang !== '') parts.push(el('span', { className: 'md-code-lang', text: node.lang, attrs: { title: node.info } }));
        parts.push(el('pre', { className: 'md-code-block' }, el('code', { text: node.text })));
        return el('div', { className: 'md-code', attrs: node.lang !== '' ? { 'data-lang': node.lang } : {} }, ...parts);
      }
      case 'table': {
        // Alignment is a class (no style attributes); the wrapper scrolls a table wider than the pane.
        // Cells beyond the header's width (parsed with `extraCells`) are not squeezed into the
        // table: each row's extra cells show as one line below it, so nothing is hidden.
        const width = node.header.length;
        const cell = (tag: 'th' | 'td', content: readonly Inline[], column: number): E => {
          const align = node.align[column];
          return fill(el(tag, { ...(align ? { className: `md-align-${align}` } : {}), ...(tag === 'th' ? { attrs: { scope: 'col' } } : {}) }), inlines(content));
        };
        const extras = node.rows.filter((row) => row.length > width).map((row) => {
          const parts: (E | string)[] = [];
          row.slice(width).forEach((content, k) => {
            if (k > 0) parts.push(' ');
            parts.push(...inlines(content));
          });
          return fill(el('p', { className: 'md-table-extra', attrs: { dir: 'auto' } }), parts);
        });
        const table = el(
          'div',
          { className: 'md-table-wrap' },
          el(
            'table',
            { className: 'md-table' },
            el('thead', {}, fill(el('tr'), node.header.map((content, k) => cell('th', content, k)))),
            fill(el('tbody'), node.rows.map((row) => fill(el('tr'), row.slice(0, width).map((content, k) => cell('td', content, k))))),
          ),
        );
        return extras.length === 0 ? table : fill(el('div', { className: 'md-table-group' }), [table, ...extras]);
      }
    }
  };

  return fill(el('div', { className: 'md' }), blocks.map(block));
}
