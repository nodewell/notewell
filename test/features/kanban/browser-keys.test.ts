// VS Code's webview host forwards every keydown that bubbles to the window to the
// workbench keybindings, even when defaultPrevented (webview pre/index.html,
// handleInnerKeydown). Keys the board handles must therefore stop propagation, or e.g.
// Alt+Left would move the card and then run VS Code's 'Go Back'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../../../src/features/kanban/browser/main.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../../src/features/kanban/browser/kanban.css', import.meta.url), 'utf8');

function block(start: RegExp): string {
  const at = main.search(start);
  assert.ok(at >= 0, String(start));
  const end = main.indexOf('\n});', at);
  return main.slice(at, end);
}

test('consume() prevents the default and stops propagation', () => {
  const body = /function consume\(event: Event\): void \{([\s\S]*?)\n\}/.exec(main)?.[1];
  assert.ok(body);
  assert.match(body, /event\.preventDefault\(\);/);
  assert.match(body, /event\.stopPropagation\(\);/);
});

test('every key the board handles is consumed, never only prevented', () => {
  const handler = block(/app\.addEventListener\('keydown'/);
  assert.doesNotMatch(handler, /preventDefault\(\)/, 'use consume(event) so the key does not reach VS Code');
  // Alt+arrows (cards and lanes), arrows, Space, F2/Enter, Enter on links, N, the card
  // menu shortcut, Delete, Ctrl+Enter (open in text), the body fold keys and the preview chord
  // (start, Ctrl+I), Enter/Space on the date badge (date picker): 15 places.
  assert.equal([...handler.matchAll(/consume\(event\);/g)].length, 15);
});

test('the board listens on #app, below the window where VS Code listens', () => {
  assert.match(main, /app\.addEventListener\('keydown'/);
  assert.doesNotMatch(main, /window\.addEventListener\('keydown'/);
});

test('inline editors keep their keys inside the editor', () => {
  const editor = /field\.addEventListener\('keydown', \(event\) => \{([\s\S]*?)\n  \}\);/.exec(main)?.[1];
  assert.ok(editor);
  assert.match(editor, /event\.stopPropagation\(\);/);
});

test('a clicked card, keyboard focus and the card just added share one selection ring', () => {
  const rule = /\.card:focus,\s*\.card\.selected,\s*\.card:not\(\.editing\):focus-within\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(rule, 'selection rule present');
  assert.match(rule, /outline: 1px solid var\(--nw-focus\)/);
  assert.doesNotMatch(css, /\.card:focus-visible\s*\{/, 'no separate keyboard-only look');
});

test('N opens the add input from a selected card or lane title and is consumed', () => {
  const handler = block(/app\.addEventListener\('keydown'/);
  const branch = /if \(isAddCardShortcut\(event\)[^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(handler)?.[1];
  assert.ok(branch, 'N branch present');
  assert.match(branch, /openAdder\(lane\)/);
  assert.match(branch, /consume\(event\);/);
  assert.match(handler, /target\.matches\('li\.card'\) \|\| target\.matches\('\.lane-title'\)/);
});

test('the add input keeps its keys (N types an n there) and never closes on a redraw', () => {
  const opener = /function openAdder\([\s\S]*?\n\}/.exec(main)?.[0];
  assert.ok(opener);
  assert.match(opener, /input\.addEventListener\('keydown', \(event\) => \{\s*\/\/[^\n]*\n\s*event\.stopPropagation\(\);/);
  assert.match(opener, /if \(drawing \|\| adder !== a\) return;/, 'blur from a redraw is ignored');
});

test('Shift+F10 / the context menu key and Delete on a selected card are consumed', () => {
  const handler = block(/app\.addEventListener\('keydown'/);
  const branch = (shortcut: string) =>
    new RegExp(`if \\(target\\.matches\\('li\\.card'\\) && ${shortcut}\\(event\\)\\) \\{([\\s\\S]*?)\\n  \\}`).exec(handler)?.[1];
  const menuBranch = branch('isCardMenuShortcut');
  assert.ok(menuBranch);
  assert.match(menuBranch, /openCardMenu\(ref\)/);
  assert.match(menuBranch, /consume\(event\);/);
  const deleteBranch = branch('isDeleteShortcut');
  assert.ok(deleteBranch);
  assert.match(deleteBranch, /requestDelete\(ref\)/);
  assert.match(deleteBranch, /consume\(event\);/);
});

test('Ctrl+Enter on a selected card opens it in text before Enter/F2 can edit it (kanban.md 4.7)', () => {
  const handler = block(/app\.addEventListener\('keydown'/);
  const at = handler.indexOf("if (target.matches('li.card') && isOpenInTextShortcut(event)) {");
  assert.ok(at >= 0);
  const branch = handler.slice(at, handler.indexOf('\n  }', at));
  assert.match(branch, /post\(openInTextMessage\(version, card\.id\)\)/);
  assert.match(branch, /consume\(event\);/);
  // Checked before the plain Enter/F2 edit branch and after the Ctrl+K chord (which stays first).
  const edit = handler.indexOf("key === 'F2' || key === 'Enter') {\n    editCard(ref);");
  assert.ok(edit > at);
  assert.ok(handler.indexOf('chordStep(') < at);
});

test('menu keys stay in the menu and handled ones are prevented', () => {
  const body = /function onMenuKey\([^)]*\): void \{([\s\S]*?)\n\}/.exec(main)?.[1];
  assert.ok(body);
  const stop = body.indexOf('event.stopPropagation();');
  assert.ok(stop >= 0 && stop < body.indexOf('menuKeyAction(event)'), 'stopped before anything else');
  assert.match(body, /if \(action === 'none'\) return;\s*event\.preventDefault\(\);/);
  // Escape in the lane list steps back to the menu; otherwise the menu closes onto the card.
  assert.match(body, /closeLaneMenu\(open, true\)/);
  assert.match(body, /closeCardMenu\(true\)/);
});

test('closing the menu returns focus to its card; a redraw closes it', () => {
  const close = /function closeCardMenu\(returnFocus: boolean\): void \{([\s\S]*?)\n\}/.exec(main)?.[1];
  assert.ok(close);
  assert.match(close, /if \(returnFocus\) card\?\.focus\(\);/);
  const draw = /function draw\(\)[\s\S]*?\n\}/.exec(main)?.[0];
  assert.ok(draw);
  assert.match(draw, /closeCardMenu\(false\);/);
});

test('right-click on a card opens the card menu instead of the browser one', () => {
  const handler = block(/app\.addEventListener\('contextmenu'/);
  assert.match(handler, /event\.preventDefault\(\);/);
  assert.match(handler, /openCardMenu\(ref, \{ x: event\.clientX, y: event\.clientY \}\)/);
  assert.match(handler, /card\.classList\.contains\('editing'\)/, 'editors keep the browser menu');
});

test('resting on "Move to lane" opens the lane list after 250ms without taking focus', () => {
  assert.match(main, /const SUBMENU_DELAY_MS = 250;/);
  const hover = /function hoverMain\([^)]*\): void \{([\s\S]*?)\n\}/.exec(main)?.[1];
  assert.ok(hover);
  assert.match(hover, /openLaneMenu\(open, i, false\)/);
  assert.match(hover, /else if \(open\.sub\) \{\s*closeLaneMenu\(open, false\);/, 'another item closes the list');
  assert.match(main, /function closeCardMenu[^{]*\{\s*clearTimeout\(submenuTimer\);/);
});

test('the active menu row is a filled selection drawn with the menu tokens', () => {
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  const active = rule('.card-menu-item.active');
  assert.match(active, /background: var\(--nw-menu-active-bg\);/);
  assert.match(active, /border-color: var\(--nw-menu-active-border\);/);
  // Label, delete text, hints, chevron and check mark all take the selection text color.
  assert.match(css, /\.card-menu-item\.active,\s*\.card-menu-item\.active\.danger,\s*\.card-menu-item\.active \.card-menu-keybinding,\s*\.card-menu-item\.active \.card-menu-chevron,\s*\.card-menu-item\.active \.card-menu-done \{\s*color: var\(--nw-menu-active-fg\);/);
  assert.match(rule('.card-menu-item.danger'), /color-mix\(in srgb, var\(--nw-error\) 80%, var\(--nw-menu-fg\)\)/);
  assert.match(rule("body[data-style='obsidian'] .card-menu-item.danger"), /color-mix\(in srgb, var\(--nw-error\) 55%, var\(--nw-menu-fg\)\)/);
  assert.match(rule('.card-menu'), /background: var\(--nw-menu-bg\);/);
  assert.match(rule('.card-menu-separator'), /background: var\(--nw-menu-separator\);/);
});

test('obsidian style: accent-tinted active row with an accent border and menu text', () => {
  assert.match(
    css,
    /body\[data-style='obsidian'\] \.card-menu-item\.active \{\s*background: color-mix\(in srgb, var\(--nw-menu-active-bg\) 20%, var\(--nw-menu-bg\)\);\s*border-color: var\(--nw-menu-active-bg\);/,
  );
  assert.match(css, /body\[data-style='obsidian'\] \.card-menu-item\.active \.card-menu-done \{\s*color: var\(--nw-menu-fg\);/);
});

test('obsidian keeps the delete hue on the tinted row; vscode adds a ring to a keyboard-driven row', () => {
  assert.match(css, /body\[data-style='obsidian'\] \.card-menu-item\.active\.danger \{\s*color: color-mix\(in srgb, var\(--nw-error\) 45%, var\(--nw-menu-fg\)\);/);
  assert.match(css, /body\[data-style='vscode'\] \.card-menu-item\.active:focus-visible \{\s*outline: 1px solid var\(--nw-focus\);\s*outline-offset: -1px;/);
});

test('the collapse chevron turns 90deg in 120ms, starts from its old angle after a redraw, and keeps focus', () => {
  assert.match(css, /\.lane-collapse-icon \{[^}]*font-size: 16px;[^}]*transition: transform 120ms ease-out;/);
  assert.match(css, /button\.lane-collapse\[aria-expanded='true'\] \.lane-collapse-icon \{\s*transform: rotate\(90deg\);/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.lane-collapse-icon \{\s*transition: none;/);
  const turn = /function turnIcon\([^)]*\): void \{([\s\S]*?)\n\}/.exec(main)?.[1];
  assert.ok(turn);
  assert.match(turn, /classList\.add\('turn-from'\);\s*void button\.offsetWidth;\s*button\.classList\.remove\('turn-from'\);/);
  assert.match(turn, /if \(focus\) button\.focus\(\);/);
  assert.match(main, /draw\(\);\s*turnCollapseIcon\(lane, hadFocus\);/);
});
