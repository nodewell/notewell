// View models sent from the extension to the Backlog webview (backlog.md 4). Plain data,
// no VS Code API; every string here is shown with textContent only.

/** A task in the board and list views (backlog.md 4.2, 4.3). */
export interface TaskSummary {
  /** Project-relative POSIX path of the task file; identifies the task in messages. */
  readonly path: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** False when the status is not one of the configured statuses ("other status" column). */
  readonly statusKnown: boolean;
  readonly priority: string | null;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly milestone: string | null;
  /** Title from milestones/, or null when not found. */
  readonly milestoneTitle: string | null;
  readonly parent: string | null;
  readonly subtaskCount: number;
  readonly ordinal: number | null;
  readonly ac: { readonly done: number; readonly total: number } | null;
  /** Dependency IDs that are missing or not in the done status. */
  readonly blockedBy: readonly string[];
  /** Another task file has the same ID (backlog.md 3.1). */
  readonly duplicateId: boolean;
  /** The text search looks in, lower-cased without whitespace (backlog.md 4.3). */
  readonly searchText: string;
  /** `YYYY-MM-DD HH:mm` UTC as stored, or null. */
  readonly created: string | null;
  readonly updated: string | null;
  /** Why every write to this task would be refused, or null when it can be edited (backlog.md 4.4). */
  readonly readOnly: ReadOnlyNotice | null;
}

/**
 * Why a task is shown read-only before anything is tried (backlog.md 4.4):
 * - `archived`: in archive/tasks/ or completed/ (3.1)
 * - `frontmatter`: a frontmatter line that is not a field, an indented value, blank or a comment
 * - `markers`: a section marker outside its section or without its pair
 * - `updatedDate`: `updated_date` cannot be written (5.2)
 * - `fileSystem`: the project is on a file system that cannot be written
 */
export type ReadOnlyReason = 'archived' | 'frontmatter' | 'markers' | 'updatedDate' | 'fileSystem';

export interface ReadOnlyNotice {
  readonly reason: ReadOnlyReason;
  /** 1-based file line the reason is about (`frontmatter`, `markers`), else null. */
  readonly line: number | null;
}

export interface UnreadableTask {
  readonly path: string;
  readonly reason: 'noFrontmatter' | 'noId' | 'notUtf8' | 'tooLarge';
}

export interface BacklogView {
  /** Project name shown in the panel (workspace folder name). */
  readonly project: string;
  /** Configured statuses in order (board columns). */
  readonly statuses: readonly string[];
  /** The last configured status, treated as done; null without statuses. */
  readonly doneStatus: string | null;
  /** Tasks sorted for display: ordinal, then ID number (backlog.md 4.2). */
  readonly tasks: readonly TaskSummary[];
  /** Archived tasks (backlog.md 3.1), for the list's archived filter only; never on the board. */
  readonly archived: readonly TaskSummary[];
  readonly unreadable: readonly UnreadableTask[];
  readonly milestones: readonly { readonly id: string; readonly title: string }[];
  /** Task types offered when editing (backlog.md 2.2; the CLI defaults unless configured). */
  readonly taskTypes: readonly string[];
  /** Configured priority order, highest first (backlog.md 2.2), for sorting by priority. */
  readonly priorities: readonly string[];
  /** Where the detail pane sits (backlog.md 4.1, notewell.backlog.detailPosition). */
  readonly detailPosition: 'bottom' | 'right';
  /** Remembered layout for this project (saveLayout), applied when the panel opens. */
  readonly layout: {
    readonly columnWidths: { readonly [column: string]: number };
    /** Detail share in permille per position. */
    readonly paneSizes: { readonly bottom?: number; readonly right?: number };
  };
  readonly strings: ViewStrings;
}

/** A link to another task from the detail view; title and status are null when not found. */
export interface TaskRef {
  readonly id: string;
  readonly path: string | null;
  readonly title: string | null;
  readonly status: string | null;
  /** In archive/tasks/ or completed/: opens read-only (backlog.md 3.1). */
  readonly archived: boolean;
}

