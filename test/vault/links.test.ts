// Link target resolution (links.md 2.2): names, paths, relative Markdown links, NFC and case,
// excluded folders, and duplicates reported instead of guessed (10 #4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAmongDuplicates, comparable, resolveLink, type LinkResolution } from '../../src/vault/links.ts';

const FILES = [
  'Home.md',
  'notes/노트.md',
  'notes/Project Plan.md',
  'notes/deep/Leaf.md',
  'archive/Leaf.md',
  'v1.2.md',
  'images/diagram.png',
  'images/Pasted image 20240101.png',
  '.obsidian/workspace.md',
  '.trash/Deleted.md',
];
const wiki = (path: string, from = 'Home.md') => resolveLink({ form: 'wikilink', path }, FILES, from);
const md = (path: string, from = 'Home.md') => resolveLink({ form: 'markdown', path }, FILES, from);
const found = (path: string): LinkResolution => ({ kind: 'found', path });
const MISSING: LinkResolution = { kind: 'missing' };

test('wikilinks: by file name anywhere, .md added, case-insensitive', () => {
  assert.deepEqual(wiki('home'), found('Home.md'));
  assert.deepEqual(wiki('Project Plan'), found('notes/Project Plan.md'));
  assert.deepEqual(wiki('project plan.md'), found('notes/Project Plan.md'));
  assert.deepEqual(wiki('v1.2'), found('v1.2.md'), 'a dot in the name is not an extension when the .md exists');
  assert.deepEqual(wiki('diagram.png'), found('images/diagram.png'), 'attachments keep their extension');
  assert.deepEqual(wiki('Nothing'), MISSING);
  assert.deepEqual(wiki('lan'), MISSING, 'no partial names');
});

test('wikilinks: subpaths are cut; an empty path is missing (same note)', () => {
  assert.deepEqual(wiki('Home#Section'), found('Home.md'));
  assert.deepEqual(wiki('Home#^abc'), found('Home.md'));
  assert.deepEqual(wiki('#Section'), MISSING);
  assert.deepEqual(wiki('   '), MISSING);
});

test('paths with / match from the vault root or as a trailing path', () => {
  assert.deepEqual(wiki('notes/deep/Leaf'), found('notes/deep/Leaf.md'));
  assert.deepEqual(wiki('deep/Leaf'), found('notes/deep/Leaf.md'));
  assert.deepEqual(wiki('/archive/Leaf'), found('archive/Leaf.md'));
  assert.deepEqual(wiki('eep/Leaf'), MISSING, 'trailing match starts at a separator');
});

test('Unicode: NFC and NFD names compare equal', () => {
  const nfd = '노트'.normalize('NFD');
  assert.notEqual(nfd, '노트');
  assert.deepEqual(wiki(nfd), found('notes/노트.md'));
  assert.deepEqual(resolveLink({ form: 'wikilink', path: '노트' }, [`notes/${nfd}.md`], 'Home.md'), found(`notes/${nfd}.md`), 'NFD file names on disk');
  const combining = `A${String.fromCharCode(0x0308)}B`; // A + combining diaeresis (NFD)
  assert.equal(comparable(combining), comparable('äb'));
});

test('markdown links: ./ and ../ are relative to the linking file', () => {
  assert.deepEqual(md('./deep/Leaf.md', 'notes/Project Plan.md'), found('notes/deep/Leaf.md'));
  assert.deepEqual(md('../archive/Leaf.md', 'notes/노트.md'), found('archive/Leaf.md'));
  assert.deepEqual(md('../images/Pasted image 20240101.png', 'notes/노트.md'), found('images/Pasted image 20240101.png'));
  assert.deepEqual(md('./Leaf.md', 'Home.md'), MISSING, 'relative means relative: no fallback to the name');
  assert.deepEqual(md('../../Home.md', 'notes/노트.md'), MISSING, 'leaving the vault');
});

test('markdown links: vault-root path first, then by name', () => {
  assert.deepEqual(md('notes/Project Plan.md'), found('notes/Project Plan.md'));
  assert.deepEqual(md('/notes/Project Plan.md'), found('notes/Project Plan.md'));
  assert.deepEqual(md('Project Plan.md'), found('notes/Project Plan.md'), 'no root match: by file name');
  assert.deepEqual(md('Project Plan'), found('notes/Project Plan.md'), 'extensionless: .md added');
});

test('.obsidian/ and .trash/ are never targets', () => {
  assert.deepEqual(wiki('workspace'), MISSING);
  assert.deepEqual(wiki('Deleted'), MISSING);
  assert.deepEqual(md('.trash/Deleted.md'), MISSING);
});

test('duplicate names: the vault-root file, else the linking folder, else reported (links.md 2.2)', () => {
  // As Obsidian 1.12 resolved [[회의]] with 회의.md, Notes/회의.md and Archive/2025/회의.md (2026-10-21).
  assert.deepEqual(wiki('Leaf'), { kind: 'ambiguous', paths: ['archive/Leaf.md', 'notes/deep/Leaf.md'] }, 'no rule picks one');
  assert.deepEqual(wiki('Leaf', 'notes/deep/Other.md'), found('notes/deep/Leaf.md'), 'the linking folder');
  assert.deepEqual(wiki('Leaf', 'archive/Other.md'), found('archive/Leaf.md'));
  assert.deepEqual(wiki('Leaf', 'notes/Other.md'), { kind: 'ambiguous', paths: ['archive/Leaf.md', 'notes/deep/Leaf.md'] }, 'a parent folder is not the same folder');
  assert.deepEqual(wiki('notes/deep/Leaf'), found('notes/deep/Leaf.md'), 'a path that fits one file is not ambiguous');
  const withRoot = [...FILES, 'Leaf.md'];
  assert.deepEqual(resolveLink({ form: 'wikilink', path: 'Leaf' }, withRoot, 'notes/deep/Other.md'), found('Leaf.md'), 'the vault-root file wins over the same folder');
  assert.deepEqual(resolveLink({ form: 'wikilink', path: 'leaf' }, withRoot, 'archive/x.md'), found('Leaf.md'), 'compared ignoring case');
  assert.deepEqual(resolveLink({ form: 'wikilink', path: 'deep/Leaf' }, [...FILES, 'deep/Leaf.md'], 'Home.md'), found('deep/Leaf.md'), 'a path spelled from the root');
  assert.deepEqual(chooseAmongDuplicates([], 'x.md'), MISSING);
  assert.deepEqual(chooseAmongDuplicates(['a.md'], 'x.md'), found('a.md'));
  assert.deepEqual(chooseAmongDuplicates(['b/n.md', 'a/n.md'], 'x.md'), { kind: 'ambiguous', paths: ['a/n.md', 'b/n.md'] });
  assert.deepEqual(chooseAmongDuplicates(['b/n.md', 'a/n.md'], 'a/x.md'), found('a/n.md'));
});

test('Windows separators in the written path are accepted', () => {
  assert.deepEqual(wiki('notes\\deep\\Leaf'), found('notes/deep/Leaf.md'));
});
