// Link preview and go-to (links.md 6). Pure: the link under the cursor, the line a `#heading` /
// `#^block` subpath points at, and the preview text of a note. Read-only.
import { extractLinks, type LinkRef } from '../../vault/link-index.ts';

/** Preview length (links.md 6: the first 20 lines after the frontmatter). */
export const PREVIEW_LINES = 20;

/** The link token (wikilink or Markdown link) at `line:character`, if any. */
export function linkAt(text: string | readonly LinkRef[], line: number, character: number): LinkRef | undefined {
  const links = typeof text === 'string' ? extractLinks(text) : text;
  return links.find((link) => link.line === line && character >= link.start && character <= link.end);
}

/** First body line: after a frontmatter block (`---` ... `---` from the first line). */
export function bodyStart(texts: readonly string[]): number {
  if (texts[0]?.trim() !== '---') return 0;
  const close = texts.findIndex((t, i) => i > 0 && t.trim() === '---');
  return close === -1 ? 0 : close + 1;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const comparable = (s: string): string => s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The line a subpath names: `^block` = the line ending with ` ^block`; `heading` (the last part
 * of `a#b`) = the heading line with that text (case-insensitive). Undefined when not found.
 */
export function subpathLine(texts: readonly string[], subpath: string | null): number | undefined {
  if (subpath === null || subpath.trim() === '') return undefined;
  if (subpath.startsWith('^')) {
    const id = subpath.slice(1).trim();
    const re = new RegExp(`(^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
    const found = texts.findIndex((t) => re.test(t));
    return found === -1 ? undefined : found;
  }
  const wanted = comparable(subpath.split('#').filter((p) => p !== '').pop() ?? '');
  for (let i = bodyStart(texts); i < texts.length; i++) {
    const m = HEADING.exec(texts[i]!);
    if (m !== null && comparable(m[2]!) === wanted) return i;
  }
  return undefined;
}

/**
 * Preview lines and where they start: a heading's section (up to the next heading of the same or a
 * higher level), a block's line, or the note's beginning; at most PREVIEW_LINES lines.
 */
export function previewRange(texts: readonly string[], subpath: string | null): { start: number; lines: string[]; found: boolean } {
  const at = subpathLine(texts, subpath);
  if (at === undefined) {
    const start = bodyStart(texts);
    return { start, lines: texts.slice(start, start + PREVIEW_LINES), found: subpath === null || subpath.trim() === '' };
  }
  if (subpath!.startsWith('^')) return { start: at, lines: [texts[at]!], found: true };
  const level = HEADING.exec(texts[at]!)![1]!.length;
  let end = at + 1;
  while (end < texts.length) {
    const m = HEADING.exec(texts[end]!);
    if (m !== null && m[1]!.length <= level) break;
    end++;
  }
  return { start: at, lines: texts.slice(at, Math.min(end, at + PREVIEW_LINES)), found: true };
}

/**
 * Preview Markdown made safe for a hover: image syntax becomes text (a hover would otherwise load
 * remote images), raw `<` is escaped (HTML is off anyway). Links stay text-clickable only as the
 * editor allows (isTrusted false: no command links).
 */
export function safePreviewMarkdown(lines: readonly string[]): string {
  return lines
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => `[image${alt ? `: ${alt}` : ''}]`)
    .replace(/!\[\[([^\]]*)\]\]/g, (_, target: string) => `[embed: ${target}]`)
    .replace(/</g, '&lt;');
}

/** Human-readable size: B, KB, MB with one decimal above 1 KB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
