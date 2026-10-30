// Last checks before a task file is written (backlog.md 5.1): user text that could break the
// file's structure is refused, and every planned change is parsed back and compared with the
// file it was built on. Anything outside what the operation may touch must come out the same,
// and the touched part must read back as requested; otherwise nothing is written. Pure.
import { findFences } from '../../core/fences.ts';
import type { Frontmatter } from '../../core/frontmatter.ts';
import { lineTexts, parseLines } from '../../core/lines.ts';
import { MARKER_NAMES, parseTaskFile, SECTION_ORDER, type SectionName, type TaskFile } from './task-file.ts';

/**
 * Characters never written: C0 controls but tab (LF only where a caller allows lines), DEL,
 * C1 controls, the Unicode line and paragraph separators, unpaired surrogates (not encodable as
 * UTF-8) and the noncharacters U+FFFE/U+FFFF. YAML cannot hold most of them even quoted.
 */
function hasBadCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfffe || c === 0xffff) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Section marker text anywhere in a line, in any case or spacing. Backlog.md may look for
 * markers without anchoring them to a line, so none may appear inside user text.
 */
const MARKER_TEXT = /<!--\s*([a-z_]+(?:\s*:\s*[a-z_]+)?)\s*:\s*(begin|end)\s*-->/gi;

/** A heading that names a task section (`## Acceptance Criteria`, any level and case). */
const SECTION_HEADING =
  /^[ \t]{0,3}#{1,6}[ \t]+(description|acceptance criteria|definition of done|implementation plan|implementation notes|comments|final summary)[ \t]*#*[ \t]*$/i;

/** Whether one-line user input (a field value or list item) may be written. */
export function valueAllowed(value: string): boolean {
  return !value.includes('\n') && !hasBadCharacter(value) && !hasMarkerText(value);
}

/**
 * Whether multi-line user text (section content, a comment) may be written: no character
 * hasBadCharacter refuses, no marker text, no section heading and no HTML comment left open (it
 * would hide everything after it in a Markdown view).
 */
export function textAllowed(text: string): boolean {
  if (hasBadCharacter(text) || hasMarkerText(text)) return false;
  if (text.split('\n').some((line) => SECTION_HEADING.test(line))) return false;
  return htmlCommentsClosed(text);
}

function hasMarkerText(text: string): boolean {
  MARKER_TEXT.lastIndex = 0;
  return MARKER_TEXT.test(text);
}

function htmlCommentsClosed(text: string): boolean {
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open === -1) return true;
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return false;
    from = close + 3;
  }
}

/** Marker texts per section, counted the loose way (any case, spacing, position, fence). */
export function markerCounts(text: string): Map<SectionName, { begin: number; end: number }> {
  const counts = new Map<SectionName, { begin: number; end: number }>();
  for (const match of text.matchAll(MARKER_TEXT)) {
    const name = MARKER_NAMES[match[1].replace(/\s+/g, '').toUpperCase()];
    if (name === undefined) continue;
    const count = counts.get(name) ?? { begin: 0, end: 0 };
    if (match[2].toLowerCase() === 'begin') count.begin++;
    else count.end++;
    counts.set(name, count);
  }
  return counts;
}

/**
 * Whether a body line outside every recognised section and outside code fences is a marker
 * (any case or spacing): a section left half-written, or markers this parser does not pair.
 * Such a file is not written at all.
 */
export function hasStrayMarker(parsed: ParsedText): boolean {
  return strayMarkerLine(parsed) !== null;
}

/** The first line hasStrayMarker finds, or null. */
export function strayMarkerLine(parsed: ParsedText): number | null {
  const { texts, file } = parsed;
  const bodyStart = file.frontmatter === null ? 0 : file.frontmatter.closeLine + 1;
  const covered = new Array<boolean>(texts.length).fill(false);
  for (const section of Object.values(file.sections)) {
    for (let j = section.heading ?? section.begin; j <= section.end; j++) covered[j] = true;
  }
  for (const fence of findFences(texts, bodyStart)) {
    for (let j = fence.open; j <= fence.last; j++) covered[j] = true;
  }
  for (let j = bodyStart; j < texts.length; j++) {
    if (!covered[j] && MARKER_LINE.test(texts[j].trim())) return j;
  }
  return null;
}

const MARKER_LINE = /^<!--\s*[a-z_]+(?:\s*:\s*[a-z_]+)?\s*:\s*(begin|end)\s*-->$/i;

const FIELD_LINE = /^[A-Za-z_][\w-]*[ \t]*:/;

