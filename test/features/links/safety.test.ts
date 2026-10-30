// Link rewrites on rename must never corrupt a file (links.md 3): edits are checked against the
// current text, link-like text that is not a link stays untouched, and every rewritten link
// still names its file. Pure: a LinkIndex over an in-memory vault and planFileRenames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinLines, parseLines } from '../../../src/core/lines.ts';
import { extractLinks, LinkIndex } from '../../../src/vault/link-index.ts';
import { planFileRenames, readableText, type RenameOutcome, type RenamePorts } from '../../../src/features/links/rename.ts';

const V = '/v';
const BOM = String.fromCharCode(0xfeff);

/** An in-memory vault (vault-relative path -> text) with its index. */
function vault(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  let index = LinkIndex.build(disk.keys(), (p) => disk.get(p));
  const reindexed: string[] = [];
  const ports = (over: Partial<RenamePorts> = {}): RenamePorts => ({
    vaultOf: (path) => (path.startsWith(`${V}/`) ? V : undefined),
    indexFor: () => index,
    mode: () => 'always',
    trusted: () => true,
    confirm: async () => true,
    readText: async (path) => disk.get(path.slice(V.length + 1)),
    reindex: (paths) => void reindexed.push(...paths.map((p) => p.slice(V.length + 1))),
    ...over,
  });
  /** Plans, applies the edits as VS Code would (by line and character), then moves the files. */
  const rename = async (pairs: readonly (readonly [string, string])[], over: Partial<RenamePorts> = {}): Promise<RenameOutcome> => {
    const outcome = await planFileRenames(
      pairs.map(([from, to]) => ({ oldPath: `${V}/${from}`, newPath: `${V}/${to}` })),
      ports(over),
    );
    const byFile = new Map<string, typeof outcome.edits[number][]>();
    for (const e of outcome.edits) byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
    for (const [path, edits] of byFile) {
      const rel = path.slice(V.length + 1);
      const doc = parseLines(disk.get(rel)!);
      const lines = doc.lines.map((l) => ({ ...l }));
      for (const e of [...edits].sort((a, b) => b.line - a.line || b.start - a.start)) {
        const line = lines[e.line]!;
        line.text = line.text.slice(0, e.start) + e.newText + line.text.slice(e.end);
      }
      disk.set(rel, joinLines({ bom: doc.bom, lines }));
    }
    for (const [from, to] of pairs) {
      for (const [path, text] of [...disk]) {
        if (path === from || path.startsWith(`${from}/`)) {
          disk.delete(path);
          disk.set(`${to}${path.slice(from.length)}`, text);
        }
      }
    }
    index = LinkIndex.build(disk.keys(), (p) => disk.get(p)); // as the link store follows the rename
    return outcome;
  };
  /** Where each link of `path` resolves in a fresh index of the vault as it is now. */
  const targets = (path: string): string[] =>
    LinkIndex.build(disk.keys(), (p) => disk.get(p))
      .outgoing(path)
      .map((o) => (o.resolution.kind === 'found' ? o.resolution.path : o.resolution.kind));
  return { disk, index: () => index, ports, rename, targets, reindexed };
}

// 1. Stale index offsets.
test('case 1: a file changed since it was indexed is not edited, is reported and re-indexed', async () => {
  const v = vault({ '대상.md': '', 'a.md': 'x [[대상]] y\n', 'b.md': '[[대상]]\n' });
  v.disk.set('a.md', 'inserted text [[대상]] y\n'); // the index did not notice
  const outcome = await v.rename([['대상.md', '새.md']]);
  assert.equal(v.disk.get('a.md'), 'inserted text [[대상]] y\n', 'untouched');
  assert.equal(v.disk.get('b.md'), '[[새]]\n', 'others are updated');
  assert.deepEqual(outcome.notices, [{ kind: 'stale', files: 1 }]);
  assert.deepEqual(v.reindexed, ['a.md']);
});

test('case 1: the same length but different characters at the link is caught too', async () => {
  const v = vault({ '대상.md': '', 'a.md': '[[대상]]\n' });
  v.disk.set('a.md', '[[대양]]\n');
  await v.rename([['대상.md', '새.md']]);
  assert.equal(v.disk.get('a.md'), '[[대양]]\n');
});

