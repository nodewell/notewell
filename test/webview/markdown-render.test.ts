// Renders markdown (src/webview/markdown-render.ts) with a fake document: only whitelisted
// elements, no event or loading attributes, source text intact, and the open-url hook only
// on http(s) links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/webview/markdown-render.ts';
import { parseMarkdown } from '../../src/webview/markdown.ts';
import { FakeElement, fakeDocument as doc } from '../support/markdown.ts';

// Headings shifted by two, as the Backlog detail view draws them.
const render = (source: string) => renderMarkdown(doc, parseMarkdown(source), { headingOffset: 2 });
const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'input', 'blockquote', 'pre', 'code', 'hr', 'br', 'strong', 'em', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ALLOWED_ATTRS = new Set(['role', 'tabindex', 'data-action', 'data-url', 'data-lang', 'title', 'type', 'disabled', 'checked', 'start', 'scope', 'dir']);

function assertSafe(root: FakeElement): void {
  for (const element of root.walk()) {
    assert.ok(ALLOWED_TAGS.has(element.tagName), element.tagName);
    for (const attr of element.attrs.keys()) {
      assert.ok(ALLOWED_ATTRS.has(attr) && !attr.startsWith('on'), attr);
    }
  }
}

const EVERYTHING = [
  '# H1', '## H2', '### H3', '#### H4', '###### H6', '',
  'para **b** *i* ~~s~~ `c` [web](https://x.test "t") [mail](mailto:a@b.test) [js](javascript:alert(1)) <http://y.test> ![alt](https://z.test/a.png) ![](local.png)',
  'second line', '',
  '- [x] done', '- [ ] open', '  1. nested', '', '5. five', '', '> quote', '', '---', '', '| a | b |', '|---|--:|', '| **1** | 2 |', '', '```mermaid', 'graph TD', '```',
].join('\n');

test('every block and inline kind maps to whitelisted elements and attributes', () => {
  const root = render(EVERYTHING);
  assertSafe(root);
  const tags = new Set([...root.walk()].map((e) => e.tagName));
  for (const tag of ALLOWED_TAGS) assert.ok(tags.has(tag), `${tag} not produced`);
});

test('HTML-like text becomes text nodes only', () => {
  const source = '<script>alert(1)</script> <img src=x onerror=alert(1)> <!-- c -->';
  const root = render(source);
  assertSafe(root);
  assert.deepEqual(root.find((e) => e.tagName === 'p')[0]!.children, [source]);
});

test('only http(s) links get the open-url hook; others are inert text with the URL as title', () => {
  const root = render(EVERYTHING);
  const live = root.find((e) => e.classes.has('md-link'));
  assert.deepEqual(live.map((e) => [e.textContent, e.attrs.get('data-action'), e.attrs.get('data-url'), e.attrs.get('title')]), [
    ['web', 'open-url', 'https://x.test', 't\nhttps://x.test'],
    ['http://y.test', 'open-url', 'http://y.test', 'http://y.test'],
  ]);
  const inert = root.find((e) => e.classes.has('md-link-inert'));
  assert.deepEqual(inert.map((e) => [e.textContent, e.attrs.get('title'), e.attrs.has('data-url')]), [
    ['mail', 'mailto:a@b.test', false],
    ['js', 'javascript:alert(1)', false],
  ]);
});

test('images show alt text (or the source) and are never loaded', () => {
  const root = render(EVERYTHING);
  assert.deepEqual(root.find((e) => e.classes.has('md-image')).map((e) => [e.tagName, e.textContent, e.attrs.get('title')]), [
    ['span', 'alt', 'https://z.test/a.png'],
    ['span', 'local.png', 'local.png'],
  ]);
  assert.equal(root.find((e) => e.attrs.has('src') || e.attrs.has('href')).length, 0);
});

test('structure: heading levels, lists, tasks, code language and classes', () => {
  const root = render(EVERYTHING);
  const byClass = (cls: string) => root.find((e) => e.classes.has(cls));
  assert.deepEqual(byClass('md-heading').map((e) => [e.tagName, e.textContent]), [['h3', 'H1'], ['h4', 'H2'], ['h5', 'H3'], ['h6', 'H4'], ['h6', 'H6']]);
  assert.equal(byClass('md-paragraph')[0]!.find((e) => e.tagName === 'br').length, 1);
  const boxes = byClass('md-checkbox');
  assert.deepEqual(boxes.map((b) => [b.attrs.get('type'), b.attrs.has('disabled'), b.attrs.has('checked')]), [['checkbox', true, true], ['checkbox', true, false]]);
  assert.deepEqual(byClass('md-task-checked').map((e) => e.find((c) => c.classes.has('md-item-text'))[0]!.textContent), ['done']);
  const lists = byClass('md-list');
  assert.deepEqual(lists.map((l) => [l.tagName, l.attrs.get('start')]), [['ul', undefined], ['ol', undefined], ['ol', '5']]);
  assert.deepEqual(byClass('md-code').map((e) => [e.attrs.get('data-lang'), e.textContent]), [['mermaid', 'mermaidgraph TD']]);
  const [table] = byClass('md-table');
  assert.equal(byClass('md-table-wrap')[0]!.children[0], table, 'the table sits in its scroll wrapper');
  assert.deepEqual(table!.children.map((c) => (c as FakeElement).tagName), ['thead', 'tbody']);
  assert.deepEqual(table!.find((e) => e.tagName === 'th').map((e) => [e.textContent, e.attrs.get('scope'), [...e.classes].join(' ')]), [['a', 'col', ''], ['b', 'col', 'md-align-right']]);
  assert.deepEqual(table!.find((e) => e.tagName === 'td').map((e) => [e.textContent, [...e.classes].join(' ')]), [['1', ''], ['2', 'md-align-right']]);
  assert.equal(table!.find((e) => e.tagName === 'strong').length, 1, 'cells carry inline markdown');
  assert.equal(byClass('md-quote').length, 1);
  assert.equal(byClass('md-rule').length, 1);
});

