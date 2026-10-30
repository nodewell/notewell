// One Backlog panel: turns webview messages into task file edits and sends views back
// (backlog.md 4, 5, 9 #2). VS Code-free; the panel supplies the ports.
import { lineTexts, parseLines, type Line } from '../../core/lines.ts';
import { applyEdits as applyTextEdits, computePatch, type TextEdit } from '../../core/patch.ts';
import { validateWebviewMessage, type ErrorReason, type ExtensionMessage } from './messages.ts';
import { planSetList, planSetScalar } from './field-ops.ts';
import { planSetStatus, planToggleCheck, type OperationPlan } from './operations.ts';
import { planMoveInColumn, type Neighbour } from './ordinal-ops.ts';
import { planAddComment, planSetSection } from './section-ops.ts';
import { parseChecklist, parseComments, parseTaskFile, sectionText, taskData, type SectionName, type TaskFile } from './task-file.ts';
import type { BacklogView, TaskDetail } from './view.ts';
import { changeIsSafe, textAllowed, valueAllowed, type ChangeTarget, type ParsedText } from './write-guard.ts';
import { fieldOf, listOf, scalarOf } from './yaml-lite.ts';

export interface TaskText {
  readonly text: string;
  readonly version: number;
}

export interface TaskChange {
  readonly before: string;
  readonly after: string;
  readonly edits: readonly TextEdit[];
}

/**
 * - `written`: the change is in the file (or in the open editor with unsaved changes)
 * - `stale`: the file changed since it was read; nothing was written
 * - `failed`: nothing was written (the editor or the file system refused)
 */
/**
 * - `readOnly`: the file system refused (read-only, permission denied, locked); nothing changed
 * - `encoding`: an editor holds the file decoded with another encoding than UTF-8
 */
export type WriteResult = 'written' | 'stale' | 'failed' | 'readOnly' | 'encoding';

export interface BacklogPorts {
  /** The current view, or undefined when there is no project to show. */
  readonly view: () => BacklogView | undefined;
  /** Detail of the task at a project-relative path; null when it no longer exists. */
  readonly detail: (path: string) => TaskDetail | null;
  /**
   * Current text of a task file (open document or disk); undefined when it cannot be read,
   * 'encoding' when its bytes are not UTF-8 or an editor decoded it with another encoding.
   */
  readonly readTask: (path: string) => Promise<TaskText | undefined | 'encoding'>;
  /**
   * Writes a change to one task file (backlog.md 5.1): `before` is the text the change was
   * built on (from readTask), `after` the full new text and `edits` the same change as edits.
   * The panel chooses how (editor edit or direct file write) and refuses with 'stale' when the
   * file no longer holds `before`.
   */
  readonly write: (path: string, change: TaskChange) => Promise<WriteResult>;
  /** Configured statuses (config.yml), in their spelling. */
  readonly statuses: () => readonly string[];
  /** Configured priorities (config.yml); the CLI's defaults when not given. */
  readonly priorities?: () => readonly string[];
  readonly post: (message: ExtensionMessage) => void;
  readonly openTask: (path: string) => Promise<void>;
  /** Opens a project-relative path; the panel checks that it stays inside the project. */
  readonly openPath: (path: string) => Promise<void>;
  /** Opens an http(s) URL; the session only passes those. */
  readonly openUrl: (url: string) => Promise<void>;
  readonly now: () => Date;
  /** Stores where the detail pane sits (backlog.md 4.1); the setting change redraws the panel. */
  readonly setDetailPosition: (position: 'bottom' | 'right') => Promise<void>;
  /** Remembers list column widths and detail pane shares for the project (backlog.md 4.1, 4.3). */
  readonly saveLayout: (layout: BacklogView['layout']) => Promise<void>;
  /** Every task's dependencies, for the dependency checks of setList (backlog.md 5.4). */
  readonly dependencies: () => DependencyGraph;
  readonly errors: Readonly<Record<ErrorReason, string>>;
}

/** A change made from this panel, as full texts, so undo can restore the bytes exactly. */
interface UndoEntry {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export const UNDO_LIMIT = 50;
/**
 * Characters the undo entries may keep together (each holds the file before and after). Edits
 * of a multi-megabyte task would otherwise keep 50 full copies; the oldest entries go first,
 * the latest change can always be undone.
 */
export const UNDO_CHAR_LIMIT = 32_000_000;

export class BacklogSession {
  readonly #ports: BacklogPorts;
  /** Messages are handled one at a time so each sees the result of the previous one. */
  #queue: Promise<void> = Promise.resolve();
  #pending = 0;
  #selected: string | null = null;
  /** The webview instance of the latest 'ready'; older instances' messages are dropped. */
  #instance: string | undefined;
  readonly #undo: UndoEntry[] = [];

