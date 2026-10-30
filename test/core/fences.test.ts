import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fenceMask, findFences } from '../../src/core/fences.ts';
import { findFrontmatter } from '../../src/core/frontmatter.ts';
import { lineTexts, parseLines } from '../../src/core/lines.ts';

function fixtureTexts(name: string): string[] {
  const source = readFileSync(new URL(`../fixtures/kanban/${name}`, import.meta.url), 'utf8');
  return lineTexts(parseLines(source));
}

test('backtick fence', () => {
  const texts = ['a', '```', '## x', '```', 'b'];
  assert.deepEqual(findFences(texts), [{ open: 1, close: 3, last: 3, marker: '`', length: 3, indent: '' }]);
  assert.deepEqual(fenceMask(texts), [false, true, true, true, false]);
});

test('tilde fence with info string', () => {
  const texts = ['~~~js', '- [ ] x', '~~~'];
  assert.deepEqual(findFences(texts), [{ open: 0, close: 2, last: 2, marker: '~', length: 3, indent: '' }]);
});

test('indented fence keeps its indent; closer may be indented differently', () => {
  const texts = ['- [ ] card', '\t```', '\t## x', '    ```'];
  assert.deepEqual(findFences(texts), [{ open: 1, close: 3, last: 3, marker: '`', length: 3, indent: '\t' }]);
});

test('closing needs the same character', () => {
  const texts = ['```', '~~~', '## x', '```'];
  assert.deepEqual(
    findFences(texts).map((b) => [b.open, b.close]),
    [[0, 3]],
  );
  const tilde = ['~~~', '```', '~~~'];
  assert.deepEqual(
    findFences(tilde).map((b) => [b.open, b.close]),
    [[0, 2]],
  );
});

test('closing run must be at least as long and have nothing else', () => {
  const texts = ['````', '```', '``` x', '`````', 'after'];
  assert.deepEqual(
    findFences(texts).map((b) => [b.open, b.close]),
    [[0, 3]],
  );
  assert.deepEqual(fenceMask(texts), [true, true, true, true, false]);
});

test('closer may have trailing whitespace', () => {
  assert.equal(findFences(['```', 'x', '```  '])[0]?.close, 2);
});

test('unclosed fence runs to the end', () => {
  const texts = ['a', '```', '## x', '', '- [ ] y'];
  assert.deepEqual(findFences(texts), [{ open: 1, close: null, last: 4, marker: '`', length: 3, indent: '' }]);
  assert.deepEqual(fenceMask(texts), [false, true, true, true, true]);
});

test('unclosed fence runs to the given end only', () => {
  const texts = ['```', 'x', '%% kanban:settings', '%%'];
  assert.deepEqual(findFences(texts, 0, 2), [{ open: 0, close: null, last: 1, marker: '`', length: 3, indent: '' }]);
  assert.deepEqual(fenceMask(texts, 0, 2), [true, true, false, false]);
});

test('scan can start after the frontmatter', () => {
  const texts = ['---', '```', '---', 'a'];
  assert.equal(findFences(texts).length, 1);
  const fm = findFrontmatter(texts);
  assert.ok(fm);
  assert.deepEqual(findFences(texts, fm.closeLine + 1), []);
});

test('not fences: short runs, inline code, backtick in info string', () => {
  assert.deepEqual(findFences(['``', '`code`', '```js```', 'text ```', '```a`b']), []);
});

test('tilde info string may contain backticks', () => {
  assert.equal(findFences(['~~~ a`b', '~~~']).length, 1);
});

test('consecutive fences', () => {
  const texts = ['```', 'a', '```', '~~~', 'b', '~~~'];
  assert.deepEqual(
    findFences(texts).map((b) => [b.open, b.close]),
    [
      [0, 2],
      [3, 5],
    ],
  );
});

test('fixture 13: structure-like lines inside fences are masked', () => {
  const texts = fixtureTexts('13-code-fences.md');
  const fm = findFrontmatter(texts);
  assert.ok(fm);
  const blocks = findFences(texts, fm.closeLine + 1);
  assert.deepEqual(
    blocks.map((b) => [b.marker, b.indent, b.close === null]),
    [
      ['`', '\t', false],
      ['~', '\t', false],
      ['`', '\t', true],
    ],
  );
  const mask = fenceMask(texts, fm.closeLine + 1);
  const at = (text: string): boolean => mask[texts.indexOf(text)] === true;
  assert.equal(at('\t## 이건 열이 아님'), true);
  assert.equal(at('\t- [ ] 이건 카드가 아님'), true);
  assert.equal(at('\t***'), true);
  assert.equal(at('\t%% kanban:settings'), true);
  assert.equal(at('\tconst a = "## x";'), true);
  assert.equal(at('\t계속 이어짐'), true);
  assert.equal(mask[texts.length - 1], true);
  // The blank line inside the first fence is masked too.
  const first = blocks[0];
  assert.ok(first && first.close !== null);
  assert.ok(texts.slice(first.open, first.close).includes(''));
  // Structure outside fences is not masked.
  assert.equal(at('## 할 일'), false);
  assert.equal(at('## 끝'), false);
  assert.equal(at('- [ ] 인라인 `## 코드` 와 `#태그아님`'), false);
  assert.equal(at('- [ ] 닫히지 않은 펜스'), false);
});
