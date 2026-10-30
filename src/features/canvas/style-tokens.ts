// Canvas style tokens (canvas.md 4, core.md 6). canvas.css draws everything through these
// CSS variables; their defaults are VS Code theme variables. User colors from the file go
// through `--nw-node-color` on the card or edge element (validated presets and hex only).
// No VS Code API.

export const CANVAS_STYLE_TOKENS = [
  // Surfaces
  '--nw-board-bg',
  '--nw-card-bg',
  '--nw-border',
  '--nw-shadow',
  '--nw-popup-bg',
  '--nw-popup-border',
  '--nw-toolbar-hover',
  '--nw-outline',
  '--nw-canvas-dot',
  '--nw-unsupported-bg',
  // Text
  '--nw-fg',
  '--nw-fg-muted',
  '--nw-card-muted',
  '--nw-link',
  '--nw-link-active',
  '--nw-code-bg',
  // Lines, focus, states
  '--nw-edge',
  '--nw-focus',
  '--nw-error',
  '--nw-info',
  '--nw-warning',
  // Color presets 1-6 (red, orange, yellow, green, cyan, purple)
  '--nw-color-1',
  '--nw-color-2',
  '--nw-color-3',
  '--nw-color-4',
  '--nw-color-5',
  '--nw-color-6',
  // Shape and type
  '--nw-radius-card',
  '--nw-font',
  '--nw-font-mono',
  '--nw-font-size',
] as const;