// 2. Changed between plan and apply (while the question is open).
test('case 2: a file changed while the question was open is not edited', async () => {
  const v = vault({ '대상.md': '', 'a.md': '[[대상]]\n', 'b.md': '[[대상]]\n' });
  const outcome = await v.rename([['대상.md', '새.md']], {
    mode: () => 'prompt',
    confirm: async () => {
      v.disk.set('a.md', 'typed meanwhile\n[[대상]]\n');
      return true;
    },
  });
  assert.equal(v.disk.get('a.md'), 'typed meanwhile\n[[대상]]\n');
  assert.equal(v.disk.get('b.md'), '[[새]]\n');
  assert.deepEqual(outcome.notices, [{ kind: 'stale', files: 1 }]);
});

test('case 2: a file that cannot be read any more is skipped', async () => {
  const v = vault({ '대상.md': '', 'a.md': '[[대상]]\n' });
  const outcome = await v.rename([['대상.md', '새.md']], { readText: async () => undefined });
  assert.equal(v.disk.get('a.md'), '[[대상]]\n');
  assert.deepEqual(outcome.edits, []);
  assert.deepEqual(outcome.notices, [{ kind: 'stale', files: 1 }]);
});

// 3. Link-like text that is not a link.
const NOT_LINKS = [
  '    [[대상]] [t](대상.md) indented code at the start',
  '',
  'para',
  '',
  '\t[[대상]] tab-indented code',
  '',
  '$$',
  '[[대상]] [t](대상.md)',
  '$$',
  'inline $[[대상]]$ math and $x [t](대상.md) y$',
  '$$ [[대상]] $$ one-line block',
  '%% [[대상]] %% inline comment',
  '%%',
  '[[대상]] [t](대상.md)',
  '%%',
  '<!-- [[대상]] --> inline html comment',
  '<!--',
  '[[대상]] [t](대상.md)',
  '-->',
  '<a title="[[대상]]" href="대상.md">x</a> <img alt="[t](대상.md)">',
  '\\[\\[대상]] and \\[t](대상.md)',
  '``code [[대상]] `` and ` [t](대상.md) `',
  '````md',
  '[[대상]]',
  '```',
  '````',
  '~~~',
  '[[대상]] [t](대상.md)',
  '~~~',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"board","x":"[[대상]]"}',
  '```',
  '%%',
  '```',
  '[[대상]] unclosed fence to the end',
  '',
].join('\n');

test('case 3: link-like text in code, math, comments, HTML, escapes and settings stays byte-identical', async () => {
  const v = vault({ '대상.md': '', 'n.md': NOT_LINKS });
  assert.deepEqual(extractLinks(NOT_LINKS), [], 'nothing in it is a link');
  await v.rename([['대상.md', '새.md']]);
  assert.equal(v.disk.get('n.md'), NOT_LINKS);
});

test('case 3/18: frontmatter: only quoted "[[...]]" values are links (not plain YAML, block scalars or aliases)', async () => {
  const text = [
    '---',
    'plain: [[대상]]',
    'string: see [[대상]] here',
    'block: |',
    '  "[[대상]]"',
    'folded: >-',
    '  "[[대상]]"',
    'aliases:',
    '  - "[[대상]]"',
    'related: "[[대상]]"',
    'list:',
    '  - "[[대상|shown]]"',
    "single: '[[대상]]'",
    '---',
    'body',
    '',
  ].join('\n');
  const v = vault({ '대상.md': '', 'n.md': text });
  await v.rename([['대상.md', '새.md']]);
  assert.equal(v.disk.get('n.md'), text.replace('related: "[[대상]]"', 'related: "[[새]]"').replace('"[[대상|shown]]"', '"[[새|shown]]"').replace("'[[대상]]'", "'[[새]]'"));
});

test('case 3: real links in quotes, tables (\\|), lists, quotes, callouts and list continuations are updated', async () => {
  const text = [
    'He said "[[대상]]".',
    '| col | link |',
    '| --- | ---- |',
    '| a   | [[대상\\|별칭]] [t](대상.md) |',
    '- [[대상]]',
    '    - nested [[대상]]',
    '',
    '    continued [[대상]] after a blank line in the list',
    '> [[대상]]',
    '> [!note] Title',
    '> [[대상]]',
    'para',
    '    lazy [[대상]]',
    '',
  ].join('\n');
  const v = vault({ '대상.md': '', 'n.md': text });
  await v.rename([['대상.md', '새.md']]);
  assert.equal(v.disk.get('n.md'), text.replaceAll('[[대상', '[[새').replace('(대상.md)', '(새.md)'));
  assert.ok(v.targets('n.md').every((t) => t === '새.md'));
});

