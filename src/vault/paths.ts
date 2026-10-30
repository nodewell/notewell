// Vault root detection over plain path strings (core.md 3.1). No VS Code API.
// Paths may use either separator; comparisons are segment-aware and, when the
// file system is case-insensitive, ignore case.

export const OBSIDIAN_DIR = '.obsidian';

/** Converts to forward slashes and resolves `.`, `..`, duplicate and trailing slashes. */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const absolute = slashed.startsWith('/');
  const out: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}

/** Vault roots for the given paths of `.obsidian` folders (or files directly inside them). */
export function vaultRootsFromObsidianPaths(paths: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const raw of paths) {
    const segments = normalizePath(raw).split('/');
    const index = segments.lastIndexOf(OBSIDIAN_DIR);
    // Accept `<root>/.obsidian` and `<root>/.obsidian/<file>` only.
    if (index < 0 || index < segments.length - 2) continue;
    roots.add(segments.slice(0, index).join('/') || '/');
  }
  return [...roots];
}

export interface VaultIndexOptions {
  readonly caseInsensitive: boolean;
}

export interface VaultIndex {
  /** Normalized vault roots, as given (case preserved). */
  readonly roots: readonly string[];
  /** Root of the closest enclosing vault, or undefined when the path is in no vault. */
  vaultOf(path: string): string | undefined;
}

const DRIVE = /^(\/?)([A-Za-z]):(?=\/|$)/;

/** Comparison form of a normalized path: drive letters always ignore case, the rest when the file system does. */
function comparable(path: string, options: VaultIndexOptions): string {
  return options.caseInsensitive ? path.toLowerCase() : path.replace(DRIVE, (_, slash: string, drive: string) => `${slash}${drive.toLowerCase()}:`);
}

/**
 * `path` relative to `root` (forward slashes, no leading slash, case as in `path`), or undefined
 * unless it is strictly inside `root`. Either may use either separator.
 */
export function relativePath(root: string, path: string, options: VaultIndexOptions): string | undefined {
  const base = normalizePath(root);
  const target = normalizePath(path);
  if (base.startsWith('/') !== target.startsWith('/')) return undefined;
  const baseSegments = base.split('/').filter((s) => s !== '');
  const segments = target.split('/').filter((s) => s !== '');
  if (segments.length <= baseSegments.length) return undefined;
  const head = `/${segments.slice(0, baseSegments.length).join('/')}`;
  if (comparable(head, options) !== comparable(`/${baseSegments.join('/')}`, options)) return undefined;
  return segments.slice(baseSegments.length).join('/');
}

/** Whether two paths name the same file, compared as the file system does. */
export function samePath(a: string, b: string, options: VaultIndexOptions): boolean {
  return comparable(normalizePath(a), options) === comparable(normalizePath(b), options);
}

export function createVaultIndex(roots: Iterable<string>, options: VaultIndexOptions): VaultIndex {
  const key = (p: string): string => comparable(p, options);
  const byKey = new Map<string, string>();
  for (const root of roots) {
    const normalized = normalizePath(root);
    if (!byKey.has(key(normalized))) byKey.set(key(normalized), normalized);
  }
  // Longest first, so the first match is the closest ancestor.
  const entries = [...byKey].sort((a, b) => b[0].length - a[0].length);

  return {
    roots: entries.map(([, root]) => root),
    vaultOf(path) {
      const target = key(normalizePath(path));
      for (const [rootKey, root] of entries) {
        if (target === rootKey) return root;
        const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
        if (target.startsWith(prefix)) return root;
      }
      return undefined;
    },
  };
}
