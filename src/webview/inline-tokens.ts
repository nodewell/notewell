// Obsidian tokens inside a run of Markdown text (a renderMarkdown `text` hook): `[[wikilinks]]`
// as links to open, `#tags` as tags; everything else stays text. DOM-free like the renderer.
import { findTokens } from '../core/tokens.ts';
import { createElementFactory, type DomDocument, type DomElement } from './dom.ts';

export interface InlineTokenOptions {
  /** Wikilinks get `data-action="open-link"` and a target to open; false: inert text. Default true. */
  readonly openLinks?: boolean;
}

/** Wikilinks and tags of `text` as elements, the rest as strings. */
export function renderInlineTokens<E extends DomElement<E>>(doc: DomDocument<E>, text: string, options: InlineTokenOptions = {}): (E | string)[] {
  const el = createElementFactory(doc);
  const out: (E | string)[] = [];
  let from = 0;
  for (const token of findTokens(text)) {
    if (token.kind !== 'wikilink' && token.kind !== 'tag') continue;
    if (token.start > from) out.push(text.slice(from, token.start));
    if (token.kind === 'tag') {
      out.push(el('span', { className: 'md-tag', text: `#${token.name}` }));
    } else {
      const shown = token.alias ?? token.target;
      const attrs: Record<string, string> =
        options.openLinks === false
          ? { title: token.target }
          : { role: 'link', tabindex: '-1', 'data-action': 'open-link', 'data-target': token.target, title: token.target };
      out.push(el('span', { className: 'md-wikilink', text: shown, attrs }));
    }
    from = token.end;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}
