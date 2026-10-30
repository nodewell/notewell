import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findFrontmatter, frontmatterHasKey } from '../../src/core/frontmatter.ts';
import { lineTexts, parseLines } from '../../src/core/lines.ts';

function fixtureTexts(name: string): string[] {
  const source = readFileSync(new URL(`../fixtures/kanban/${name}`, import.meta.url), 'utf8');
  return lineTexts(parseLines(source));
}

test('frontmatter between first line and next ---', () => {
  const texts = ['---', 'kanban-plugin: basic', '---', '', '## a'];
  assert.deepEqual(findFrontmatter(texts), { openLine: 0, closeLine: 2 });
});

test('delimiters may have surrounding whitespace', () => {
  assert.deepEqual(findFrontmatter([' ---\t', 'a: 1', '---  ']), { openLine: 0, closeLine: 2 });
  assert.deepEqual(findFrontmatter(['---', 'a: 1', '---\t ']), { openLine: 0, closeLine: 2 });
});

test('an indented --- is part of a YAML value, not the closing line', () => {
  const texts = ['---', 'id: TASK-1', 'notes: |', '  first', '  ---', '  after the rule', 'status: To Do', '---', '', 'body'];
  assert.deepEqual(findFrontmatter(texts), { openLine: 0, closeLine: 7 });
  assert.deepEqual(findFrontmatter(['---', 'a: |', '\t---', 'b: 1', '---']), { openLine: 0, closeLine: 4 });
  assert.equal(findFrontmatter(['---', 'a: |', '  ---', 'b: 1']), null, 'only indented rules: never closed');
  assert.equal(frontmatterHasKey(texts, findFrontmatter(texts)!, 'status'), true);
});

test('empty frontmatter', () => {
  assert.deepEqual(findFrontmatter(['---', '---']), { openLine: 0, closeLine: 1 });
});

test('no closing --- means no frontmatter', () => {
  assert.equal(findFrontmatter(['---', 'kanban-plugin: basic', '', '## a']), null);
  assert.equal(findFrontmatter(['---']), null);
});

test('first line must be ---', () => {
  assert.equal(findFrontmatter([]), null);
  assert.equal(findFrontmatter(['', '---', 'a: 1', '---']), null);
  assert.equal(findFrontmatter(['----', 'a: 1', '---']), null);
  assert.equal(findFrontmatter(['--- x', 'a: 1', '---']), null);
});

test('key check is line based and ignores the value', () => {
  const texts = ['---', 'title: x', 'kanban-plugin: board', 'empty:', 'spaced : 1', '---', 'after: 1'];
  const fm = findFrontmatter(texts);
  assert.ok(fm);
  assert.equal(frontmatterHasKey(texts, fm, 'kanban-plugin'), true);
  assert.equal(frontmatterHasKey(texts, fm, 'empty'), true);
  assert.equal(frontmatterHasKey(texts, fm, 'spaced'), true);
  assert.equal(frontmatterHasKey(texts, fm, 'after'), false);
  assert.equal(frontmatterHasKey(texts, fm, 'kanban'), false);
  assert.equal(frontmatterHasKey(texts, fm, 'title: x'), false);
});

test('key check requires a top-level key', () => {
  const texts = ['---', 'parent:', '  kanban-plugin: basic', '# kanban-plugin: basic', '---'];
  const fm = findFrontmatter(texts);
  assert.ok(fm);
  assert.equal(frontmatterHasKey(texts, fm, 'kanban-plugin'), false);
  assert.equal(frontmatterHasKey(texts, fm, 'parent'), true);
});

test('fixture 01: blank lines inside frontmatter', () => {
  const texts = fixtureTexts('01-workspace-style.md');
  const fm = findFrontmatter(texts);
  assert.ok(fm);
  assert.equal(frontmatterHasKey(texts, fm, 'kanban-plugin'), true);
  assert.ok(texts.slice(fm.openLine + 1, fm.closeLine).includes(''));
});

test('fixture 09: malformed YAML still has the key', () => {
  const texts = fixtureTexts('09-malformed-frontmatter.md');
  const fm = findFrontmatter(texts);
  assert.deepEqual(fm, { openLine: 0, closeLine: 4 });
  assert.equal(frontmatterHasKey(texts, fm, 'kanban-plugin'), true);
});

test('fixture 10: unclosed frontmatter is no frontmatter', () => {
  assert.equal(findFrontmatter(fixtureTexts('10-unclosed-frontmatter.md')), null);
});

test('fixture 07: no frontmatter', () => {
  assert.equal(findFrontmatter(fixtureTexts('07-no-frontmatter.md')), null);
});

test('fixtures 21, 22, 24: CRLF, BOM and mixed EOL do not affect detection', () => {
  for (const name of ['21-crlf.md', '22-bom.md', '24-mixed-eol.md']) {
    const texts = fixtureTexts(name);
    const fm = findFrontmatter(texts);
    assert.deepEqual(fm, { openLine: 0, closeLine: 2 }, name);
    assert.equal(frontmatterHasKey(texts, fm, 'kanban-plugin'), true, name);
  }
});
