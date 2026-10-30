// Allowed CSS custom property values for theme styles (core.md 3.6). Used by the
// extension when reading Obsidian themes and again by the webview before
// style.setProperty, so a value can only ever be a color, length, number, font list or
// a combination of those through var()/calc()/color-mix() and the rgb/hsl functions.
// No VS Code API.

export const MAX_CSS_VALUE_LENGTH = 500;

const ALLOWED_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'var', 'calc', 'color-mix']);
const FORBIDDEN_TEXT = ['url(', 'expression', 'image', '\\', ';', '{', '}', '<', '>', '/*', '*/', '!', '@', '`'];
// Outside quotes: letters (any script, for font names), digits, spaces and the
// punctuation colors, lengths, calc() and font lists need.
const PLAIN_CHAR = /^[\p{L}\p{N} #.,%+*/_-]$/u;
// Inside a quoted font name.
const QUOTED_TEXT = /^[\p{L}\p{N} _.-]*$/u;

/** Whether `value` is safe to use as a style token value. */
export function isSafeCssValue(value: string): boolean {
  if (value.trim() === '' || value.length > MAX_CSS_VALUE_LENGTH) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return false;
  }
  const lower = value.toLowerCase();
  if (FORBIDDEN_TEXT.some((text) => lower.includes(text))) return false;

  let depth = 0;
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '"' || ch === "'") {
      const end = value.indexOf(ch, i + 1);
      if (end < 0 || !QUOTED_TEXT.test(value.slice(i + 1, end))) return false;
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      const name = /([a-z-]+)$/i.exec(value.slice(0, i))?.[1]?.toLowerCase();
      if (name === undefined || !ALLOWED_FUNCTIONS.has(name)) return false;
      depth++;
    } else if (ch === ')') {
      if (--depth < 0) return false;
    } else if (!PLAIN_CHAR.test(ch)) {
      return false;
    }
    i++;
  }
  return depth === 0;
}