// 4. Names that contain the renamed name.
test('case 4: links to names that merely contain the name are left alone', async () => {
  const text = '[[대상2]] [[my대상]] [[대상 2]] [a](대상2.md) [b](my대상.md) [c](대상.md.bak) [[대상.md.bak]] [[대상]]\n';
  const v = vault({ '대상.md': '', '대상2.md': '', 'my대상.md': '', '대상 2.md': '', '대상.md.bak': '', 'n.md': text });
  await v.rename([['대상.md', '새.md']]);
  assert.equal(v.disk.get('n.md'), text.replace('[[대상]]', '[[새]]'));
});

// 5. Special characters in names.
const SPECIAL = ['a+b.md', '(x).md', '[x].md', '100%.md', 'a#b.md', 'a^b.md', 'a|b.md', ' lead.md', 'trail .md', 'dot..md', 'a`b.md', 'a]]b.md', 'a)b.md'];

for (const name of SPECIAL) {
  test(`case 5: renaming to "${name}": every rewritten link names it, the rest is reported unchanged`, async () => {
    const text = '[[대상]] [[대상|shown]] [[대상#h]] [m](대상.md) [m](<대상.md>) | [t](./대상.md) |\n';
    const v = vault({ '대상.md': '', 'n.md': text });
    const outcome = await v.rename([['대상.md', name]]);
    const after = v.disk.get('n.md')!;
    const links = extractLinks(after);
    assert.equal(links.length, 6, `still six links: ${after}`);
    assert.deepEqual(links.map((l) => [l.display, l.subpath]), extractLinks(text).map((l) => [l.display, l.subpath]), 'display and subpath kept');
    const targets = v.targets('n.md');
    const unchanged = outcome.notices.find((n) => n.kind === 'unchanged');
    const kept = links.filter((l, i) => l.rawPath === extractLinks(text)[i]!.rawPath).length;
    assert.ok(targets.every((t) => t === name || t === 'missing'), `${after} -> ${targets.join(',')}`);
    assert.equal(targets.filter((t) => t === 'missing').length, kept, 'only links left as they were are broken');
    assert.equal(unchanged === undefined ? 0 : unchanged.links, kept, 'and each of them is reported');
  });
}

test('case 5: renaming files whose names hold special characters', async () => {
  const text = '[[a+b]] [m](a+b.md) [p](%28x%29.md) [q](<(x).md>) [[100%]] [r](100%25.md)\n';
  const v = vault({ 'a+b.md': '', '(x).md': '', '100%.md': '', 'n.md': text });
  await v.rename([['a+b.md', 'c+d.md'], ['(x).md', '(y).md'], ['100%.md', '50%.md']]);
  assert.equal(v.disk.get('n.md'), '[[c+d]] [m](c+d.md) [p](%28y%29.md) [q](<(y).md>) [[50%]] [r](50%25.md)\n');
});

// 6. Case-only renames.
test('case 6: case-only renames', async () => {
  const v = vault({ '대상.md': '', 'Note.md': '', 'n.md': '[[대상]] [[Note]] [x](Note.md) [y](대상.md)\n' });
  await v.rename([['대상.md', '대상.MD'], ['Note.md', 'note.md']]);
  // A Markdown path names the file exactly, so it follows the new case; `[[대상]]` already fits.
  assert.equal(v.disk.get('n.md'), '[[대상]] [[note]] [x](note.md) [y](대상.MD)\n');
  assert.deepEqual(v.targets('n.md'), ['대상.MD', 'note.md', 'note.md', '대상.MD']);
});

// 7. Moving onto a name used elsewhere.
test('case 7: a move that makes a name ambiguous never redirects links to the other file', async () => {
  const text = '[[대상]] [[other]] [o](b/other.md)\n';
  const v = vault({ 'a/대상.md': '', 'b/other.md': '', 'n.md': text });
  const outcome = await v.rename([['b/other.md', 'b/대상.md']]);
  assert.equal(v.disk.get('n.md'), '[[대상]] [[b/대상]] [o](b/대상.md)\n');
  assert.deepEqual(outcome.notices, [{ kind: 'unchanged', links: 1 }], '[[대상]] would now fit both: left alone and reported');
  assert.deepEqual(v.targets('n.md').slice(1), ['b/대상.md', 'b/대상.md']);
});

