// Backlog.md task file parser (backlog.md 3.2-3.5). Pure: line texts in, fields, marked
// sections, checklists and comments out, each with the line indexes operations need.
import { findFences } from '../../core/fences.ts';
import { findFrontmatter, type Frontmatter } from '../../core/frontmatter.ts';
import { listOf, parseFields, scalarOf, type Field } from './yaml-lite.ts';

export type SectionName = 'description' | 'ac' | 'dod' | 'plan' | 'notes' | 'comments' | 'finalSummary';

/** Display order (backlog.md 4.4). */
export const SECTION_ORDER: readonly SectionName[] = ['description', 'ac', 'dod', 'plan', 'notes', 'comments', 'finalSummary'];

export const MARKER_NAMES: Readonly<Record<string, SectionName>> = {
  'SECTION:DESCRIPTION': 'description',
  AC: 'ac',
  DOD: 'dod',
  'SECTION:PLAN': 'plan',
  'SECTION:NOTES': 'notes',
  COMMENTS: 'comments',
  'SECTION:FINAL_SUMMARY': 'finalSummary',
};

const MARKER = /^<!--\s*([A-Z_]+(?::[A-Z_]+)?):(BEGIN|END)\s*-->$/;
const HEADING = /^##[ \t]+\S/;
const CHECK_ITEM = /^- \[([ xX])\] #(\d+)(?: (.*))?$/;

export interface Section {
  readonly name: SectionName;
  /** The `## Title` line that introduces the section, if any. */
  readonly heading: number | null;
  /** BEGIN and END marker lines; content is `begin + 1 .. end - 1`. */
  readonly begin: number;
  readonly end: number;
}

export interface CheckItem {
  readonly line: number;
  readonly checked: boolean;
  readonly number: number;
  readonly text: string;
}

export interface Checklist {
  readonly items: readonly CheckItem[];
  /** A line in the block is not a `- [ ] #n` / `- [x] #n` item (backlog.md 3.4). */
  readonly readOnly: boolean;
}

export interface Comment {
  readonly author: string | null;
  readonly created: string | null;
  readonly body: string;
}

export interface TaskFile {
  readonly frontmatter: Frontmatter | null;
  readonly fields: readonly Field[];
  readonly sections: Readonly<Partial<Record<SectionName, Section>>>;
  /** Body text outside the marked sections and their headings (shown as is). */
  readonly otherBody: string;
}

export function parseTaskFile(texts: readonly string[]): TaskFile {
  const frontmatter = findFrontmatter(texts);
  const fields = frontmatter === null ? [] : parseFields(texts, frontmatter.openLine + 1, frontmatter.closeLine);
  const bodyStart = frontmatter === null ? 0 : frontmatter.closeLine + 1;
  const sections = findSections(texts, bodyStart);
  return { frontmatter, fields, sections, otherBody: otherBody(texts, bodyStart, sections) };
}

function markerAt(text: string): { name: SectionName; kind: 'BEGIN' | 'END' } | undefined {
  const match = MARKER.exec(text.trim());
  const name = match === null ? undefined : MARKER_NAMES[match[1]];
  return name === undefined ? undefined : { name, kind: match![2] as 'BEGIN' | 'END' };
}

/**
 * Marked sections. A BEGIN pairs with the first END of the same name after it that is not
 * inside a code fence opened after the BEGIN. Markers in fences outside sections are ignored.
 */
function findSections(texts: readonly string[], bodyStart: number): Partial<Record<SectionName, Section>> {
  const sections: Partial<Record<SectionName, Section>> = {};
  const outerFences = new Map(findFences(texts, bodyStart).map((f) => [f.open, f.last]));
  let i = bodyStart;
  while (i < texts.length) {
    const marker = markerAt(texts[i]);
    if (marker?.kind === 'BEGIN' && sections[marker.name] === undefined) {
      const end = findEnd(texts, i, marker.name);
      if (end !== undefined) {
        sections[marker.name] = { name: marker.name, heading: headingBefore(texts, i, bodyStart), begin: i, end };
        i = end + 1;
        continue;
      }
    }
    const fenceLast = outerFences.get(i);
    i = fenceLast === undefined ? i + 1 : fenceLast + 1;
  }
  return sections;
}