test('kanban options: extra table cells show on a line below the table; ==highlight== is a mark', () => {
  const root = renderMarkdown(doc, parseMarkdown('| a | b |\n|---|--:|\n| 1 | 2 | 3 |\n\n==hi **there**==', { extraCells: true, highlight: true }));
  for (const element of root.walk()) {
    assert.ok(ALLOWED_TAGS.has(element.tagName) || element.tagName === 'mark', element.tagName);
    for (const attr of element.attrs.keys()) assert.ok(ALLOWED_ATTRS.has(attr), attr);
  }
  assert.deepEqual(root.find((e) => e.tagName === 'td').map((e) => [e.textContent, [...e.classes].join(' ')]), [['1', ''], ['2', 'md-align-right']]);
  const [group] = root.find((e) => e.classes.has('md-table-group'));
  assert.deepEqual(group!.find((e) => e.classes.has('md-table-extra')).map((e) => e.textContent), ['3']);
  assert.equal(root.find((e) => e.tagName === 'th').length, 2);
  const [mark] = root.find((e) => e.tagName === 'mark');
  assert.ok(mark!.classes.has('md-highlight'));
  assert.equal(mark!.textContent, 'hi there');
  assert.equal(mark!.find((e) => e.tagName === 'strong').length, 1);
});

test('heading offset: none by default, shifted on request, never past h6', () => {
  const source = ['# H1', '## H2', '###### H6'].join('\n');
  const tags = (root: FakeElement) => root.find((e) => e.classes.has('md-heading')).map((e) => e.tagName);
  assert.deepEqual(tags(renderMarkdown(doc, parseMarkdown(source))), ['h1', 'h2', 'h6']);
  assert.deepEqual(tags(renderMarkdown(doc, parseMarkdown(source), { headingOffset: 2 })), ['h3', 'h4', 'h6']);
  assert.deepEqual(tags(renderMarkdown(doc, parseMarkdown(source), { headingOffset: 9 })), ['h6', 'h6', 'h6']);
  assert.deepEqual(tags(renderMarkdown(doc, parseMarkdown(source), { headingOffset: -3 })), ['h1', 'h2', 'h6']);
});

test('text hook: plain text outside code and links goes through it; defaults are unchanged', () => {
  const seen: string[] = [];
  const root = renderMarkdown(doc, parseMarkdown('a **b** `c` [d](https://x.test) ![e](f.png)\n\n- g\n\n| h |\n|---|\n| i |'), {
    text: (t) => {
      seen.push(t);
      return [doc.createElement('mark'), t];
    },
  });
  assert.deepEqual(seen, ['a ', 'b', ' ', ' ', ' ', 'g', 'h', 'i']);
  // Code, link text and image alt are not passed to the hook.
  assert.equal(root.find((e) => e.classes.has('md-code-span'))[0]?.textContent, 'c');
  assert.deepEqual(root.find((e) => e.classes.has('md-link'))[0]?.children, ['d']);
  const plain = renderMarkdown(doc, parseMarkdown('a **b**'));
  assert.deepEqual(plain.find((e) => e.tagName === 'p')[0]!.children.slice(0, 1), ['a ']);
});

test('openLinks: false draws every link inert, http(s) included', () => {
  const root = renderMarkdown(doc, parseMarkdown('[web](https://x.test) <http://y.test> [mail](mailto:a@b.test)'), { openLinks: false });
  assert.equal(root.find((e) => e.attrs.has('data-url') || e.attrs.get('data-action') === 'open-url').length, 0);
  assert.deepEqual(root.find((e) => e.classes.has('md-link-inert')).map((e) => [e.textContent, e.attrs.get('title')]), [
    ['web', 'https://x.test'],
    ['http://y.test', 'http://y.test'],
    ['mail', 'mailto:a@b.test'],
  ]);
});
