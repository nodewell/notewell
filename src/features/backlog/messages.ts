// Messages between the Backlog webview and the extension (backlog.md 5.1, 7). Webview input
// is validated by the shared schema validator before anything else looks at it.
import { defineMessages, type MessageOf } from '../../webview/messages.ts';
import type { BacklogView, TaskDetail } from './view.ts';

export const LIMITS = {
  path: 1_000,
  sourceLine: 20_000,
  status: 200,
  url: 2_000,
  line: 1_000_000,
  value: 2_000,
  text: 200_000,
  textLines: 10_000,
  comments: 100_000,
} as const;

const path = { kind: 'string', maxLength: LIMITS.path, minLength: 1 } as const;
/**
 * Which webview instance sent the message (random per page load). After a 'ready' with a new
 * instance, messages from an older one are dropped: that page is gone (backlog.md 5.1).
 */
const instance = { kind: 'string', maxLength: 64, minLength: 1, optional: true } as const;
const sourceLine = { kind: 'string', maxLength: LIMITS.sourceLine } as const;
const width = { kind: 'int', min: 48, max: 2000, optional: true } as const;
const share = { kind: 'int', min: 1, max: 999, optional: true } as const;
// LF only (the shared validator rejects CR, NEL, LS and PS).
const multiline = { kind: 'string', maxLength: LIMITS.text, allowNewline: true, maxLines: LIMITS.textLines } as const;

export const WEBVIEW_MESSAGES = {
  ready: { instance },
  /** Asks for the detail view of a task (answered with 'detail'). */
  showTask: { instance, path },
  /** The detail view was closed; stop sending 'detail' with renders. */
  hideTask: { instance },
  /**
   * Status change (backlog.md 5.3). From the detail view `statusLine` is the expected source of
   * the `status:` line. From the board (which has no source lines) `statusLine` is '' and
   * `fromStatus` is the status the card showed; the change is stale if the file's status differs.
   */
  setStatus: {
    instance,
    path,
    statusLine: sourceLine,
    status: { kind: 'string', maxLength: LIMITS.status, minLength: 1 },
    fromStatus: { kind: 'string', maxLength: LIMITS.status, minLength: 1, optional: true },
  },
  /** AC or DoD check; `source` is the expected source of the item line. */
  toggleCheck: {
    instance,
    path,
    list: { kind: 'enum', values: ['ac', 'dod'] },
    line: { kind: 'int', min: 0, max: LIMITS.line },
    source: sourceLine,
    checked: { kind: 'boolean' },
  },
  // Stage 2 (backlog.md 5.4). `expected` is the field's or section's current source text
  // (lines joined with LF); omitted when the requester saw no such field or section.
  /** Scalar field; '' removes optional fields the way the CLI does. */
  setField: {
    instance,
    path,
    name: { kind: 'enum', values: ['title', 'priority', 'type', 'milestone', 'due_date', 'project', 'reporter'] },
    value: { kind: 'string', maxLength: LIMITS.value },
    expected: { ...multiline, optional: true },
  },
  /** List field; `values` holds one item per line ('' = empty list). */
  setList: {
    instance,
    path,
    name: { kind: 'enum', values: ['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files'] },
    values: { kind: 'string', maxLength: LIMITS.value * 10, allowNewline: true, maxLines: 500 },
    expected: { ...multiline, optional: true },
  },
  /** Marked body section content (backlog.md 3.3); `text` may be empty. */
  setSection: {
    instance,
    path,
    section: { kind: 'enum', values: ['description', 'plan', 'notes', 'finalSummary'] },
    text: multiline,
    expected: { ...multiline, optional: true },
  },
  /**
   * Moves a task within its board column (backlog.md 5.4, 9 #3): the extension computes the
   * new `ordinal` from the neighbours it will sit between (paths as shown on the board).
   */
  moveInColumn: {
    instance,
    path,
    fromStatus: { kind: 'string', maxLength: LIMITS.status, minLength: 1 },
    beforePath: { ...path, optional: true },
    afterPath: { ...path, optional: true },
  },
  /** Appends a comment (backlog.md 3.5). */
  addComment: {
    instance,
    path,
    text: { ...multiline, minLength: 1 },
    /** Comments the detail showed: a resent or doubled submit finds one more and is stale. */
    seen: { kind: 'int', min: 0, max: LIMITS.comments },
  },
  /** Toolbar layout switch (backlog.md 4.1): stored in notewell.backlog.detailPosition. */
  setDetailPosition: { instance, position: { kind: 'enum', values: ['bottom', 'right'] } },
  /**
   * Layout to remember across panel closes (backlog.md 4.1, 4.3): list column widths in px and the
   * detail pane's share of the layout per position in permille. Absent fields = automatic.
   */
  saveLayout: {
    instance,
    id: width, title: width, status: width, priority: width, assignee: width, milestone: width,
    bottom: share, right: share,
  },
  /** Opens the task file in the text editor. */
  openTask: { instance, path },
  /** Opens a project-relative file named in documentation, modified_files or references. */
  openPath: { instance, path },
  /** Opens an http(s) URL through VS Code (backlog.md 9 #5). */
  openUrl: { instance, url: { kind: 'string', maxLength: LIMITS.url, minLength: 1 } },
  /** Undoes the last change made from this panel (backlog.md 9 #2). */
  undo: { instance },
} as const;

export type WebviewMessage = MessageOf<typeof WEBVIEW_MESSAGES>;

export const validateWebviewMessage = defineMessages(WEBVIEW_MESSAGES);

/** Why a change was not applied. */
export type ErrorReason = 'stale' | 'invalid' | 'unsafe' | 'failed' | 'nothingToUndo' | 'readOnly' | 'encoding';

/** Extension -> webview (trusted direction). */
export type ExtensionMessage =
  | { readonly type: 'render'; readonly view: BacklogView }
  /** `detail` is null when the task no longer exists. */
  | { readonly type: 'detail'; readonly path: string; readonly detail: TaskDetail | null }
  | { readonly type: 'error'; readonly reason: ErrorReason; readonly message: string }
  /** Select a task and open its details, e.g. when the panel was opened from that task's file. */
  | { readonly type: 'select'; readonly path: string }
  /** The project behind the panel is gone (for now); a later 'render' brings the board back. */
  | { readonly type: 'unavailable' };
