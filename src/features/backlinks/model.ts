// Backlinks (links.md 5): what the sidebar shows for one note. Pure: the index's incoming links
// and file texts in, groups of mentions out. Read-only.
import { fenceMask } from '../../core/fences.ts';
import { lineTexts, parseLines } from '../../core/lines.ts';
import type { IncomingLink, LinkRef } from '../../vault/link-index.ts';

export interface Mention {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  /** The line as plain text, shortened around the mention. */
  readonly preview: string;
}

export interface MentionGroup {
  /** Vault-relative path of the file with the mentions. */
  readonly source: string;
  readonly mentions: readonly Mention[];
}

const PREVIEW_AROUND = 60;

/** The line text around `start..end`, cut with an ellipsis, tabs and runs of spaces collapsed. */
export function preview(line: string, start: number, end: number): string {
  const from = Math.max(0, start - PREVIEW_AROUND);
  const to = Math.min(line.length, end + PREVIEW_AROUND);
  const text = line.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${text}${to < line.length ? '…' : ''}`;
}

const byPath = (a: MentionGroup, b: MentionGroup): number => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0);

/**
 * Linked mentions grouped by source file (sorted by path, mentions in line order). `lines`
 * gives a file's line texts (an open editor's or the disk's); unreadable files show their links
 * without line text.
 */
export function linkedMentions(incoming: readonly IncomingLink[], lines: (path: string) => readonly string[] | undefined): MentionGroup[] {
  const groups = new Map<string, LinkRef[]>();
  for (const { source, link } of incoming) {
    const list = groups.get(source);
    if (list === undefined) groups.set(source, [link]);
    else list.push(link);
  }
  return [...groups]
    .map(([source, links]) => {
      const texts = lines(source);
      const mentions = [...links]
        .sort((a, b) => a.line - b.line || a.start - b.start)
        .map((link) => ({ line: link.line, start: link.start, end: link.end, preview: preview(texts?.[link.line] ?? '', link.start, link.end) }));
      return { source, mentions };
    })
    .sort(byPath);
}

/** The note name as Obsidian shows it: the file name without `.md`. */
export function noteName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** Inline code spans of a line (`...`), as ranges. */
function codeSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /(`+)[\s\S]*?\1/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * Unlinked mentions of `name` in one file's text (links.md 5): case-insensitive whole-word
 * occurrences outside links, code fences, inline code and the frontmatter. `links` are the
 * file's own link tokens (so a mention inside `[[...]]` or `[...](...)` is not counted).
 */
export function unlinkedMentions(text: string, name: string, links: readonly LinkRef[]): Mention[] {
  const needle = name.normalize('NFC').toLowerCase();
  if (needle.trim() === '') return [];
  const texts = lineTexts(parseLines(text));
  const fenced = fenceMask(texts);
  let bodyStart = 0;
  if (texts[0]?.trim() === '---') {
    const close = texts.findIndex((t, i) => i > 0 && t.trim() === '---');
    if (close !== -1) bodyStart = close + 1;
  }
  const out: Mention[] = [];
  texts.forEach((line, n) => {
    if (n < bodyStart || fenced[n]) return;
    const hay = line.normalize('NFC').toLowerCase();
    if (hay.length !== line.length) return; // normalization changed offsets: skip rather than mis-place
    const blocked = [...codeSpans(line), ...links.filter((l) => l.line === n).map((l) => [l.start, l.end] as [number, number])];
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (isWordChar(line[at - 1]) || isWordChar(line[end])) continue;
      if (blocked.some(([s, e]) => at < e && end > s)) continue;
      out.push({ line: n, start: at, end, preview: preview(line, at, end) });
    }
  });
  return out;
}

/**
 * Obsidian's "Excluded files" (`userIgnoreFilters`): a `/regex/` entry is a regular expression,
 * anything else a path prefix (links.md 5: excluded files are left out of unlinked mentions).
 */
export function isExcluded(path: string, filters: readonly string[]): boolean {
  for (const filter of filters) {
    const regex = /^\/(.+)\/([a-z]*)$/.exec(filter);
    if (regex !== null) {
      try {
        if (new RegExp(regex[1]!, regex[2]).test(path)) return true;
      } catch {
        // An invalid pattern excludes nothing.
      }
      continue;
    }
    if (filter !== '' && path.startsWith(filter)) return true;
  }
  return false;
}
