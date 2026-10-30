// `.obsidian/appearance.json` and how a vault's theme is put together (core.md 3.2, 3.6).
// Pure: the adapter (appearance-store.ts) reads the files and passes their text here.
import { cascadeThemeVariables, isSafeThemeValue, type ThemeVariables } from './theme-css.ts';

/** `theme`: `obsidian` = dark, `moonstone` = light, anything else (incl. `system`) = follow VS Code. */
export type AppearanceMode = 'dark' | 'light' | 'system';

export interface ObsidianAppearance {
  /** Community theme folder name under `.obsidian/themes/`; '' = default theme. */
  readonly cssTheme: string;
  readonly mode: AppearanceMode;
  /** Accent colour set in Obsidian (validated CSS value), if any. */
  readonly accentColor?: string;
  /** Enabled snippet names (files `.obsidian/snippets/<name>.css`), in Obsidian's order. */
  readonly enabledCssSnippets: readonly string[];
  /** Font family list for text (validated CSS value), if set. */
  readonly textFontFamily?: string;
  /** Base font size in px, if set (8..64). */
  readonly baseFontSize?: number;
}

export const DEFAULT_APPEARANCE: ObsidianAppearance = Object.freeze({
  cssTheme: '',
  mode: 'system',
  enabledCssSnippets: Object.freeze([]) as readonly string[],
});

export interface AppearanceResult {
  readonly appearance: ObsidianAppearance;
  /** Set when the file exists but is not a JSON object (defaults are used). */
  readonly error?: string;
}

/**
 * A theme or snippet name usable as one path segment: no separators, no `.`/`..`, no
 * control characters, not too long. Anything else is ignored (never joined into a path).
 */
export function isSafeName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/:*?"<>|]/.test(name) &&
    ![...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  );
}

/** Parses appearance.json text; missing file (undefined) or bad values fall back to defaults. */
export function parseAppearance(text: string | undefined): AppearanceResult {
  if (text === undefined) return { appearance: DEFAULT_APPEARANCE };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { appearance: DEFAULT_APPEARANCE, error: error instanceof Error ? error.message : 'invalid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { appearance: DEFAULT_APPEARANCE, error: 'not a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  const theme = r['theme'];
  const accent = r['accentColor'];
  const font = r['textFontFamily'];
  const size = r['baseFontSize'];
  const snippets = Array.isArray(r['enabledCssSnippets']) ? r['enabledCssSnippets'].filter(isSafeName) : [];
  return {
    appearance: {
      cssTheme: isSafeName(r['cssTheme']) ? r['cssTheme'] : '',
      mode: theme === 'obsidian' ? 'dark' : theme === 'moonstone' ? 'light' : 'system',
      ...(typeof accent === 'string' && accent !== '' && isSafeThemeValue(accent) ? { accentColor: accent } : {}),
      enabledCssSnippets: [...new Set(snippets)],
      ...(typeof font === 'string' && font.trim() !== '' && isSafeThemeValue(font) ? { textFontFamily: font.trim() } : {}),
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 8 && size <= 64 ? { baseFontSize: size } : {}),
    },
  };
}

export interface ThemeSources {
  /** theme.css of the community theme, if one is set and readable. */
  readonly themeCss?: string;
  /** Enabled snippets that could be read, in appearance.json order. */
  readonly snippetCss: readonly string[];
}

/**
 * The vault's effective variables: built-in default theme values (lowest), then the
 * community theme, then the enabled snippets (later wins at equal CSS weight).
 */
export function composeThemeVariables(defaults: ThemeVariables, sources: ThemeSources): ThemeVariables {
  return cascadeThemeVariables([...(sources.themeCss === undefined ? [] : [sources.themeCss]), ...sources.snippetCss], defaults);
}