export interface CheckItemView {
  readonly line: number;
  /** The item's source line, sent back as the expected text (optimistic check). */
  readonly source: string;
  readonly number: number;
  readonly text: string;
  readonly checked: boolean;
}

export interface ChecklistView {
  readonly readOnly: boolean;
  readonly items: readonly CheckItemView[];
}

export interface CommentView {
  readonly author: string | null;
  readonly created: string | null;
  readonly body: string;
}

/** Everything the detail view shows for one task (backlog.md 4.4). */
export interface TaskDetail {
  readonly path: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** Source text of the `status:` line, sent back with setStatus; null when it cannot be changed. */
  readonly statusLine: string | null;
  readonly priority: string | null;
  readonly type: string | null;
  readonly project: string | null;
  readonly reporter: string | null;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly milestone: string | null;
  readonly milestoneTitle: string | null;
  readonly due: string | null;
  readonly created: string | null;
  readonly updated: string | null;
  readonly parent: TaskRef | null;
  readonly subtasks: readonly TaskRef[];
  readonly dependencies: readonly TaskRef[];
  /** Tasks that list this one in their dependencies. */
  readonly blocks: readonly TaskRef[];
  readonly references: readonly string[];
  readonly documentation: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly description: string | null;
  readonly plan: string | null;
  readonly notes: string | null;
  readonly finalSummary: string | null;
  readonly ac: ChecklistView | null;
  readonly dod: ChecklistView | null;
  readonly comments: readonly CommentView[] | null;
  /** The comments block as text when it has another shape. */
  readonly commentsRaw: string | null;
  readonly otherBody: string;
  readonly otherFields: readonly { readonly name: string; readonly source: string }[];
  /** False when an edit would be refused anyway: `readOnly` says why (backlog.md 4.4). */
  readonly editable: boolean;
  readonly readOnly: ReadOnlyNotice | null;
  /** An archived task (backlog.md 3.1): shown read-only. */
  readonly archived: boolean;
  /**
   * Stage 2 editing (backlog.md 5.4): current source text of each editable field (its lines
   * joined with LF) or null when the field is absent; fields whose shape cannot be written
   * are listed in `lockedFields` instead.
   */
  readonly fieldSources: { readonly [name: string]: string | null };
  readonly lockedFields: readonly string[];
  /** Current text between the markers of each editable section, or null when absent. */
  readonly sectionSources: { readonly [section: string]: string | null };
}