// 8. Folders.
test('case 8: nested folder rename, hundreds of files, and a folder moved into its own subfolder', async () => {
  const files: Record<string, string> = { 'top.md': '' };
  for (let i = 0; i < 300; i++) files[`f/sub${i % 7}/n${i}.md`] = `[[n${(i + 1) % 300}]] [up](../../top.md) [s](./n${i}.md)\n`;
  files['links.md'] = Array.from({ length: 300 }, (_, i) => `[l](f/sub${i % 7}/n${i}.md)`).join('\n');
  const v = vault(files);
  const started = performance.now();
  await v.rename([['f', 'g/h']]);
  assert.ok(performance.now() - started < 3000);
  assert.ok(v.targets('links.md').every((t) => t.startsWith('g/h/')));
  assert.equal(v.disk.get('g/h/sub0/n0.md'), '[[n1]] [up](../../../top.md) [s](./n0.md)\n');
  await v.rename([['g', 'g/inner/g']]);
  assert.ok(v.targets('links.md').every((t) => t.startsWith('g/inner/g/h/')));
  assert.deepEqual(v.targets('g/inner/g/h/sub0/n0.md'), ['g/inner/g/h/sub1/n1.md', 'top.md', 'g/inner/g/h/sub0/n0.md']);
});

// 9. Out of the vault, into another vault.
test('case 9: moves out of the vault or into another vault change nothing and warn', async () => {
  const v = vault({ '대상.md': '', 'n.md': '[[대상]]\n' });
  const vaultOf = (p: string) => (p.startsWith('/w/') ? '/w' : p.startsWith(`${V}/`) ? V : undefined);
  for (const newPath of ['/elsewhere/대상.md', '/w/대상.md']) {
    const outcome = await planFileRenames([{ oldPath: `${V}/대상.md`, newPath }], v.ports({ vaultOf }));
    assert.deepEqual(outcome.edits, []);
    assert.deepEqual(outcome.notices, [{ kind: 'leftVault', links: 1 }]);
  }
});

// 10, 11. Batches and relative links among moved files.
test('case 10/11: a batch of files linking to each other, with relative links among them', async () => {
  const v = vault({
    'a.md': '[[b]] [b](b.md) [rel](./b.md) [up](sub/c.md)\n',
    'b.md': '[[a]] [a](./a.md)\n',
    'sub/c.md': '[a](../a.md) [[a]]\n',
    'stay.md': '[[a]] [x](./a.md) [y](b.md)\n',
  });
  await v.rename([['a.md', 'x/a.md'], ['b.md', 'x/b.md']]);
  assert.deepEqual(v.targets('x/a.md'), ['x/b.md', 'x/b.md', 'x/b.md', 'sub/c.md']);
  assert.deepEqual(v.targets('x/b.md'), ['x/a.md', 'x/a.md']);
  assert.deepEqual(v.targets('sub/c.md'), ['x/a.md', 'x/a.md']);
  assert.deepEqual(v.targets('stay.md'), ['x/a.md', 'x/a.md', 'x/b.md']);
  assert.equal(v.disk.get('x/b.md'), '[[a]] [a](./a.md)\n', 'links between co-moved files stay as they are');
});

// 14. Line endings, BOM and encodings.
test('case 14: CRLF, BOM, mixed line endings and no trailing newline are kept byte for byte', async () => {
  const files = {
    '대상.md': '',
    'crlf.md': 'a\r\n[[대상]] x\r\nb\r\n',
    'bom.md': `${BOM}[[대상]]\n`,
    'mixed.md': 'a\n[[대상]]\r\nb [[대상]]\n',
    'none.md': 'end [[대상]]',
  };
  const v = vault(files);
  await v.rename([['대상.md', '새.md']]);
  for (const [path, text] of Object.entries(files)) if (path !== '대상.md') assert.equal(v.disk.get(path), text.replaceAll('[[대상]]', '[[새]]'), path);
});

test('case 14: a lone CR (a line break for VS Code, not for the index) makes the file skipped', async () => {
  const v = vault({ '대상.md': '', 'cr.md': 'a\rb [[대상]]\n' });
  const outcome = await v.rename([['대상.md', '새.md']]);
  assert.equal(v.disk.get('cr.md'), 'a\rb [[대상]]\n');
  assert.deepEqual(outcome.notices, [{ kind: 'stale', files: 1 }]);
});

