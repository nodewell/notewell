// What to do when VS Code renames or moves files (links.md 3). VS Code-free: the adapter
// (index.ts) supplies vaults, indexes, settings, file texts and the user's answer through ports.
// Edits come from the index, so before they are offered each file's current text is checked:
// a file that changed since it was indexed (or cannot be read safely) is left alone.
import { joinLines, lineTexts, parseLines } from '../../core/lines.ts';
import { extractLinks, type LinkIndex } from '../../vault/link-index.ts';
import { planRename, type LinkEdit, type RenamePlan } from './rewrite.ts';

/** `notewell.links.updateOnRename`. */
export type UpdateMode = 'obsidian' | 'always' | 'prompt' | 'never';

/** One file operation as VS Code reports it (URIs as strings with `/` paths). */
export interface FileRename {
  readonly oldPath: string;
  readonly newPath: string;
}

export interface RenamePorts {
  /** The vault root containing `path`, or undefined outside every vault. */
  readonly vaultOf: (path: string) => string | undefined;
  /** The vault's link index, or undefined while it is still being built. */
  readonly indexFor: (root: string) => LinkIndex | undefined;
  /** Read again after the question: a switch to 'never' meanwhile cancels the update. */
  readonly mode: () => UpdateMode;
  /** `notewell.links.enabled`, read again after the question (absent: on). */
  readonly enabled?: () => boolean;
  readonly trusted: () => boolean;
  /** Asks to update `links` links in `files` files ('prompt' mode only); true = update. */
  readonly confirm: (links: number, files: number) => Promise<boolean>;
  /**
   * The file's text as an edit would see it: the open document's text, else the file decoded
   * with `readableText`; undefined when it cannot be read or is not plain UTF-8 text.
   */
  readonly readText: (path: string) => Promise<string | undefined>;
  /** Files found changed since they were indexed: read them again. */
  readonly reindex: (paths: readonly string[]) => void;
}

/** A link edit in a file, by absolute path (the file as it is before the rename). */
export interface PlannedEdit extends LinkEdit {
  readonly path: string;
}

export type RenameNotice =
  | { readonly kind: 'untrusted' }
  | { readonly kind: 'leftVault'; readonly links: number }
  | { readonly kind: 'notReady' }
  | { readonly kind: 'unchanged'; readonly links: number }
  /** Files left alone because their text changed since it was indexed or cannot be read safely. */
  | { readonly kind: 'stale'; readonly files: number }
  /** Notes too large to read for links: links in them to the renamed files are not updated. */
  | { readonly kind: 'tooLarge'; readonly files: number };

export interface RenameOutcome {
  readonly edits: readonly PlannedEdit[];
  /** Files changed (absolute paths before the rename) and where they end up. */
  readonly files: readonly { readonly path: string; readonly newPath: string }[];
  readonly notices: readonly RenameNotice[];
}

/**
 * File bytes as text for editing: strict UTF-8 (a UTF-8 BOM is dropped, as VS Code shows it),
 * without NUL characters. Anything else (UTF-16, Latin-1, binary) is undefined: such a file
 * would be damaged by editing and saving it as UTF-8.
 */
export function readableText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return text.includes('\0') ? undefined : text;
}

/**
 * Whether writing `path` could land outside the vault `root` (links.md 8): it is not inside
 * the root, or a folder on the way or the file itself is a symbolic link (`isLink`), or a
 * check fails. Such files are never edited.
 */
