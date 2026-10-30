// Daily note paths, date input and template insertion (daily-notes.md 4, 5, 9.5, 9.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderTemplate } from '../../../src/core/template.ts';
import { atTimeOf, dailyNotePath, noteTitle, parseDateInput, templateInsertion, templatePath } from '../../../src/features/daily-notes/model.ts';
import { DEFAULT_DAILY_NOTES_SETTINGS } from '../../../src/vault/settings.ts';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/daily-notes/obsidian/${name}`, import.meta.url), 'utf8');
const DAY = new Date(2026, 9, 21, 14, 37);
const settings = (folder: string, format: string) => ({ ...DEFAULT_DAILY_NOTES_SETTINGS, folder, format });

test('daily note paths: folder and format, subfolders from the format, the settings folder kept apart', () => {
  assert.deepEqual(dailyNotePath(DEFAULT_DAILY_NOTES_SETTINGS, DAY), { ok: true, folder: '', path: '2026-10-21.md', title: '2026-10-21' });
  assert.deepEqual(dailyNotePath(settings('Daily', 'YYYY-MM-DD'), DAY), { ok: true, folder: 'Daily', path: 'Daily/2026-10-21.md', title: '2026-10-21' });
  // `title` is Obsidian's `{{title}}`: the whole formatted date, subfolders included.
  assert.deepEqual(dailyNotePath(settings('/Journal/Days/', 'YYYY/MMMM/YYYY-MMM-DD'), DAY), {
    ok: true,
    folder: 'Journal/Days',
    path: 'Journal/Days/2026/October/2026-Oct-21.md',
    title: '2026/October/2026-Oct-21',
  });
  assert.deepEqual(dailyNotePath(settings('', 'YYYY/MM/DD'), DAY), { ok: true, folder: '', path: '2026/10/21.md', title: '2026/10/21' });
  // Obsidian trims the formatted date.
  assert.deepEqual(dailyNotePath(settings('Daily', '[ ]YYYY-MM-DD[ ]'), DAY), { ok: true, folder: 'Daily', path: 'Daily/2026-10-21.md', title: '2026-10-21' });
  assert.deepEqual(dailyNotePath(settings('Daily', 'YYYY/MMMM/DD dddd'), DAY, 'ko'), { ok: true, folder: 'Daily', path: 'Daily/2026/10월/21 수요일.md', title: '2026/10월/21 수요일' });
});

test('daily note paths: unsupported tokens and paths outside the vault or with refused characters', () => {
  assert.deepEqual(dailyNotePath(settings('Daily', 'LL'), DAY), { ok: false, reason: 'format', token: 'LL' });
  for (const [folder, format] of [['../out', 'YYYY'], ['.obsidian', 'YYYY'], ['Daily', 'HH:mm'], ['Daily', '[..]/[..]/YYYY'], ['Daily', 'YYYY/'], ['Daily', '[a?]']]) {
    const result = dailyNotePath(settings(folder!, format!), DAY);
    assert.equal(result.ok ? 'ok' : result.reason, 'path', `${folder} ${format}`);
  }
});

test('template settings, titles, relative day input', () => {
  // As Obsidian looks it up: `.md` added when the path has no extension (after its last dot).
  assert.equal(templatePath('Templates/일일'), 'Templates/일일.md');
  assert.equal(templatePath('/Templates/Day.md'), 'Templates/Day.md');
  assert.equal(templatePath('Templates/Day.txt'), 'Templates/Day.txt');
  assert.equal(templatePath('Templates/v1.'), undefined, 'a name ending in a dot is not a vault path');
  assert.equal(templatePath('../x'), undefined);
  assert.equal(templatePath('/'), undefined);
  assert.equal(noteTitle('Daily/2026-10-21.md'), '2026-10-21');
  assert.equal(noteTitle('a/v1.2 notes.md'), 'v1.2 notes');
  const words = { today: ['today', '오늘'], yesterday: ['yesterday', '어제'], tomorrow: ['tomorrow', '내일'] };
  const day = (text: string) => parseDateInput(text, DAY, words)?.toDateString();
  assert.equal(day('2024-02-29'), new Date(2024, 1, 29).toDateString());
  assert.equal(day(' Yesterday '), new Date(2026, 9, 20).toDateString());
  assert.equal(day('내일'), new Date(2026, 9, 22).toDateString());
  assert.equal(day('today'), new Date(2026, 9, 21).toDateString());
  assert.equal(day('2026-12-31'), new Date(2026, 11, 31).toDateString());
  assert.equal(parseDateInput('2025-02-29', DAY, words), undefined);
  for (const bad of ['', '2026-1-2', '21.10.2026', '2026-13-01', 'later']) assert.equal(parseDateInput(bad, DAY, words), undefined, bad);
  assert.equal(atTimeOf(new Date(2020, 0, 2), DAY).getTime(), new Date(2020, 0, 2, 14, 37).getTime());
});

test('template insertion: frontmatter only at the start of a note without one; never a BOM', () => {
  const template = '\uFEFF---\nd: 1\n---\n\n# Body\n';
  assert.deepEqual(templateInsertion(template, { hasFrontmatter: false, atStart: true }), { text: '---\nd: 1\n---\n\n# Body\n', droppedFrontmatter: false });
  assert.deepEqual(templateInsertion(template, { hasFrontmatter: false, atStart: false }), { text: '\n# Body\n', droppedFrontmatter: true });
  assert.deepEqual(templateInsertion(template, { hasFrontmatter: true, atStart: true }), { text: '\n# Body\n', droppedFrontmatter: true });
  assert.deepEqual(templateInsertion('\uFEFFplain {{x}}', { hasFrontmatter: true, atStart: false }), { text: 'plain {{x}}', droppedFrontmatter: false });
});

test("template over a selection: Obsidian's body, without the frontmatter Obsidian merged (9.5)", () => {
  const note = fixture('루트 노트.md');
  const selected = '같은 이름 시험 ';
  const start = note.indexOf(selected);
  const rendered = renderTemplate(fixture('Templates/일일.md'), { title: '루트 노트', now: DAY, dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' });
  assert.ok(rendered.ok);
  const { text, droppedFrontmatter } = templateInsertion(rendered.text, { hasFrontmatter: false, atStart: false });
  assert.equal(droppedFrontmatter, true);
  const ours = note.slice(0, start) + text + note.slice(start + selected.length);
  // Obsidian put the template's frontmatter on top of the note (re-written as YAML); the rest is the same.
  const obsidian = fixture('results/루트 노트.md');
  assert.equal(obsidian, `---\n날짜: 2026-10-21\n---\n${ours}`);
});