test('case 14/15: only valid UTF-8 text without NUL bytes is offered for editing', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(readableText(enc('[[a]]\n')), '[[a]]\n');
  assert.equal(readableText(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('[[a]]')])), '[[a]]', 'UTF-8 BOM dropped as VS Code shows it');
  assert.equal(readableText(Uint8Array.from([0xff, 0xfe, 0x5b, 0x00, 0x5b, 0x00])), undefined, 'UTF-16');
  assert.equal(readableText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])), undefined, 'Latin-1');
  assert.equal(readableText(enc('a\u0000b')), undefined, 'binary');
});

// 15. Huge files and long lines.
test('case 15: a very long line full of brackets is scanned in reasonable time', () => {
  const started = performance.now();
  extractLinks(`${'[['.repeat(100_000)}${'[x]('.repeat(50_000)}`);
  extractLinks('`'.repeat(100_000));
  assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
});

test('case 15: a huge Markdown file is indexed without its links (never rewritten)', async () => {
  const huge = `[[대상]]\n${'x'.repeat(17 * 1024 * 1024)}`;
  const v = vault({ '대상.md': '', 'huge.md': huge });
  assert.deepEqual(v.index().outgoing('huge.md'), []);
  const outcome = await v.rename([['대상.md', '새.md']]);
  assert.deepEqual(outcome.edits, []);
});

// 16. Unicode normalization.
test('case 16: NFC and NFD Korean names and links resolve alike; each link keeps its own form', async () => {
  const nfd = '대상'.normalize('NFD');
  const v = vault({ [`${nfd}.md`]: '', 'n.md': `[[대상]] [[${nfd}]] [m](${nfd}.md)\n` });
  await v.rename([[`${nfd}.md`, '새로운.md']]);
  assert.equal(v.disk.get('n.md'), `[[새로운]] [[${'새로운'.normalize('NFD')}]] [m](${'새로운'.normalize('NFD')}.md)\n`);
});

// 17. Encoded, angle-bracket, titled links and headings holding the name.
test('case 17: %20 and <angle> links, titles and #headings that contain the name', async () => {
  const text = '[a](%EB%8C%80%EC%83%81.md) [b](<대상.md> "대상") [c](대상.md#대상 "제목 대상") [[대상#대상]] [[#대상]] [d](대상%20노트.md)\n';
  const v = vault({ '대상.md': '', '대상 노트.md': '', 'n.md': text });
  await v.rename([['대상.md', '새 이름.md'], ['대상 노트.md', '다른 노트.md']]);
  // An encoded link gets the readable encoding (2.4 #4: space, %, parentheses ...).
  assert.equal(v.disk.get('n.md'), '[a](새%20이름.md) [b](<새 이름.md> "대상") [c](새%20이름.md#대상 "제목 대상") [[새 이름#대상]] [[#대상]] [d](다른%20노트.md)\n');
});

// 19. Trust and building.
test('case 19: untrusted workspace and an index still being built write nothing', async () => {
  const v = vault({ '대상.md': '', 'n.md': '[[대상]]\n' });
  assert.deepEqual((await v.rename([['대상.md', '새.md']], { trusted: () => false })).edits, []);
  assert.deepEqual((await v.rename([['새.md', '또.md']], { indexFor: () => undefined })).edits, []);
  assert.equal(v.disk.get('n.md'), '[[대상]]\n');
});

test('attachments: image and PDF renames are checked like notes (a stale file is left alone)', async () => {
  const v = vault({ 'img/a.png': '', 'docs/b c.pdf': '', 'n.md': '![x](img/a.png) [p](docs/b%20c.pdf)\n', 'm.md': '![[img/a.png]]\n' });
  v.disk.set('m.md', 'moved down\n![[img/a.png]]\n');
  const outcome = await v.rename([['img', 'pics'], ['docs/b c.pdf', 'b c.pdf']]);
  assert.equal(v.disk.get('n.md'), '![x](pics/a.png) [p](b%20c.pdf)\n');
  assert.equal(v.disk.get('m.md'), 'moved down\n![[img/a.png]]\n');
  assert.deepEqual(outcome.notices, [{ kind: 'stale', files: 1 }]);
});

