// Per-vault link index (links.md 2.3): every Markdown file's outgoing links with their
// positions and resolved targets, and the reverse map. Pure and in memory only; the adapter
// (link-store.ts) feeds it files and texts. Read-only: nothing here writes files.
import { fenceMask } from '../core/fences.ts';
import { findFrontmatter } from '../core/frontmatter.ts';
import { lineTexts, parseLines } from '../core/lines.ts';
import { findTokens } from '../core/tokens.ts';
import { nonLinkSpans, overlaps } from './link-context.ts';
import { candidateNames, isHiddenPath, LinkResolver, type LinkForm, type LinkResolution } from './links.ts';

/** One link in a file, with what a rewrite needs (links.md 2.4). */
export interface LinkRef {
  readonly line: number;
  /** The whole token (`[[...]]`, `![...](...)`). */
  readonly start: number;
  readonly end: number;
  readonly form: LinkForm;
  readonly embed: boolean;
  /** The path part as written: before `#` and `|`; Markdown still encoded, without `<>`. */
  readonly rawPath: string;
  /** Offsets of `rawPath` in the line. */
  readonly pathStart: number;
  readonly pathEnd: number;
  /** The path to resolve: wikilinks as written, Markdown percent-decoded. */
  readonly path: string;
  /** `heading`, `^block` after `#`, or null. */
  readonly subpath: string | null;
  /** Wikilink display text after `|`, or null; Markdown link text. */
  readonly display: string | null;
  /** Markdown `<destination>`. */
  readonly angle: boolean;
  /** In a frontmatter property value (`"[[note]]"`, links.md 10 #3). */
  readonly frontmatter: boolean;
  /** The whole token as written (`line.slice(start, end)`), to check the text before editing. */
  readonly token: string;
}

const isMarkdown = (path: string): boolean => /\.md$/i.test(path);

/** Notes larger than this (UTF-16 units) are indexed without their links, so never rewritten. */
export const MAX_LINKED_TEXT = 16 * 1024 * 1024;

