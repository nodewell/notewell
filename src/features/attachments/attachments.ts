// Attachment paste and drop (links.md 4). Pure: vault-relative POSIX paths in, the folder, the
// file name and the embed link to insert out. The VS Code part (index.ts) writes the file.
import type { NewLinkFormat } from '../../vault/settings.ts';

/** Above this size a paste or drop asks first (links.md 10 #9). */
export const CONFIRM_BYTES = 50 * 1024 * 1024;

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const join = (...parts: string[]): string => parts.filter((p) => p !== '').join('/');

/**
 * `path` as a vault-relative folder ('' = the vault root), or undefined when it is absolute
 * outside the vault (drive letter, scheme, UNC), leaves the vault through `..`, or enters a
 * hidden (dot) folder.
 */
function vaultFolder(path: string): string | undefined {
  const posix = path.replace(/\\/g, '/');
  if (/^[A-Za-z][\w+.-]*:/.test(posix) || posix.startsWith('//')) return undefined;
  const out: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    // Windows trims trailing dots and spaces; a segment like ".. " would act as "..". Hidden
    // folders (`.obsidian`, `.trash`, ...) are not vault folders and are never written to.
    if (/^[. ]+$/.test(segment) || segment.startsWith('.')) return undefined;
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Where a new attachment for the note at `notePath` goes (links.md 4.2), as a vault-relative
 * folder ('' = vault root), or undefined when the setting points outside the vault.
 * - '', '/' (or nothing): the vault root
 * - './': the note's folder; './name': `name` under the note's folder
 * - anything else: that folder from the vault root
 * `override` is the VS Code setting notewell.attachments.folder (same syntax), used when set.
 */
export function attachmentFolder(attachmentFolderPath: string, notePath: string, override = ''): string | undefined {
  const value = (override.trim() !== '' ? override : attachmentFolderPath).trim();
  if (value === '' || value === '/') return '';
  if (value === '.' || value === './' || value.startsWith('./')) return vaultFolder(join(dirname(notePath), value.slice(1)));
  return vaultFolder(value);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `Pasted image YYYYMMDDHHmmss.<ext>` in local time, as Obsidian names pasted images. */
export function pastedImageName(now: Date, extension: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${extension}`;
}

/** File extension for a pasted clipboard image's MIME type. */
export function imageExtension(mime: string): string | undefined {
  const known: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
  };
  return known[mime.toLowerCase()];
}

/**
 * A file name usable on every platform and in a link: path separators (only the last part is
 * kept) and characters Windows refuses or that end a link path (`#` subpath, `^` block, `[` `]`,
 * `|` alias) become `-`; leading spaces and trailing dots and spaces are dropped. Undefined when
 * nothing is left.
 */
export function safeFileName(name: string): string | undefined {
  const base = basename(name.replace(/\\/g, '/'));
  // Only dots and spaces ("..", ". ."): no name at all.
  if (/^[. ]*$/.test(base)) return undefined;
  const cleaned = base
    .replace(/[<>:"|?*#^[\]\u0000-\u001f]/g, '-')
    // No leading spaces (a link would trim them); a leading dot (a hidden file Obsidian does not
    // show) gets a name in front, so `.png` keeps its extension as `file.png`.
    .replace(/^\s+/, '')
    .replace(/^\./, 'file.')
    .replace(/[. ]+$/, '');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? undefined : cleaned;
}

/**
 * The first free name: `name`, then `base 1.ext`, `base 2.ext`, ... (links.md 4.3; Obsidian's
 * own duplicate format is not confirmed yet, links.md 10 #8 — only this function changes).
 * `taken` compares however the file system does (the caller passes a case-insensitive check
 * where needed).
 */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = `${base} ${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Relative path from folder `from` to `to` (both vault-relative). */
function relative(from: string, to: string): string {
  const a = from === '' ? [] : from.split('/');
  const b = to.split('/');
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}

/**
 * Markdown link destination: `%` first, then the characters that end or break a destination
 * (space, parentheses, angle brackets, `#` and `?`, brackets and `|`) or would make Obsidian read
 * the text as something else (`$` math, backtick code) are percent-encoded; other characters stay
 * readable (confidence: Obsidian's exact encoding is to be checked, links.md 10 #1).
 */
export function encodeLinkPath(path: string): string {
  return path.replace(/[% ()<>#?[\]|$`]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A path a wikilink cannot hold as written: subpath, block, alias or bracket characters, edge
 * spaces, and text Obsidian reads as a comment (`%%`, `<!--`), math (`$`) or code (backtick).
 */
const WIKILINK_UNSAFE = /[#^[\]|$`]|%%|<!--|^\s|\s$/;

export interface LinkSettings {
  readonly useMarkdownLinks: boolean;
  readonly newLinkFormat: NewLinkFormat;
}

/**
 * The embed to insert for `attachmentPath` in the note at `notePath` (links.md 4.4):
 * `![[target]]` or `![](encoded)`. `vaultFiles` (vault-relative) decides whether the short form
 * is unique; the new file counts itself.
 */
export function attachmentLink(settings: LinkSettings, notePath: string, attachmentPath: string, vaultFiles: readonly string[]): string {
  const name = basename(attachmentPath);
  const lower = name.normalize('NFC').toLowerCase();
  const unique = !vaultFiles.some((f) => basename(f).normalize('NFC').toLowerCase() === lower && f !== attachmentPath);
  // Explicitly relative (`./`, `../`): a bare name would be read from the vault root or by name.
  let relativeTarget = relative(dirname(notePath), attachmentPath);
  if (!relativeTarget.startsWith('../')) relativeTarget = `./${relativeTarget}`;
  let target: string;
  if (settings.newLinkFormat === 'relative') target = relativeTarget;
  else if (settings.newLinkFormat === 'absolute') target = attachmentPath;
  else target = unique ? name : attachmentPath;
  // A file at the vault root whose name is used elsewhere too: its vault path is only its name,
  // which a wikilink reads by name (ambiguous). The relative path names it exactly.
  if (!target.includes('/') && !unique && !settings.useMarkdownLinks) target = relativeTarget;
  // A vault file named so that a wikilink would break is embedded as a Markdown link instead.
  return settings.useMarkdownLinks || WIKILINK_UNSAFE.test(target) ? `![](${encodeLinkPath(target)})` : `![[${target}]]`;
}

/** The URIs in a `text/uri-list` (RFC 2483): one per line, `#` lines are comments. */
export function uriListEntries(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Joins the folder and the file name into the vault-relative attachment path. */
export function attachmentPath(folder: string, name: string): string {
  return join(folder, name);
}
