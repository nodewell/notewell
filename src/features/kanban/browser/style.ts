// Applies a board style message (kanban.md 3.1, core.md 3.6) to the page: token values
// go onto the root element with style.setProperty, never as CSS text. Names must be
// board tokens and values must pass the shared value check; anything else is ignored.
// The board is not redrawn, so an open editor and its draft are untouched.
// DOM-free (structural types) so it can be unit tested.
import { isSafeCssValue } from '../../../webview/css-values.ts';
import { isKanbanStyleToken, KANBAN_STYLE_TOKENS, type BoardStyle, type ColorScheme } from '../style-tokens.ts';

export interface StyleRoot {
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): unknown;
  };
}

export interface StyleBody {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface StyleResult {
  readonly style: BoardStyle;
  readonly applied: readonly string[];
  readonly ignored: readonly string[];
}

const OVERRIDING_STYLES: ReadonlySet<string> = new Set<BoardStyle>(['obsidian', 'notewell']);
const SCHEMES: ReadonlySet<string> = new Set<ColorScheme>(['dark', 'light']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Replaces the current style. Every token override is removed first, so switching
 * styles never leaves values behind. 'vscode', or any message that is not a valid
 * 'obsidian'/'notewell' style with a dark/light scheme, ends there (token defaults).
 */
export function applyStyle(
  root: StyleRoot,
  body: StyleBody,
  message: { style?: unknown; scheme?: unknown; tokens?: unknown },
): StyleResult {
  for (const token of KANBAN_STYLE_TOKENS) root.style.removeProperty(token);
  const tokens = isPlainObject(message.tokens) ? message.tokens : undefined;
  const overriding =
    typeof message.style === 'string' &&
    OVERRIDING_STYLES.has(message.style) &&
    typeof message.scheme === 'string' &&
    SCHEMES.has(message.scheme) &&
    tokens !== undefined;
  if (!overriding) {
    body.setAttribute('data-style', 'vscode');
    body.removeAttribute('data-scheme');
    return { style: 'vscode', applied: [], ignored: tokens ? Object.keys(tokens) : [] };
  }

  const applied: string[] = [];
  const ignored: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (isKanbanStyleToken(name) && typeof value === 'string' && isSafeCssValue(value)) {
      root.style.setProperty(name, value);
      applied.push(name);
    } else {
      ignored.push(name);
    }
  }
  body.setAttribute('data-style', message.style as BoardStyle);
  body.setAttribute('data-scheme', message.scheme as ColorScheme);
  return { style: message.style as BoardStyle, applied, ignored };
}