// Frontmatter keys whose values are names, not links.
const NOT_LINK_KEYS = new Set(['aliases', 'alias', 'tags', 'tag', 'cssclasses', 'cssclass']);
const TOP_KEY = /^([^\s#:'"-][^:]*?)[ \t]*:/;
const BLOCK_SCALAR = /:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$|^[ \t]*-[ \t]+[|>][-+0-9]*[ \t]*$/;

/**
 * Frontmatter lines whose wikilinks count: a property value that is exactly a quoted
 * `"[[...]]"` (or `'[[...]]'`), also as a list item (links.md 10 #3). Plain YAML (`key: [[a]]`
 * is a nested list), text around the link, block scalars and name keys are not links.
 */
function frontmatterLinkLines(texts: readonly string[], open: number, close: number): Set<number> {
  const lines = new Set<number>();
  let key = '';
  let scalarIndent = -1;
  for (let i = open + 1; i < close; i++) {
    const text = texts[i]!;
    const indent = text.length - text.trimStart().length;
    if (scalarIndent >= 0) {
      if (text.trim() === '' || indent > scalarIndent) continue;
      scalarIndent = -1;
    }
    const top = indent === 0 ? TOP_KEY.exec(text) : null;
    if (top !== null) key = top[1]!.trim().toLowerCase();
    if (BLOCK_SCALAR.test(text)) {
      scalarIndent = indent;
      continue;
    }
    if (!NOT_LINK_KEYS.has(key)) lines.add(i);
  }
  return lines;
}

/** A frontmatter wikilink is a link only when it is the whole quoted value. */
function quotedValue(text: string, start: number, end: number): boolean {
  const quote = text[start - 1];
  if ((quote !== '"' && quote !== "'") || text[end] !== quote) return false;
  return /^[ \t]*(?:-[ \t]+|[^:]*:[ \t]*)?$/.test(text.slice(0, start - 1)) && text.slice(end + 1).trim() === '';
}

/**
 * Links in a Markdown text: wikilinks and Markdown links/embeds in the body, and quoted
 * wikilinks in frontmatter values. Not links: code (fenced, indented, inline), math, comments,
 * HTML tags, escaped brackets and external URLs (link-context.ts).
 */
export function extractLinks(text: string): LinkRef[] {
  if (text.length > MAX_LINKED_TEXT) return [];
  const texts = lineTexts(parseLines(text));
  const frontmatter = findFrontmatter(texts);
  const bodyStart = frontmatter === null ? 0 : frontmatter.closeLine + 1;
  const fenced = fenceMask(texts, bodyStart);
  const skipped = nonLinkSpans(texts, bodyStart, fenced);
  const frontmatterLines = frontmatter === null ? new Set<number>() : frontmatterLinkLines(texts, frontmatter.openLine, frontmatter.closeLine);
  const out: LinkRef[] = [];
  texts.forEach((lineText, line) => {
    const inFrontmatter = frontmatter !== null && line > frontmatter.openLine && line < frontmatter.closeLine;
    if (frontmatter !== null && line <= frontmatter.closeLine && !frontmatterLines.has(line)) return;
    for (const token of findTokens(lineText)) {
      if (token.kind !== 'wikilink' && token.kind !== 'mdlink') continue;
      if (overlaps(skipped[line]!, token.start, token.end)) continue;
      if (inFrontmatter && (token.kind !== 'wikilink' || !quotedValue(lineText, token.start, token.end))) continue;
      const whole = lineText.slice(token.start, token.end);
      if (token.kind === 'wikilink') {
        const open = token.start + (token.embed ? 1 : 0) + 2;
        const hash = token.target.indexOf('#');
        let rawPath = hash === -1 ? token.target : token.target.slice(0, hash);
        // In a table the alias bar is escaped (`[[note\|shown]]`): the `\` is not part of the path.
        if (hash === -1 && token.alias !== null && rawPath.endsWith('\\')) rawPath = rawPath.slice(0, -1);
        out.push({
          line,
          start: token.start,
          end: token.end,
          form: 'wikilink',
          embed: token.embed,
          rawPath,
          pathStart: open,
          pathEnd: open + rawPath.length,
          path: rawPath,
          subpath: hash === -1 ? null : token.target.slice(hash + 1),
          display: token.alias,
          angle: false,
          frontmatter: inFrontmatter,
          token: whole,
        });
      } else if (token.kind === 'mdlink' && !token.external && !inFrontmatter) {
        const hash = token.destination.indexOf('#');
        const rawPath = hash === -1 ? token.destination : token.destination.slice(0, hash);
        out.push({
          line,
          start: token.start,
          end: token.end,
          form: 'markdown',
          embed: token.embed,
          rawPath,
          pathStart: token.destStart,
          pathEnd: token.destStart + rawPath.length,
          path: token.path,
          subpath: token.subpath,
          display: token.text,
          angle: token.angle,
          frontmatter: false,
          token: whole,
        });
      }
    }
  });
  return out;
}

interface FileLinks {
  readonly links: readonly LinkRef[];
  resolved: LinkResolution[];
}

export interface IncomingLink {
  readonly source: string;
  readonly link: LinkRef;
}

/**
 * Links of one vault. Files are vault-relative paths. Every vault file is known to the
 * resolver (attachments are link targets too); Markdown files also carry their links.
 * Changes re-resolve only the links whose written name could match the changed file.
 */
export class LinkIndex {
  readonly #resolver = new LinkResolver();
  readonly #files = new Set<string>();
  readonly #links = new Map<string, FileLinks>();
  /** Comparable file name -> files with a link that could match a file of that name. */
  readonly #byName = new Map<string, Set<string>>();
  /** Target path -> sources with a link that resolves to it. */
  readonly #incoming = new Map<string, Set<string>>();

  /** Builds the index in one pass: all files first, then each Markdown text. */
  static build(files: Iterable<string>, read: (path: string) => string | undefined): LinkIndex {
    const index = new LinkIndex();
    const all = [...files].filter((path) => !isHiddenPath(path));
    for (const path of all) {
      index.#files.add(path);
      index.#resolver.add(path);
    }
    for (const path of all) {
      if (!isMarkdown(path)) continue;
      const text = read(path);
      if (text !== undefined) index.#store(path, text);
    }
    return index;
  }

  get size(): number {
    return this.#files.size;
  }

  /** Notes too large to read for links (MAX_LINKED_TEXT): their links are not known. */
  readonly #unread = new Set<string>();

  /** Number of notes whose links were not read because they are too large. */
  get unreadCount(): number {
    return this.#unread.size;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  /** A file appeared or its text changed (text only for Markdown). */
  setFile(path: string, text?: string): void {
    // Hidden files (dot-folders) are not vault files: never indexed, so never edited.
    if (isHiddenPath(path)) return;
    const added = !this.#files.has(path);
    if (added) {
      this.#files.add(path);
      this.#resolver.add(path);
    }
    if (isMarkdown(path) && text !== undefined) {
      this.#drop(path);
      this.#store(path, text);
    }
    if (added) this.#reresolve(path);
  }

  removeFile(path: string): void {
    if (!this.#files.delete(path)) return;
    this.#resolver.remove(path);
    this.#drop(path);
    this.#reresolve(path);
  }

  /** A rename or move; `text` is the file's text when it is Markdown. */
  renameFile(oldPath: string, newPath: string, text?: string): void {
    this.removeFile(oldPath);
    this.setFile(newPath, text);
  }

  /** Links in `path` with their resolution, in file order. */
  outgoing(path: string): { link: LinkRef; resolution: LinkResolution }[] {
    const entry = this.#links.get(path);
    return entry === undefined ? [] : entry.links.map((link, i) => ({ link, resolution: entry.resolved[i]! }));
  }

  /** Links elsewhere that resolve to `path` (backlinks). */
  incoming(path: string): IncomingLink[] {
    const out: IncomingLink[] = [];
    for (const source of this.#incoming.get(path) ?? []) {
      const entry = this.#links.get(source)!;
      entry.links.forEach((link, i) => {
        const r = entry.resolved[i]!;
        if (r.kind === 'found' && r.path === path) out.push({ source, link });
      });
    }
    return out;
  }

  /** Links whose resolution is ambiguous and includes `path` among the candidates. */
  ambiguousTo(path: string): IncomingLink[] {
    const out: IncomingLink[] = [];
    for (const [source, entry] of this.#links) {
      entry.links.forEach((link, i) => {
        const r = entry.resolved[i]!;
        if (r.kind === 'ambiguous' && r.paths.includes(path)) out.push({ source, link });
      });
    }
    return out;
  }

  /** The resolver over the current files (for computing rewrites). */
  get resolver(): LinkResolver {
    return this.#resolver;
  }

  files(): IterableIterator<string> {
    return this.#files.values();
  }

  #store(path: string, text: string): void {
    if (text.length > MAX_LINKED_TEXT) this.#unread.add(path);
    else this.#unread.delete(path);
    const links = extractLinks(text);
    const entry: FileLinks = { links, resolved: [] };
    this.#links.set(path, entry);
    for (const link of links) {
      for (const name of candidateNames(link, path)) {
        let set = this.#byName.get(name);
        if (set === undefined) this.#byName.set(name, (set = new Set()));
        set.add(path);
      }
    }
    this.#resolveFile(path, entry);
  }

  #resolveFile(path: string, entry: FileLinks): void {
    for (const r of entry.resolved) if (r.kind === 'found') this.#incoming.get(r.path)?.delete(path);
    entry.resolved = entry.links.map((link) => this.#resolver.resolve(link, path));
    for (const r of entry.resolved) {
      if (r.kind !== 'found') continue;
      let set = this.#incoming.get(r.path);
      if (set === undefined) this.#incoming.set(r.path, (set = new Set()));
      set.add(path);
    }
  }

  #drop(path: string): void {
    this.#unread.delete(path);
    const entry = this.#links.get(path);
    if (entry === undefined) return;
    for (const r of entry.resolved) if (r.kind === 'found') this.#incoming.get(r.path)?.delete(path);
    for (const link of entry.links) for (const name of candidateNames(link, path)) this.#byName.get(name)?.delete(path);
    this.#links.delete(path);
  }

  /** Re-resolves links that could name a file called like `changed`. */
  #reresolve(changed: string): void {
    const name = changed.slice(changed.lastIndexOf('/') + 1).normalize('NFC').toLowerCase();
    for (const source of this.#byName.get(name) ?? []) {
      const entry = this.#links.get(source);
      if (entry !== undefined) this.#resolveFile(source, entry);
    }
  }
}
