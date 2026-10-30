// Attachment location, names and links (links.md 4): pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentFolder,
  attachmentLink,
  attachmentPath,
  CONFIRM_BYTES,
  encodeLinkPath,
  imageExtension,
  pastedImageName,
  safeFileName,
  uniqueName,
  uriListEntries,
} from '../../../src/features/attachments/attachments.ts';

test('folder from attachmentFolderPath (links.md 4.2)', () => {
  const note = 'notes/day/today.md';
  assert.equal(attachmentFolder('', note), '');
  assert.equal(attachmentFolder('/', note), '');
  assert.equal(attachmentFolder('./', note), 'notes/day');
  assert.equal(attachmentFolder('.', note), 'notes/day');
  assert.equal(attachmentFolder('./assets', note), 'notes/day/assets');
  assert.equal(attachmentFolder('./assets/img/', note), 'notes/day/assets/img');
  assert.equal(attachmentFolder('attachments', note), 'attachments');
  assert.equal(attachmentFolder('/files/img', note), 'files/img');
  assert.equal(attachmentFolder('files\\img', note), 'files/img');
  assert.equal(attachmentFolder('./', 'root.md'), '');
  assert.equal(attachmentFolder('./a', 'root.md'), 'a');
});

test('folders outside the vault are refused', () => {
  for (const bad of ['../outside', 'a/../../x', './../../x', 'C:/Windows', 'C:\\x', '\\\\server\\share', '//server/share', 'file:///etc', 'x/.. /y', 'x/. /y']) {
    assert.equal(attachmentFolder(bad, 'notes/n.md'), undefined, bad);
  }
  assert.equal(attachmentFolder('./..', 'notes/n.md'), '', 'the note folder parent is still the vault');
  assert.equal(attachmentFolder('./../..', 'notes/n.md'), undefined);
});

test('the VS Code override wins when set', () => {
  assert.equal(attachmentFolder('/', 'n/x.md', './img'), 'n/img');
  assert.equal(attachmentFolder('assets', 'n/x.md', '  '), 'assets');
  assert.equal(attachmentFolder('assets', 'n/x.md', '../out'), undefined);
});

test('names: pasted images, unsafe characters, duplicates', () => {
  assert.equal(pastedImageName(new Date(2024, 4, 7, 22, 27, 46), 'png'), 'Pasted image 20240507222746.png');
  assert.equal(imageExtension('image/PNG'), 'png');
  assert.equal(imageExtension('image/jpeg'), 'jpg');
  assert.equal(imageExtension('application/pdf'), undefined);
  assert.equal(safeFileName('report: final?.pdf'), 'report- final-.pdf');
  assert.equal(safeFileName('dir/sub\\name.png'), 'name.png');
  assert.equal(safeFileName('trailing. . '), 'trailing');
  assert.equal(safeFileName('..'), undefined);
  assert.equal(safeFileName('한국어 파일.png'), '한국어 파일.png');
  const taken = new Set(['a.png', 'a 1.png', 'noext']);
  assert.equal(uniqueName('b.png', (n) => taken.has(n)), 'b.png');
  assert.equal(uniqueName('a.png', (n) => taken.has(n)), 'a 2.png');
  assert.equal(uniqueName('noext', (n) => taken.has(n)), 'noext 1');
  assert.equal(uniqueName('.hidden', () => false), '.hidden');
  assert.equal(attachmentPath('', 'x.png'), 'x.png');
  assert.equal(attachmentPath('a/b', 'x.png'), 'a/b/x.png');
  assert.equal(CONFIRM_BYTES, 50 * 1024 * 1024);
});

test('links per useMarkdownLinks and newLinkFormat (links.md 4.4)', () => {
  const wiki = { useMarkdownLinks: false, newLinkFormat: 'shortest' } as const;
  const md = { useMarkdownLinks: true, newLinkFormat: 'shortest' } as const;
  const note = 'notes/day/today.md';
  const file = 'assets/Pasted image 1.png';
  assert.equal(attachmentLink(wiki, note, file, [file]), '![[Pasted image 1.png]]');
  assert.equal(attachmentLink(wiki, note, file, [file, 'other/Pasted Image 1.png']), '![[assets/Pasted image 1.png]]', 'not unique (case-insensitive): full path');
  assert.equal(attachmentLink(md, note, file, [file]), '![](Pasted%20image%201.png)');
  assert.equal(attachmentLink({ ...wiki, newLinkFormat: 'relative' }, note, file, []), '![[../../assets/Pasted image 1.png]]');
  assert.equal(attachmentLink({ ...md, newLinkFormat: 'relative' }, note, 'notes/day/img/x (1).png', []), '![](./img/x%20%281%29.png)');
  assert.equal(attachmentLink({ ...md, newLinkFormat: 'absolute' }, note, file, []), '![](assets/Pasted%20image%201.png)');
  assert.equal(attachmentLink({ ...wiki, newLinkFormat: 'relative' }, 'root.md', 'x.pdf', []), '![[./x.pdf]]');
  assert.equal(encodeLinkPath('100% <done>.png'), '100%25%20%3Cdone%3E.png');
  assert.equal(encodeLinkPath('한국어.png'), '한국어.png');
});

test('uriListEntries: one URI per line, CRLF or LF, comments and blank lines dropped', () => {
  assert.deepEqual(uriListEntries('# from Explorer\r\nfile:///c:/a.png\r\n\r\n  file:///c:/b%20c.pdf  \nhttps://x.test/y\n'), ['file:///c:/a.png', 'file:///c:/b%20c.pdf', 'https://x.test/y']);
  assert.deepEqual(uriListEntries(''), []);
});