  constructor(ports: BacklogPorts) {
    this.#ports = ports;
  }

  /** Sends the view and, when a task is open in the detail view, its detail (so it follows edits). */
  render(): void {
    const view = this.#ports.view();
    // No project behind the panel any more (config gone, folder removed or unregistered): the
    // webview must stop showing the old board, whose edits could only be refused.
    if (view === undefined) {
      this.#ports.post({ type: 'unavailable' });
      return;
    }
    this.#ports.post({ type: 'render', view });
    if (this.#selected !== null) this.#postDetail(this.#selected);
  }

  /** Handles one raw webview message. Never throws; the returned promise settles after it is handled. */
  handle(raw: unknown): Promise<void> {
    this.#pending++;
    const next = this.#queue.then(() => this.#handle(raw));
    this.#queue = next.catch(() => undefined);
    return next.catch(() => this.#fail('failed')).finally(() => void this.#pending--);
  }

  /** Messages received and not handled yet (quiescence.ts). */
  get busy(): boolean {
    return this.#pending > 0;
  }

  async #handle(raw: unknown): Promise<void> {
    const validated = validateWebviewMessage(raw);
    if (!validated.ok) {
      this.#fail('invalid');
      return;
    }
    const message = validated.message;
    if (message.type === 'ready') this.#instance = message.instance;
    else if (message.instance !== undefined && this.#instance !== undefined && message.instance !== this.#instance) return;
    switch (message.type) {
      case 'ready':
        this.render();
        return;
      case 'showTask':
        this.#selected = message.path;
        this.#postDetail(message.path);
        return;
      case 'hideTask':
        this.#selected = null;
        return;
      case 'openTask':
        await this.#ports.openTask(message.path);
        return;
      case 'openPath':
        await this.#ports.openPath(message.path);
        return;
      case 'openUrl':
        if (isWebUrl(message.url)) await this.#ports.openUrl(message.url);
        else this.#fail('invalid');
        return;
      case 'setStatus': {
        const { path, status, statusLine, fromStatus } = message;
        // The board has no source lines: it names the status it showed instead.
        if (statusLine === '' && fromStatus === undefined) {
          this.#fail('invalid');
          return;
        }
        await this.#edit(path, (texts, file, now) => {
          let expected = statusLine;
          if (statusLine === '') {
            const field = fieldOf(file.fields, 'status');
            if (field === undefined || field.value.kind !== 'scalar' || field.end !== field.line + 1) return { ok: false, reason: 'unsafe' };
            if (field.value.value.toLowerCase() !== fromStatus!.toLowerCase()) return { ok: false, reason: 'stale' };
            expected = texts[field.line];
          }
          return planSetStatus(texts, file, { status, statusLine: expected, statuses: this.#ports.statuses() }, now);
        }, fieldTarget('status', (value) => value?.toLowerCase() === status.toLowerCase()));
        return;
      }
      case 'toggleCheck': {
        const { path, list, line, source, checked } = message;
        await this.#edit(path, (texts, file, now) => planToggleCheck(texts, file, { list, line, source, checked }, now), {
          fields: [],
          sections: [list],
          readsBack: (a, b) => {
            const before = parseChecklist(a.texts, a.file.sections[list]);
            const after = parseChecklist(b.texts, b.file.sections[list]);
            if (before === null || after === null || before.readOnly || after.readOnly || before.items.length !== after.items.length) return false;
            return after.items.every((item, i) => {
              const old = before.items[i];
              return item.line === old.line && item.number === old.number && item.text === old.text && item.checked === (item.line === line ? checked : old.checked);
            });
          },
        });
        return;
      }
      case 'setField': {
        const { path, name, value, expected } = message;
        if (!valueAllowed(value)) {
          this.#fail('invalid');
          return;
        }
        await this.#edit(
          path,
          (texts, file, now) => planSetScalar(texts, file, { name, value: value === '' ? null : value, expected: expected ?? null, priorities: this.#ports.priorities?.() }, now),
          fieldTarget(name, (written, present) => (value === '' ? !present : written === value)),
        );
        return;
      }
      case 'setList': {
        const { path, name, expected } = message;
        // One item per line; surrounding spaces and blank lines are dropped.
        const values = message.values.split('\n').map((v) => v.trim()).filter((v) => v !== '');
        if (!values.every(valueAllowed)) {
          this.#fail('invalid');
          return;
        }
        await this.#edit(path, (texts, file, now) => {
          // A repeated item (in any case) is refused rather than merged, as which spelling to keep
          // is a guess; repeats already in the file may stay, so such a list can still be shortened.
          if (addsRepeat(listOf(file.fields, name), values)) return { ok: false, reason: 'invalid' };
          if (name === 'dependencies' && !dependenciesAllowed(this.#ports.dependencies(), scalarOf(file.fields, 'id'), listOf(file.fields, name), values)) {
            return { ok: false, reason: 'invalid' };
          }
          return planSetList(texts, file, { name, values, expected: expected === undefined ? null : expected.split('\n') }, now);
        }, {
          fields: [name],
          sections: [],
          readsBack: (_, b) => {
            const field = fieldOf(b.file.fields, name);
            if (values.length === 0) return field === undefined || (field.value.kind === 'list' && field.value.items.length === 0);
            const written = listOf(b.file.fields, name);
            return field?.value.kind === 'list' && written.length === values.length && written.every((v, i) => v === values[i]);
          },
        });
        return;
      }
      case 'setSection': {
        const { path, section, text, expected } = message;
        if (!textAllowed(text)) {
          this.#fail('invalid');
          return;
        }
        const wanted = text.trim();
        await this.#edit(path, (texts, file, now) => planSetSection(texts, file, { section, text, expected: expected ?? null }, now), {
          fields: [],
          sections: [section],
          readsBack: (_, b) => (wanted === '' ? b.file.sections[section] === undefined : sectionText(b.texts, b.file.sections[section]) === wanted),
        });
        return;
      }
      case 'addComment': {
        const { path, text, seen } = message;
        if (!textAllowed(text)) {
          this.#fail('invalid');
          return;
        }
        await this.#edit(path, (texts, file, now) => {
          // Not the comments the requester saw: this text may already have been added.
          const comments = file.sections.comments === undefined ? [] : parseComments(texts, file.sections.comments);
          if (comments !== null && comments.length !== seen) return { ok: false, reason: 'stale' };
          return planAddComment(texts, file, { text }, now);
        }, {
          fields: [],
          sections: ['comments'],
          readsBack: (a, b) => {
            const before = a.file.sections.comments === undefined ? [] : parseComments(a.texts, a.file.sections.comments);
            const after = parseComments(b.texts, b.file.sections.comments);
            if (before === null || after === null || after.length !== before.length + 1) return false;
            const added = after[after.length - 1];
            return before.every((c, i) => JSON.stringify(c) === JSON.stringify(after[i])) && added.author === null && added.body === text.trim();
          },
        });
        return;
      }
      case 'moveInColumn':
        await this.#moveInColumn(message.path, message.fromStatus, message.afterPath, message.beforePath);
        return;
      case 'undo':
        await this.#undoLast();
        return;
      case 'setDetailPosition':
        await this.#ports.setDetailPosition(message.position);
        return;
      case 'saveLayout': {
        const { type: _type, bottom, right, ...columns } = message;
        const columnWidths: Record<string, number> = {};
        for (const [column, width] of Object.entries(columns)) if (typeof width === 'number') columnWidths[column] = width;
        const paneSizes: { bottom?: number; right?: number } = {};
        if (bottom !== undefined) paneSizes.bottom = bottom;
        if (right !== undefined) paneSizes.right = right;
        await this.#ports.saveLayout({ columnWidths, paneSizes });
        return;
      }
    }
  }

  /**
   * Plans a change on the current text and writes it only when write-guard confirms that the
   * result differs from the file just as `target` allows (backlog.md 5.1).
   */
  async #edit(path: string, plan: (texts: readonly string[], file: TaskFile, now: Date) => OperationPlan, target: ChangeTarget): Promise<void> {
    const current = await this.#ports.readTask(path);
    if (current === 'encoding') {
      this.#fail('encoding');
      return;
    }
    if (current === undefined) {
      this.#stale();
      return;
    }
    const doc = parseLines(current.text);
    const texts = lineTexts(doc);
    const planned = plan(texts, parseTaskFile(texts), this.#ports.now());
    if (!planned.ok) {
      if (planned.reason === 'stale') this.#stale();
      else this.#fail(planned.reason);
      return;
    }
    if (planned.operations.length === 0) return;
    // The version is compared with itself here (both come from this read); what protects the
    // change is the plan's expectedLines, checked against this text, and then the write port's
    // check that the file still holds it.
    const patch = computePatch(doc, current.version, { ...planned, expectedVersion: current.version });
    if (!patch.ok) {
      if (patch.reason === 'version' || patch.reason === 'content') this.#stale();
      else this.#fail('failed');
      return;
    }
    const after = applyTextEdits(doc, patch.edits);
    if (!changeIsSafe(current.text, after, target)) {
      this.#fail('unsafe');
      return;
    }
    await this.#apply({ path, before: current.text, after }, patch.edits, true);
  }

  /**
   * Moves a task between the cards shown above (`afterPath`) and below (`beforePath`) it in
   * its column (backlog.md 5.4, 9 #3). The board's tasks give the neighbours' columns and
   * ordinals; the file's status must still be the one the card showed.
   */
  async #moveInColumn(path: string, fromStatus: string, afterPath: string | undefined, beforePath: string | undefined): Promise<void> {
    if (afterPath === path || beforePath === path) {
      this.#fail('invalid');
      return;
    }
    const tasks = this.#ports.view()?.tasks ?? [];
    const column = fromStatus.toLowerCase();
    const moved = tasks.find((task) => task.path === path);
    const neighbour = (other: string | undefined): Neighbour | null => {
      if (other === undefined) return undefined;
      const task = tasks.find((candidate) => candidate.path === other);
      return task === undefined || task.status.toLowerCase() !== column ? null : { ordinal: task.ordinal };
    };
    const above = neighbour(afterPath);
    const below = neighbour(beforePath);
    if (moved === undefined || moved.status.toLowerCase() !== column || above === null || below === null) {
      this.#stale();
      return;
    }
    // The neighbours' ordinals come from the index, which may be behind the disk (another tool
    // writing): read them again; any difference makes the move stale rather than misplaced.
    for (const other of [afterPath, beforePath]) {
      if (other === undefined) continue;
      const shown = tasks.find((candidate) => candidate.path === other)!;
      const fresh = await this.#ports.readTask(other);
      const data = fresh === undefined || fresh === 'encoding' ? undefined : taskData(lineTexts(parseLines(fresh.text)));
      if (data === undefined || data.ordinal !== shown.ordinal || (data.status !== null && data.status.toLowerCase() !== column)) {
        this.#stale();
        return;
      }
    }
    await this.#edit(path, (texts, file) => {
      const status = fieldOf(file.fields, 'status');
      if (status?.value.kind === 'scalar' && status.value.value.toLowerCase() !== column) return { ok: false, reason: 'stale' };
      return planMoveInColumn(texts, file, { above, below });
    }, fieldTarget('ordinal', (value) => value !== undefined && /^\d+(\.\d+)?$/.test(value)));
  }

  async #undoLast(): Promise<void> {
    const entry = this.#undo.pop();
    if (entry === undefined) {
      this.#fail('nothingToUndo');
      return;
    }
    const current = await this.#ports.readTask(entry.path);
    // Not readable as UTF-8 right now (an editor with another encoding): kept for a retry.
    if (current === 'encoding') {
      this.#undo.push(entry);
      this.#fail('encoding');
      return;
    }
    if (current === undefined || current.text !== entry.after) {
      this.#stale();
      return;
    }
    const edit = restoreEdit(entry.after, entry.before);
    if (edit === undefined) {
      this.#fail('failed');
      return;
    }
    const result = await this.#apply({ path: entry.path, before: entry.after, after: entry.before }, [edit], false);
    // The file still holds this panel's change: the undo stays possible once the write can succeed.
    if (result !== 'written' && result !== 'stale') this.#undo.push(entry);
  }

  async #apply(change: UndoEntry, edits: readonly TextEdit[], remember: boolean): Promise<WriteResult> {
    const result = await this.#ports.write(change.path, { before: change.before, after: change.after, edits });
    if (result === 'stale') {
      this.#stale();
      return result;
    }
    if (result !== 'written') {
      this.render();
      this.#fail(result);
      return result;
    }
    if (remember) {
      this.#undo.push(change);
      const size = (entry: UndoEntry): number => entry.before.length + entry.after.length;
      let total = this.#undo.reduce((sum, entry) => sum + size(entry), 0);
      while (this.#undo.length > UNDO_LIMIT || (this.#undo.length > 1 && total > UNDO_CHAR_LIMIT)) total -= size(this.#undo.shift()!);
    }
    return result;
  }

  #postDetail(path: string): void {
    const detail = this.#ports.detail(path);
    this.#ports.post({ type: 'detail', path, detail });
    if (detail === null && this.#selected === path) this.#selected = null;
  }

  /** The view was built from an older file: redraw first, then explain (render clears notices). */
  #stale(): void {
    this.render();
    this.#fail('stale');
  }

  #fail(reason: ErrorReason): void {
    this.#ports.post({ type: 'error', reason, message: this.#ports.errors[reason] });
  }
}

