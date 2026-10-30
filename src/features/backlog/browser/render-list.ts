// List view for the Backlog webview (backlog.md 4.3): a table with sortable headers. DOM-free
// like render-board.ts; rows carry data-* hooks handled by main.ts.
import { createElementFactory, type DomDocument, type DomElement } from '../../../webview/dom.ts';
import type { BacklogView, TaskSummary } from '../view.ts';
import { format, type SortColumn, type SortState } from './filters.ts';
import { appendAll, priorityBadge, renderLabels } from './render-board.ts';

export interface ListState {
  readonly sort: SortState | null;
  readonly selected: string | null;
  /** Rows drawn (backlog.md 4.3); the rest wait behind a "Show all" button. Missing: all. */
  readonly limit?: number;
}

export function renderList<E extends DomElement<E>>(doc: DomDocument<E>, view: BacklogView, tasks: readonly TaskSummary[], state: ListState): E {
  const el = createElementFactory(doc);
  const s = view.strings;
  const columns: readonly [SortColumn, string][] = [
    ['id', s.columnId],
    ['title', s.columnTitle],
    ['status', s.columnStatus],
    ['priority', s.columnPriority],
    ['assignee', s.columnAssignee],
    ['milestone', s.columnMilestone],
  ];

  const header = ([column, label]: readonly [SortColumn, string]): E => {
    const sorted = state.sort?.column === column;
    const direction = sorted ? (state.sort!.descending ? 'descending' : 'ascending') : 'none';
    return el(
      'th',
      { className: `col-${column}`, attrs: { scope: 'col', 'aria-sort': direction } },
      el(
        'button',
        { className: `sort${sorted ? ` sorted ${direction}` : ''}`, attrs: { type: 'button', 'data-action': 'sort', 'data-column': column } },
        el('span', { className: 'sort-label', text: label }),
        el('span', { className: 'sort-icon', attrs: { 'aria-hidden': 'true' } }),
      ),
      // Width handle (backlog.md 4.3): drag, Left/Right keys, double-click resets all widths.
      el('span', {
        className: 'col-resizer',
        attrs: {
          role: 'separator',
          tabindex: '0',
          'aria-orientation': 'vertical',
          'aria-label': format(s.resizeColumn, label),
          'data-action': 'resize-column',
          'data-column': column,
        },
      }),
    );
  };

  const row = (task: TaskSummary, index: number): E => {
    const selected = task.path === state.selected;
    const title = el('td', { className: 'col-title' }, el('span', { className: 'row-title', text: task.title === '' ? task.id : task.title, attrs: { dir: 'auto' } }));
    if (task.duplicateId) title.append(el('span', { className: 'duplicate', text: '!', attrs: { 'aria-hidden': 'true' } }));
    if (task.labels.length > 0) title.append(renderLabels(doc, task.labels));
    if (task.duplicateId) title.append(el('div', { className: 'duplicate-note', text: s.duplicateId }));
    const priority = el('td', { className: 'col-priority' });
    if (task.priority !== null) {
      const badge = priorityBadge(task.priority, s);
      priority.append(el('span', { className: badge.className, text: badge.text }));
    }
    const statusClass = `status${task.statusKnown ? '' : ' other'}${task.status === view.doneStatus ? ' done' : ''}`;
    return el(
      'tr',
      {
        className: `row${selected ? ' selected' : ''}`,
        attrs: { tabindex: '0', 'data-action': 'show-task', 'data-path': task.path, 'data-row': String(index), 'aria-selected': String(selected) },
      },
      el('td', { className: 'col-id', text: task.id }),
      title,
      el('td', { className: 'col-status' }, el('span', { className: statusClass, text: task.status, attrs: task.statusKnown ? {} : { title: s.otherStatus } })),
      priority,
      el('td', { className: 'col-assignee', text: task.assignees.join(', ') }),
      el('td', { className: 'col-milestone', text: task.milestoneTitle ?? task.milestone ?? '', attrs: task.milestone === null ? { dir: 'auto' } : { dir: 'auto', title: task.milestone } }),
    );
  };

  /** A row that cannot be drawn still shows its ID and title, so one task never blanks the list. */
  const safeRow = (task: TaskSummary, index: number): E => {
    try {
      return row(task, index);
    } catch {
      return el(
        'tr',
        { className: 'row', attrs: { tabindex: '0', 'data-action': 'show-task', 'data-path': String(task.path), 'data-row': String(index), 'aria-selected': 'false' } },
        el('td', { className: 'col-id', text: String(task.id) }),
        el('td', { className: 'col-title', attrs: { colspan: String(columns.length - 1) } }, el('span', { className: 'row-title', text: String(task.title), attrs: { dir: 'auto' } })),
      );
    }
  };

  const shown = Math.min(tasks.length, state.limit ?? tasks.length);
  const table = el(
    'table',
    { className: 'task-table', attrs: { 'aria-rowcount': String(tasks.length + 1) } },
    el('colgroup', {}, ...columns.map(([column]) => el('col', { attrs: { 'data-col': column } }))),
    el('thead', {}, el('tr', {}, ...columns.map(header))),
    appendAll(el('tbody'), tasks.slice(0, shown).map((task, index) => safeRow(task, index))),
  );
  const wrap = el('div', { className: 'list-wrap' }, table);
  if (shown < tasks.length) {
    wrap.append(el('button', { className: 'show-all', text: format(s.showAll, tasks.length), attrs: { type: 'button', 'data-action': 'show-all', 'data-column': 'list' } }));
  }
  if (tasks.length === 0) wrap.append(el('p', { className: 'empty', text: s.noTasks }));
  return wrap;
}
