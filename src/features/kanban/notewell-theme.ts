// Notewell's own board palette (kanban.md 3.1 'notewell' style): fixed colors that do not
// follow the VS Code theme; dark or light is chosen by the VS Code theme's brightness.
// Extension-side data (core.md 6): literal colors are allowed here, never in stylesheets.
// Every pair of text and background meets 4.5:1 and graphics 3:1 on card and hover
// surfaces (kanban.md 3.1; test/features/kanban/notewell-theme.test.ts checks the values).
// Fonts and sizes keep following VS Code.
import type { ColorScheme, KanbanStyleToken } from './style-tokens.ts';

export type NotewellPalette = Readonly<Record<KanbanStyleToken, string>>;

const SHAPE_AND_TYPE = {
  '--nw-radius-card': '6px',
  '--nw-radius-lane': '8px',
  '--nw-font': 'var(--vscode-font-family)',
  '--nw-font-mono': 'var(--vscode-editor-font-family)',
  '--nw-font-size': '13px',
  // High contrast always uses the 'vscode' style; no outline in this palette.
  '--nw-outline': 'transparent',
} as const;

/** Deep slate surfaces in three steps, one calm blue accent, quiet semantic hues. */
const DARK: NotewellPalette = {
  '--nw-board-bg': '#0f141b',
  '--nw-lane-bg': '#151c25',
  '--nw-card-bg': '#1b2430',
  '--nw-border': '#263241',
  '--nw-hover-bg': '#222d3b',
  '--nw-hover-border': '#3a4b60',
  '--nw-input-bg': '#111821',
  '--nw-input-border': '#566b86',
  '--nw-input-fg': '#e3e9f1',
  '--nw-shadow': '#00000080',
  '--nw-popup-bg': '#1b2430',
  '--nw-popup-border': '#34445a',
  '--nw-toolbar-hover': '#ffffff14',
  '--nw-scrollbar': '#3a4a5e99',
  '--nw-scrollbar-hover': '#52667eb3',
  '--nw-fg': '#e3e9f1',
  '--nw-fg-muted': '#9eabbd',
  '--nw-fg-faint': '#75849a',
  '--nw-link': '#82b6ff',
  '--nw-link-active': '#a9ccff',
  '--nw-accent': '#5b9cf5',
  '--nw-on-accent': '#0b1220',
  '--nw-focus': '#6ea8fe',
  '--nw-done': '#4cc38a',
  '--nw-info': '#5b9cf5',
  '--nw-error': '#f0707a',
  // Card menu: the popup surface with an accent-filled selection.
  '--nw-menu-bg': '#1b2430',
  '--nw-menu-fg': '#e3e9f1',
  '--nw-menu-border': '#34445a',
  '--nw-menu-separator': '#263241',
  '--nw-menu-active-bg': '#5b9cf5',
  '--nw-menu-active-fg': '#0b1220',
  '--nw-menu-active-border': 'transparent',
  '--nw-tag-bg': '#a78bfa29',
  '--nw-tag-fg': '#c9b8ff',
  '--nw-date': '#67c6e3',
  '--nw-date-past': '#f0707a',
  '--nw-date-today': '#e8b357',
  '--nw-highlight-bg': '#f0c0602e',
  '--nw-code-bg': '#111821',
  ...SHAPE_AND_TYPE,
};

/** The same character in light: cool paper surfaces, deeper hues for text. */
const LIGHT: NotewellPalette = {
  '--nw-board-bg': '#f3f5f8',
  '--nw-lane-bg': '#e8ecf1',
  '--nw-card-bg': '#ffffff',
  '--nw-border': '#d3dae3',
  '--nw-hover-bg': '#f2f5f9',
  '--nw-hover-border': '#aebbcb',
  '--nw-input-bg': '#ffffff',
  '--nw-input-border': '#8796a8',
  '--nw-input-fg': '#1c2733',
  '--nw-shadow': '#1c273326',
  '--nw-popup-bg': '#ffffff',
  '--nw-popup-border': '#c4cdd8',
  '--nw-toolbar-hover': '#1c273312',
  '--nw-scrollbar': '#8a98a866',
  '--nw-scrollbar-hover': '#6d7c8d99',
  '--nw-fg': '#1c2733',
  '--nw-fg-muted': '#506070',
  '--nw-fg-faint': '#6a7888',
  '--nw-link': '#1d5bb8',
  '--nw-link-active': '#164891',
  '--nw-accent': '#2463c7',
  '--nw-on-accent': '#ffffff',
  '--nw-focus': '#2463c7',
  '--nw-done': '#146b43',
  '--nw-info': '#2463c7',
  '--nw-error': '#c0364a',
  // Card menu: the popup surface with an accent-filled selection.
  '--nw-menu-bg': '#ffffff',
  '--nw-menu-fg': '#1c2733',
  '--nw-menu-border': '#c4cdd8',
  '--nw-menu-separator': '#d3dae3',
  '--nw-menu-active-bg': '#2463c7',
  '--nw-menu-active-fg': '#ffffff',
  '--nw-menu-active-border': 'transparent',
  '--nw-tag-bg': '#7c5cd61f',
  '--nw-tag-fg': '#5a3db0',
  '--nw-date': '#16779c',
  '--nw-date-past': '#c0364a',
  '--nw-date-today': '#9a620a',
  '--nw-highlight-bg': '#f2c2424d',
  '--nw-code-bg': '#eef2f6',
  ...SHAPE_AND_TYPE,
};

export const NOTEWELL_PALETTE: Readonly<Record<ColorScheme, NotewellPalette>> = { dark: DARK, light: LIGHT };
