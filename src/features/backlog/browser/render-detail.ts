// The task detail view (backlog.md 4.4) and its editors (5.4). DOM-free like the kanban
// renderer, so it runs under node:test with a fake document. Elements come from
// createElementFactory only; every task value is text. Actions are data-action attributes
// handled by delegation in main.ts:
//   set-status (select: data-path, data-status-line), toggle-check (checkbox: data-path,
//   data-list, data-line, data-source), show-task (data-path), open-task (data-path),
//   open-path (data-path), open-url (data-url), close-detail.
// Editing (only with DetailEditOptions, and only while the task is editable and the field is
// not locked):
//   edit-title, set-field (select or date input: data-field), chip-input (text input:
//   data-field), remove-item (data-field, data-index), edit-section / add-section
//   (data-section), save-edit, cancel-edit, add-comment. Editors carry data-editor
//   ('title', 'section', 'comment') so main.ts can read their drafts.
import { createElementFactory, type DomDocument, type DomElement } from '../../../webview/dom.ts';
import { parseInline, parseMarkdown } from '../../../webview/markdown.ts';
import { SECTION_ORDER, type SectionName } from '../task-file.ts';
import type { ChecklistView, ReadOnlyNotice, TaskDetail, TaskRef, ViewStrings } from '../view.ts';
import { renderMarkdown } from '../../../webview/markdown-render.ts';

const WEB_URL = /^https?:\/\/\S/i;
const STORED_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * A stored `YYYY-MM-DD HH:mm` UTC value in local time, same format (backlog.md 0, dates).
 * Other values are returned as written.
 */
