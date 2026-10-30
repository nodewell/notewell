// Toolbar and board for the Backlog webview (backlog.md 4.2, 4.3). DOM-free like the kanban
// renderer: structural element types from webview/dom.ts, so it runs under node:test with a
// fake document. Task text goes in as textContent only; interactions are data-* hooks that
// main.ts handles by delegation.
import { createElementFactory, type DomDocument, type DomElement } from '../../../webview/dom.ts';
import type { BacklogView, TaskSummary, ViewStrings } from '../view.ts';
import { format, type BoardColumn, type FilterOption, type FilterOptions, type UiState } from './filters.ts';
import { readOnlyText } from './render-detail.ts';

/** Priority badge text and class; unknown values are shown as written. */
export function priorityBadge(priority: string, strings: ViewStrings): { text: string; className: string } {
  const lower = priority.toLowerCase();
  const names: Readonly<Record<string, string>> = { high: strings.priorityHigh, medium: strings.priorityMedium, low: strings.priorityLow };
  return Object.hasOwn(names, lower)
    ? { text: names[lower]!, className: `priority priority-${lower}` }
    : { text: priority, className: 'priority' };
}

/**
 * The search box. main.ts creates it once and keeps it outside the redrawn toolbar parts, so
 * typing and IME composition are never interrupted by a redraw.
 */
export function renderSearch<E extends DomElement<E>>(doc: DomDocument<E>, placeholder: string, value: string): E {
  const el = createElementFactory(doc);
  return el('input', {
    className: 'search',
    attrs: { type: 'search', placeholder, 'aria-label': placeholder, value, spellcheck: 'false' },
  });
}

/**
 * Toolbar parts around the search box: view tabs, project name, filters and keyboard help.
 * The wrapper is `display: contents` (backlog.css), so the parts and the search box share one
 * flex row; CSS `order` puts the search box after the project name.
 */
export function renderToolbar<E extends DomElement<E>>(
  doc: DomDocument<E>,
  view: BacklogView,
  state: UiState,
  options: FilterOptions,
  position: BacklogView['detailPosition'] = view.detailPosition,
): E {
  const el = createElementFactory(doc);
  const s = view.strings;

  const tab = (mode: 'board' | 'list', label: string): E =>
    el('button', {
      className: `view-tab${state.mode === mode ? ' active' : ''}`,
      text: label,
      attrs: { type: 'button', role: 'tab', 'aria-selected': String(state.mode === mode), 'data-action': 'set-mode', 'data-mode': mode },
    });

  const select = (name: keyof FilterOptions, label: string, current: string, choices: readonly FilterOption[]): E => {
    const known = choices.some((o) => o.value === current);
    return el(
      'select',
      { className: `filter filter-${name}`, attrs: { 'data-filter': name, 'aria-label': label, title: label } },
      ...choices.map((o, i) => {
        const attrs: Record<string, string> = { value: o.value };
        if (o.value === current || (!known && i === 0)) attrs.selected = '';
        return el('option', { text: o.label, attrs });
      }),
    );
  };

  const filters = el('div', { className: 'filters' });
  if (state.mode === 'list') filters.append(select('status', s.columnStatus, state.status, options.status));
  filters.append(
    select('milestone', s.columnMilestone, state.milestone, options.milestone),
    select('label', s.fieldLabels, state.label, options.label),
    select('assignee', s.columnAssignee, state.assignee, options.assignee),
  );

  return el(
    'div',
    { className: 'toolbar-parts' },
    el('div', { className: 'view-tabs', attrs: { role: 'tablist', 'aria-label': view.project } }, tab('board', s.boardView), tab('list', s.listView)),
    el('span', { className: 'project-name', text: view.project, attrs: { title: view.project } }),
    filters,
    // Detail position (backlog.md 4.1): two buttons with a pressed state; the icon shows the layout.
    el(
      'div',
      { className: 'detail-position', attrs: { role: 'group', 'aria-label': s.detailPosition } },
      ...(['bottom', 'right'] as const).map((p) =>
        el(
          'button',
          {
            className: `detail-position-button${position === p ? ' active' : ''}`,
            attrs: {
              type: 'button',
              'data-action': 'set-detail-position',
              'data-position': p,
              'aria-pressed': String(position === p),
              'aria-label': p === 'bottom' ? s.detailBelow : s.detailRight,
              title: p === 'bottom' ? s.detailBelow : s.detailRight,
            },
          },
          el('span', { className: `layout-icon layout-icon-${p}`, attrs: { 'aria-hidden': 'true' } }),
        ),
      ),
    ),
    // Keyboard help: a quiet "?" whose text shows on hover or focus (as in the kanban board).
    el(
      'button',
      { className: 'help', attrs: { type: 'button', 'aria-label': s.keyboardHelpLabel, 'aria-describedby': 'backlog-help-text' } },
      el('span', { className: 'help-icon', text: '?', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'help-text', text: s.keyboardHelp, attrs: { id: 'backlog-help-text', role: 'tooltip' } }),
    ),
  );
}

