// Link rewrites for a rename or move (links.md 2.4, 3.2). Pure: the vault's link index and
// the renames in, minimal edits per file out (only the path part of each link). Links whose
// meaning is uncertain are reported instead of changed (10 #4).
import { extractLinks, type IncomingLink, type LinkIndex, type LinkRef } from '../../vault/link-index.ts';
import { candidateNames, comparable, LinkResolver, writtenPath, type LinkResolution } from '../../vault/links.ts';

export interface Rename {
  /** Vault-relative path of a file or folder before the rename. */
  readonly from: string;
  readonly to: string;
}

/** Replace `start .. end - 1` on `line` with `newText` (positions in the file before the rename). */
export interface LinkEdit {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  /** The whole link as indexed and where it is: the text must still be there to edit it. */
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly token: string;
  /** The whole link after the edit. */
  readonly newToken: string;
}

export interface FileEdits {
  /** The file as it is now (before the rename). */
  readonly path: string;
  /** Where it will be after the rename (equal to `path` when it does not move). */
  readonly newPath: string;
  readonly edits: readonly LinkEdit[];
}

export interface Unchanged {
  readonly source: string;
  readonly link: LinkRef;
  /**
   * - `ambiguous`: the link already fits several files, one of them renamed
   * - `wouldChange`: the rename makes the link name a different file (or several)
   * - `unsafe`: no rewrite of it is certain to stay the same link to the renamed file (the
   *   new name cannot be written in this link's form, or would change its text or subpath)
   */
  readonly reason: 'ambiguous' | 'wouldChange' | 'unsafe';
}

export interface RenamePlan {
  readonly files: readonly FileEdits[];
  readonly unchanged: readonly Unchanged[];
  /** Number of links rewritten. */
  readonly count: number;
}

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Path from folder `from` to file `to` (both vault-relative). */
function relativePath(from: string, to: string): string {
  const a = from === '' ? [] : from.split('/');
  const b = to.split('/');
  let common = 0;
  while (common < a.length && common < b.length - 1 && comparable(a[common]!) === comparable(b[common]!)) common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}

