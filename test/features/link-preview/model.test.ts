// Link preview model (links.md 6): link under the cursor, heading/block lines, preview range,
// hover-safe Markdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyStart, formatSize, linkAt, previewRange, safePreviewMarkdown, subpathLine } from '../../../src/features/link-preview/model.ts';

const NOTE = ['---', 'tags: [a]', '---', '# Title', 'intro', '## Setup', 'step one ^s1', '### Detail', 'deep', '## Next', 'later'];

test('link under the cursor: wikilinks and Markdown links, not outside them', () => {
  const text = 'See [[Note#Setup|alias]] and [doc](folder/My%20doc.md).';
  assert.equal(linkAt(text, 0, 6)?.path, 'Note');
  assert.equal(linkAt(text, 0, 6)?.subpath, 'Setup');
  assert.equal(linkAt(text, 0, 32)?.path, 'folder/My doc.md');
  assert.equal(linkAt(text, 0, 1), undefined);
  assert.equal(linkAt('`[[code]]`', 0, 3), undefined, 'not in inline code');
});

test('subpath lines: headings (case-insensitive, last part) and blocks', () => {
  assert.equal(bodyStart(NOTE), 3);
  assert.equal(subpathLine(NOTE, 'setup'), 5);
  assert.equal(subpathLine(NOTE, 'Title#Setup#Detail'), 7);
  assert.equal(subpathLine(NOTE, '^s1'), 6);
  assert.equal(subpathLine(NOTE, 'Missing'), undefined);
  assert.equal(subpathLine(NOTE, null), undefined);
  assert.equal(subpathLine(['tags: x', 'a ^s1x'], '^s1'), undefined, 'block id must match exactly');
});

test('preview range: beginning after frontmatter, heading section, block line, missing subpath', () => {
  assert.deepEqual(previewRange(NOTE, null), { start: 3, lines: NOTE.slice(3), found: true });
  assert.deepEqual(previewRange(NOTE, 'Setup'), { start: 5, lines: ['## Setup', 'step one ^s1', '### Detail', 'deep'], found: true });
  assert.deepEqual(previewRange(NOTE, '^s1'), { start: 6, lines: ['step one ^s1'], found: true });
  assert.equal(previewRange(NOTE, 'Nope').found, false);
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  assert.equal(previewRange(long, null).lines.length, 20);
});

test('hover Markdown: no images loaded, no raw HTML', () => {
  const md = safePreviewMarkdown(['![logo](https://example.com/x.png) and ![](local.png)', '![[pic.png]]', '<img src=x onerror=1>']);
  assert.equal(md, '[image: logo] and [image]\n[embed: pic.png]\n&lt;img src=x onerror=1>');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
});
