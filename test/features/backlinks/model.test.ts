// Backlinks model (links.md 5): linked mentions grouped by file, unlinked mentions, exclusions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkIndex, extractLinks } from '../../../src/vault/link-index.ts';
import { isExcluded, linkedMentions, noteName, preview, unlinkedMentions } from '../../../src/features/backlinks/model.ts';

const FILES: Record<string, string> = {
  'Target.md': '# Target\n',
  'a.md': 'See [[Target]] and [[target|again]].\nNothing here.\n![[Target#Intro]]\n',
  'notes/b.md': '---\nup: "[[Target]]"\n---\nA [link](../Target.md) here.\n',
  'c.md': 'Target is mentioned without a link.\n`Target` in code\n```\nTarget in a fence\n```\nTargets and subTarget do not count. [[Target]] is a link.\n',
  'Target copy.md': 'Target\n',
};

const index = LinkIndex.build(Object.keys(FILES), (p) => FILES[p]);
const lines = (path: string) => FILES[path]?.split('\n');

test('linked mentions: grouped by source, sorted, with the line text', () => {
  const groups = linkedMentions(index.incoming('Target.md'), lines);
  assert.deepEqual(groups.map((g) => [g.source, g.mentions.map((m) => m.line)]), [
    ['a.md', [0, 0, 2]],
    ['c.md', [5]],
    ['notes/b.md', [1, 3]],
  ]);
  const first = groups[0].mentions[0];
  assert.equal(first.preview, 'See [[Target]] and [[target|again]].');
  assert.equal(FILES['a.md'].split('\n')[0].slice(first.start, first.end), '[[Target]]');
  assert.deepEqual(linkedMentions(index.incoming('Target.md'), () => undefined)[0].mentions[0].preview, '', 'unreadable: no text');
});

test('unlinked mentions: whole words outside links, code and frontmatter', () => {
  const found = unlinkedMentions(FILES['c.md'], 'Target', extractLinks(FILES['c.md']));
  assert.deepEqual(found.map((m) => [m.line, m.start]), [[0, 0]]);
  assert.deepEqual(unlinkedMentions('---\ntitle: Target\n---\ntarget here', 'Target', []).map((m) => m.line), [3], 'case-insensitive, not in frontmatter');
  // Whole words only: an attached particle (노트와) or a longer word (노트북) does not count.
  assert.deepEqual(unlinkedMentions('한국어 노트 그리고 노트와 노트북', '노트', []).map((m) => m.start), [4], 'word boundaries for Hangul');
  assert.deepEqual(unlinkedMentions('x', '  ', []), []);
});

test('excluded files, note names, previews', () => {
  assert.equal(isExcluded('archive/old.md', ['archive/']), true);
  assert.equal(isExcluded('notes/a.md', ['/^notes\\//']), true);
  assert.equal(isExcluded('notes/a.md', ['/[/']), false, 'invalid regex excludes nothing');
  assert.equal(isExcluded('notes/a.md', ['']), false);
  assert.equal(noteName('a/b/Note Name.md'), 'Note Name');
  assert.equal(noteName('img.png'), 'img.png');
  const long = `${'x'.repeat(100)} [[Target]] ${'y'.repeat(100)}`;
  const p = preview(long, 101, 111);
  assert.ok(p.startsWith('…') && p.endsWith('…') && p.includes('[[Target]]'));
  assert.equal(preview('a\t\tb   c', 0, 1), 'a b c');
});

test('round 5: one file with 50,000 links to the note and adversarial unlinked lines stay fast', () => {
  const text = Array.from({ length: 50_000 }, (_, i) => `[[Target]] line ${i}`).join('\n');
  const index = LinkIndex.build(['Target.md', 'big.md'], (p) => (p === 'big.md' ? text : ''));
  const lines = text.split('\n');
  let started = performance.now();
  const groups = linkedMentions(index.incoming('Target.md'), () => lines);
  assert.equal(groups[0]!.mentions.length, 50_000);
  assert.ok(performance.now() - started < 2000, `linked ${performance.now() - started} ms`);
  for (const line of ['`'.repeat(200_000), '` '.repeat(100_000), `${'`a'.repeat(50_000)} Target`, `${'Target '.repeat(30_000)}`]) {
    started = performance.now();
    unlinkedMentions(line, 'Target', extractLinks(line));
    assert.ok(performance.now() - started < 2000, `unlinked ${line.slice(0, 6)}: ${performance.now() - started} ms`);
  }
});