function findEnd(texts: readonly string[], begin: number, name: SectionName): number | undefined {
  const fences = findFences(texts, begin + 1);
  let f = 0;
  for (let j = begin + 1; j < texts.length; j++) {
    while (f < fences.length && fences[f].last < j) f++;
    if (f < fences.length && fences[f].open <= j) continue;
    const marker = markerAt(texts[j]);
    if (marker?.name === name && marker.kind === 'END') return j;
    if (marker?.name === name && marker.kind === 'BEGIN') return undefined;
  }
  return undefined;
}

/** A `## Title` line directly before the BEGIN marker (blank lines between allowed). */
function headingBefore(texts: readonly string[], begin: number, bodyStart: number): number | null {
  for (let j = begin - 1; j >= bodyStart; j--) {
    if (texts[j].trim() === '') continue;
    return HEADING.test(texts[j]) ? j : null;
  }
  return null;
}

function otherBody(texts: readonly string[], bodyStart: number, sections: Partial<Record<SectionName, Section>>): string {
  const taken = new Array<boolean>(texts.length).fill(false);
  for (const section of Object.values(sections)) {
    for (let j = section.heading ?? section.begin; j <= section.end; j++) taken[j] = true;
  }
  const chunks: string[][] = [[]];
  for (let j = bodyStart; j < texts.length; j++) {
    if (taken[j]) {
      if (chunks[chunks.length - 1].length > 0) chunks.push([]);
      continue;
    }
    chunks[chunks.length - 1].push(texts[j]);
  }
  return chunks
    .map((lines) => trimBlankLines(lines).join('\n'))
    .filter((text) => text !== '')
    .join('\n\n');
}

function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/** Section content between its markers, blank lines at both ends removed; null when absent. */
export function sectionText(texts: readonly string[], section: Section | undefined): string | null {
  if (section === undefined) return null;
  return trimBlankLines(texts.slice(section.begin + 1, section.end)).join('\n');
}

export function parseChecklist(texts: readonly string[], section: Section | undefined): Checklist | null {
  if (section === undefined) return null;
  const items: CheckItem[] = [];
  let readOnly = false;
  for (let j = section.begin + 1; j < section.end; j++) {
    const text = texts[j];
    if (text.trim() === '') continue;
    const match = CHECK_ITEM.exec(text);
    if (match === null) {
      readOnly = true;
      continue;
    }
    items.push({ line: j, checked: match[1] !== ' ', number: Number(match[2]), text: match[3] ?? '' });
  }
  return { items, readOnly };
}

/**
 * Comments as Backlog.md writes them: `author:` / `created:` lines, then the body between
 * two `---` lines. Returns null when the block has another shape (shown as plain text).
 */
export function parseComments(texts: readonly string[], section: Section | undefined): Comment[] | null {
  if (section === undefined) return null;
  const lines = texts.slice(section.begin + 1, section.end);
  const comments: Comment[] = [];
  let i = 0;
  const skipBlank = (): void => {
    while (i < lines.length && lines[i].trim() === '') i++;
  };
  skipBlank();
  while (i < lines.length) {
    let author: string | null = null;
    let created: string | null = null;
    for (;;) {
      const meta = /^(author|created):[ \t]*(.*)$/.exec(lines[i] ?? '');
      if (meta === null) break;
      if (meta[1] === 'author') author = meta[2].trim();
      else created = meta[2].trim();
      i++;
    }
    // CLI 1.54.0 puts a blank line between the metadata and the opening `---` (backlog.md 3.5).
    skipBlank();
    if (lines[i]?.trim() !== '---') return null;
    // Searched from here on, not from the top: thousands of comments stay linear.
    let close = i + 1;
    while (close < lines.length && lines[close].trim() !== '---') close++;
    if (close === lines.length) return null;
    comments.push({ author, created, body: trimBlankLines(lines.slice(i + 1, close)).join('\n') });
    i = close + 1;
    skipBlank();
  }
  return comments;
}

