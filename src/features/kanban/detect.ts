// Content-based board detection for "open boards by default" (kanban.md 2.2, 5).
import { findFrontmatter, frontmatterHasKey } from '../../core/frontmatter.ts';
import { lineTexts, parseLines } from '../../core/lines.ts';

/** Frontmatter has a `kanban-plugin:` key. */
export function hasKanbanFrontmatter(text: string): boolean {
  const texts = lineTexts(parseLines(text));
  const frontmatter = findFrontmatter(texts);
  return frontmatter !== null && frontmatterHasKey(texts, frontmatter, 'kanban-plugin');
}
