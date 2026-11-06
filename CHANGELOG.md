# Changelog

Notable changes in each Notewell release. While the version is below 1.0, a minor version may change behavior.

## 0.8.5 — 2026-11-06

- Marketplace page: the extension's own description, tags and this change log. The extension itself is unchanged.

## 0.8.4 — 2026-11-06

- Marketplace page: the full README with screenshots. The extension itself is unchanged.

## 0.8.3 — 2026-11-02

- **Kanban**: the board scrolls inside the editor, so its horizontal scrollbar stays at the bottom of the window however long the lanes are. The scroll position is kept when the board redraws or the tab is hidden.

## 0.8.2 — 2026-11-02

- Marketplace package: commands and settings in Korean again. The extension itself is unchanged.

## 0.8.1 — 2026-11-02

- Marketplace page: icon and links. The extension itself is unchanged.

## 0.8.0 — 2026-11-02

First public release (preview).

### Obsidian

- **Kanban**: boards made with the Kanban community plugin open as boards. Check, add, edit (multi-line), move, duplicate and delete cards; reorder and rename lanes; card menu, date picker and full keyboard control; checkbox display and lane width per board, as Obsidian stores them; done lanes; new boards from the Explorer.
- **Links and attachments**: renaming or moving a note updates the links to it; pasted or dropped files are saved where Obsidian's attachment setting says; a Backlinks view; link previews on hover; **Ctrl+click** on a link to a missing note creates it.
- **Daily notes and templates**: open or create today's (or any date's) daily note and insert templates, the current date and time, with Obsidian's folders, date formats and templates, and English or Korean month and weekday names.
- **Canvas**: `.canvas` files open in a canvas view with groups, colors, edges, note and image cards. Move, resize and recolor cards and edit text cards.

### Backlog.md

- Board, list and detail views of a project's tasks in an editor tab. Drag cards to change their status or order; check acceptance criteria and Definition of Done items; edit fields, the description, plan, notes and final summary; add comments; filter and search.

### Everywhere

- Only the lines (or, in a canvas, the values) an action changes are rewritten, and the original tool keeps working on the same files. Edits go through the editor, so **Ctrl+Z** works.
- No runtime dependencies and no network access. English and Korean.
- VS Code's own settings stay untouched unless you turn on `notewell.kanban.rememberBoards`.