export async function throughSymlink(root: string, path: string, isLink: (path: string) => Promise<boolean>): Promise<boolean> {
  const base = root.replace(/\/$/, '');
  if (!path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return true;
  const segments = path.slice(base.length + 1).split('/');
  try {
    for (let i = 1; i <= segments.length; i++) {
      if (await isLink(`${base}/${segments.slice(0, i).join('/')}`)) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/** Whether VS Code reads text with this encoding as UTF-8 (undefined: a host without the API). */
function utf8Encoding(encoding: string | undefined): boolean {
  return encoding === undefined || encoding === 'utf8' || encoding === 'utf8bom';
}

/** An open document's text for editing, only when VS Code read it as UTF-8. */
export function documentText(text: string, encoding: string | undefined): string | undefined {
  return utf8Encoding(encoding) ? text : undefined;
}

/** How VS Code will decode a closed file it opens to apply an edit (files.encoding, files.autoGuessEncoding). */
export interface OpenEncoding {
  readonly encoding: string | undefined;
  readonly autoGuess: boolean;
}

/**
 * A closed file's text for editing. VS Code opens it with `files.encoding` (or a guess) to
 * apply the edit and may save it in that encoding, so the file is edited only when that read
 * matches UTF-8: a UTF-8 default without guessing, a UTF-8 BOM (always detected), or plain
 * ASCII under a single-byte or multi-byte legacy default (read alike; never under UTF-16).
 */
export function closedFileText(bytes: Uint8Array, open: OpenEncoding): string | undefined {
  const text = readableText(bytes);
  if (text === undefined) return undefined;
  if (utf8Encoding(open.encoding) && !open.autoGuess) return text;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return text;
  if (open.encoding?.startsWith('utf16') === true) return undefined;
  return bytes.every((b) => b < 0x80) ? text : undefined;
}

interface FileEdits {
  readonly path: string;
  readonly newPath: string;
  readonly edits: readonly PlannedEdit[];
}

interface Checked {
  readonly files: FileEdits[];
  readonly stale: string[];
  /** Links dropped because the edited file would not read as the same links. */
  readonly unsafe: number;
}

const linkTexts = (text: string): string[] => extractLinks(text).map((l) => `${l.line}:${l.token}`);

/**
 * Keeps the files whose current text still holds every indexed link where the edits expect it
 * and that, edited, read as the same links with only the planned ones changed. A lone CR is a
 * line break for VS Code but not for the line model, so such files are left alone too.
 */
async function check(files: readonly FileEdits[], readText: RenamePorts['readText']): Promise<Checked> {
  const kept: FileEdits[] = [];
  const stale: string[] = [];
  let unsafe = 0;
  for (const file of files) {
    const text = await readText(file.path);
    if (text === undefined || /\r(?!\n)/.test(text)) {
      stale.push(file.path);
      continue;
    }
    const doc = parseLines(text);
    const lines = lineTexts(doc);
    if (!file.edits.every((e) => lines[e.line]?.slice(e.tokenStart, e.tokenEnd) === e.token)) {
      stale.push(file.path);
      continue;
    }
    const edited = doc.lines.map((line) => ({ ...line }));
    for (const e of [...file.edits].sort((a, b) => b.line - a.line || b.start - a.start)) {
      const line = edited[e.line]!;
      line.text = line.text.slice(0, e.start) + e.newText + line.text.slice(e.end);
    }
    const expected = extractLinks(text).map((l) => `${l.line}:${file.edits.find((e) => e.line === l.line && e.tokenStart === l.start)?.newToken ?? l.token}`);
    const actual = linkTexts(joinLines({ bom: doc.bom, lines: edited }));
    if (actual.length !== expected.length || actual.some((t, i) => t !== expected[i])) {
      unsafe += file.edits.length;
      continue;
    }
    kept.push(file);
  }
  return { files: kept, stale, unsafe };
}

const relative = (root: string, path: string): string => path.slice(root.replace(/\/$/, '').length + 1);
const join = (root: string, path: string): string => `${root.replace(/\/$/, '')}/${path}`;

/**
 * The link edits for a batch of renames, grouped by vault (links.md 3.1-3.3):
 * - untrusted workspace: no edits, a notice (8);
 * - a move out of the vault or into another vault: no edits, a warning with the number of
 *   links that will break (10 #6);
 * - otherwise the rewrite plan, applied always, after asking, or never (3.3). Links left
 *   unchanged because they are or would become ambiguous, or cannot be rewritten safely, are
 *   counted in a notice; files whose text changed since they were indexed are skipped,
 *   reported and read again. Files are checked before asking and again after the answer.
 */
export async function planFileRenames(renames: readonly FileRename[], ports: RenamePorts): Promise<RenameOutcome> {
  const notices: RenameNotice[] = [];
  const byVault = new Map<string, { from: string; to: string }[]>();
  let leaving = 0;
  for (const { oldPath, newPath } of renames) {
    const root = ports.vaultOf(oldPath);
    if (root === undefined) continue;
    const index = ports.indexFor(root);
    if (ports.vaultOf(newPath) !== root) {
      const from = relative(root, oldPath);
      if (index !== undefined) {
        for (const path of index.files()) if (path === from || path.startsWith(`${from}/`)) leaving += index.incoming(path).length;
      }
      continue;
    }
    const list = byVault.get(root) ?? [];
    list.push({ from: relative(root, oldPath), to: relative(root, newPath) });
    byVault.set(root, list);
  }
  if (leaving > 0) notices.push({ kind: 'leftVault', links: leaving });
  if (byVault.size === 0) return { edits: [], files: [], notices };

  const plans: { root: string; plan: RenamePlan }[] = [];
  for (const [root, list] of byVault) {
    const index = ports.indexFor(root);
    if (index === undefined) {
      notices.push({ kind: 'notReady' });
      continue;
    }
    plans.push({ root, plan: planRename(index, list) });
    if (index.unreadCount > 0) notices.push({ kind: 'tooLarge', files: index.unreadCount });
  }
  let unchanged = plans.reduce((n, p) => n + p.plan.unchanged.length, 0);
  const stale = new Set<string>();
  const finish = (files: readonly FileEdits[]): RenameOutcome => {
    if (unchanged > 0) notices.push({ kind: 'unchanged', links: unchanged });
    if (stale.size > 0) {
      notices.push({ kind: 'stale', files: stale.size });
      ports.reindex([...stale]);
    }
    return {
      edits: files.flatMap((f) => f.edits),
      files: files.map(({ path, newPath }) => ({ path, newPath })),
      notices,
    };
  };
  let files: FileEdits[] = plans.flatMap(({ root, plan }) =>
    plan.files.map((file) => ({
      path: join(root, file.path),
      newPath: join(root, file.newPath),
      edits: file.edits.map((e) => ({ ...e, path: join(root, file.path) })),
    })),
  );
  if (files.length === 0) return finish([]);

  if (!ports.trusted()) {
    notices.unshift({ kind: 'untrusted' });
    return { edits: [], files: [], notices };
  }
  const mode = ports.mode();
  if (mode === 'never') return finish([]);

  const recheck = async (): Promise<void> => {
    const checked = await check(files, ports.readText);
    for (const path of checked.stale) stale.add(path);
    unchanged += checked.unsafe;
    files = checked.files;
  };
  await recheck();
  if (files.length === 0) return finish([]);
  // Only 'prompt' asks here. Otherwise VS Code's own confirmation of the edits a rename
  // participant returns is the one question (links.md 3.3), so the user is not asked twice.
  if (mode === 'prompt') {
    const count = files.reduce((n, f) => n + f.edits.length, 0);
    if (!(await ports.confirm(count, files.length))) return finish([]);
    // The settings may have changed while the question was open: turned off means no update.
    if (ports.mode() === 'never' || ports.enabled?.() === false) return finish([]);
    // The question may have stayed open while files changed.
    await recheck();
  }
  return finish(files);
}
