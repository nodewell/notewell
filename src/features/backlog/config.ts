// Backlog.md project detection and configuration (backlog.md 2). Pure: the caller supplies a
// reader for files under a workspace folder root. Config files are read line by line with
// yaml-lite (never parsed as YAML) and never written.
import { lineTexts, parseLines } from '../../core/lines.ts';
import { resolveProjectPath } from './paths.ts';
import { fieldOf, parseFields, type Field } from './yaml-lite.ts';

export interface BacklogConfig {
  /** Board columns in order; the last one counts as done. */
  readonly statuses: readonly string[];
  /** Shown for tasks without a status. */
  readonly defaultStatus: string;
  /** ID prefix, as written in the config (`task`); IDs are compared case-insensitively. */
  readonly taskPrefix: string;
  readonly labels: readonly string[];
  readonly projectName: string | null;
  /** Task types (`types:`); the CLI's defaults when missing or empty. */
  readonly types: readonly string[];
  /** Priority order (`priorities:`), highest first; the CLI's defaults when missing or empty. */
  readonly priorities: readonly string[];
}

/** Backlog.md 1.54.0 default task types. */
export const DEFAULT_TASK_TYPES: readonly string[] = ['bug', 'feature', 'enhancement', 'task', 'chore', 'docs', 'spike'];

/** Backlog.md 1.54.0 default priorities, highest first. */
export const DEFAULT_PRIORITIES: readonly string[] = ['High', 'Medium', 'Low'];

export const DEFAULT_CONFIG: BacklogConfig = {
  statuses: ['To Do', 'In Progress', 'Done'],
  defaultStatus: 'To Do',
  taskPrefix: 'task',
  labels: [],
  projectName: null,
  types: DEFAULT_TASK_TYPES,
  priorities: DEFAULT_PRIORITIES,
};

export interface ConfigResult {
  readonly config: BacklogConfig;
  /** Why some keys fell back to defaults; undefined when the config was read fully. */
  readonly error?: string;
  /** The keys that fell back to defaults. */
  readonly unreadable?: readonly string[];
}

/** Detection order at a workspace folder root (backlog.md 2.1). */
export const CONFIG_CANDIDATES = [
  /** Task folder is its `backlog_directory:` value. */
  { file: 'backlog.config.yml', directory: null },
  { file: 'backlog/config.yml', directory: 'backlog' },
  { file: '.backlog/config.yml', directory: '.backlog' },
] as const;

export const CONFIG_FILES: readonly string[] = CONFIG_CANDIDATES.map((c) => c.file);

export interface DetectedProject {
  /** Config file path relative to the folder root (POSIX). */
  readonly configFile: string;
  /** Task folder relative to the folder root (POSIX), '' for the root itself. */
  readonly directory: string;
  readonly config: BacklogConfig;
  readonly error?: string;
  readonly unreadable?: readonly string[];
}

function texts(text: string): string[] {
  return lineTexts(parseLines(text));
}

function stringList(field: Field | undefined): string[] | undefined {
  if (field === undefined) return undefined;
  if (field.value.kind === 'list') return field.value.items.map((item) => item.value);
  return undefined;
}

function scalar(field: Field | undefined): string | undefined {
  return field?.value.kind === 'scalar' ? field.value.value : undefined;
}

/** Reads the 2.2 keys; a key with an unreadable shape keeps its default and is named in `error`. */
export function parseConfig(text: string): ConfigResult {
  const fields = parseFields(texts(text));
  const bad: string[] = [];
  const read = <T>(name: string, get: (field: Field) => T | undefined, valid: (value: T) => boolean = () => true): T | undefined => {
    const field = fieldOf(fields, name);
    if (field === undefined) return undefined;
    const value = get(field);
    if (value === undefined || !valid(value)) {
      bad.push(name);
      return undefined;
    }
    return value;
  };

  const statuses = read('statuses', stringList, (list) => list.length > 0 && list.every((s) => s.trim() !== '')) ?? DEFAULT_CONFIG.statuses;
  const nonEmpty = (s: string): boolean => s.trim() !== '';
  const defaultStatus = read('default_status', scalar, nonEmpty) ?? statuses[0];
  const taskPrefix = read('task_prefix', scalar, nonEmpty) ?? DEFAULT_CONFIG.taskPrefix;
  const labels = read('labels', (f) => stringList(f) ?? (scalar(f) === '' ? [] : undefined)) ?? DEFAULT_CONFIG.labels;
  const projectName = read('project_name', scalar) ?? null;
  const types = cleanList(read('types', (f) => stringList(f) ?? (scalar(f) === '' ? [] : undefined)) ?? [], DEFAULT_TASK_TYPES);
  // Runs of white space become one space, as `backlog config get priorities` shows them.
  const priorities = cleanList((read('priorities', (f) => stringList(f) ?? (scalar(f) === '' ? [] : undefined)) ?? []).map((p) => p.replace(/\s+/g, ' ')), DEFAULT_PRIORITIES);

  const config: BacklogConfig = { statuses, defaultStatus, taskPrefix, labels, projectName, types, priorities };
  return bad.length === 0 ? { config } : { config, error: `Unreadable keys: ${bad.join(', ')}`, unreadable: bad };
}

/** As the CLI reads `types` and `priorities`: trimmed, blanks and case-insensitive repeats dropped, defaults when empty. */
function cleanList(list: readonly string[], defaults: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const type = raw.trim();
    const key = type.toLowerCase();
    if (type === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(type);
  }
  return out.length > 0 ? out : defaults;
}

/**
 * The `backlog_directory:` value as a POSIX path relative to the folder root, or null when it
 * is missing, absolute or leaves the root.
 */
export function backlogDirectory(text: string): string | null {
  const raw = scalar(fieldOf(parseFields(texts(text)), 'backlog_directory'));
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === '') return null;
  // `.` is the folder itself.
  if (/^\.[\\/]*$/.test(value)) return '';
  // No `..` at all (not even `a/../b`), nor names Windows reads as one (`...`, `.. `).
  if (value.replaceAll('\\', '/').split('/').some((part) => part !== '' && part !== '.' && part.replace(/[. ]+$/, '') === '')) return null;
  // Absolute paths, drives, UNC paths, schemes and NTFS streams are refused there.
  return resolveProjectPath(value) ?? null;
}

/**
 * The folder's project: the first candidate that exists (backlog.md 2.1). A
 * `backlog.config.yml` whose `backlog_directory` is unusable is skipped.
 * `read` returns the file text, or undefined when it does not exist.
 */
export async function detectProject(read: (path: string) => Promise<string | undefined>): Promise<DetectedProject | null> {
  for (const candidate of CONFIG_CANDIDATES) {
    const text = await read(candidate.file);
    if (text === undefined) continue;
    const directory = candidate.directory ?? backlogDirectory(text);
    if (directory === null) continue;
    return { configFile: candidate.file, directory, ...parseConfig(text) };
  }
  return null;
}
