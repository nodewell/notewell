import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fenceMask } from '../../src/core/fences.ts';
import { findFrontmatter } from '../../src/core/frontmatter.ts';
import { lineTexts, parseLines } from '../../src/core/lines.ts';
import { findTokens, findTokensByLine, type Token } from '../../src/core/tokens.ts';

function fixtureTexts(name: string): string[] {
  const source = readFileSync(new URL(`../fixtures/kanban/${name}`, import.meta.url), 'utf8');
  return lineTexts(parseLines(source));
}

/** Each token as [kind, source slice] for compact assertions. */
function slices(text: string, tokens: Token[] = findTokens(text)): [string, string][] {
  return tokens.map((t) => [t.kind, text.slice(t.start, t.end)]);
}

test('wikilink with and without alias', () => {
  const text = 'see [[폴더/노트]] and [[노트|보이는 이름]]';
  assert.deepEqual(findTokens(text), [
    { kind: 'wikilink', start: 4, end: 13, target: '폴더/노트', alias: null, embed: false },
    { kind: 'wikilink', start: 18, end: 31, target: '노트', alias: '보이는 이름', embed: false },
  ]);
});

test('wikilink keeps heading and block refs in the target; alias may contain |', () => {
  const [a, b] = findTokens('[[note#Heading]] [[note^abc|x|y]]');
  assert.equal(a?.kind === 'wikilink' && a.target, 'note#Heading');
  assert.ok(b?.kind === 'wikilink');
  assert.equal(b.target, 'note^abc');
  assert.equal(b.alias, 'x|y');
});

test('embed wikilink starts at !', () => {
  assert.deepEqual(findTokens('![[image.png]]'), [
    { kind: 'wikilink', start: 0, end: 14, target: 'image.png', alias: null, embed: true },
  ]);
});

test('date-style wikilink is a wikilink; the @ prefix is left to the caller', () => {
  assert.deepEqual(slices('@[[2026-10-21]]'), [['wikilink', '[[2026-10-21]]']]);
});

test('not wikilinks', () => {
  assert.deepEqual(findTokens('[[]] [[ ]] [[|x]] [[a [[b]] [single] [[open'), [
    { kind: 'wikilink', start: 22, end: 27, target: 'b', alias: null, embed: false },
  ]);
  assert.deepEqual(findTokens('[[a]b]]'), []);
  assert.deepEqual(findTokens('\\[[a]]'), []);
});

test('tags', () => {
  const text = '#기능 #v2-기능 #버그_수정 #a/b #ä';
  assert.deepEqual(
    findTokens(text).map((t) => t.kind === 'tag' && t.name),
    ['기능', 'v2-기능', '버그_수정', 'a/b', 'ä'],
  );
});

test('tag ends at punctuation', () => {
  assert.deepEqual(slices('end #tag, and #tag.'), [
    ['tag', '#tag'],
    ['tag', '#tag'],
  ]);
});

test('tag must start the line or follow whitespace', () => {
  assert.deepEqual(slices('a#b x(#c) [[n]]#d'), [['wikilink', '[[n]]']]);
  assert.deepEqual(slices('x\t#tab'), [['tag', '#tab']]);
});

test('not tags: heading markers, lone #, escaped #', () => {
  assert.deepEqual(findTokens('## heading'), []);
  assert.deepEqual(findTokens('# heading'), []);
  assert.deepEqual(findTokens('a # b'), []);
  assert.deepEqual(findTokens('\\#tag'), []);
});

test('#123 rule: digits-only is not a tag, a tag needs one non-digit (Obsidian)', () => {
  assert.deepEqual(findTokens('이슈 #123 은'), []);
  assert.deepEqual(findTokens('#2026'), []);
  assert.deepEqual(findTokens('#١٢٣'), []);
  assert.deepEqual(
    findTokens('#123a #1-2 #2026/10 #_1').map((t) => t.kind === 'tag' && t.name),
    ['123a', '1-2', '2026/10', '_1'],
  );
});

