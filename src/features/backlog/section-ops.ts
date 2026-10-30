// Stage 2 body writes (backlog.md 5.4): replace a marked section's text and append a comment,
// as Backlog.md 1.54.0 does. Text is trimmed like the CLI does. Only the lines between the
// markers change, except when a section is created (heading and markers after the section
// before it in display order) or removed (with the blank line that separates it).
import { findFences } from '../../core/fences.ts';
import type { ExpectedLine, LineOperation } from '../../core/patch.ts';
import { planUpdatedDate, refuse, type OperationPlan } from './operations.ts';
import { parseComments, SECTION_ORDER, type Section, type SectionName, type TaskFile } from './task-file.ts';

export type EditableSection = 'description' | 'plan' | 'notes' | 'finalSummary';

export interface SetSectionRequest {
  readonly section: EditableSection;
  /** New text; empty (after trimming) removes the section. */
  readonly text: string;
  /** The text between the markers as the requester saw it, or null when it saw no section. */
  readonly expected: string | null;
}

export interface AddCommentRequest {
  readonly text: string;
}

const HEADINGS: Readonly<Record<SectionName, string>> = {
  description: 'Description',
  ac: 'Acceptance Criteria',
  dod: 'Definition of Done',
  plan: 'Implementation Plan',
  notes: 'Implementation Notes',
  comments: 'Comments',
  finalSummary: 'Final Summary',
};

const MARKERS: Readonly<Record<SectionName, string>> = {
  description: 'SECTION:DESCRIPTION',
  ac: 'AC',
  dod: 'DOD',
  plan: 'SECTION:PLAN',
  notes: 'SECTION:NOTES',
  comments: 'COMMENTS',
  finalSummary: 'SECTION:FINAL_SUMMARY',
};

const EDITABLE: ReadonlySet<string> = new Set<EditableSection>(['description', 'plan', 'notes', 'finalSummary']);
const ANY_MARKER = /^<!--\s*[A-Z_]+(?::[A-Z_]+)?:(BEGIN|END)\s*-->$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` UTC, unquoted, as the CLI writes a comment's `created:`. */
export function formatCommentDate(now: Date): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
}

/** The CLI trims text; lines that look like section markers would break the file's structure. */
function textLines(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const lines = trimmed.split('\n');
  if (lines.some((line) => ANY_MARKER.test(line.trim()) || line.includes('\r'))) return undefined;
  // An unclosed fence would swallow every marker after it (core.md 3.3): the section's END and
  // all later sections would stop being structure.
  return findFences(lines).some((fence) => fence.close === null) ? undefined : lines;
}

/** Adds the updated_date change; no change plans nothing. */
function finish(texts: readonly string[], file: TaskFile, now: Date, expectedLines: ExpectedLine[], operations: LineOperation[]): OperationPlan {
  const updated = planUpdatedDate(texts, file, now);
  if (updated === undefined) return refuse('unsafe');
  return {
    ok: true,
    expectedLines: [...expectedLines, ...updated.expectedLines],
    operations: operations.length === 0 ? [] : [...operations, ...updated.operations],
  };
}

const linesOf = (texts: readonly string[], start: number, end: number): ExpectedLine[] =>
  texts.slice(start, end).map((text, i) => ({ line: start + i, text }));

/**
 * A new section as the CLI writes it: after the closest earlier section in display order
 * (or the frontmatter), as a blank line, `## Title`, a blank line and the marked block. When
 * only blank lines follow, they are replaced (the CLI ends the file with the block).
 */
function createSection(texts: readonly string[], file: TaskFile, name: SectionName, content: readonly string[]): { expected: ExpectedLine[]; operation: LineOperation } {
  let at = file.frontmatter!.closeLine + 1;
  for (const earlier of SECTION_ORDER.slice(0, SECTION_ORDER.indexOf(name))) {
    const section = file.sections[earlier];
    if (section !== undefined) at = Math.max(at, section.end + 1);
  }
  const marker = MARKERS[name];
  const block = ['', `## ${HEADINGS[name]}`, '', `<!-- ${marker}:BEGIN -->`, ...content, `<!-- ${marker}:END -->`];
  const anchor = linesOf(texts, at - 1, at);
  const onlyBlank = texts.slice(at).every((text) => text.trim() === '');
  if (onlyBlank && at < texts.length) {
    return { expected: [...anchor, ...linesOf(texts, at, texts.length)], operation: { kind: 'replace', start: at, end: texts.length, lines: block } };
  }
  return { expected: anchor, operation: { kind: 'insert', at, lines: block } };
}