// 2.4 #2: plain Markdown paths that matched next to the note stay note-relative.
test('note-relative: an image moved into a subfolder and back', async () => {
  const v = vault({ 'image.png': '', 'n.md': '![alt](image.png) ![[image.png]] ![b](<image.png>)\n' });
  await v.rename([['image.png', '폴더/image.png']]);
  assert.equal(v.disk.get('n.md'), '![alt](폴더/image.png) ![[image.png]] ![b](<폴더/image.png>)\n');
  await v.rename([['폴더/image.png', 'image.png']]);
  assert.equal(v.disk.get('n.md'), '![alt](image.png) ![[image.png]] ![b](<image.png>)\n');
});

test('note-relative: a note moved away from its same-folder image, and an encoded name', async () => {
  const v = vault({ 'a/my pic.png': '', 'a/n.md': '![x](my%20pic.png) ![[my pic.png]]\n' });
  await v.rename([['a/n.md', 'b/c/n.md']]);
  assert.equal(v.disk.get('b/c/n.md'), '![x](../../a/my%20pic.png) ![[my pic.png]]\n');
  assert.deepEqual(v.targets('b/c/n.md'), ['a/my pic.png', 'a/my pic.png']);
});

test('note-relative: a plain path that only matched by name elsewhere stays as it is', async () => {
  const v = vault({ 'x/image.png': '', 'n.md': '![alt](image.png)\n', 'x/m.md': '![m](image.png)\n' });
  await v.rename([['x/image.png', 'y/image.png']]);
  assert.equal(v.disk.get('n.md'), '![alt](image.png)\n', 'n.md is at the root: it named x/image.png by name only');
  assert.equal(v.disk.get('x/m.md'), '![m](../y/image.png)\n', 'm.md had it next to it');
  assert.deepEqual(v.targets('n.md'), ['y/image.png']);
});

test('note-relative: a plain relative path that the vault root would read differently gets ./', async () => {
  const v = vault({ 'notes/sub/pic.png': '', 'img/pic.png': '', 'notes/n.md': '![p](sub/pic.png)\n' });
  await v.rename([['notes/sub/pic.png', 'notes/img/pic.png']]);
  assert.equal(v.disk.get('notes/n.md'), '![p](./img/pic.png)\n', '`img/pic.png` would name the root img/pic.png');
  assert.deepEqual(v.targets('notes/n.md'), ['notes/img/pic.png']);
});

// Documents and files VS Code would not read as UTF-8 (files.encoding, files.autoGuessEncoding).
test('encoding: an open document read with another encoding is never edited', async () => {
  const { documentText } = await import('../../../src/features/links/rename.ts');
  assert.equal(documentText('[[대상]]', 'utf8'), '[[대상]]');
  assert.equal(documentText('[[대상]]', 'utf8bom'), '[[대상]]');
  assert.equal(documentText('[[대상]]', undefined), '[[대상]]');
  for (const encoding of ['cp949', 'euckr', 'shiftjis', 'gbk', 'windows1252', 'utf16le']) assert.equal(documentText('[[x]]', encoding), undefined, encoding);
});

test('encoding: a closed file is edited only when VS Code will read it as the same UTF-8 text', async () => {
  const { closedFileText } = await import('../../../src/features/links/rename.ts');
  const korean = new TextEncoder().encode('[[대상]]\n');
  const ascii = new TextEncoder().encode('[[target]]\n');
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...korean]);
  const utf8 = { encoding: 'utf8', autoGuess: false };
  assert.equal(closedFileText(korean, utf8), '[[대상]]\n');
  assert.equal(closedFileText(korean, { encoding: undefined, autoGuess: false }), '[[대상]]\n');
  for (const encoding of ['cp949', 'euckr', 'shiftjis', 'gbk']) {
    assert.equal(closedFileText(korean, { encoding, autoGuess: false }), undefined, `${encoding}: mojibake risk`);
    assert.equal(closedFileText(ascii, { encoding, autoGuess: false }), '[[target]]\n', `${encoding}: ASCII reads the same`);
    assert.equal(closedFileText(bom, { encoding, autoGuess: false }), '[[대상]]\n', `${encoding}: a BOM is always detected`);
  }
  assert.equal(closedFileText(korean, { encoding: 'utf8', autoGuess: true }), undefined, 'a guess may pick another encoding');
  assert.equal(closedFileText(ascii, { encoding: 'utf16le', autoGuess: false }), undefined, 'UTF-16 reads ASCII bytes differently');
});

