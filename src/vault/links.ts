// Link target resolution shared by every feature (links.md 2.2). Pure: vault-relative POSIX
// paths in, the file a link names out. Never creates files.

/** How the link was written: wikilinks and Markdown links resolve slightly differently. */
export type LinkForm = 'wikilink' | 'markdown';

export interface LinkTarget {
  readonly form: LinkForm;
  /**
   * The path part only: no `#heading` / `^block`, and for Markdown links already
   * percent-decoded (core token `path`). Wikilink text may still carry a subpath; it is cut.
   */
  readonly path: string;
}

export type LinkResolution =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'missing' }
  /** More than one file fits and the rule for choosing is not confirmed (links.md 10 #4). */
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] };

/**
 * Paths Obsidian does not treat as vault files: any file or folder whose name starts with a dot
 * (`.obsidian/`, `.trash/`, `.git/`, ...). They are never link targets (links.md 2.2) nor indexed.
 */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/** Comparison form: NFC (macOS may hand out NFD names, links.md 10 #13) and case-insensitive. */
export function comparable(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function normalize(path: string): string | undefined {
  const out: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined; // leaves the vault
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Names to try for a written path: `.md` first unless it already ends in `.md`, then as written. */
function variants(path: string): string[] {
  if (/\.md$/i.test(path)) return [path];
  // Without a note of that name, the path as written (an attachment, also one without extension).
  return [`${path}.md`, path];
}

/**
 * The file among several that a link names, as Obsidian 1.12 picks it (links.md 2.2, checked
 * 2026-10-21): the file at the vault-root path the link spells (`rootPath`: `[[Note]]` ->
 * `Note.md`), else the only one in the linking file's folder. Obsidian's choice beyond that is
 * not a rule we could confirm, so more than one remaining match is ambiguous instead of guessed.
 */
export function chooseAmongDuplicates(matches: readonly string[], fromFile: string, rootPath?: string): LinkResolution {
  if (matches.length === 0) return { kind: 'missing' };
  if (matches.length === 1) return { kind: 'found', path: matches[0]! };
  if (rootPath !== undefined) {
    const atRoot = matches.filter((file) => comparable(file) === comparable(rootPath));
    if (atRoot.length === 1) return { kind: 'found', path: atRoot[0]! };
  }
  const folder = comparable(dirname(fromFile));
  const near = matches.filter((file) => comparable(dirname(file)) === folder);
  if (near.length === 1) return { kind: 'found', path: near[0]! };
  return { kind: 'ambiguous', paths: [...matches].sort() };
}

/** The written path part of a link, cleaned up; '' when it names no file (same note). */
export function writtenPath(target: LinkTarget): string {
  let written = target.path;
  if (target.form === 'wikilink') {
    const hash = written.indexOf('#');
    if (hash !== -1) written = written.slice(0, hash);
  }
  return written.trim().replace(/\\/g, '/');
}

/**
 * Comparable file names a link could match (`.md` added as in resolution), used by the
 * link index to find links whose resolution may change when such a file appears or goes.
 */
export function candidateNames(target: LinkTarget, fromFile: string): string[] {
  const written = writtenPath(target);
  if (written === '') return [];
  const base = /^\.\.?\//.test(written) ? normalize(`${dirname(fromFile)}/${written}`) : normalize(written);
  if (base === undefined || base === '') return [];
  return variants(base).map((name) => comparable(basename(name)));
}

const excluded = isHiddenPath;

function addTo(map: Map<string, string[]>, id: string, path: string): void {
  const list = map.get(id);
  if (list === undefined) map.set(id, [path]);
  else if (!list.includes(path)) list.push(path);
}

function removeFrom(map: Map<string, string[]>, id: string, path: string): void {
  const list = map.get(id);
  if (list === undefined) return;
  const rest = list.filter((p) => p !== path);
  if (rest.length === 0) map.delete(id);
  else map.set(id, rest);
}

/**
 * Resolution over a changing set of vault files (vault-relative paths), with lookups by path
 * and by file name so a vault of thousands of files resolves each link in near-constant time.
 * - Without `/`: by file name anywhere in the vault.
 * - With `/`: by vault-relative path, also as a trailing path (`folder/note` matches
 *   `a/folder/note.md`).
 * - `./` / `../` (Markdown links and wikilinks): relative to the linking file only. A leading `/` or a plain path:
 *   the vault-root path first, then as above.
 * Comparison ignores case and Unicode normalization; `.obsidian/`, `.trash/` and paths that
 * leave the vault never match.
 */
export class LinkResolver {
  readonly #byPath = new Map<string, string[]>();
  readonly #byName = new Map<string, string[]>();

  constructor(files: Iterable<string> = []) {
    for (const file of files) this.add(file);
  }

  add(path: string): void {
    if (excluded(path)) return;
    addTo(this.#byPath, comparable(path), path);
    addTo(this.#byName, comparable(basename(path)), path);
  }

  remove(path: string): void {
    removeFrom(this.#byPath, comparable(path), path);
    removeFrom(this.#byName, comparable(basename(path)), path);
  }

  resolve(target: LinkTarget, fromFile: string): LinkResolution {
    const written = writtenPath(target);
    if (written === '') return { kind: 'missing' };
    const exact = (path: string): string[] => this.#byPath.get(comparable(path)) ?? [];

    if (/^\.\.?\//.test(written)) {
      const relative = normalize(`${dirname(fromFile)}/${written}`);
      if (relative === undefined) return { kind: 'missing' };
      for (const name of variants(relative)) {
        const found = exact(name);
        if (found.length > 0) return chooseAmongDuplicates(found, fromFile);
      }
      return { kind: 'missing' };
    }

    const rooted = normalize(written);
    if (rooted === undefined || rooted === '') return { kind: 'missing' };
    if (target.form === 'markdown' || written.startsWith('/')) {
      for (const name of variants(rooted)) {
        const found = exact(name);
        if (found.length > 0) return chooseAmongDuplicates(found, fromFile);
      }
    }
    for (const name of variants(rooted)) {
      const wanted = comparable(name);
      const matches = (this.#byName.get(comparable(basename(name))) ?? []).filter((file) => {
        const id = comparable(file);
        return id === wanted || id.endsWith(`/${wanted}`);
      });
      if (matches.length > 0) return chooseAmongDuplicates(matches, fromFile, name);
    }
    return { kind: 'missing' };
  }
}

/** One-off resolution against a list of vault files (see LinkResolver). */
export function resolveLink(target: LinkTarget, files: readonly string[], fromFile: string): LinkResolution {
  return new LinkResolver(files).resolve(target, fromFile);
}