/**
 * The lines a removed section takes with it: heading to END marker plus one separating blank
 * line, before it when another section precedes it, otherwise after it.
 */
function removalRange(texts: readonly string[], file: TaskFile, section: Section): { start: number; end: number } {
  let start = section.heading ?? section.begin;
  let end = section.end + 1;
  const afterFrontmatter = start - 1 <= (file.frontmatter?.closeLine ?? -1) + 1;
  if (!afterFrontmatter && texts[start - 1]?.trim() === '') start--;
  else if (texts[end] !== undefined && texts[end].trim() === '') end++;
  return { start, end };
}

/**
 * Sets a section's text (trimmed, as the CLI stores it). Empty text removes the plan, notes or
 * final summary as the CLI does; an empty description is refused (the CLI never removes one).
 * A missing section is created where the CLI puts it.
 */
export function planSetSection(texts: readonly string[], file: TaskFile, request: SetSectionRequest, now: Date): OperationPlan {
  if (!EDITABLE.has(request.section)) return refuse('invalid');
  const content = textLines(request.text);
  if (content === undefined || (content.length === 0 && request.section === 'description')) return refuse('invalid');
  if (file.frontmatter === null) return refuse('unsafe');
  const section = file.sections[request.section];
  const current = section === undefined ? null : texts.slice(section.begin + 1, section.end).join('\n');
  if (current !== request.expected) return refuse('stale');

  if (section === undefined) {
    if (content.length === 0) return finish(texts, file, now, [], []);
    const created = createSection(texts, file, request.section, content);
    return finish(texts, file, now, created.expected, [created.operation]);
  }
  const markerLines = [...linesOf(texts, section.begin, section.begin + 1), ...linesOf(texts, section.end, section.end + 1)];
  if (content.length === 0) {
    const { start, end } = removalRange(texts, file, section);
    return finish(texts, file, now, linesOf(texts, start, end), [{ kind: 'delete', start, end }]);
  }
  const old = texts.slice(section.begin + 1, section.end);
  if (old.length === content.length && old.every((line, i) => line === content[i])) return finish(texts, file, now, markerLines, []);
  const operation: LineOperation =
    old.length === 0
      ? { kind: 'insert', at: section.end, lines: content }
      : { kind: 'replace', start: section.begin + 1, end: section.end, lines: content };
  return finish(texts, file, now, [...markerLines, ...linesOf(texts, section.begin + 1, section.end)], [operation]);
}

/**
 * Appends a comment as the CLI writes it without `--comment-author` (no author line; Notewell
 * has no user identity): `created:` in UTC, then the trimmed text between `---` lines. A
 * missing Comments section is created; a block of another shape is refused.
 */
export function planAddComment(texts: readonly string[], file: TaskFile, request: AddCommentRequest, now: Date): OperationPlan {
  const content = textLines(request.text);
  // The CLI refuses standalone `---` lines: they delimit comments.
  if (content === undefined || content.length === 0 || content.some((line) => line.trim() === '---')) return refuse('invalid');
  if (file.frontmatter === null) return refuse('unsafe');
  // The CLI 1.54.0 shape (backlog.md 3.5): blank lines keep the metadata from reading as a heading.
  const comment = [`created: ${formatCommentDate(now)}`, '', '---', '', ...content, '', '---'];
  const section = file.sections.comments;
  if (section === undefined) {
    const created = createSection(texts, file, 'comments', comment);
    return finish(texts, file, now, created.expected, [created.operation]);
  }
  const existing = parseComments(texts, section);
  if (existing === null) return refuse('unsafe');
  // After the last non-blank line of the block, separated by one blank line from earlier comments.
  let at = section.end;
  while (at - 1 > section.begin && texts[at - 1].trim() === '') at--;
  const lines = existing.length === 0 ? comment : ['', ...comment];
  return finish(texts, file, now, linesOf(texts, section.begin, section.end + 1), [{ kind: 'insert', at, lines }]);
}