/** UI strings, localized by the extension (strings.ts). `{0}` is replaced in the webview. */
export const DEFAULT_STRINGS = {
  boardView: 'Board',
  listView: 'List',
  searchPlaceholder: 'Search tasks',
  allStatuses: 'All statuses',
  notDone: 'Not done',
  archivedTasks: 'Archived',
  allMilestones: 'All milestones',
  allLabels: 'All labels',
  allAssignees: 'All assignees',
  noMilestone: 'No milestone',
  otherStatus: 'Other status',
  noTasks: 'No tasks match.',
  projectUnavailable: 'This Backlog.md project is not available any more (its config.yml or folder is gone). The board comes back when the project does.',
  showAll: 'Show all ({0})',
  unreadableTasks: '{0} task files could not be read.',
  unreadableNoFrontmatter: 'no frontmatter',
  unreadableNoId: 'no id',
  unreadableNotUtf8: 'not UTF-8 text',
  unreadableTooLarge: 'too large to read',
  columnId: 'ID',
  columnTitle: 'Title',
  columnStatus: 'Status',
  columnPriority: 'Priority',
  columnAssignee: 'Assignee',
  columnMilestone: 'Milestone',
  blocked: 'Blocked',
  blockedBy: 'Blocked by {0}',
  subtaskCount: '{0} subtasks',
  duplicateId: 'Another task file has this ID.',
  priorityHigh: 'High',
  priorityMedium: 'Medium',
  priorityLow: 'Low',
  openFile: 'Open file',
  closeDetail: 'Close',
  fieldStatus: 'Status',
  fieldPriority: 'Priority',
  fieldType: 'Type',
  fieldProject: 'Project',
  fieldReporter: 'Reporter',
  fieldAssignee: 'Assignee',
  fieldLabels: 'Labels',
  fieldMilestone: 'Milestone',
  fieldDue: 'Due',
  fieldCreated: 'Created',
  fieldUpdated: 'Updated',
  fieldParent: 'Parent',
  fieldSubtasks: 'Subtasks',
  fieldDependsOn: 'Blocked by',
  fieldBlocks: 'Blocks',
  fieldReferences: 'References',
  fieldDocumentation: 'Documentation',
  fieldModifiedFiles: 'Modified files',
  fieldOther: 'Other fields',
  sectionDescription: 'Description',
  sectionAcceptanceCriteria: 'Acceptance Criteria',
  sectionDefinitionOfDone: 'Definition of Done',
  sectionPlan: 'Implementation Plan',
  sectionNotes: 'Implementation Notes',
  sectionComments: 'Comments',
  sectionFinalSummary: 'Final Summary',
  sectionOther: 'Other content',
  checklistReadOnly: 'This list has lines Notewell does not recognize, so it can only be changed as text.',
  taskNotFound: 'not found',
  archivedTask: 'archived',
  readOnlyLabel: 'Read-only',
  archivedNotice: 'This task is archived. Restore it with the Backlog.md CLI to edit it.',
  readOnlyFrontmatter:
    'Notewell does not edit this task: line {0}, in its frontmatter, is not a field, an indented value, a blank line or a # comment, so a change could not be checked safely. Fix that line with Open file, or edit the task with the Backlog.md CLI.',
  readOnlyMarkers:
    'Notewell does not edit this task: the section marker on line {0} is outside its section or has no pair, so a change could land in the wrong place. Fix the markers with Open file, then edit the task here again.',
  readOnlyUpdatedDate:
    'Notewell does not edit this task: its updated_date is not a one-line value (or it is missing, and so are status and created_date), and every change updates it as the CLI does. Make updated_date a one-line value with Open file, or edit the task with the Backlog.md CLI.',
  readOnlyFileSystem: 'Notewell does not edit this task: the project is on a file system that cannot be written.',
  keyboardHelp:
    'Arrow keys move between tasks, Alt+Left/Right changes the status, Alt+Up/Down reorders within the column, Enter opens the details, Esc closes them, Ctrl+Z undoes the last change.',
  keyboardHelpLabel: 'Keyboard shortcuts',
  resizeColumn: 'Resize the {0} column',
  drawFailed: 'Part of the panel could not be shown. Close and reopen the panel; if Notewell was just updated, reload the window.',
  // Layout (backlog.md 4.1)
  detailPosition: 'Detail position',
  detailBelow: 'Details below',
  detailRight: 'Details on the right',
  splitter: 'Resize details',
  // Editing (backlog.md 5.4)
  editTitle: 'Edit title',
  editSection: 'Edit',
  addSection: 'Add {0}',
  save: 'Save',
  cancel: 'Cancel',
  editHint: 'Ctrl+Enter saves, Esc cancels.',
  noPriority: 'No priority',
  noType: 'No type',
  addItem: 'Add…',
  addItemHint: 'Enter or comma adds an item; Backspace in an empty box removes the last one.',
  removeItem: 'Remove {0}',
  unknownTaskId: 'There is no task with ID {0}.',
  selfDependency: 'A task cannot depend on itself.',
  emptyTitle: 'The title cannot be empty.',
  commentPlaceholder: 'Write a comment (Markdown)',
  addComment: 'Add comment',
  commentHint: 'Ctrl+Enter adds the comment.',
  unclosedFence: 'Close the code block (```) before saving.',
  textTooLong: 'Too long to save here: at most {0} characters and {1} lines. Nothing was sent; your text is kept.',
  taskGone: 'This task is no longer in the project (moved, archived or deleted). Your unsaved text is kept: copy it before closing the editor.',
} as const;

export type ViewStrings = { readonly [K in keyof typeof DEFAULT_STRINGS]: string };