/**
 * Whether the frontmatter holds only what a YAML mapping of the CLI's shape can: `name:` lines,
 * indented continuation lines after them, blank lines and `#` comments. A missing closing line
 * whose place was taken by a later `---` (a comment delimiter) shows up here as body lines.
 */
export function frontmatterSane(texts: readonly string[], frontmatter: Frontmatter): boolean {
  return frontmatterProblemLine(texts, frontmatter) === null;
}

/** The first frontmatter line frontmatterSane refuses, or null. */
export function frontmatterProblemLine(texts: readonly string[], frontmatter: Frontmatter): number | null {
  let inField = false;
  for (let i = frontmatter.openLine + 1; i < frontmatter.closeLine; i++) {
    const text = texts[i];
    if (text.includes('<!--') || SECTION_HEADING.test(text)) return i;
    if (text.trim() === '') continue;
    if (text.startsWith('#')) continue;
    if (FIELD_LINE.test(text)) {
      inField = true;
      continue;
    }
    if (inField && /^[ \t]/.test(text)) continue;
    return i;
  }
  return null;
}

export interface ParsedText {
  readonly texts: readonly string[];
  readonly file: TaskFile;
}

export function parseText(text: string): ParsedText {
  const texts = lineTexts(parseLines(text));
  return { texts, file: parseTaskFile(texts) };
}

/** What an operation may change, and how its result must read back. */
export interface ChangeTarget {
  /** Frontmatter keys the operation writes (`updated_date` is always allowed). */
  readonly fields: readonly string[];
  readonly sections: readonly SectionName[];
  readonly readsBack: (before: ParsedText, after: ParsedText) => boolean;
}

function fieldSources(parsed: ParsedText): Map<string, string> {
  const sources = new Map<string, string>();
  for (const field of parsed.file.fields) {
    const source = parsed.texts.slice(field.line, field.end).join('\n');
    sources.set(field.name, sources.has(field.name) ? `${sources.get(field.name)}\n${source}` : source);
  }
  return sources;
}

function sectionSource(parsed: ParsedText, name: SectionName): string | null {
  const section = parsed.file.sections[name];
  if (section === undefined) return null;
  const heading = section.heading === null ? '' : parsed.texts[section.heading];
  return JSON.stringify([heading, parsed.texts.slice(section.begin, section.end + 1)]);
}

/**
 * Whether `after` is `before` with only the target's change: same BOM, no new kind of line
 * ending, a sane frontmatter on both sides, every other field and section unchanged, marker
 * texts unambiguous for the target sections and unchanged for the others, the loose body
 * text unchanged, and the target reading back as requested.
 */
export function changeIsSafe(before: string, after: string, target: ChangeTarget): boolean {
  const docBefore = parseLines(before);
  const docAfter = parseLines(after);
  if (docBefore.bom !== docAfter.bom) return false;
  const eols = new Set(docBefore.lines.map((line) => line.eol).filter((eol) => eol !== ''));
  if (eols.size > 0 && docAfter.lines.some((line) => line.eol !== '' && !eols.has(line.eol))) return false;

  const a = parseText(before);
  const b = parseText(after);
  if (a.file.frontmatter === null || b.file.frontmatter === null) return false;
  if (!frontmatterSane(a.texts, a.file.frontmatter) || !frontmatterSane(b.texts, b.file.frontmatter)) return false;
  if (hasStrayMarker(a) || hasStrayMarker(b)) return false;

  const allowed = new Set([...target.fields, 'updated_date']);
  const fieldsA = fieldSources(a);
  const fieldsB = fieldSources(b);
  for (const name of new Set([...fieldsA.keys(), ...fieldsB.keys()])) {
    if (!allowed.has(name) && fieldsA.get(name) !== fieldsB.get(name)) return false;
  }
  const updated = b.file.fields.filter((field) => field.name === 'updated_date');
  if (updated.length > 1 || (updated.length === 1 && (updated[0].value.kind !== 'scalar' || updated[0].end !== updated[0].line + 1))) return false;

  const countsA = markerCounts(before);
  const countsB = markerCounts(after);
  for (const name of SECTION_ORDER) {
    const countA = countsA.get(name) ?? { begin: 0, end: 0 };
    const countB = countsB.get(name) ?? { begin: 0, end: 0 };
    if (target.sections.includes(name)) {
      const present = b.file.sections[name] === undefined ? 0 : 1;
      if (countB.begin !== present || countB.end !== present) return false;
    } else if (countA.begin !== countB.begin || countA.end !== countB.end || sectionSource(a, name) !== sectionSource(b, name)) {
      return false;
    }
  }
  return a.file.otherBody === b.file.otherBody && target.readsBack(a, b);
}