// Round 3.
test('round 3 case 1: notes in .obsidian/, .trash/ or other dot-folders are never edited (Obsidian ignores them)', async () => {
  const hidden = {
    '.obsidian/plugins/p/README.md': '[[Note]] [n](../../../Note.md)\n',
    '.trash/old.md': '[[Note]]\n',
    '.hidden/x.md': '[[Note]]\n',
    'sub/.dot.md': '[[Note]]\n',
  };
  const v = vault({ 'Note.md': '', 'a.md': '[[Note]]\n', ...hidden });
  await v.rename([['Note.md', 'Renamed.md']]);
  assert.equal(v.disk.get('a.md'), '[[Renamed]]\n');
  for (const [path, text] of Object.entries(hidden)) assert.equal(v.disk.get(path), text, path);
  assert.deepEqual(v.index().incoming('Renamed.md').map((l) => l.source), ['a.md'], 'not backlinks either');
});

test('round 3 case 3: a file reached through a symbolic link inside the vault is never edited', async () => {
  const { throughSymlink } = await import('../../../src/features/links/rename.ts');
  const links = new Set(['/v/linked', '/v/notes/file-link.md']);
  const isLink = async (path: string) => links.has(path);
  assert.equal(await throughSymlink('/v', '/v/linked/deep/n.md', isLink), true, 'a folder link on the way');
  assert.equal(await throughSymlink('/v', '/v/notes/file-link.md', isLink), true, 'the file itself');
  assert.equal(await throughSymlink('/v', '/v/notes/plain.md', isLink), false);
  assert.equal(await throughSymlink('/v', '/elsewhere/n.md', isLink), true, 'outside the vault counts as unsafe');
  // A stat error (vanished) is unsafe too.
  assert.equal(await throughSymlink('/v', '/v/notes/x.md', async () => { throw new Error('gone'); }), true);
});

test('round 3 case 5: renaming a folder of 5,000 linked notes plans, checks and applies within a few seconds', async () => {
  const files: Record<string, string> = { 'index.md': Array.from({ length: 5000 }, (_, i) => `[[n${i}]] [m](big/n${i}.md)`).join('\n') };
  for (let i = 0; i < 5000; i++) files[`big/n${i}.md`] = `[[n${(i + 1) % 5000}]] [up](../index.md) [s](./n${(i + 7) % 5000}.md)\n`;
  const v = vault(files);
  const started = performance.now();
  const outcome = await v.rename([['big', 'moved/big']]);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `${elapsed} ms`);
  assert.equal(outcome.files.length, 5001);
  assert.ok(v.targets('index.md').every((t) => t.startsWith('moved/big/')));
});

test('round 6 case 1: Unicode case folding edge cases never redirect or corrupt links', async () => {
  const files: Record<string, string> = {
    'İstanbul.md': '',
    'Straße.md': '',
    'ΟΔΟΣ.md': '',
    'ＡＢＣ.md': '',
    'n.md': '[[İstanbul]] [[istanbul]] [[STRASSE]] [[straße]] [[οδος]] [[ΟΔΟΣ]] [[ａｂｃ]] [[ABC]]\n',
  };
  const v = vault(files);
  const before = v.targets('n.md');
  await v.rename([['İstanbul.md', 'Ankara.md'], ['Straße.md', 'Weg.md'], ['ΟΔΟΣ.md', 'Δρόμος.md'], ['ＡＢＣ.md', 'XYZ.md']]);
  const after = v.targets('n.md');
  const moved: Record<string, string> = { 'İstanbul.md': 'Ankara.md', 'Straße.md': 'Weg.md', 'ΟΔΟΣ.md': 'Δρόμος.md', 'ＡＢＣ.md': 'XYZ.md' };
  before.forEach((target, i) => {
    // A link that named a renamed file now names its new name; one that named nothing still names nothing.
    assert.equal(after[i], moved[target] ?? target, `link ${i}: ${target} -> ${after[i]}`);
  });
  assert.equal(extractLinks(v.disk.get('n.md')!).length, 8);
});

