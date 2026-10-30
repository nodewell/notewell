// Template variables of Obsidian's Templates and Daily notes core plugins (daily-notes.md 5.2).
// Text replacement only: no expressions, and every other `{{...}}` (Templater, other plugins)
// stays as written. Names match in any case and an empty format is the set one, as in
// Obsidian (1.14, measured). Pure.
import { formatDate, type DateLocale } from './date-format.ts';
import { findFrontmatter } from './frontmatter.ts';
import { BOM, parseLines } from './lines.ts';

export interface TemplateValues {
  /** File name of the target note without its extension. */
  readonly title: string;
  readonly now: Date;
  /** Formats of `{{date}}` and `{{time}}` (Templates settings). */
  readonly dateFormat: string;
  readonly timeFormat: string;
  /** Language of month and weekday names (default `en`). */
  readonly locale?: DateLocale;
}

export type TemplateResult =
  | { readonly ok: true; readonly text: string }
  /** A date or time format uses a Moment token outside the supported subset (daily-notes.md 3). */
  | { readonly ok: false; readonly format: string; readonly token: string };

const VARIABLE = /\{\{(title|date|time)(?::([^{}\r\n]*))?\}\}/gi;

export function renderTemplate(text: string, values: TemplateValues): TemplateResult {
  let failure: { format: string; token: string } | undefined;
  const out = text.replace(VARIABLE, (whole, name: string, format: string | undefined) => {
    const kind = name.toLowerCase();
    if (kind === 'title') return format === undefined ? values.title : whole;
    const used = format || (kind === 'date' ? values.dateFormat : values.timeFormat);
    const result = formatDate(values.now, used, values.locale);
    if (result.ok) return result.text;
    failure ??= { format: used, token: result.token };
    return whole;
  });
  return failure === undefined ? { ok: true, text: out } : { ok: false, ...failure };
}

/**
 * A template split at its frontmatter: `frontmatter` is the opening line through the closing
 * line with its line break (null without frontmatter), `body` the rest as written. A BOM stays
 * in front of whichever part comes first.
 */
export function splitFrontmatter(text: string): { readonly frontmatter: string | null; readonly body: string } {
  const doc = parseLines(text);
  const found = findFrontmatter(doc.lines.map((l) => l.text));
  if (found === null) return { frontmatter: null, body: text };
  let length = doc.bom ? BOM.length : 0;
  for (let i = 0; i <= found.closeLine; i++) length += doc.lines[i]!.text.length + doc.lines[i]!.eol.length;
  return { frontmatter: text.slice(0, length), body: text.slice(length) };
}