/** Whether `values` repeats an item (case-insensitively) more often than `current` already does. */
function addsRepeat(current: readonly string[], values: readonly string[]): boolean {
  const counts = (list: readonly string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const v of list) map.set(v.toLowerCase(), (map.get(v.toLowerCase()) ?? 0) + 1);
    return map;
  };
  const before = counts(current);
  return [...counts(values)].some(([key, n]) => n > 1 && n > (before.get(key) ?? 1));
}

/** A change to one frontmatter scalar; `reads` checks the value it reads back as (undefined when absent). */
function fieldTarget(name: string, reads: (value: string | undefined, present: boolean) => boolean): ChangeTarget {
  return {
    fields: [name],
    sections: [] as SectionName[],
    readsBack: (_: ParsedText, b: ParsedText) => {
      const field = fieldOf(b.file.fields, name);
      if (field !== undefined && (field.value.kind !== 'scalar' || field.end !== field.line + 1)) return false;
      return reads(scalarOf(b.file.fields, name), field !== undefined);
    },
  };
}

export interface DependencyGraph {
  /** Normalized ID (the index's idKey: case-insensitive, `7` means `TASK-7`). */
  readonly keyOf: (id: string) => string;
  /** Dependency IDs of each task, by its normalized ID. */
  readonly tasks: ReadonlyMap<string, readonly string[]>;
}

