// Shared helpers for the markdown tests (src/webview/markdown.ts and markdown-render.ts).
import assert from 'node:assert/strict';
import type { Block, Inline } from '../../src/webview/markdown.ts';

/** Every piece of text the model carries, in source order. */
export function inlineText(list: readonly Inline[]): string {
  return list
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.text;
        case 'break':
          return '\n';
        case 'image':
          return `${n.alt} ${n.src}`;
        case 'link':
          return `${inlineText(n.children)} ${n.url} ${n.title ?? ''}`;
        default:
          return inlineText(n.children);
      }
    })
    .join('');
}

export function blockText(list: readonly Block[]): string {
  return list
    .map((b) => {
      switch (b.kind) {
        case 'heading':
        case 'paragraph':
          return inlineText(b.content);
        case 'list':
          return b.items
            .map((i) => `${i.number ?? ''} ${i.checked === true ? 'x' : ''} ${inlineText(i.content)} ${blockText(i.blocks)}`)
            .join('\n');
        case 'quote':
          return blockText(b.blocks);
        case 'rule':
          return '';
        case 'code':
          return `${b.info}\n${b.text}`;
        case 'table':
          return [b.header, ...b.rows].map((row) => row.map(inlineText).join(' | ')).join('\n');
      }
    })
    .join('\n');
}

/** Letters and digits of `source` appear in `rendered` in the same order. */
export function assertKeepsContent(source: string, rendered: string): void {
  const significant = (s: string) => [...s.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const want = significant(source);
  const have = significant(rendered);
  let k = 0;
  for (const c of have) if (k < want.length && c === want[k]) k++;
  assert.equal(k, want.length, `lost content after ${JSON.stringify(want.slice(k, k + 20).join(''))} in ${JSON.stringify(source.slice(0, 200))}`);
}

/** A minimal element for rendering under node:test. */
export class FakeElement {
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
    return this.#text ?? this.children.map((c) => (typeof c === 'string' ? c : c.tagName === 'br' ? '\n' : c.textContent)).join('');
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

export const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };
