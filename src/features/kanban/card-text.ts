// Multi-line card text (kanban.md 4.4): a card is edited as one text whose first line is
// the title and whose other lines are the body with one indentation step removed, as in
// Obsidian Kanban 2.x. Shared by the board view (initial edit text) and the operations.
import type { KanbanCard } from './model.ts';

/** One indentation step for card body lines: a tab or four spaces. */
export type IndentUnit = '\t' | '    ';

const FOUR_SPACES = '    ';

/**
 * The indentation step the card body already uses: the first indentation character of its
 * first non-blank body line (tab -> tab, space -> four spaces), or undefined without a body.
 */
export function bodyIndentUnit(texts: readonly string[], card: KanbanCard): IndentUnit | undefined {
  for (let i = card.body.start; i < card.body.end; i++) {
    const text = texts[i];
    if (text.trim() === '') continue;
    if (text[0] === '\t') return '\t';
    if (text[0] === ' ') return FOUR_SPACES;
  }
  return undefined;
}

/** Indentation for new body lines: the body's own step, else `useTab` (vault setting), else tab. */
export function indentUnitFor(texts: readonly string[], card: KanbanCard, useTab = true): IndentUnit {
  return bodyIndentUnit(texts, card) ?? (useTab ? '\t' : FOUR_SPACES);
}

/**
 * A body line as edit text: one leading tab or four leading spaces removed. Other
 * indentation (for example two spaces) is kept as written, as is a lazy continuation line
 * without indentation (kanban.md 2.5); blank lines become empty.
 */
export function decodeBodyLine(line: string): string {
  if (line.trim() === '') return '';
  if (line.startsWith('\t')) return line.slice(1);
  if (line.startsWith(FOUR_SPACES)) return line.slice(FOUR_SPACES.length);
  return line;
}

/** An edit-text line as a body line: one indentation step added (an empty line is the step alone). */
export function encodeBodyLine(text: string, unit: IndentUnit): string {
  return unit + text;
}

/** The card as edit text: title, then decoded body lines, joined with `\n`. */
export function cardEditText(texts: readonly string[], card: KanbanCard): string {
  const lines = [texts[card.range.start].slice(card.titleOffset)];
  for (let i = card.body.start; i < card.body.end; i++) lines.push(decodeBodyLine(texts[i]));
  return lines.join('\n');
}
