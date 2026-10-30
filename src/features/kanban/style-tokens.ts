// Board style tokens (kanban.md 3.1). kanban.css draws everything through these CSS
// variables; their defaults are the Notewell style (VS Code theme variables). The
// Obsidian style overrides them at runtime with validated values (core.md 3.6).
// No VS Code API: shared by the extension (mapping) and the webview (applying).

export const KANBAN_STYLE_TOKENS = [
  // Surfaces
  '--nw-board-bg',
  '--nw-lane-bg',
  '--nw-card-bg',
  '--nw-border',
  '--nw-hover-bg',
  '--nw-input-bg',
  '--nw-input-border',
  '--nw-shadow',
  '--nw-popup-bg',
  '--nw-popup-border',
  '--nw-hover-border',
  '--nw-toolbar-hover',
  '--nw-scrollbar',
  '--nw-scrollbar-hover',
  '--nw-outline',
  // Text
  '--nw-fg',
  '--nw-fg-muted',
  '--nw-fg-faint',
  '--nw-link',
  '--nw-link-active',
  '--nw-input-fg',
  // Accent, focus, done
  '--nw-accent',
  '--nw-on-accent',
  '--nw-focus',
  '--nw-done',
  '--nw-info',
  '--nw-error',
  // Card menu (kanban.md 4.6): the vscode style follows VS Code's menu colors
  '--nw-menu-bg',
  '--nw-menu-fg',
  '--nw-menu-border',
  '--nw-menu-separator',
  '--nw-menu-active-bg',
  '--nw-menu-active-fg',
  '--nw-menu-active-border',
  // Tokens in cards
  '--nw-tag-bg',
  '--nw-tag-fg',
  '--nw-date',
  '--nw-date-past',
  '--nw-date-today',
  '--nw-highlight-bg',
  '--nw-code-bg',
  // Shape and type
  '--nw-radius-card',
  '--nw-radius-lane',
  '--nw-font',
  '--nw-font-mono',
  '--nw-font-size',
] as const;

export type KanbanStyleToken = (typeof KANBAN_STYLE_TOKENS)[number];

const TOKEN_SET: ReadonlySet<string> = new Set(KANBAN_STYLE_TOKENS);

export function isKanbanStyleToken(name: string): name is KanbanStyleToken {
  return TOKEN_SET.has(name);
}

/**
 * Board style (kanban.md 3.1): 'vscode' = the token defaults (VS Code theme), 'obsidian' =
 * the vault's Obsidian theme, 'notewell' = Notewell's own palette (notewell-theme.ts).
 */
export type BoardStyle = 'vscode' | 'obsidian' | 'notewell';

/** Dark or light variant of the 'obsidian' and 'notewell' styles. */
export type ColorScheme = 'dark' | 'light';