/** Why a task file is listed as unreadable, in the panel's language. */
function reasonText(view: BacklogView, reason: BacklogView['unreadable'][number]['reason']): string {
  if (reason === 'noFrontmatter') return view.strings.unreadableNoFrontmatter;
  if (reason === 'noId') return view.strings.unreadableNoId;
  if (reason === 'tooLarge') return view.strings.unreadableTooLarge;
  return view.strings.unreadableNotUtf8;
}

/** Notices above the content: unreadable task files, each with the reason in the tooltip. */
export function renderNotices<E extends DomElement<E>>(doc: DomDocument<E>, view: BacklogView): E[] {
  const el = createElementFactory(doc);
  if (view.unreadable.length === 0) return [];
  return [
    el('p', {
      className: 'notice unreadable',
      text: format(view.strings.unreadableTasks, view.unreadable.length),
      attrs: { role: 'status', title: view.unreadable.map((u) => `${u.path} (${reasonText(view, u.reason)})`).join('\n') },
    }),
  ];
}

/** Badges shared by cards and list rows: labels. */
/** Appends in slices: spreading 100k+ nodes into one call overflows the stack. */
export function appendAll<E extends DomElement<E>>(element: E, children: readonly (E | string)[]): E {
  for (let i = 0; i < children.length; i += 1000) element.append(...children.slice(i, i + 1000));
  return element;
}

export function renderLabels<E extends DomElement<E>>(doc: DomDocument<E>, labels: readonly string[]): E {
  const el = createElementFactory(doc);
  return el('span', { className: 'labels' }, ...labels.map((label) => el('span', { className: 'label', text: label, attrs: { dir: 'auto' } })));
}

export interface BoardState {
  readonly selected: string | null;
  /**
   * Cards drawn per column (backlog.md 4.2); the rest wait behind a "Show all" button. Missing
   * or larger than the column: all of them.
   */
  readonly limits?: readonly number[];
}