test('inline code', () => {
  assert.deepEqual(findTokens('a `b` c'), [{ kind: 'code', start: 2, end: 5, content: 'b' }]);
  assert.deepEqual(findTokens('``a ` b``'), [{ kind: 'code', start: 0, end: 9, content: 'a ` b' }]);
});

test('unmatched backticks are literal', () => {
  assert.deepEqual(findTokens('a ` #tag'), [{ kind: 'tag', start: 4, end: 8, name: 'tag' }]);
  // A run of 2 is not closed by a run of 1 or 3; a run of 1 skips the run of 3.
  assert.deepEqual(findTokens('``a` b``` c'), []);
  assert.deepEqual(slices('``a` b``` c `d'), [['code', '` b``` c `']]);
  assert.deepEqual(findTokens('\\`not code`'), []);
});

test('tokens inside inline code are excluded', () => {
  assert.deepEqual(slices('`#tag [[link]]` #real [[real]]'), [
    ['code', '`#tag [[link]]`'],
    ['tag', '#real'],
    ['wikilink', '[[real]]'],
  ]);
});

test('inline code takes precedence over a wikilink it starts inside', () => {
  assert.deepEqual(slices('[[a `b]]` c'), [['code', '`b]]`']]);
  // A span closed inside the link does not break it.
  assert.deepEqual(slices('[[a `b` c]]'), [['wikilink', '[[a `b` c]]']]);
});

test('offsets are UTF-16 indices', () => {
  const text = '😀 #태그 [[🎉]]';
  assert.deepEqual(slices(text), [
    ['tag', '#태그'],
    ['wikilink', '[[🎉]]'],
  ]);
  assert.equal(findTokens(text)[0]?.start, 3);
});

test('findTokensByLine skips flagged lines', () => {
  const texts = ['#a', '```', '#b [[c]]', '```', '#d'];
  const byLine = findTokensByLine(texts, fenceMask(texts));
  assert.deepEqual(
    byLine.map((tokens, i) => slices(texts[i], tokens)),
    [[['tag', '#a']], [], [], [], [['tag', '#d']]],
  );
  assert.deepEqual(findTokensByLine(['#x']).length, 1);
});

test('fixture 18: tokens', () => {
  const texts = fixtureTexts('18-tokens.md');
  const line = (prefix: string): string => {
    const found = texts.find((t) => t.startsWith(`- [ ] ${prefix}`));
    assert.ok(found, prefix);
    return found;
  };
  assert.deepEqual(slices(line('위키 날짜')), [
    ['wikilink', '[[2026-10-21]]'],
    ['wikilink', '[[2026-10-22]]'],
  ]);
  assert.deepEqual(slices(line('링크')), [
    ['wikilink', '[[폴더/하위/노트]]'],
    ['wikilink', '[[노트|보이는 이름]]'],
  ]);
  assert.deepEqual(slices(line('태그')), [
    ['tag', '#기능'],
    ['tag', '#v2-기능'],
    ['tag', '#버그_수정'],
  ]);
  assert.deepEqual(slices(line('**굵게**')), [
    ['code', '`코드`'],
    ['mdlink', '[글](https://example.com)'],
  ]);
  assert.deepEqual(findTokens(line('이슈')), []);
  assert.deepEqual(findTokens(line('Dataview')), []);
  assert.deepEqual(findTokens(line('블록 ID')), []);
  assert.deepEqual(findTokens(line('HTML')), []);
});

test('fixture 13: tokens in fences and inline code are excluded', () => {
  const texts = fixtureTexts('13-code-fences.md');
  const fm = findFrontmatter(texts);
  assert.ok(fm);
  const byLine = findTokensByLine(texts, fenceMask(texts, fm.closeLine + 1));
  const all = byLine.flatMap((tokens, i) => slices(texts[i], tokens));
  assert.deepEqual(all, [
    ['code', '`## 코드`'],
    ['code', '`#태그아님`'],
  ]);
});

// --- Markdown links and embeds (links.md 2.1) ---

const mdlink = (text: string) => {
  const tokens = findTokens(text).filter((t) => t.kind === 'mdlink');
  assert.equal(tokens.length, 1, text);
  return tokens[0] as Extract<Token, { kind: 'mdlink' }>;
};

