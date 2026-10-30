// Obsidian theme variables -> board style tokens (kanban.md 3.1). Pure (no VS Code API):
// used by the extension (style messages) and by design previews.
import { isSafeCssValue } from '../../webview/css-values.ts';
import type { StyleMessage } from './messages.ts';
import { isKanbanStyleToken, type BoardStyle, type ColorScheme, type KanbanStyleToken } from './style-tokens.ts';

/** Candidate Obsidian variables per token, first available wins. */
export const OBSIDIAN_TOKEN_SOURCES: Readonly<Partial<Record<KanbanStyleToken, readonly string[]>>> = {
  '--nw-board-bg': ['--background-primary'],
  '--nw-lane-bg': ['--background-secondary'],
  '--nw-card-bg': ['--background-primary-alt', '--background-primary'],
  '--nw-border': ['--background-modifier-border'],
  '--nw-hover-bg': ['--background-modifier-hover'],
  '--nw-input-bg': ['--background-modifier-form-field', '--background-primary'],
  '--nw-input-border': ['--background-modifier-border'],
  '--nw-popup-bg': ['--background-secondary'],
  '--nw-popup-border': ['--background-modifier-border'],
  '--nw-hover-border': ['--background-modifier-border-hover'],
  '--nw-toolbar-hover': ['--background-modifier-hover'],
  '--nw-scrollbar': ['--scrollbar-thumb-bg'],
  '--nw-scrollbar-hover': ['--scrollbar-active-thumb-bg'],
  '--nw-fg': ['--text-normal'],
  '--nw-fg-muted': ['--text-muted'],
  '--nw-fg-faint': ['--text-faint'],
  '--nw-link': ['--text-accent', '--interactive-accent'],
  '--nw-link-active': ['--text-accent-hover'],
  '--nw-input-fg': ['--text-normal'],
  '--nw-accent': ['--interactive-accent'],
  '--nw-on-accent': ['--text-on-accent'],
  '--nw-focus': ['--interactive-accent'],
  '--nw-done': ['--color-green'],
  '--nw-info': ['--interactive-accent'],
  '--nw-error': ['--text-error'],
  '--nw-tag-bg': ['--tag-background'],
  '--nw-tag-fg': ['--tag-color'],
  '--nw-date': ['--color-blue'],
  '--nw-date-past': ['--text-error'],
  '--nw-date-today': ['--text-warning'],
  '--nw-highlight-bg': ['--text-highlight-bg'],
  '--nw-code-bg': ['--code-background'],
  '--nw-radius-card': ['--radius-s'],
  '--nw-radius-lane': ['--radius-m'],
  '--nw-font-mono': ['--font-monospace', '--font-monospace-theme'],
  // Card menu: same sources as the popup, text, border and accent tokens.
  '--nw-menu-bg': ['--background-secondary'],
  '--nw-menu-fg': ['--text-normal'],
  '--nw-menu-border': ['--background-modifier-border'],
  '--nw-menu-separator': ['--background-modifier-border'],
  '--nw-menu-active-bg': ['--interactive-accent'],
  '--nw-menu-active-fg': ['--text-on-accent'],
};

/** Tokens deliberately not taken from Obsidian (kanban.md 3.1): they keep the notewell value. */
// The active menu item border keeps the VS Code value, like the outline (it carries the
// high contrast border; Obsidian has no matching variable).
export const UNMAPPED_TOKENS: readonly KanbanStyleToken[] = ['--nw-shadow', '--nw-outline', '--nw-font-size', '--nw-menu-active-border'];

export interface StyleAppearance {
  /** appearance.json `textFontFamily` (already validated by the vault reader). */
  readonly textFontFamily?: string;
}

/**
 * Board tokens for resolved Obsidian variables of one scheme. A token is left out when
 * none of its sources is set (the board keeps its notewell value). Text font: a theme's
 * `--font-text`, then Obsidian's text font setting, then the theme's `--font-text-theme`.
 * Every value is checked again with the shared allowlist before it is returned.
 */
export function obsidianStyleTokens(
  vars: ReadonlyMap<string, string>,
  appearance: StyleAppearance = {},
): Partial<Record<KanbanStyleToken, string>> {
  const tokens: Partial<Record<KanbanStyleToken, string>> = {};
  const set = (token: string, value: string | undefined): boolean => {
    if (value === undefined || !isKanbanStyleToken(token) || !isSafeCssValue(value)) return false;
    tokens[token] = value;
    return true;
  };
  for (const [token, sources] of Object.entries(OBSIDIAN_TOKEN_SOURCES)) {
    for (const source of sources ?? []) if (set(token, vars.get(source))) break;
  }
  if (!set('--nw-font', vars.get('--font-text')) && !set('--nw-font', appearance.textFontFamily)) {
    set('--nw-font', vars.get('--font-text-theme'));
  }
  return tokens;
}

/** `notewell.kanban.style` (kanban.md 3.1). */
export type StyleSetting = BoardStyle;

/** Board tokens of one palette. */
export type StylePalette = Readonly<Partial<Record<KanbanStyleToken, string>>>;

/**
 * Style message to the webview (kanban.md 3.1). `vscode`: no tokens (VS Code theme);
 * `obsidian`: vault theme tokens; `notewell`: built-in palette tokens.
 */
export type BoardStyleMessage = StyleMessage;

export interface StyleInputs {
  readonly setting: StyleSetting;
  /** The board file is inside a vault whose appearance can be read. */
  readonly inVault: boolean;
  /** VS Code uses a high contrast theme (dark or light). */
  readonly highContrast: boolean;
  /** appearance.json `theme` of the vault (for `obsidian`). */
  readonly mode: 'dark' | 'light' | 'system';
  /** VS Code theme brightness. */
  readonly vscodeLight: boolean;
}

/**
 * Which style a board uses (kanban.md 3.1): high contrast always uses `vscode`;
 * `obsidian` outside a vault (or before vaults are known) uses `vscode`; `notewell` takes
 * dark/light from VS Code; `obsidian` from appearance.json, `system` following VS Code.
 */
export function chooseBoardStyle(inputs: StyleInputs): { style: StyleSetting; scheme: ColorScheme | null } {
  const vscodeScheme: ColorScheme = inputs.vscodeLight ? 'light' : 'dark';
  if (inputs.highContrast || inputs.setting === 'vscode') return { style: 'vscode', scheme: null };
  if (inputs.setting === 'notewell') return { style: 'notewell', scheme: vscodeScheme };
  if (!inputs.inVault) return { style: 'vscode', scheme: null };
  return { style: 'obsidian', scheme: inputs.mode === 'system' ? vscodeScheme : inputs.mode };
}

/** Only token names and values that pass both checks (the webview checks again). */
export function safeTokens(tokens: Readonly<Record<string, string | undefined>>): StylePalette {
  const out: Partial<Record<KanbanStyleToken, string>> = {};
  for (const [name, value] of Object.entries(tokens)) {
    if (isKanbanStyleToken(name) && value !== undefined && isSafeCssValue(value)) out[name] = value;
  }
  return out;
}