test('round 6 case 5: notes too large to index are reported on a rename (their links are not checked)', async () => {
  const huge = `[[Note]]\n${'x'.repeat(17 * 1024 * 1024)}`;
  const v = vault({ 'Note.md': '', 'a.md': '[[Note]]\n', 'huge.md': huge });
  const outcome = await v.rename([['Note.md', 'Renamed.md']]);
  assert.equal(v.disk.get('a.md'), '[[Renamed]]\n');
  assert.equal(v.disk.get('huge.md'), huge, 'never edited');
  assert.ok(outcome.notices.some((n) => n.kind === 'tooLarge' && n.files === 1), JSON.stringify(outcome.notices));
});

test('round 7 case 2: links near the 4,096-character token bound are either rewritten correctly or left whole and reported', async () => {
  const longText = 'T'.repeat(4090);
  const deep = `${'d/'.repeat(2040)}`; // a destination just under the bound
  const text = [`[${longText}](대상.md)`, `[short](${deep}대상.md)`, `[${'U'.repeat(4097)}](대상.md)`, `[[대상|${'A'.repeat(5000)}]]`].join('\n') + '\n';
  const v = vault({ '대상.md': '', [`${deep}대상.md`]: '', 'n.md': text });
  const outcome = await v.rename([['대상.md', `${'긴이름'.repeat(20)}.md`], [`${deep}대상.md`, `${deep}${'x'.repeat(60)}.md`]]);
  const after = v.disk.get('n.md')!;
  const lines = after.split('\n');
  const old = text.split('\n');
  assert.equal(lines.length, old.length);
  lines.forEach((line, i) => {
    // Each line is either the original or the original with only its link path replaced.
    if (line === old[i]) return;
    const prefix = old[i]!.slice(0, old[i]!.indexOf(i === 3 ? '대상' : '](') + 2);
    assert.ok(line.startsWith(i === 3 ? '[[' : prefix.slice(0, -2)), `line ${i} kept its text`);
  });
  const unchanged = outcome.notices.find((n) => n.kind === 'unchanged');
  const kept = lines.filter((l, i) => l === old[i]).length;
  assert.ok(kept === 0 || (unchanged !== undefined && unchanged.links >= 1) || lines[2] === old[2], 'anything left alone is reported or was never a link');
  assert.ok(v.targets('n.md').every((t) => t !== '대상.md' && t !== `${deep}대상.md`), 'no link points at an old path');
});

test('round 7 case 3: block-reference embeds and aliases with bracket-like text survive renames', async () => {
  const text = '![[대상#^abc123]] ![[대상#^abc123|별칭]] [[대상#제목|a [b] c]] [[대상|x]y]] ![[대상.md#^id]] [t](대상.md#^id)\n';
  const v = vault({ '대상.md': '', 'n.md': text });
  await v.rename([['대상.md', '새 노트.md']]);
  assert.equal(v.disk.get('n.md'), '![[새 노트#^abc123]] ![[새 노트#^abc123|별칭]] [[대상#제목|a [b] c]] [[대상|x]y]] ![[새 노트.md#^id]] [t](새%20노트.md#^id)\n');
});

test('round 7 case 4: relative wikilinks (newLinkFormat relative) resolve from the linking file and follow renames', async () => {
  const v = vault({ 'assets/p.png': '', 'notes/day/today.md': '![[../../assets/p.png]] [[./sibling]] [[../up]]\n', 'notes/day/sibling.md': '', 'notes/up.md': '' });
  assert.deepEqual(v.targets('notes/day/today.md'), ['assets/p.png', 'notes/day/sibling.md', 'notes/up.md']);
  await v.rename([['assets', 'media'], ['notes/day/sibling.md', 'notes/day/brother.md']]);
  assert.equal(v.disk.get('notes/day/today.md'), '![[../../media/p.png]] [[./brother]] [[../up]]\n');
});

test('round 10: link updates switched off while the question is open are not applied', async () => {
  for (const off of ['never', 'disabled'] as const) {
    let mode: 'prompt' | 'never' = 'prompt';
    const v = vault({ '대상.md': '', 'n.md': '[[대상]]\n' });
    const outcome = await v.rename([['대상.md', '새.md']], {
      mode: () => (off === 'never' ? mode : 'prompt'),
      enabled: () => !(off === 'disabled' && mode === 'never'),
      confirm: async () => {
        mode = 'never'; // the user (or a synced settings file) turns updates off meanwhile
        return true;
      },
    });
    assert.deepEqual(outcome.edits, [], off);
    assert.equal(v.disk.get('n.md'), '[[대상]]\n', off);
  }
});
