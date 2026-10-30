// Text from task files, folder names and settings shown in VS Code's own UI (backlog.md 4.1):
// panel titles, quick pick items, the status bar tooltip, notifications. Pure. VS Code reads
// `$(name)` there as an icon and `[label](command:...)` in notifications as a clickable link,
// so such text from a repository must be shown literally, on one line and with a bounded
// length.

/** Line breaks, other controls, bidi embeddings/overrides/isolates and zero-width characters. */
function isHidden(code: number): boolean {
  return (
    code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x200b && code <= 0x200d) || code === 0xfeff
  );
}

/**
 * One line of plain text: hidden characters become a space (runs collapse), at most `max`
 * characters (whole code points), cut with an ellipsis.
 */
export function uiText(text: string, max = 100): string {
  let out = '';
  let space = false;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isHidden(code) || ch === ' ') {
      space = out !== '';
      continue;
    }
    if (space) out += ' ';
    space = false;
    out += ch;
  }
  const chars = [...out];
  return chars.length <= max ? out : `${chars.slice(0, max - 1).join('')}…`;
}

/** For labels and descriptions that render `$(icon)` (quick pick items): icons escaped as VS Code reads `\$(`. */
export function uiLabel(text: string, max = 100): string {
  return uiText(text, max).replace(/\$\(/g, '\\$(');
}

/**
 * For a value inside a notification: icons escaped, and `](` broken up so `[label](target)`
 * cannot become a link (an invisible word joiner, U+2060, between them).
 */
export function uiMessageArg(text: string, max = 200): string {
  return uiLabel(text, max).replace(/\]\(/g, `]${String.fromCharCode(0x2060)}(`);
}
