// Daily note paths, date input and template insertion (daily-notes.md 4, 5). Pure.
import { formatDate, type DateLocale } from '../../core/date-format.ts';
import { splitFrontmatter } from '../../core/template.ts';
import { BOM } from '../../core/lines.ts';
import type { DailyNotesSettings } from '../../vault/settings.ts';
import { vaultPath } from '../../vault/new-file.ts';

export type DailyNotePath =
  /**
   * `folder` is the settings folder (must exist, as in Obsidian); `path` the note, maybe in
   * subfolders of it; `title` the formatted date, subfolders included: Obsidian's `{{title}}`.
   */
  | { readonly ok: true; readonly folder: string; readonly path: string; readonly title: string }
  /** The date format has a Moment token Notewell does not support (daily-notes.md 3). */
  | { readonly ok: false; readonly reason: 'format'; readonly token: string }
  /** The folder or the formatted name is not a file name inside the vault (4.2, 8). */
  | { readonly ok: false; readonly reason: 'path'; readonly path: string };

/** `<folder>/<format(date)>.md`; a `/` in the formatted date makes subfolders (4.2). */
export function dailyNotePath(settings: DailyNotesSettings, date: Date, locale: DateLocale = 'en'): DailyNotePath {
  const formatted = formatDate(date, settings.format, locale);
  if (!formatted.ok) return { ok: false, reason: 'format', token: formatted.token };
  // Obsidian trims the formatted date and uses it as the name and as `{{title}}` (1.14, measured).
  const name = formatted.text.trim();
  const written = `${settings.folder}/${name}.md`;
  const folder = vaultPath(settings.folder);
  const path = vaultPath(written);
  if (folder === undefined || path === undefined || !(folder === '' || path.startsWith(`${folder}/`)) || path.endsWith('/.md')) {
    return { ok: false, reason: 'path', path: written };
  }
  return { ok: true, folder, path, title: name };
}

/**
 * The note a template setting names, as Obsidian looks it up: `.md` is added when the path has
 * no extension (Obsidian reads the extension after the last dot of the whole path).
 */
export function templatePath(template: string): string | undefined {
  const path = vaultPath(template);
  if (path === undefined || path === '') return undefined;
  const dot = path.lastIndexOf('.');
  return dot <= 0 || dot === path.length - 1 ? `${path}.md` : path;
}

/** File name without its extension: the `{{title}}` of a note. */
export function noteTitle(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Words for relative days in the date prompt (English always works, plus the UI language). */
export interface DateWords {
  readonly today: readonly string[];
  readonly yesterday: readonly string[];
  readonly tomorrow: readonly string[];
}

/** A day typed in the "Open daily note for date" prompt (9.6): `YYYY-MM-DD` or a relative word. */
export function parseDateInput(text: string, today: Date, words: DateWords): Date | undefined {
  const input = text.trim().toLowerCase();
  const day = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  if (words.today.some((w) => w.toLowerCase() === input)) return day(0);
  if (words.yesterday.some((w) => w.toLowerCase() === input)) return day(-1);
  if (words.tomorrow.some((w) => w.toLowerCase() === input)) return day(1);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (match === null) return undefined;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const result = new Date(year, month - 1, date);
  result.setFullYear(year);
  return result.getFullYear() === year && result.getMonth() === month - 1 && result.getDate() === date ? result : undefined;
}

/** `date` at the time of day of `now`: `{{time}}` in a note for another day is still the current time. */
export function atTimeOf(date: Date, now: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
}

/**
 * The text Insert Template puts at the cursor (5.2, 9.5): a template's frontmatter goes in only
 * when the note has none and the insertion is at the very start; otherwise only the body is
 * inserted (`droppedFrontmatter`). A BOM is never inserted into a note.
 */
export function templateInsertion(rendered: string, target: { readonly hasFrontmatter: boolean; readonly atStart: boolean }): { readonly text: string; readonly droppedFrontmatter: boolean } {
  const text = rendered.startsWith(BOM) ? rendered.slice(BOM.length) : rendered;
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null || (!target.hasFrontmatter && target.atStart)) return { text, droppedFrontmatter: false };
  return { text: body, droppedFrontmatter: true };
}