export function renderBoard<E extends DomElement<E>>(doc: DomDocument<E>, view: BacklogView, columns: readonly BoardColumn[], state: BoardState): E {
  const el = createElementFactory(doc);
  const s = view.strings;

  const card = (task: TaskSummary, column: number, index: number): E => {
    const selected = task.path === state.selected;
    const top = el('div', { className: 'card-top' }, el('span', { className: 'card-id', text: task.id }));
    if (task.priority !== null) {
      const badge = priorityBadge(task.priority, s);
      top.append(el('span', { className: badge.className, text: badge.text, attrs: { title: `${s.columnPriority}: ${task.priority}` } }));
    }
    if (task.duplicateId) top.append(el('span', { className: 'duplicate', text: '!', attrs: { 'aria-hidden': 'true' } }));
    // Read-only before anything is tried (backlog.md 4.4): the tooltip says why; the card cannot be moved.
    if (task.readOnly !== null) top.append(el('span', { className: 'card-read-only', text: s.readOnlyLabel, attrs: { title: readOnlyText(task.readOnly, s) } }));

    const meta = el('div', { className: 'card-meta' });
    if (task.ac !== null) {
      meta.append(
        el('span', {
          className: `card-ac${task.ac.done === task.ac.total ? ' complete' : ''}`,
          text: `${task.ac.done}/${task.ac.total}`,
          attrs: { title: s.sectionAcceptanceCriteria },
        }),
      );
    }
    if (task.subtaskCount > 0) meta.append(el('span', { className: 'card-subtasks', text: format(s.subtaskCount, task.subtaskCount) }));
    if (task.blockedBy.length > 0) {
      meta.append(el('span', { className: 'card-blocked', text: s.blocked, attrs: { title: format(s.blockedBy, task.blockedBy.join(', ')) } }));
    }
    if (task.milestone !== null) {
      meta.append(el('span', { className: 'card-milestone', text: task.milestoneTitle ?? task.milestone, attrs: { dir: 'auto', title: `${s.columnMilestone}: ${task.milestone}` } }));
    }

    const item = el(
      'li',
      {
        className: `card${selected ? ' selected' : ''}${task.blockedBy.length > 0 ? ' blocked' : ''}${task.readOnly !== null ? ' read-only' : ''}`,
        attrs: {
          tabindex: '0',
          draggable: String(task.readOnly === null),
          'data-action': 'show-task',
          'data-path': task.path,
          'data-column': String(column),
          'data-card': String(index),
          'aria-current': String(selected),
        },
      },
      top,
      // dir=auto: a right-to-left title is laid out on its own, without reordering what is around it.
      el('div', { className: 'card-title', text: task.title === '' ? task.id : task.title, attrs: { dir: 'auto' } }),
    );
    if (task.labels.length > 0) item.append(renderLabels(doc, task.labels));
    // Visible text, not only a hover tooltip: the warning matters before any edit.
    if (task.duplicateId) item.append(el('div', { className: 'duplicate-note', text: s.duplicateId }));
    if (task.ac !== null || task.subtaskCount > 0 || task.blockedBy.length > 0 || task.milestone !== null) item.append(meta);
    return item;
  };

  /** A card that cannot be drawn still shows its ID and title, so one task never blanks the board. */
  const safeCard = (task: TaskSummary, column: number, index: number): E => {
    try {
      return card(task, column, index);
    } catch {
      return el(
        'li',
        {
          className: 'card',
          attrs: { tabindex: '0', 'data-action': 'show-task', 'data-path': String(task.path), 'data-column': String(column), 'data-card': String(index), 'aria-current': 'false' },
        },
        el('div', { className: 'card-top' }, el('span', { className: 'card-id', text: String(task.id) })),
        el('div', { className: 'card-title', text: String(task.title), attrs: { dir: 'auto' } }),
      );
    }
  };

  const shown = (index: number, col: BoardColumn): number => Math.min(col.tasks.length, state.limits?.[index] ?? col.tasks.length);
  /** The button that draws a capped column's remaining cards. */
  const showAll = (index: number, col: BoardColumn): E[] =>
    shown(index, col) >= col.tasks.length
      ? []
      : [el('button', { className: 'show-all', text: format(s.showAll, col.tasks.length), attrs: { type: 'button', 'data-action': 'show-all', 'data-column': String(index) } })];

  const column = (col: BoardColumn, index: number): E => {
    const name = col.known ? col.status : s.otherStatus;
    const done = col.known && col.status === view.doneStatus;
    return el(
      'section',
      {
        className: `column${col.known ? '' : ' other'}${done ? ' done' : ''}`,
        attrs: { 'data-column': String(index), 'data-status': col.status, 'data-known': String(col.known), 'aria-label': name },
      },
      el(
        'header',
        { className: 'column-header' },
        el('h2', { className: 'column-title', text: name, attrs: { title: name, dir: 'auto' } }),
        el('span', { className: 'column-count', text: String(col.tasks.length) }),
      ),
      appendAll(el('ul', { className: 'column-cards' }), col.tasks.slice(0, shown(index, col)).map((t, i) => safeCard(t, index, i))),
      ...showAll(index, col),
    );
  };

  const board = el('div', { className: 'board' }, ...columns.map(column));
  if (columns.every((c) => c.tasks.length === 0)) return el('div', { className: 'board-wrap' }, el('p', { className: 'empty', text: s.noTasks }), board);
  return el('div', { className: 'board-wrap' }, board);
}
