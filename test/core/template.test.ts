// Template variables (daily-notes.md 5.2) against what Obsidian wrote (test/fixtures/daily-notes/obsidian/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOM } from '../../src/core/lines.ts';
import { renderTemplate, splitFrontmatter } from '../../src/core/template.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/daily-notes/obsidian/${name}`, import.meta.url), 'utf8');
const NOW = new Date(2026, 9, 21, 14, 37, 5);
const values = (title: string) => ({ title, now: NOW, dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' });

test("daily notes: the template gives Obsidian's file byte for byte", () => {
  const template = fixture('Templates/일일.md');
  assert.deepEqual(renderTemplate(template, values('2026-10-21')), { ok: true, text: fixture('results/Daily/2026-10-21.md') });
  const korean = '2026년 10월 21일 수요일';
  assert.deepEqual(renderTemplate(template, values(korean)), { ok: true, text: fixture(`results/Daily/${korean}.md`) });
});

test('variables: title, date and time with the set or written formats; others stay', () => {
  const text = '{{title}} {{date}} {{time}} {{date:dddd, MMMM Do}} {{time:h:mm A}} {{date:[week] W}}';
  assert.deepEqual(renderTemplate(text, { ...values('Note'), dateFormat: 'DD.MM.YYYY', timeFormat: 'HH:mm:ss' }), {
    ok: true,
    text: 'Note 21.10.2026 14:37:05 Wednesday, October 21st 2:37 PM week 43',
  });
  const kept = '{{ date }} {{ title }} {{title:x}} {{tp.date.now()}} <% tp.file.title %> {{query}} {date} {{date';
  assert.deepEqual(renderTemplate(kept, values('Note')), { ok: true, text: kept });
  // Replacement text is not read again, and `$` in a title is not a pattern.
  assert.deepEqual(renderTemplate('{{title}}', values('$& {{date}}')), { ok: true, text: '$& {{date}}' });
});

test('names in any case and an empty format, as Obsidian 1.14 replaces them', () => {
  // Measured: `{{DATE}} / {{Title}} / {{TIME}}` and `[{{date:}}] [{{time:}}]` in a daily note template.
  const text = '{{DATE}} / {{Title}} / {{TIME}} [{{date:}}] [{{time:}}] {{Date:YYYY}}';
  assert.deepEqual(renderTemplate(text, { ...values('Note'), dateFormat: 'DD.MM.YYYY' }), {
    ok: true,
    text: '21.10.2026 / Note / 14:37 [21.10.2026] [14:37] 2026',
  });
});

test('month and weekday names in Korean', () => {
  assert.deepEqual(renderTemplate('{{date:YYYY년 MMMM Do dddd A}}', { ...values('T'), locale: 'ko' }), { ok: true, text: '2026년 10월 21일 수요일 오후' });
  assert.deepEqual(renderTemplate('{{date:dddd}}', values('T')), { ok: true, text: 'Wednesday' });
});

test('line endings, BOM and other bytes are kept', () => {
  const text = `${BOM}---\r\nd: "{{date}}"\r\n---\r\n# {{title}}\r\n\ttab  \r\nno end`;
  assert.deepEqual(renderTemplate(text, values('T')), { ok: true, text: `${BOM}---\r\nd: "2026-10-21"\r\n---\r\n# T\r\n\ttab  \r\nno end` });
});

test('an unsupported format refuses the whole template', () => {
  assert.deepEqual(renderTemplate('{{date}} {{date:LL}}', values('T')), { ok: false, format: 'LL', token: 'LL' });
  assert.deepEqual(renderTemplate('{{time}}', { ...values('T'), timeFormat: 'HH:mm:ss.SSS' }), { ok: false, format: 'HH:mm:ss.SSS', token: 'SSS' });
});

test('frontmatter split: through the closing line, BOM in front, body as written', () => {
  assert.deepEqual(splitFrontmatter('---\na: 1\n---\n\n# Body\n'), { frontmatter: '---\na: 1\n---\n', body: '\n# Body\n' });
  assert.deepEqual(splitFrontmatter(`${BOM}---\r\na: 1\r\n---\r\nx`), { frontmatter: `${BOM}---\r\na: 1\r\n---\r\n`, body: 'x' });
  assert.deepEqual(splitFrontmatter('---\na: 1\n---'), { frontmatter: '---\na: 1\n---', body: '' });
  for (const text of ['# No\n---\n', '---\nunclosed\n', '', 'x']) assert.deepEqual(splitFrontmatter(text), { frontmatter: null, body: text });
});