/**
 * Fields this module shows as named fields and their shape (backlog.md 3.2); others are
 * "other". A list field may also be a scalar (read as one item), a scalar field may not be a list.
 */
export const KNOWN_FIELDS: ReadonlyMap<string, 'scalar' | 'list'> = new Map([
  ...['id', 'title', 'status', 'reporter', 'created_date', 'updated_date', 'due_date', 'milestone', 'parent_task_id', 'priority', 'type', 'project', 'ordinal']
    .map((name) => [name, 'scalar'] as const),
  ...['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files'].map((name) => [name, 'list'] as const),
]);

function isOtherField(field: Field): boolean {
  const shape = KNOWN_FIELDS.get(field.name);
  return shape === undefined || field.value.kind === 'unknown' || (shape === 'scalar' && field.value.kind !== 'scalar');
}

/** Plain task data for views and the index. Missing scalars are null, missing lists empty. */
export interface TaskData {
  readonly id: string | null;
  readonly title: string;
  readonly status: string | null;
  readonly priority: string | null;
  readonly type: string | null;
  readonly project: string | null;
  readonly reporter: string | null;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly milestone: string | null;
  readonly parent: string | null;
  readonly dependencies: readonly string[];
  readonly references: readonly string[];
  readonly documentation: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly ordinal: number | null;
  readonly created: string | null;
  readonly updated: string | null;
  readonly due: string | null;
  readonly description: string | null;
  readonly plan: string | null;
  readonly notes: string | null;
  readonly finalSummary: string | null;
  readonly ac: Checklist | null;
  readonly dod: Checklist | null;
  /** Parsed comments; null when there is no block, `raw` when it has another shape. */
  readonly comments: readonly Comment[] | null;
  readonly commentsRaw: string | null;
  readonly otherBody: string;
  /** Fields not in KNOWN_FIELDS or whose value has an unknown or wrong shape, as their source lines. */
  readonly otherFields: readonly { readonly name: string; readonly source: string }[];
}

export function taskData(texts: readonly string[], file: TaskFile = parseTaskFile(texts)): TaskData {
  const { fields, sections } = file;
  const scalar = (name: string): string | null => {
    const value = scalarOf(fields, name);
    return value === undefined || value === '' ? null : value;
  };
  const ordinal = scalar('ordinal');
  const comments = parseComments(texts, sections.comments);
  return {
    id: scalar('id'),
    title: scalar('title') ?? '',
    status: scalar('status'),
    priority: scalar('priority'),
    type: scalar('type'),
    project: scalar('project'),
    reporter: scalar('reporter'),
    assignees: listOf(fields, 'assignee'),
    labels: listOf(fields, 'labels'),
    milestone: scalar('milestone'),
    parent: scalar('parent_task_id'),
    dependencies: listOf(fields, 'dependencies'),
    references: listOf(fields, 'references'),
    documentation: listOf(fields, 'documentation'),
    modifiedFiles: listOf(fields, 'modified_files'),
    ordinal: ordinal !== null && /^-?\d+(\.\d+)?$/.test(ordinal) ? Number(ordinal) : null,
    created: scalar('created_date'),
    updated: scalar('updated_date'),
    due: scalar('due_date'),
    description: sectionText(texts, sections.description),
    plan: sectionText(texts, sections.plan),
    notes: sectionText(texts, sections.notes),
    finalSummary: sectionText(texts, sections.finalSummary),
    ac: parseChecklist(texts, sections.ac),
    dod: parseChecklist(texts, sections.dod),
    comments,
    commentsRaw: comments === null ? sectionText(texts, sections.comments) : null,
    otherBody: file.otherBody,
    otherFields: fields
      .filter(isOtherField)
      .map((field) => ({ name: field.name, source: texts.slice(field.line, field.end).join('\n') })),
  };
}
