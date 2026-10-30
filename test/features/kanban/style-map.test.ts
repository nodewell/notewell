import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chooseBoardStyle,
  OBSIDIAN_TOKEN_SOURCES,
  obsidianStyleTokens,
  safeTokens,
  UNMAPPED_TOKENS,
  type StyleInputs,
} from '../../../src/features/kanban/style-map.ts';
import { KANBAN_STYLE_TOKENS } from '../../../src/features/kanban/style-tokens.ts';
import { composeThemeVariables, parseAppearance } from '../../../src/vault/appearance.ts';
import { obsidianDefaultTheme } from '../../../src/vault/obsidian-defaults.ts';
import { cascadeThemeVariables } from '../../../src/vault/theme-css.ts';
import { isSafeCssValue } from '../../../src/webview/css-values.ts';

const FIXTURE = new URL('../../fixtures/obsidian-theme/.obsidian/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, FIXTURE), 'utf8');

test('every board token is either mapped or explicitly left unmapped', () => {
  const mapped = new Set([...Object.keys(OBSIDIAN_TOKEN_SOURCES), '--nw-font']);
  for (const token of KANBAN_STYLE_TOKENS) {
    assert.ok(mapped.has(token) !== UNMAPPED_TOKENS.includes(token), token);
  }
});

test('default theme fills every mapped token in both schemes', () => {
  const vars = cascadeThemeVariables([], obsidianDefaultTheme());
  for (const scheme of [vars.dark, vars.light]) {
    const tokens = obsidianStyleTokens(scheme);
    // Fonts are not part of the built-in defaults: the board keeps the VS Code fonts.
    for (const token of Object.keys(OBSIDIAN_TOKEN_SOURCES)) {
      if (token !== '--nw-font-mono') assert.ok(token in tokens, token);
    }
    for (const value of Object.values(tokens)) assert.ok(isSafeCssValue(value!), value);
    assert.equal('--nw-shadow' in tokens, false);
    assert.equal('--nw-font' in tokens, false);
    assert.equal('--nw-font-mono' in tokens, false);
  }
  const dark = obsidianStyleTokens(vars.dark);
  assert.equal(dark['--nw-board-bg'], '#1c1c1c');
  assert.equal(dark['--nw-card-bg'], '#232323');
  assert.equal(dark['--nw-link'], 'hsl(258, 88%, 66%)');
  assert.equal(dark['--nw-done'], '#44cf6e');
});

test('fallbacks: card from primary, link from interactive accent, input from primary', () => {
  const tokens = obsidianStyleTokens(new Map([['--background-primary', '#101010'], ['--interactive-accent', '#ff00ff']]));
  assert.equal(tokens['--nw-card-bg'], '#101010');
  assert.equal(tokens['--nw-input-bg'], '#101010');
  assert.equal(tokens['--nw-link'], '#ff00ff');
  assert.equal(tokens['--nw-tag-bg'], undefined);
});

test('font: theme --font-text, then the text font setting, then --font-text-theme', () => {
  assert.equal(obsidianStyleTokens(new Map([['--font-text', '"A", serif']]), { textFontFamily: '"B"' })['--nw-font'], '"A", serif');
  assert.equal(obsidianStyleTokens(new Map([['--font-text-theme', '"C"']]), { textFontFamily: '"B"' })['--nw-font'], '"B"');
  assert.equal(obsidianStyleTokens(new Map([['--font-text-theme', '"C"']]))['--nw-font'], '"C"');
});

test('unsafe values never become tokens', () => {
  const tokens = obsidianStyleTokens(new Map([['--background-primary', 'url(x)'], ['--text-normal', 'red; x:y']]), { textFontFamily: 'a{b}' });
  assert.deepEqual(tokens, {});
});

test('fixture vault: theme and snippets show through the tokens', () => {
  const { appearance } = parseAppearance(read('appearance.json'));
  const vars = composeThemeVariables(obsidianDefaultTheme(appearance.accentColor), {
    themeCss: read('themes/Sample/theme.css'),
    snippetCss: [read('snippets/soft-cards.css'), read('snippets/hostile.css')],
  });
  const dark = obsidianStyleTokens(vars.dark, appearance);
  assert.equal(dark['--nw-board-bg'], '#1b2430');
  assert.equal(dark['--nw-lane-bg'], '#151c26');
  assert.equal(dark['--nw-card-bg'], '#26303f');
  assert.equal(dark['--nw-radius-card'], '8px');
  assert.equal(dark['--nw-font'], '"Sample Sans", sans-serif');
  assert.equal(dark['--nw-accent'], 'hsl(146.5, 50.3%, 36.3%)');
  const light = obsidianStyleTokens(vars.light, appearance);
  assert.equal(light['--nw-board-bg'], '#fbfaf7');
});

// --- choosing the style (kanban.md 3.1) ---

const base: StyleInputs = { setting: 'vscode', inVault: true, highContrast: false, mode: 'dark', vscodeLight: false };

test('style choice: three settings x dark/light/high contrast x in/out of a vault', () => {
  const rows: [Partial<StyleInputs>, { style: string; scheme: string | null }][] = [
    // vscode: always the VS Code theme.
    [{ setting: 'vscode' }, { style: 'vscode', scheme: null }],
    [{ setting: 'vscode', inVault: false, vscodeLight: true }, { style: 'vscode', scheme: null }],
    // notewell: brightness from VS Code, vault does not matter.
    [{ setting: 'notewell', vscodeLight: false }, { style: 'notewell', scheme: 'dark' }],
    [{ setting: 'notewell', vscodeLight: true, inVault: false }, { style: 'notewell', scheme: 'light' }],
    [{ setting: 'notewell', mode: 'light', vscodeLight: false }, { style: 'notewell', scheme: 'dark' }],
    // obsidian: appearance.json mode; system follows VS Code; outside a vault -> vscode.
    [{ setting: 'obsidian', mode: 'dark', vscodeLight: true }, { style: 'obsidian', scheme: 'dark' }],
    [{ setting: 'obsidian', mode: 'light', vscodeLight: false }, { style: 'obsidian', scheme: 'light' }],
    [{ setting: 'obsidian', mode: 'system', vscodeLight: true }, { style: 'obsidian', scheme: 'light' }],
    [{ setting: 'obsidian', mode: 'system', vscodeLight: false }, { style: 'obsidian', scheme: 'dark' }],
    [{ setting: 'obsidian', inVault: false }, { style: 'vscode', scheme: null }],
    // High contrast: always vscode.
    [{ setting: 'obsidian', highContrast: true }, { style: 'vscode', scheme: null }],
    [{ setting: 'notewell', highContrast: true }, { style: 'vscode', scheme: null }],
    [{ setting: 'notewell', highContrast: true, vscodeLight: true }, { style: 'vscode', scheme: null }],
  ];
  for (const [inputs, expected] of rows) {
    assert.deepEqual(chooseBoardStyle({ ...base, ...inputs }), expected, JSON.stringify(inputs));
  }
});

test('safeTokens keeps only known tokens with safe values', () => {
  assert.deepEqual(safeTokens({ '--nw-fg': '#ffffff', '--nw-bogus': '#000000', '--nw-board-bg': 'url(x)', '--nw-border': undefined }), {
    '--nw-fg': '#ffffff',
  });
});
