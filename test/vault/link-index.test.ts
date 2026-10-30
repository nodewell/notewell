// Link index (links.md 2.3, 10 #3, #14): extraction with positions, forward and backward links,
// incremental updates, ambiguity, and the 10,000-file build time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, LinkIndex } from '../../src/vault/link-index.ts';

test('extractLinks: wikilinks, Markdown links and embeds with path offsets', () => {
  const line = 'See [[Folder/Note#Head|shown]], ![[img.png]] and [t](Other%20Note.md#^b) or ![](<a b.png>).';
  const links = extractLinks(line);
  assert.deepEqual(
    links.map((l) => [l.form, l.embed, l.rawPath, line.slice(l.pathStart, l.pathEnd), l.path, l.subpath, l.display, l.angle]),
    [
      ['wikilink', false, 'Folder/Note', 'Folder/Note', 'Folder/Note', 'Head', 'shown', false],
      ['wikilink', true, 'img.png', 'img.png', 'img.png', null, null, false],
      ['markdown', false, 'Other%20Note.md', 'Other%20Note.md', 'Other Note.md', '^b', 't', false],
      ['markdown', true, 'a b.png', 'a b.png', 'a b.png', null, '', true],
    ],
  );
});

test('extractLinks: frontmatter property links count; fences, inline code and URLs do not', () => {
  const text = [
    '---',
    'related: "[[Alpha]]"',
    'tags: [x]',
    '---',
    '[[Beta]] `[[Code]]` [web](https://example.com)',
    '```',
    '[[Fenced]] [f](f.md)',
    '```',
    '[[Gamma]]',
  ].join('\n');
  const links = extractLinks(text);
  assert.deepEqual(links.map((l) => [l.rawPath, l.line, l.frontmatter]), [['Alpha', 1, true], ['Beta', 4, false], ['Gamma', 8, false]]);
});

const FILES: Record<string, string> = {
  'Home.md': 'Links: [[Notes/A]] [[B]] [c](sub/C.md) ![[pic.png]] [[Missing]] [[Leaf]]',
  'Notes/A.md': 'Back to [[Home]]',
  'B.md': '',
  'sub/C.md': '[[../Home]] [up](../Home.md)',
  'pic.png': '',
  'x/Leaf.md': '',
  'y/Leaf.md': '',
};
const build = (files = FILES) => LinkIndex.build(Object.keys(files), (p) => files[p]);
const targets = (index: LinkIndex, path: string) =>
  index.outgoing(path).map(({ link, resolution }) => [link.rawPath, resolution.kind === 'found' ? resolution.path : resolution.kind]);

test('forward and backward links, ambiguous recorded as ambiguous', () => {
  const index = build();
  assert.deepEqual(targets(index, 'Home.md'), [
    ['Notes/A', 'Notes/A.md'],
    ['B', 'B.md'],
    ['sub/C.md', 'sub/C.md'],
    ['pic.png', 'pic.png'],
    ['Missing', 'missing'],
    ['Leaf', 'ambiguous'],
  ]);
  // sub/C.md links twice: [[../Home]] (a relative wikilink, from its own folder) and [up](../Home.md).
  assert.deepEqual(index.incoming('Home.md').map((l) => l.source).sort(), ['Notes/A.md', 'sub/C.md', 'sub/C.md']);
  assert.deepEqual(index.incoming('pic.png').map((l) => l.source), ['Home.md']);
  assert.deepEqual(index.ambiguousTo('x/Leaf.md').map((l) => l.source), ['Home.md']);
  assert.deepEqual(index.incoming('x/Leaf.md'), []);
});

test('incremental: create, change, delete, rename re-resolve the affected links', () => {
  const index = build();
  index.setFile('Missing.md', '');
  assert.deepEqual(targets(index, 'Home.md')[4], ['Missing', 'Missing.md'], 'a new file resolves a missing link');
  index.removeFile('y/Leaf.md');
  assert.deepEqual(targets(index, 'Home.md')[5], ['Leaf', 'x/Leaf.md'], 'deleting a duplicate resolves the ambiguity');
  index.setFile('Notes/A.md', 'now links [[B]]');
  assert.deepEqual(index.incoming('Home.md').map((l) => l.source), ['sub/C.md', 'sub/C.md'], 'changed text updates backlinks');
  assert.deepEqual(index.incoming('B.md').map((l) => l.source).sort(), ['Home.md', 'Notes/A.md']);
  index.renameFile('B.md', 'Renamed.md', '');
  assert.deepEqual(targets(index, 'Home.md')[1], ['B', 'missing'], 'renamed away: the old name no longer resolves');
  assert.deepEqual(index.incoming('Renamed.md'), []);
  index.renameFile('Renamed.md', 'deep/B.md', '');
  assert.deepEqual(targets(index, 'Home.md')[1], ['B', 'deep/B.md'], 'found again under its name in another folder');
  index.removeFile('Home.md');
  assert.deepEqual(index.incoming('deep/B.md').map((l) => l.source), ['Notes/A.md']);
  assert.deepEqual(index.outgoing('Home.md'), []);
});

test('Unicode: a link written in NFC finds an NFD file name and follows its rename', () => {
  const nfd = '노트'.normalize('NFD');
  const index = LinkIndex.build(['a.md', `${nfd}.md`], (p) => (p === 'a.md' ? '[[노트]]' : ''));
  assert.deepEqual(targets(index, 'a.md'), [['노트', `${nfd}.md`]]);
});

test('10,000-file synthetic vault: first index under 2 seconds (links.md 10 #14)', () => {
  const files: string[] = [];
  const texts = new Map<string, string>();
  for (let i = 0; i < 10_000; i++) {
    const folder = `f${i % 100}/g${i % 7}`;
    const path = i % 10 === 0 ? `${folder}/img${i}.png` : `${folder}/Note ${i}.md`;
    files.push(path);
    if (path.endsWith('.md')) {
      const lines = [`# Note ${i}`, '', `Links: [[Note ${(i + 1) % 10_000}]] [[f${(i + 3) % 100}/g${(i + 3) % 7}/Note ${(i + 3) % 10_000}|x]]`];
      lines.push(`![[img${Math.floor(i / 10) * 10}.png]] [m](../g${(i + 1) % 7}/Note%20${(i + 5) % 10_000}.md#h) [[Missing ${i}]]`);
      for (let k = 0; k < 20; k++) lines.push(`Body line ${k} with some words and a #tag and \`code [[x]]\`.`);
      texts.set(path, lines.join('\n'));
    }
  }
  const started = performance.now();
  const index = LinkIndex.build(files, (p) => texts.get(p));
  const ms = performance.now() - started;
  assert.equal(index.size, 10_000);
  assert.ok(index.incoming('f2/g2/Note 2.md').length >= 1, 'Note 1 links Note 2');
  assert.ok(ms < 2000, `first index took ${ms.toFixed(0)} ms`);
  // An incremental change stays small.
  const t2 = performance.now();
  index.setFile('f1/g1/Note 1.md', '[[Note 2]]');
  index.renameFile('f2/g2/Note 2.md', 'f2/g2/Two.md', '');
  assert.ok(performance.now() - t2 < 100, 'incremental updates are fast');
});
