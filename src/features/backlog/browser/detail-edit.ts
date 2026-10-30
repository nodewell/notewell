// Detail view edits (backlog.md 5.4) as messages. Pure: the detail as shown plus the user's
// input in, a message (with the source the user saw as `expected`) or a validation error out.
import { findFences } from '../../../core/fences.ts';
import type { WebviewMessage } from '../messages.ts';
import type { TaskDetail, ViewStrings } from '../view.ts';
import { format } from './filters.ts';
import { listValues, sectionText, type EditSection, type ListField } from './render-detail.ts';

type Message<T extends WebviewMessage['type']> = Extract<WebviewMessage, { type: T }>;
export type ScalarField = Message<'setField'>['name'];

/** `expected` only when the requester saw the field (the extension inserts otherwise). */
function withExpected<T extends object>(message: T, expected: string | null | undefined): T & { expected?: string } {
  return expected === null || expected === undefined ? message : { ...message, expected };
}

/** Current value of a scalar field as the select or input shows it ('' when absent). */
export function scalarValue(detail: TaskDetail, name: ScalarField): string {
  switch (name) {
    case 'title':
      return detail.title;
    case 'priority':
      return detail.priority?.toLowerCase() ?? '';
    case 'type':
      return detail.type ?? '';
    case 'milestone':
      return detail.milestone ?? '';
    case 'due_date':
      return detail.due ?? '';
    case 'project':
      return detail.project ?? '';
    case 'reporter':
      return detail.reporter ?? '';
  }
}

/** setField, or undefined when the value does not change. */
export function setFieldMessage(detail: TaskDetail, name: ScalarField, value: string): Message<'setField'> | undefined {
  if (value === scalarValue(detail, name)) return undefined;
  return withExpected({ type: 'setField' as const, path: detail.path, name, value }, detail.fieldSources[name]);
}

/** setList with all items, or undefined when they do not change. */
export function setListMessage(detail: TaskDetail, name: ListField, values: readonly string[]): Message<'setList'> | undefined {
  const current = listValues(detail, name);
  if (values.length === current.length && values.every((v, i) => v === current[i])) return undefined;
  return withExpected({ type: 'setList' as const, path: detail.path, name, values: values.join('\n') }, detail.fieldSources[name]);
}

/** setSection, or undefined when the text does not change (an empty new section is no change). `expected` is the raw marked text. */
export function setSectionMessage(detail: TaskDetail, section: EditSection, text: string): Message<'setSection'> | undefined {
  const shown = sectionText(detail, section);
  if (text.trim() === (shown ?? '').trim()) return undefined;
  return withExpected({ type: 'setSection' as const, path: detail.path, section, text }, detail.sectionSources[section]);
}

/**
 * Text with a code fence that is never closed. Written into a section or comment, it would hide
 * the END marker and every later section from the parser, so the extension refuses it; the
 * editor says so before sending. Checked on the trimmed text, as the extension stores it.
 */
export function hasUnclosedFence(text: string): boolean {
  return findFences(text.trim().split('\n')).some((fence) => fence.close === null);
}

export function addCommentMessage(detail: TaskDetail, text: string): Message<'addComment'> | undefined {
  return text.trim() === '' ? undefined : { type: 'addComment', path: detail.path, text, seen: detail.comments?.length ?? 0 };
}

/** Fields whose chip input splits on commas (values of other fields may contain commas). */
const COMMA_SEPARATED: ReadonlySet<ListField> = new Set<ListField>(['assignee', 'labels', 'dependencies']);

export interface ChipContext {
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
  readonly strings: ViewStrings;
}

/**
 * Items typed into a chip input appended to the field's values: trimmed, empty and repeated
 * ones dropped. Dependencies must name another existing task (spelled as that task's ID);
 * the extension still refuses cycles.
 */
export function addChipValues(
  detail: TaskDetail,
  field: ListField,
  input: string,
  context: ChipContext,
): { readonly values: readonly string[] } | { readonly error: string } {
  const parts = (COMMA_SEPARATED.has(field) ? input.split(',') : [input]).map((p) => p.trim()).filter((p) => p !== '');
  const values = [...listValues(detail, field)];
  const seen = new Set(values.map((v) => v.toLowerCase()));
  for (const part of parts) {
    let value = part;
    if (field === 'dependencies') {
      const task = context.tasks.find((t) => t.id.toLowerCase() === part.toLowerCase());
      if (task === undefined) return { error: format(context.strings.unknownTaskId, part) };
      if (task.id.toLowerCase() === detail.id.toLowerCase()) return { error: context.strings.selfDependency };
      value = task.id;
    }
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
  }
  return { values };
}

/** The values without the item at `index`. */
export function removeChipValue(detail: TaskDetail, field: ListField, index: number): readonly string[] {
  return listValues(detail, field).filter((_, i) => i !== index);
}
