// Markdown parsing of real task sections (backlog.md 4.5): fixture text keeps every
// character of content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { parseMarkdown } from '../../../src/webview/markdown.ts';
import { taskData } from '../../../src/features/backlog/task-file.ts';
import { assertKeepsContent, blockText } from '../../support/markdown.ts';

const TASKS = new URL('../../fixtures/backlog/project/tasks/', import.meta.url);
const VARIANTS = new URL('../../fixtures/backlog/variants/', import.meta.url);

function sections(dir: URL): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const data = taskData(lineTexts(parseLines(readFileSync(new URL(file, dir), 'utf8'))));
    const texts = [data.description, data.plan, data.notes, data.finalSummary, data.commentsRaw, data.otherBody, ...(data.comments ?? []).map((c) => c.body)];
    texts.forEach((text, i) => {
      if (text !== null && text !== '') out.push({ name: `${file}#${i}`, text });
    });
  }
  return out;
}

test('fixture sections keep every character of content', () => {
  const all = [...sections(TASKS), ...sections(VARIANTS)];
  assert.ok(all.length >= 8);
  for (const { name, text } of all) {
    const blocks = parseMarkdown(text);
    assert.ok(blocks.length > 0, name);
    assertKeepsContent(text, blockText(blocks));
  }
});

test('fixture task-1 description: list, nested list and the fence with a marker inside', () => {
  const data = taskData(lineTexts(parseLines(readFileSync(new URL('task-1 - Set-up-the-build.md', TASKS), 'utf8'))));
  const blocks = parseMarkdown(data.description!);
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'list', 'code']);
  const code = blocks[2];
  assert.ok(code.kind === 'code' && code.lang === 'ts' && code.text.includes('<!-- SECTION:DESCRIPTION:END -->'));
});

test('fixture task-2 description: HTML-like text and the long line are kept verbatim', () => {
  const data = taskData(lineTexts(parseLines(readFileSync(new URL('task-2 - Render-the-board.md', TASKS), 'utf8'))));
  const blocks = parseMarkdown(data.description!);
  assert.deepEqual(blocks, [{ kind: 'paragraph', content: [{ kind: 'text', text: data.description! }] }]);
});