export function localDateTime(value: string): string {
  const match = STORED_DATE.exec(value);
  if (match === null) return value;
  const [, y, mo, d, h, mi] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  // Date.UTC rolls impossible values over (Feb 30 becomes Mar 2, 24:00 the next day): such a
  // value is shown as written rather than as another date. Years below 100 map to 19xx there.
  if (
    Number.isNaN(date.getTime()) || y < 100 ||
    date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || date.getUTCHours() !== h || date.getUTCMinutes() !== mi
  ) {
    return value;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type EditSection = 'description' | 'plan' | 'notes' | 'finalSummary';
export const EDIT_SECTIONS: readonly EditSection[] = ['description', 'plan', 'notes', 'finalSummary'];

export type ListField = 'assignee' | 'labels' | 'dependencies' | 'references' | 'documentation' | 'modified_files';
export const LIST_FIELDS: readonly ListField[] = ['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files'];

/** The open text editor and its draft (kept by main.ts across redraws). */
export type OpenEditor = { readonly kind: 'title'; readonly draft: string } | { readonly kind: 'section'; readonly name: EditSection; readonly draft: string };

export interface DetailEditOptions {
  readonly taskTypes: readonly string[];
  /** Configured priorities, highest first (backlog.md 2.2). */
  readonly priorities: readonly string[];
  readonly milestones: readonly { readonly id: string; readonly title: string }[];
  /** Suggestions for the chip inputs (labels and assignees in use, task IDs with titles). */
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
  readonly editor: OpenEditor | null;
  /** Unsent text of the comment box and of each chip input. */
  readonly commentDraft: string;
  readonly chipDrafts: Readonly<Partial<Record<ListField, string>>>;
  /** A message shown under one field (validation in the webview). */
  readonly error: { readonly field: string; readonly message: string } | null;
}

/** The items of a list field as the detail shows them. */
export function listValues(detail: TaskDetail, field: ListField): readonly string[] {
  switch (field) {
    case 'assignee':
      return detail.assignees;
    case 'labels':
      return detail.labels;
    case 'dependencies':
      return detail.dependencies.map((d) => d.id);
    case 'references':
      return detail.references;
    case 'documentation':
      return detail.documentation;
    case 'modified_files':
      return detail.modifiedFiles;
  }
}

/** Section text as the detail shows it (also the editor's starting text). */
export function sectionText(detail: TaskDetail, name: EditSection): string | null {
  return detail[name];
}

const fill = (template: string, value: string): string => template.replace('{0}', value);

/** Why a task is read-only, as the detail notice and the card's tooltip say it (backlog.md 4.4). */
export function readOnlyText(notice: ReadOnlyNotice, strings: ViewStrings): string {
  const line = String(notice.line ?? '');
  switch (notice.reason) {
    case 'archived':
      return strings.archivedNotice;
    case 'frontmatter':
      return fill(strings.readOnlyFrontmatter, line);
    case 'markers':
      return fill(strings.readOnlyMarkers, line);
    case 'updatedDate':
      return strings.readOnlyUpdatedDate;
    case 'fileSystem':
      return strings.readOnlyFileSystem;
  }
}

export function renderDetail<E extends DomElement<E>>(
  doc: DomDocument<E>,
  detail: TaskDetail,
  strings: ViewStrings,
  statuses: readonly string[],
  edit?: DetailEditOptions,
): E {
  const el = createElementFactory(doc);
  /** Appends in slices: spreading tens of thousands of nodes into one call overflows the stack. */
  const appendAll = (element: E, children: readonly (E | string)[]): E => {
    for (let i = 0; i < children.length; i += 1000) element.append(...children.slice(i, i + 1000));
    return element;
  };
  // Body headings draw as h3-h6, nesting under the section titles.
  const markdown = (text: string): E => renderMarkdown(doc, parseMarkdown(text), { headingOffset: 2 });
  const inlineMarkdown = (text: string): E => renderMarkdown(doc, [{ kind: 'paragraph', content: parseInline(text) }], { headingOffset: 2 });
  const link = (className: string, text: string, attrs: Record<string, string>): E =>
    el('span', { className, text, attrs: { role: 'link', tabindex: '0', ...attrs } });
  const button = (className: string, text: string, attrs: Record<string, string>): E => el('button', { className, text, attrs: { type: 'button', ...attrs } });
  /** Editing offered for this field or section. */
  const canEdit = (name: string): boolean => edit !== undefined && detail.editable && !detail.lockedFields.includes(name);
  const errorId = (field: string): string => `detail-error-${field}`;
  const fieldError = (field: string): E | null =>
    edit?.error?.field === field
      ? el('p', { className: 'detail-field-error', text: edit.error.message, attrs: { role: 'alert', id: errorId(field) } })
      : null;
  /** aria-invalid and the error text as description, for the input of a field with an error. */
  const invalid = (field: string): Record<string, string> =>
    edit?.error?.field === field ? { 'aria-invalid': 'true', 'aria-describedby': errorId(field) } : {};

  const date = (value: string): E => el('span', { className: 'detail-date', text: localDateTime(value), attrs: { title: `${value} UTC` } });

  const priorityNames: Record<string, string> = { high: strings.priorityHigh, medium: strings.priorityMedium, low: strings.priorityLow };

  const priority = (value: string): E => {
    const lower = value.toLowerCase();
    const known = Object.hasOwn(priorityNames, lower);
    return el('span', {
      className: `detail-priority${known ? ` detail-priority-${lower}` : ''}`,
      text: known ? priorityNames[lower] : value,
      attrs: { title: `${strings.fieldPriority}: ${value}` },
    });
  };

  /** A select that sends setField on change; the current value is always an option. */
  const fieldSelect = (field: string, label: string, current: string, choices: readonly { value: string; text: string }[]): E => {
    const list = choices.some((c) => c.value === current) ? choices : [...choices, { value: current, text: current }];
    return appendAll(
      el('select', { className: `detail-select detail-select-${field}`, attrs: { 'data-action': 'set-field', 'data-field': field, 'aria-label': label } }),
      list.map((c) => {
        const attrs: Record<string, string> = { value: c.value };
        if (c.value === current) attrs.selected = '';
        return el('option', { text: c.text, attrs });
      }),
    );
  };

  const statusSelect = (): E => {
    const disabled = detail.statusLine === null || !detail.editable;
    const attrs: Record<string, string> = { 'data-action': 'set-status', 'data-path': detail.path, 'aria-label': strings.fieldStatus };
    if (detail.statusLine !== null) attrs['data-status-line'] = detail.statusLine;
    if (disabled) attrs.disabled = '';
    const names = statuses.includes(detail.status) ? statuses : [...statuses, detail.status];
    const options = names.map((name) => {
      const optionAttrs: Record<string, string> = { value: name };
      if (name === detail.status) optionAttrs.selected = '';
      return el('option', { text: name, attrs: optionAttrs });
    });
    return appendAll(el('select', { className: 'detail-status', attrs }), options);
  };

  // The configured priorities (the CLI accepts only these), sent and written in lower case like
  // the CLI; high/medium/low show their translated names. A value not configured stays shown.
  const prioritySelect = (): E =>
    fieldSelect('priority', strings.fieldPriority, detail.priority === null ? '' : detail.priority.toLowerCase(), [
      { value: '', text: strings.noPriority },
      ...(edit?.priorities ?? []).map((p) => {
        const lower = p.toLowerCase();
        return { value: lower, text: Object.hasOwn(priorityNames, lower) ? priorityNames[lower] : p };
      }),
    ]);

  const titleBlock = (): E => {
    if (edit?.editor?.kind === 'title' && canEdit('title')) {
      const input = el('input', {
        className: 'detail-title-input',
        attrs: {
          type: 'text',
          value: edit.editor.draft,
          'data-editor': 'title',
          'data-field': 'title',
          'aria-label': strings.columnTitle,
          spellcheck: 'false',
          ...invalid('title'),
        },
      });
      const parts = [input, button('detail-save', strings.save, { 'data-action': 'save-edit' }), button('detail-cancel', strings.cancel, { 'data-action': 'cancel-edit' })];
      const error = fieldError('title');
      return el('div', { className: 'detail-title-edit' }, ...parts, ...(error ? [error] : []));
    }
    if (canEdit('title')) {
      // The title itself is the edit control (click, Enter or F2), like the board's lane titles.
      return el('h1', {
        className: 'detail-title editable',
        text: detail.title,
        attrs: {
          role: 'button',
          tabindex: '0',
          'data-action': 'edit-title',
          // Shown after the title on hover and focus (backlog.css), so the control is discoverable.
          'data-hint': strings.editSection,
          title: strings.editTitle,
          'aria-label': `${strings.editTitle}: ${detail.title}`,
        },
      });
    }
    return el('h1', { className: 'detail-title', text: detail.title, attrs: { dir: 'auto' } });
  };

  const header = (): E => {
    const meta = el('div', { className: 'detail-meta' }, statusSelect());
    if (canEdit('priority')) meta.append(prioritySelect());
    else if (detail.priority !== null) meta.append(priority(detail.priority));
    if (detail.updated !== null) {
      meta.append(el('span', { className: 'detail-updated' }, el('span', { className: 'detail-meta-label', text: strings.fieldUpdated }), ' ', date(detail.updated)));
    }
    const actions = el(
      'div',
      { className: 'detail-actions' },
      button('detail-open', strings.openFile, { 'data-action': 'open-task', 'data-path': detail.path }),
      button('detail-close', strings.closeDetail, { 'data-action': 'close-detail' }),
    );
    return el('div', { className: 'detail-header' }, el('div', { className: 'detail-heading' }, el('span', { className: 'detail-id', text: detail.id }), titleBlock()), meta, actions);
  };

  const taskRef = (ref: TaskRef): E => {
    if (ref.path === null) return el('span', { className: 'detail-task-missing', text: `${ref.id} (${strings.taskNotFound})` });
    const text = ref.title === null ? ref.id : `${ref.id} ${ref.title}`;
    const attrs: Record<string, string> = { 'data-action': 'show-task', 'data-path': ref.path };
    if (ref.status !== null) attrs.title = ref.status;
    if (!ref.archived) return link('detail-task-link', text, attrs);
    // An archived task (backlog.md 3.1) opens read-only; the tag says why it is not on the board.
    return el('span', { className: 'detail-task-archived' }, link('detail-task-link', text, attrs), el('span', { className: 'detail-archived-tag', text: `(${strings.archivedTask})` }));
  };

  const target = (value: string): E =>
    WEB_URL.test(value)
      ? link('detail-url', value, { 'data-action': 'open-url', 'data-url': value })
      : link('detail-path', value, { 'data-action': 'open-path', 'data-path': value });

  const values = (className: string, items: readonly E[]): E => appendAll(el('div', { className: `detail-values ${className}` }), items);
  const texts = (className: string, items: readonly string[]): E =>
    values(className, items.map((text) => el('span', { className: 'detail-value', text })));

  /** How each list item is shown, inside a chip or on its own. */
  const itemView = (field: ListField, value: string, index: number): E => {
    switch (field) {
      case 'labels':
        return el('span', { className: 'detail-label', text: value });
      case 'dependencies':
        return taskRef(detail.dependencies[index]!);
      case 'references':
      case 'documentation':
      case 'modified_files':
        return target(value);
      default:
        return el('span', { className: 'detail-value', text: value });
    }
  };

  const SUGGEST: Partial<Record<ListField, () => readonly { value: string; text?: string }[]>> = {
    labels: () => (edit?.labels ?? []).map((value) => ({ value })),
    assignee: () => (edit?.assignees ?? []).map((value) => ({ value })),
    dependencies: () => (edit?.tasks ?? []).filter((t) => t.id !== detail.id).map((t) => ({ value: t.id, text: t.title })),
  };

  /** Chips with a remove button each, then an input that adds items (Enter or comma). */
  const chips = (field: ListField, label: string): E => {
    const items = listValues(detail, field);
    const chipList = items.map((value, index) =>
      el(
        'span',
        { className: 'detail-chip' },
        itemView(field, value, index),
        button('detail-chip-remove', '×', {
          'data-action': 'remove-item',
          'data-field': field,
          'data-index': String(index),
          'aria-label': fill(strings.removeItem, value),
          title: fill(strings.removeItem, value),
        }),
      ),
    );
    const inputAttrs: Record<string, string> = {
      type: 'text',
      value: edit?.chipDrafts[field] ?? '',
      placeholder: strings.addItem,
      'aria-label': `${label}: ${strings.addItem}`,
      title: strings.addItemHint,
      'data-action': 'chip-input',
      'data-field': field,
      spellcheck: 'false',
      autocomplete: 'off',
      ...invalid(field),
    };
    const suggestions = SUGGEST[field]?.() ?? [];
    const parts: E[] = [...chipList];
    if (suggestions.length > 0) inputAttrs.list = `detail-options-${field}`;
    parts.push(el('input', { className: 'detail-chip-input', attrs: inputAttrs }));
    const wrap = appendAll(el('div', { className: 'detail-chips', attrs: { 'data-field': field } }), parts);
    const out: E[] = [wrap];
    if (suggestions.length > 0) {
      out.push(
        appendAll(
          el('datalist', { attrs: { id: `detail-options-${field}` } }),
          suggestions.map((s) => el('option', { text: s.text ?? s.value, attrs: { value: s.value } })),
        ),
      );
    }
    const error = fieldError(field);
    if (error) out.push(error);
    return el('div', { className: 'detail-field-edit' }, ...out);
  };

  const fields = (): E => {
    const rows: [string, E][] = [];
    const add = (label: string, value: E | null): void => {
      if (value !== null) rows.push([label, value]);
    };
    const nonEmpty = <T>(list: readonly T[], make: (list: readonly T[]) => E): E | null => (list.length > 0 ? make(list) : null);
    const text = (value: string | null): E | null => (value === null ? null : el('span', { className: 'detail-value', text: value }));
    /** A list field: chips when editable, else the read-only rendering when not empty. */
    const list = (field: ListField, label: string, readOnly: () => E | null): void => add(label, canEdit(field) ? chips(field, label) : readOnly());

    list('assignee', strings.fieldAssignee, () => nonEmpty(detail.assignees, (l) => texts('detail-assignees', l)));
    list('labels', strings.fieldLabels, () =>
      nonEmpty(detail.labels, (l) => values('detail-labels', l.map((label) => el('span', { className: 'detail-label', text: label })))),
    );
    if (canEdit('milestone')) {
      const choices = [{ value: '', text: strings.noMilestone }, ...(edit?.milestones ?? []).map((m) => ({ value: m.id, text: m.title === m.id ? m.id : `${m.title} (${m.id})` }))];
      add(strings.fieldMilestone, fieldSelect('milestone', strings.fieldMilestone, detail.milestone ?? '', choices));
    } else if (detail.milestone !== null) {
      add(strings.fieldMilestone, el('span', { className: 'detail-value', text: detail.milestoneTitle ?? detail.milestone, attrs: { title: detail.milestone } }));
    }
    if (canEdit('type')) {
      const choices = [{ value: '', text: strings.noType }, ...(edit?.taskTypes ?? []).map((t) => ({ value: t, text: t }))];
      add(strings.fieldType, fieldSelect('type', strings.fieldType, detail.type ?? '', choices));
    } else {
      add(strings.fieldType, text(detail.type));
    }
    add(strings.fieldProject, text(detail.project));
    add(strings.fieldReporter, text(detail.reporter));
    if (canEdit('due_date') && (detail.due === null || DATE_INPUT.test(detail.due))) {
      add(
        strings.fieldDue,
        el('input', {
          className: 'detail-date-input',
          attrs: { type: 'date', value: detail.due ?? '', 'data-action': 'set-field', 'data-field': 'due_date', 'aria-label': strings.fieldDue },
        }),
      );
    } else {
      add(strings.fieldDue, text(detail.due));
    }
    add(strings.fieldCreated, detail.created === null ? null : date(detail.created));
    add(strings.fieldParent, detail.parent === null ? null : taskRef(detail.parent));
    add(strings.fieldSubtasks, nonEmpty(detail.subtasks, (l) => values('detail-task-links', l.map(taskRef))));
    list('dependencies', strings.fieldDependsOn, () => nonEmpty(detail.dependencies, (l) => values('detail-task-links', l.map(taskRef))));
    add(strings.fieldBlocks, nonEmpty(detail.blocks, (l) => values('detail-task-links', l.map(taskRef))));
    list('references', strings.fieldReferences, () => nonEmpty(detail.references, (l) => values('detail-targets', l.map(target))));
    list('documentation', strings.fieldDocumentation, () => nonEmpty(detail.documentation, (l) => values('detail-targets', l.map(target))));
    list('modified_files', strings.fieldModifiedFiles, () => nonEmpty(detail.modifiedFiles, (l) => values('detail-targets', l.map(target))));
    return el('dl', { className: 'detail-fields' }, ...rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', {}, value)]));
  };

  const SECTION_TITLES: Readonly<Record<EditSection, string>> = {
    description: strings.sectionDescription,
    plan: strings.sectionPlan,
    notes: strings.sectionNotes,
    finalSummary: strings.sectionFinalSummary,
  };

  const section = (name: string, title: string, ...content: E[]): E =>
    el('section', { className: `detail-section detail-section-${name}` }, el('h2', { className: 'detail-section-title', text: title }), ...content);

  const checklist = (list: 'ac' | 'dod', view: ChecklistView): E[] => {
    const disabled = view.readOnly || !detail.editable;
    const items = view.items.map((item) => {
      const attrs: Record<string, string> = {
        type: 'checkbox',
        'data-action': 'toggle-check',
        'data-path': detail.path,
        'data-list': list,
        'data-line': String(item.line),
        'data-source': item.source,
      };
      if (item.checked) attrs.checked = '';
      if (disabled) attrs.disabled = '';
      return el(
        'li',
        { className: `detail-check-item${item.checked ? ' detail-check-checked' : ''}` },
        el(
          'label',
          { className: 'detail-check' },
          el('input', { className: 'detail-checkbox', attrs }),
          el('span', { className: 'detail-check-number', text: `#${item.number}` }),
          el('span', { className: 'detail-check-text' }, inlineMarkdown(item.text)),
        ),
      );
    });
    const parts = [appendAll(el('ul', { className: 'detail-checklist' }), items)];
    if (view.readOnly) parts.push(el('p', { className: 'detail-note', text: strings.checklistReadOnly, attrs: { role: 'note' } }));
    return parts;
  };

  const comments = (): E | null => {
    const composer = (): E | null => {
      if (edit === undefined || !detail.editable) return null;
      const commentError = fieldError('comment');
      return el(
        'div',
        { className: 'detail-comment-new' },
        el('textarea', {
          className: 'detail-comment-input',
          text: edit.commentDraft,
          attrs: { rows: '3', placeholder: strings.commentPlaceholder, 'aria-label': strings.commentPlaceholder, 'data-editor': 'comment', ...invalid('comment') },
        }),
        el(
          'div',
          { className: 'detail-edit-actions' },
          button('detail-add-comment', strings.addComment, { 'data-action': 'add-comment', ...(edit.commentDraft.trim() === '' ? { disabled: '' } : {}) }),
          el('span', { className: 'detail-edit-hint', text: strings.commentHint }),
        ),
        ...(commentError ? [commentError] : []),
      );
    };
    const extra = composer();
    const tail = extra === null ? [] : [extra];
    if (detail.comments !== null && detail.comments.length > 0) {
      const list = detail.comments.map((comment) => {
        const meta = el('div', { className: 'detail-comment-meta' });
        if (comment.author !== null) meta.append(el('span', { className: 'detail-comment-author', text: comment.author }));
        if (comment.created !== null) meta.append(date(comment.created));
        return el('div', { className: 'detail-comment' }, meta, markdown(comment.body));
      });
      return appendAll(section('comments', strings.sectionComments), [...list, ...tail]);
    }
    if (detail.commentsRaw !== null) return section('comments', strings.sectionComments, markdown(detail.commentsRaw), ...tail);
    return extra === null ? null : section('comments', strings.sectionComments, extra);
  };

  /** A text section: content and an Edit button, or the open editor. */
  const textSection = (name: EditSection): E | null => {
    const title = SECTION_TITLES[name];
    const text = sectionText(detail, name);
    const editable = canEdit(name);
    if (editable && edit?.editor?.kind === 'section' && edit.editor.name === name) {
      const saveAttrs: Record<string, string> = { 'data-action': 'save-edit' };
      // The description cannot be emptied (the extension refuses it); other sections can.
      if (name === 'description' && edit.editor.draft.trim() === '') saveAttrs.disabled = '';
      const error = fieldError(name);
      return el(
        'section',
        { className: `detail-section detail-section-${name} editing` },
        el('h2', { className: 'detail-section-title', text: title }),
        el('textarea', {
          className: 'detail-section-input',
          text: edit.editor.draft,
          attrs: {
            rows: String(Math.min(Math.max(edit.editor.draft.split('\n').length + 1, 4), 20)),
            'data-editor': 'section',
            'data-section': name,
            'aria-label': title,
            ...invalid(name),
          },
        }),
        el(
          'div',
          { className: 'detail-edit-actions' },
          button('detail-save', strings.save, saveAttrs),
          button('detail-cancel', strings.cancel, { 'data-action': 'cancel-edit' }),
          el('span', { className: 'detail-edit-hint', text: strings.editHint }),
        ),
        ...(error ? [error] : []),
      );
    }
    if (text === null) return null;
    const heading = el('h2', { className: 'detail-section-title', text: title });
    const head = editable
      ? el(
          'div',
          { className: 'detail-section-head' },
          heading,
          button('detail-edit', strings.editSection, { 'data-action': 'edit-section', 'data-section': name, 'aria-label': `${strings.editSection}: ${title}` }),
        )
      : heading;
    return el('section', { className: `detail-section detail-section-${name}` }, head, markdown(text));
  };

  const bodySection = (name: SectionName): E | null => {
    if (name === 'ac') return detail.ac === null ? null : section('ac', strings.sectionAcceptanceCriteria, ...checklist('ac', detail.ac));
    if (name === 'dod') return detail.dod === null ? null : section('dod', strings.sectionDefinitionOfDone, ...checklist('dod', detail.dod));
    if (name === 'comments') return comments();
    return textSection(name);
  };

  const root = el('div', { className: 'detail', attrs: { 'data-path': detail.path } }, header());
  if (detail.readOnly !== null) {
    root.append(
      el(
        'p',
        { className: 'detail-notice detail-read-only', attrs: { role: 'note' } },
        el('strong', { className: 'detail-read-only-label', text: strings.readOnlyLabel }),
        el('span', { text: readOnlyText(detail.readOnly, strings) }),
      ),
    );
  }
  root.append(fields());

  // Sections the file does not have yet can be added (backlog.md 5.4: created where the CLI puts them).
  const missing = EDIT_SECTIONS.filter(
    (name) => canEdit(name) && sectionText(detail, name) === null && !(edit?.editor?.kind === 'section' && edit.editor.name === name),
  );
  if (missing.length > 0) {
    root.append(
      el(
        'div',
        { className: 'detail-add-sections' },
        ...missing.map((name) => button('detail-add-section', fill(strings.addSection, SECTION_TITLES[name]), { 'data-action': 'add-section', 'data-section': name })),
      ),
    );
  }

  for (const name of SECTION_ORDER) {
    const part = bodySection(name);
    if (part !== null) root.append(part);
  }
  if (detail.otherBody !== '') root.append(section('other', strings.sectionOther, markdown(detail.otherBody)));
  if (detail.otherFields.length > 0) {
    const sources = detail.otherFields.map((field) => el('pre', { className: 'detail-other-field', text: field.source }));
    root.append(appendAll(section('other-fields', strings.fieldOther), sources));
  }
  return root;
}