test('case 20: names that would leave the folder or break a link are made safe', () => {
  assert.equal(safeFileName('..\\..\\evil.png'), 'evil.png');
  assert.equal(safeFileName('a/../../x.png'), 'x.png');
  assert.equal(safeFileName('../'), undefined);
  assert.equal(safeFileName('a#b^c[1]|d.png'), 'a-b-c-1--d.png', 'no subpath, block, bracket or alias characters');
  assert.equal(safeFileName('  lead.png'), 'lead.png', 'no leading spaces (a link would trim them)');
  assert.equal(encodeLinkPath('a#b?.png'), 'a%23b%3F.png');
});

test('case 20: a vault file whose name breaks a wikilink is embedded as a Markdown link', () => {
  const wiki = { useMarkdownLinks: false, newLinkFormat: 'shortest' } as const;
  assert.equal(attachmentLink(wiki, 'n.md', 'img/a#1.png', []), '![](a%231.png)');
  assert.equal(attachmentLink(wiki, 'n.md', 'img/[x].png', []), '![](%5Bx%5D.png)');
  assert.equal(attachmentLink(wiki, 'n.md', 'img/a|b.png', []), '![](a%7Cb.png)');
});

test('round 3 case 2: attachments never go into .obsidian/ or another dot-folder', () => {
  for (const setting of ['.obsidian', '.obsidian/img', './.trash', 'a/.git/x', '.hidden']) {
    assert.equal(attachmentFolder(setting, 'notes/n.md'), undefined, setting);
    assert.equal(attachmentFolder('', 'notes/n.md', setting), undefined, `override ${setting}`);
  }
  assert.equal(attachmentFolder('./', '.trash/n.md'), undefined, 'a note inside a dot-folder');
  assert.equal(attachmentFolder('assets', 'notes/n.md'), 'assets');
  assert.equal(attachmentFolder('my.assets', 'notes/n.md'), 'my.assets', 'a dot inside a name is fine');
});

test('round 7 case 4: every inserted embed names the attachment, also in folders with #, % or [ ]', async () => {
  const { extractLinks } = await import('../../../src/vault/link-index.ts');
  const { LinkResolver } = await import('../../../src/vault/links.ts');
  const notes = ['my#notes/day.md', '100%/n.md', '[draft]/n.md', 'a b/c d/n.md', 'n.md'];
  const files = ['my#notes/img 1.png', '100%/img.png', '[draft]/x.png', 'assets/p#1.png', 'a b/c d/pic (1).png', 'other/img 1.png'];
  const resolver = new LinkResolver([...files, ...notes]);
  for (const useMarkdownLinks of [false, true]) {
    for (const newLinkFormat of ['shortest', 'relative', 'absolute'] as const) {
      for (const note of notes) {
        for (const file of files) {
          const link = attachmentLink({ useMarkdownLinks, newLinkFormat }, note, file, files);
          const [ref] = extractLinks(link);
          assert.ok(ref !== undefined, `${link} is a link`);
          const resolved = resolver.resolve(ref, note);
          assert.deepEqual(resolved, { kind: 'found', path: file }, `${newLinkFormat}/${useMarkdownLinks ? 'md' : 'wiki'} ${note} -> ${file}: ${link}`);
        }
      }
    }
  }
});

test('fuzz: embeds for random folder and file names always name the attachment', async () => {
  const { extractLinks } = await import('../../../src/vault/link-index.ts');
  const { LinkResolver } = await import('../../../src/vault/links.ts');
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const PIECES = ['a', 'B', ' ', '.', '#', '%', '[', ']', '(', ')', '^', '+', '&', "'", '~', '-', '_', '한', '가'.normalize('NFD'), 'é', '😀', '1', 'md'];
  const name = (n: number) => Array.from({ length: n }, () => PIECES[Math.floor(rand() * PIECES.length)]).join('');
  for (let round = 0; round < 400; round++) {
    const folders = Array.from({ length: 3 }, () => name(1 + Math.floor(rand() * 5)).replace(/^[. ]+|[. ]+$/g, '') || 'f');
    const noteFolder = folders.slice(0, Math.floor(rand() * 3)).join('/');
    const fileFolder = folders.slice(0, Math.floor(rand() * 3)).reverse().join('/');
    const safe = safeFileName(`${name(1 + Math.floor(rand() * 6))}.png`);
    if (safe === undefined) continue;
    const note = `${noteFolder ? `${noteFolder}/` : ''}n.md`;
    const file = `${fileFolder ? `${fileFolder}/` : ''}${safe}`;
    const files = [file, note, `other/${safe}`];
    const resolver = new LinkResolver(files);
    for (const useMarkdownLinks of [false, true]) {
      for (const newLinkFormat of ['shortest', 'relative', 'absolute'] as const) {
        const link = attachmentLink({ useMarkdownLinks, newLinkFormat }, note, file, files);
        const [ref] = extractLinks(link);
        const label = `${newLinkFormat}/${useMarkdownLinks ? 'md' : 'wiki'} ${note} -> ${file}: ${link}`;
        assert.ok(ref !== undefined && extractLinks(link).length === 1, `one link: ${label}`);
        assert.deepEqual(resolver.resolve(ref, note), { kind: 'found', path: file }, label);
      }
    }
  }
});
