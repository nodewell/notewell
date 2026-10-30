// Where a new note goes (daily-notes.md 4.2, 6, 8), shared by the features that create notes.
// Pure; the checks against the file system are in new-file-check.ts.
import type { ObsidianAppSettings } from './settings.ts';

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Characters Windows (and so Obsidian) refuses in file names (daily-notes.md 4.2). */
const INVALID_NAME_CHARS = /[\\:*?"<>|]/;

/** Device names Windows reserves, also with an extension (`CON.md`). */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.[^.]*)?$/i;

/**
 * A vault-relative path as written in a setting or link, normalized (`/` separators, no `.`,
 * a leading `/` meaning the vault root), or undefined when it leaves the vault through `..`,
 * enters a hidden folder (`.obsidian`, `.trash`: not vault files), or has a name Windows refuses
 * (the characters above, control characters, a trailing dot or space).
 */
export function vaultPath(path: string): string | undefined {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    if (RESERVED_NAMES.test(segment) || segment.startsWith('.') || INVALID_NAME_CHARS.test(segment) || /[\u0000-\u001f\u007f]/.test(segment) || /[. ]$/.test(segment)) return undefined;
    out.push(segment);
  }
  return out.join('/');
}

/** Attachment types Obsidian opens itself: a link to a missing one does not make a note. */
const ATTACHMENT = /\.(png|jpe?g|gif|bmp|svg|webp|avif|pdf|mp3|wav|m4a|ogg|flac|3gp|webm|mp4|mov|ogv|mkv|canvas|base)$/i;

/**
 * Path of the note a link to a missing target would create (daily-notes.md 6): a path with a
 * folder is taken from the vault root (`./`, `../` from the linking note), a bare name goes
 * where Obsidian puts new notes (`newFileLocation`). `.md` is added unless written. Undefined
 * when the result is not a note path inside the vault.
 */
export function newNotePath(settings: ObsidianAppSettings, fromFile: string, linkPath: string): string | undefined {
  const written = linkPath.trim();
  if (written === '' || ATTACHMENT.test(written)) return undefined;
  let joined: string;
  if (/^\.\.?\//.test(written)) joined = `${dirname(fromFile)}/${written}`;
  else if (written.includes('/')) joined = written;
  else if (settings.newFileLocation === 'current') joined = `${dirname(fromFile)}/${written}`;
  else if (settings.newFileLocation === 'folder') {
    const folder = vaultPath(settings.newFileFolderPath);
    if (folder === undefined) return undefined;
    joined = `${folder}/${written}`;
  } else joined = written;
  const path = vaultPath(/\.md$/i.test(joined) ? joined : `${joined}.md`);
  return path === undefined || basename(path) === '.md' ? undefined : path;
}
