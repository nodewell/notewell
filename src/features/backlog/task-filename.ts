// The file name the Backlog.md CLI gives a task whose title changed (CLI 1.56.0, backlog.md 5.2):
// `<id> - <title>.md` in the same folder, the ID part lowercased as in the old name, the title
// cleaned as the CLI does. Pure: no VS Code, no file system.
import { lineTexts, parseLines } from '../../core/lines.ts';
import { taskData } from './task-file.ts';
import { idKey } from './task-index.ts';

/** The ID part of a task file name, as the CLI reads it (`task-12 - Title.md` -> `task-12`). */
const FILENAME_ID = /^([a-zA-Z]+)-([a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*) -/;

/** A title as the CLI puts it in a file name (its `sanitizeFilename`). */
export function titleForFilename(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/['(),!@#$%^&+=[\]{};]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // A punctuation-only title cleans to nothing; the name keeps its `<id> - <title>.md` shape.
  return cleaned || 'untitled';
}

/**
 * The project-relative path the task at `path` moves to when a change turns its text from
 * `before` into `after`; undefined when it stays: the title did not change, the file name's ID
 * part is not the task's ID (the CLI does not repair such a name), or the name is already right.
 */
export function renamedTaskPath(path: string, before: string, after: string, taskPrefix: string): string | undefined {
  const old = taskData(lineTexts(parseLines(before)));
  const now = taskData(lineTexts(parseLines(after)));
  if (old.title === now.title || now.id === null || now.title === '') return undefined;
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const match = FILENAME_ID.exec(name);
  if (match === null || idKey(`${match[1]}-${match[2]}`, taskPrefix) !== idKey(now.id, taskPrefix)) return undefined;
  const renamed = `${`${match[1]}-${match[2]}`.toLowerCase()} - ${titleForFilename(now.title)}.md`;
  return renamed === name ? undefined : `${path.slice(0, slash + 1)}${renamed}`;
}
