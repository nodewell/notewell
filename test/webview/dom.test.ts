import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElementFactory } from '../../src/webview/dom.ts';

class FakeElement {
  readonly tagName: string;
  textContent: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly classes: string[] = [];
  readonly children: (FakeElement | string)[] = [];
  readonly classList = { add: (...tokens: string[]) => void this.classes.push(...tokens) };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }
}

const el = createElementFactory({ createElement: (tag: string) => new FakeElement(tag) });

test('sets text through textContent without interpreting markup', () => {
  const node = el('span', { text: '<b>bold</b> & [[link]]' });
  assert.equal(node.textContent, '<b>bold</b> & [[link]]');
  assert.equal(node.children.length, 0);
});

test('applies classes, attributes and children', () => {
  const child = el('li');
  const node = el('ul', { className: ' lane  done ', attrs: { 'data-id': '3', 'aria-label': 'Lane' } }, child, 'text');
  assert.deepEqual(node.classes, ['lane', 'done']);
  assert.deepEqual([...node.attrs], [['data-id', '3'], ['aria-label', 'Lane']]);
  assert.deepEqual(node.children, [child, 'text']);
});

test('refuses script-capable elements and attributes', () => {
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'template', 'link', 'meta', 'base', 'x y', '']) {
    assert.throws(() => el(tag), /Element not allowed/, tag);
  }
  for (const name of ['onclick', 'ONLOAD', 'style', 'srcdoc', 'a b', 'x"']) {
    assert.throws(() => el('div', { attrs: { [name]: 'x' } }), /Attribute not allowed/, name);
  }
});
