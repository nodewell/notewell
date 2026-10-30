// Renders real task descriptions (backlog.md 4.5) as the detail view does: only whitelisted
// elements and attributes, and the source text intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { renderMarkdown } from '../../../src/webview/markdown-render.ts';
import { parseMarkdown } from '../../../src/webview/markdown.ts';
import { taskData } from '../../../src/features/backlog/task-file.ts';
import { FakeElement, fakeDocument as doc } from '../../support/markdown.ts';

const render = (source: string) => renderMarkdown(doc, parseMarkdown(source), { headingOffset: 2 });
const TASKS = new URL('../../fixtures/backlog/project/tasks/', import.meta.url);
const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'input', 'blockquote', 'pre', 'code', 'hr', 'br', 'strong', 'em', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ALLOWED_ATTRS = new Set(['role', 'tabindex', 'data-action', 'data-url', 'data-lang', 'title', 'type', 'disabled', 'checked', 'start', 'scope', 'dir']);

function assertSafe(root: FakeElement): void {
  for (const element of root.walk()) {
    assert.ok(ALLOWED_TAGS.has(element.tagName), element.tagName);
    for (const attr of element.attrs.keys()) {
      assert.ok(ALLOWED_ATTRS.has(attr) && !attr.startsWith('on'), attr);
    }
  }
}

function fixtureDescriptions(): { name: string; text: string }[] {
  return readdirSync(TASKS)
    .filter((n) => n.endsWith('.md'))
    .map((name) => ({ name, text: taskData(lineTexts(parseLines(readFileSync(new URL(name, TASKS), 'utf8')))).description ?? '' }));
}

test('fixture descriptions render safely and with their text intact', () => {
  for (const { name, text } of fixtureDescriptions()) {
    const root = render(text);
    assertSafe(root);
    if (text !== '') assert.ok(root.textContent!.length > 0, name);
  }
  const task2 = fixtureDescriptions().find((d) => d.name.startsWith('task-2 '))!;
  const root = render(task2.text);
  assert.equal(root.textContent, task2.text);
  assert.ok(root.textContent!.includes('<b>HTML-like</b> text & symbols: < > " \''));
  assert.ok(root.textContent!.includes(`${'x'.repeat(300)}`));
  assert.equal(root.find((e) => e.tagName === 'b').length, 0);

  const task1 = fixtureDescriptions().find((d) => d.name.startsWith('task-1 '))!;
  const code = render(task1.text).find((e) => e.tagName === 'code' && !e.classes.has('md-code-span'));
  assert.deepEqual(code.map((c) => c.textContent), ['const answer = 42; // <!-- SECTION:DESCRIPTION:END --> inside a fence']);
});