// Characters a Markdown destination cannot hold unencoded (Obsidian writes `%20`).
const NEEDS_ENCODING = /[ %()<>#?|`]/g;
const encodePath = (path: string): string => path.replace(NEEDS_ENCODING, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** `folder/path` with `.` and `..` resolved, or undefined when it leaves the vault. */
function joinPath(folder: string, path: string): string | undefined {
  const out: string[] = [];
  for (const segment of `${folder}/${path}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(segment);
  }
  return out.join('/');
}

/**
 * A Markdown link written without `./`, `../` or `/` that also named `target` relative to the
 * note `source` (both before the rename), as CommonMark readers (VS Code preview) read it.
 * Such a link is kept note-relative (2.4 #2) instead of shortest.
 */
function matchedNoteRelative(link: LinkRef, source: string, target: string): boolean {
  const written = writtenPath(link);
  if (link.form !== 'markdown' || written === '' || /^(?:\.\.?\/|\/)/.test(written)) return false;
  const joined = joinPath(dirname(source), written);
  if (joined === undefined) return false;
  const wanted = comparable(target);
  return comparable(joined) === wanted || comparable(`${joined}.md`) === wanted;
}

/**
 * The new path text for `link` in `source` (after the rename) pointing at `target`.
 * `noteRelative`: the link was a plain Markdown path that matched relative to the note.
 */
function newPathText(link: LinkRef, source: string, target: string, after: LinkResolver, noteRelative = false): string {
  const written = writtenPath(link);
  const markdownTarget = /\.md$/i.test(target);
  const keepExtension = !markdownTarget || /\.md$/i.test(link.path);
  const strip = (path: string): string => (keepExtension ? path : path.replace(/\.md$/i, ''));
  let text: string;
  const explicit = /^\.\.?\//.test(written);
  // Explicitly relative paths (`./`, `../`) stay relative in both forms (2.2: a wikilink written
  // that way also resolves from the linking file).
  if (explicit || noteRelative) {
    // Stays relative: without `./` or `../` the path would resolve from the vault root or by
    // name (2.2), so `../a.md` that now points into the same folder becomes `./a.md`. A plain
    // note-relative link stays plain while it still names the file that way (`image.png` ->
    // `folder/image.png`), else it gets `./`.
    let relative = relativePath(dirname(source), target);
    if (!relative.startsWith('../')) {
      const check = after.resolve({ form: 'markdown', path: strip(relative) }, source);
      if (explicit || check.kind !== 'found' || check.path !== target) relative = `./${relative}`;
    }
    text = strip(relative);
  } else if (!written.includes('/')) {
    // Shortest form when the new name is unique, otherwise the full vault path.
    const name = strip(basename(target));
    const check = after.resolve({ form: link.form, path: name }, source);
    text = check.kind === 'found' && check.path === target ? name : strip(target);
  } else {
    text = `${written.startsWith('/') ? '/' : ''}${strip(target)}`;
  }
  // Keep the Unicode form the link was written in (10 #13).
  text = link.rawPath === link.rawPath.normalize('NFD') && link.rawPath !== link.rawPath.normalize('NFC') ? text.normalize('NFD') : text.normalize('NFC');
  if (link.form === 'markdown' && !link.angle) {
    const encoded = link.rawPath !== link.path || NEEDS_ENCODING.test(text);
    NEEDS_ENCODING.lastIndex = 0;
    if (encoded) text = encodePath(text);
  }
  return text;
}

/**
 * The link with its path part replaced, if it is certain to be the same link (form, embed,
 * display text, subpath) naming `target` from `source` (both after the rename); otherwise
 * undefined. Guards against names that break the link syntax (`]]`, `|`, `#`, a trailing space)
 * or turn it into something else (comments, math).
 */
function rewrittenToken(link: LinkRef, newText: string, source: string, target: string, after: LinkResolver): string | undefined {
  // A quoted frontmatter value must stay one YAML string.
  if (link.frontmatter && /["'\\]/.test(newText)) return undefined;
  const token = link.token.slice(0, link.pathStart - link.start) + newText + link.token.slice(link.pathEnd - link.start);
  const found = extractLinks(token);
  const again = found[0];
  if (found.length !== 1 || again === undefined || again.start !== 0 || again.end !== token.length) return undefined;
  if (again.form !== link.form || again.embed !== link.embed || again.angle !== link.angle) return undefined;
  if (again.rawPath !== newText || again.subpath !== link.subpath || again.display !== link.display) return undefined;
  const resolution = after.resolve(again, source);
  return resolution.kind === 'found' && resolution.path === target ? token : undefined;
}

/**
 * The edits a set of renames needs: links to renamed files elsewhere in the vault, and
 * relative links inside moved Markdown files. Folder renames apply to every file under them.
 */
export function planRename(index: LinkIndex, renames: readonly Rename[]): RenamePlan {
  // Every moved file, old path -> new path.
  const moved = new Map<string, string>();
  const files = [...index.files()];
  for (const { from, to } of renames) {
    for (const path of files) {
      if (path === from) moved.set(path, to);
      else if (path.startsWith(`${from}/`)) moved.set(path, `${to}${path.slice(from.length)}`);
    }
  }
  const newPathOf = (path: string): string => moved.get(path) ?? path;
  const after = new LinkResolver(files.map(newPathOf));
  const resolveAfter = (link: LinkRef, source: string): LinkResolution => after.resolve(link, newPathOf(source));

  const edits = new Map<string, LinkEdit[]>();
  const unchanged: Unchanged[] = [];
  const handled = new Set<LinkRef>();
  const addEdit = (source: string, link: LinkRef, newText: string, target: string): void => {
    if (newText === link.rawPath) return;
    const newToken = rewrittenToken(link, newText, newPathOf(source), target, after);
    if (newToken === undefined) {
      unchanged.push({ source, link, reason: 'unsafe' });
      return;
    }
    let list = edits.get(source);
    if (list === undefined) edits.set(source, (list = []));
    list.push({ line: link.line, start: link.pathStart, end: link.pathEnd, newText, tokenStart: link.start, tokenEnd: link.end, token: link.token, newToken });
  };

  // 1. Links that point at a moved file (2.4).
  for (const [oldPath, newPath] of moved) {
    for (const { source, link } of index.incoming(oldPath)) {
      handled.add(link);
      addEdit(source, link, newPathText(link, newPathOf(source), newPath, after, matchedNoteRelative(link, source, oldPath)), newPath);
    }
    for (const { source, link } of index.ambiguousTo(oldPath)) {
      if (handled.has(link)) continue;
      handled.add(link);
      unchanged.push({ source, link, reason: 'ambiguous' });
    }
  }

  // 2. Relative links inside moved files whose target did not move (3.2 #2).
  for (const [oldPath] of moved) {
    for (const { link, resolution } of index.outgoing(oldPath)) {
      if (handled.has(link) || resolution.kind !== 'found') continue;
      const noteRelative = matchedNoteRelative(link, oldPath, resolution.path);
      if (!(/^\.\.?\//.test(writtenPath(link)) || noteRelative)) continue;
      handled.add(link);
      addEdit(oldPath, link, newPathText(link, newPathOf(oldPath), newPathOf(resolution.path), after, noteRelative), newPathOf(resolution.path));
    }
  }

  // 3. Links not about the renamed files whose resolution the new names would change (3.2 #4).
  // A moved note's own links are checked too: among same-named files the one in the linking
  // note's folder wins (2.2), so moving the note can change what they name.
  const newNames = new Set([...moved.values()].map((p) => comparable(basename(p))));
  for (const source of files) {
    for (const { link, resolution } of index.outgoing(source)) {
      if (handled.has(link) || !(moved.has(source) || candidateNames(link, source).some((n) => newNames.has(n)))) continue;
      const before = resolution.kind === 'found' ? newPathOf(resolution.path) : resolution.kind;
      const now = resolveAfter(link, source);
      const nowKey = now.kind === 'found' ? now.path : now.kind;
      if (nowKey !== before) unchanged.push({ source, link, reason: 'wouldChange' });
    }
  }

  const plan: FileEdits[] = [...edits].map(([path, list]) => ({
    path,
    newPath: newPathOf(path),
    edits: list.sort((a, b) => a.line - b.line || a.start - b.start),
  }));
  plan.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: plan, unchanged, count: plan.reduce((n, f) => n + f.edits.length, 0) };
}

export type { IncomingLink };
