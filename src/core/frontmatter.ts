// Frontmatter detection by lines only; YAML is never parsed (core.md 3.3, kanban.md 2.3).

export interface Frontmatter {
  /** Index of the opening `---` line. Always 0. */
  readonly openLine: number;
  /** Index of the closing `---` line. Content lines are `openLine + 1 .. closeLine - 1`. */
  readonly closeLine: number;
}

function isOpening(text: string): boolean {
  return text.trim() === '---';
}

/** The closing line starts at column 0; an indented `---` belongs to a YAML value (block scalar). */
const CLOSING = /^---[ \t]*$/;

/**
 * Frontmatter exists only when the first line is `---` (surrounding whitespace allowed) and a
 * later line is `---` at column 0 (trailing whitespace allowed). Without a closing line there
 * is no frontmatter.
 */
export function findFrontmatter(texts: readonly string[]): Frontmatter | null {
  const first = texts[0];
  if (first === undefined || !isOpening(first)) return null;
  for (let i = 1; i < texts.length; i++) {
    if (CLOSING.test(texts[i])) return { openLine: 0, closeLine: i };
  }
  return null;
}

/**
 * Whether a top-level `key:` line exists inside the frontmatter. The line must start
 * with the key at column 0; spaces or tabs before the colon are allowed. The value is
 * not inspected.
 */
export function frontmatterHasKey(texts: readonly string[], frontmatter: Frontmatter, key: string): boolean {
  for (let i = frontmatter.openLine + 1; i < frontmatter.closeLine; i++) {
    const text = texts[i];
    if (!text.startsWith(key)) continue;
    if (/^[ \t]*:/.test(text.slice(key.length))) return true;
  }
  return false;
}