/**
 * Whether the dependencies of task `self` may become `values` (backlog.md 5.4). Only newly
 * added IDs are checked: they must name another existing task and must not reach `self`
 * through existing dependencies (a cycle). IDs already listed stay, even if they are broken,
 * so a list can always be shortened.
 */
export function dependenciesAllowed(graph: DependencyGraph, self: string | undefined, current: readonly string[], values: readonly string[]): boolean {
  const { keyOf, tasks } = graph;
  const selfKey = self === undefined ? undefined : keyOf(self);
  const kept = new Set(current.map(keyOf));
  for (const value of values) {
    const start = keyOf(value);
    if (kept.has(start)) continue;
    if (start === selfKey || !tasks.has(start)) return false;
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (next === selfKey) return false;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const dep of tasks.get(next) ?? []) queue.push(keyOf(dep));
    }
  }
  return true;
}

function isWebUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const sameLine = (a: Line, b: Line): boolean => a.text === b.text && a.eol === b.eol;

/**
 * One edit turning `from` into `to`: the lines between their common first and last lines,
 * line endings included, so the result is byte for byte `to`. Undefined when the BOM differs
 * (edit positions exclude it, so it cannot be restored with an edit).
 */
export function restoreEdit(from: string, to: string): TextEdit | undefined {
  const a = parseLines(from);
  const b = parseLines(to);
  if (a.bom !== b.bom) return undefined;
  let prefix = 0;
  while (prefix < a.lines.length && prefix < b.lines.length && sameLine(a.lines[prefix], b.lines[prefix])) prefix++;
  let suffix = 0;
  while (
    suffix < a.lines.length - prefix &&
    suffix < b.lines.length - prefix &&
    sameLine(a.lines[a.lines.length - 1 - suffix], b.lines[b.lines.length - 1 - suffix])
  ) {
    suffix++;
  }
  const newText = b.lines
    .slice(prefix, b.lines.length - suffix)
    .map((line) => line.text + line.eol)
    .join('');
  return {
    range: { start: { line: prefix, character: 0 }, end: { line: a.lines.length - suffix, character: 0 } },
    newText,
  };
}