test('markdown link: position, text, destination offsets, path and subpath', () => {
  const text = 'see [the note](folder/My%20note.md#Heading) here';
  const link = mdlink(text);
  assert.equal(text.slice(link.start, link.end), '[the note](folder/My%20note.md#Heading)');
  assert.equal(link.text, 'the note');
  assert.equal(link.destination, 'folder/My%20note.md#Heading');
  assert.equal(text.slice(link.destStart, link.destEnd), link.destination);
  assert.deepEqual([link.path, link.subpath, link.embed, link.angle, link.external, link.title], ['folder/My note.md', 'Heading', false, false, false, null]);
});

test('markdown link: block references, nested headings and empty paths', () => {
  assert.deepEqual([mdlink('[x](note.md#^abc)').path, mdlink('[x](note.md#^abc)').subpath], ['note.md', '^abc']);
  assert.equal(mdlink('[x](note#A#B)').subpath, 'A#B');
  assert.deepEqual([mdlink('[x](#Heading)').path, mdlink('[x](#Heading)').subpath], ['', 'Heading']);
  assert.equal(mdlink('[x]()').destination, '');
});

test('markdown embed and angle-bracket destinations', () => {
  const text = 'before ![](images/Pasted image 1.png) ![a](<images/My file (1).png>) after';
  const tokens = findTokens(text).filter((t) => t.kind === 'mdlink');
  // A raw destination cannot contain spaces: the first is not a link.
  assert.equal(tokens.length, 1);
  const embed = tokens[0] as Extract<Token, { kind: 'mdlink' }>;
  assert.equal(text.slice(embed.start, embed.end), '![a](<images/My file (1).png>)');
  assert.deepEqual([embed.embed, embed.angle, embed.destination, embed.path], [true, true, 'images/My file (1).png', 'images/My file (1).png']);
  assert.equal(text.slice(embed.destStart, embed.destEnd), 'images/My file (1).png', 'offsets are inside the angle brackets');
  assert.equal(mdlink('![](img.png)').text, '');
});

test('markdown link: balanced parentheses, titles, nested brackets', () => {
  assert.equal(mdlink('[x](a(b)c.md)').destination, 'a(b)c.md');
  assert.equal(findTokens('[x](a(b.md)').length, 0, 'unbalanced');
  const titled = mdlink('[x](note.md "A title")');
  assert.deepEqual([titled.destination, titled.title], ['note.md', 'A title']);
  assert.equal(mdlink("[x](note.md 'single')").title, 'single');
  assert.equal(mdlink('[a [b] c](note.md)').text, 'a [b] c');
  assert.equal(findTokens('[x](note.md "unclosed)').length, 0);
});

test('markdown link: external links are marked, Windows drives are not schemes', () => {
  for (const url of ['https://example.com/a?b=1#c', 'mailto:a@b.test', 'obsidian://open?vault=x']) assert.equal(mdlink(`[x](${url})`).external, true, url);
  assert.equal(mdlink('[x](C:/notes/a.md)').external, false);
  assert.equal(mdlink('[x](../up/note.md)').external, false);
});

test('markdown link: undecodable percent text stays as written', () => {
  assert.equal(mdlink('[x](100%.md)').path, '100%.md');
  assert.equal(mdlink('[x](%ED%95%9C%EA%B8%80.md)').path, '한글.md');
});

test('markdown link: code spans, escapes and wikilinks take precedence', () => {
  assert.deepEqual(slices('`[x](a.md)` and [y](b.md)'), [['code', '`[x](a.md)`'], ['mdlink', '[y](b.md)']]);
  assert.deepEqual(slices('[a `]` b](c.md)'), [['mdlink', '[a `]` b](c.md)']], 'a ] inside a code span does not close the text');
  assert.deepEqual(findTokens('\\[x](a.md)'), [], 'escaped bracket');
  assert.deepEqual(slices('[[note]](x.md)'), [['wikilink', '[[note]]']]);
  assert.deepEqual(findTokens('[x] (a.md)'), [], 'no space between ] and (');
  assert.deepEqual(findTokens('[x](a.md'), [], 'unclosed');
});
