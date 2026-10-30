import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeThemeVariables, DEFAULT_APPEARANCE, isSafeName, parseAppearance } from '../../src/vault/appearance.ts';
import { hexToHsl, obsidianDefaultTheme } from '../../src/vault/obsidian-defaults.ts';
import { cascadeThemeVariables, isSafeThemeValue } from '../../src/vault/theme-css.ts';

const FIXTURE = new URL('../fixtures/obsidian-theme/.obsidian/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, FIXTURE), 'utf8');

// Obsidian variables the kanban mapping (kanban.md 3.1) reads.
const MAPPED = [
  '--background-primary',
  '--background-primary-alt',
  '--background-secondary',
  '--background-modifier-border',
  '--background-modifier-border-hover',
  '--background-modifier-hover',
  '--background-modifier-form-field',
  '--text-normal',
  '--text-muted',
  '--text-faint',
  '--text-accent',
  '--text-accent-hover',
  '--interactive-accent',
  '--text-on-accent',
  '--text-error',
  '--text-warning',
  '--text-highlight-bg',
  '--tag-background',
  '--tag-color',
  '--code-background',
  '--color-green',
  '--color-blue',
  '--radius-s',
  '--radius-m',
  '--scrollbar-thumb-bg',
  '--scrollbar-active-thumb-bg',
];

// --- appearance.json ---

test('appearance.json: theme mode, names, accent, font, size', () => {
  const { appearance, error } = parseAppearance(read('appearance.json'));
  assert.equal(error, undefined);
  assert.deepEqual(appearance, {
    cssTheme: 'Sample',
    mode: 'dark',
    accentColor: '#2e8b57',
    // Path-escaping and empty names are dropped; a missing file is skipped later.
    enabledCssSnippets: ['soft-cards', 'hostile', 'missing-snippet'],
    textFontFamily: '"Sample Sans", sans-serif',
    baseFontSize: 15,
  });
  assert.equal(parseAppearance('{"theme":"moonstone"}').appearance.mode, 'light');
  assert.equal(parseAppearance('{"theme":"system"}').appearance.mode, 'system');
  assert.equal(parseAppearance('{}').appearance.mode, 'system');
});

test('appearance.json: missing, broken and hostile values', () => {
  assert.deepEqual(parseAppearance(undefined), { appearance: DEFAULT_APPEARANCE });
  assert.ok(parseAppearance('{ broken').error);
  assert.ok(parseAppearance('[1]').error);
  const hostile = parseAppearance(
    JSON.stringify({ cssTheme: '../../etc', accentColor: 'url(x)', textFontFamily: 'a; b{}', baseFontSize: 999, enabledCssSnippets: 'x' }),
  ).appearance;
  assert.deepEqual(hostile, { cssTheme: '', mode: 'system', enabledCssSnippets: [] });
});

test('safe names are single path segments', () => {
  for (const name of ['Minimal', 'AnuPpuccin', 'my snippet', '한글 테마']) assert.equal(isSafeName(name), true, name);
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'c:', 'x\u0000', 3, null]) assert.equal(isSafeName(name), false, String(name));
});

// --- built-in default theme ---

test('default theme resolves every mapped variable in both schemes', () => {
  const { dark, light } = cascadeThemeVariables([], obsidianDefaultTheme());
  for (const name of MAPPED) {
    assert.ok(dark.has(name), `dark ${name}`);
    assert.ok(light.has(name), `light ${name}`);
    assert.ok(isSafeThemeValue(dark.get(name)!), `${name}: ${dark.get(name)}`);
    assert.doesNotMatch(dark.get(name)!, /var\(/, name);
  }
  assert.equal(dark.get('--background-primary'), '#1c1c1c');
  assert.equal(light.get('--background-primary'), '#ffffff');
  assert.equal(dark.get('--text-normal'), '#dadada');
  assert.equal(light.get('--text-normal'), '#222222');
  assert.equal(dark.get('--interactive-accent'), 'hsl(258, 88%, 66%)');
  assert.equal(dark.get('--radius-m'), '8px');
});

test('accentColor replaces the accent everywhere it is derived', () => {
  assert.deepEqual(hexToHsl('#2e8b57'), { h: 146.5, s: 50.3, l: 36.3 });
  assert.deepEqual(hexToHsl('#fff'), { h: 0, s: 0, l: 100 });
  assert.equal(hexToHsl('red'), undefined);
  const { dark } = cascadeThemeVariables([], obsidianDefaultTheme('#2e8b57'));
  assert.equal(dark.get('--interactive-accent'), 'hsl(146.5, 50.3%, 36.3%)');
  assert.equal(dark.get('--text-accent'), 'hsl(146.5, 50.3%, 36.3%)');
  assert.match(dark.get('--tag-background')!, /^color-mix\(in srgb, hsl\(146\.5, 50\.3%, 36\.3%\) 10%, transparent\)$/);
  const named = cascadeThemeVariables([], obsidianDefaultTheme('teal')).light;
  assert.equal(named.get('--interactive-accent'), 'teal');
});

test('composition: defaults < theme < snippets, for the fixture vault', () => {
  const { appearance } = parseAppearance(read('appearance.json'));
  const snippetCss = appearance.enabledCssSnippets.flatMap((name) => {
    try {
      return [read(`snippets/${name}.css`)];
    } catch {
      return [];
    }
  });
  const vars = composeThemeVariables(obsidianDefaultTheme(appearance.accentColor), {
    themeCss: read('themes/Sample/theme.css'),
    snippetCss,
  });
  // Theme values over defaults.
  assert.equal(vars.dark.get('--background-primary'), '#1b2430');
  // Snippet over theme.
  assert.equal(vars.dark.get('--background-primary-alt'), '#26303f');
  // Hostile snippet values rejected, so defaults stay.
  assert.equal(vars.dark.get('--text-error'), '#fb464c');
  assert.equal(vars.dark.get('--interactive-accent'), 'hsl(146.5, 50.3%, 36.3%)');
  // The hostile cycle on --background-modifier-hover is dropped: the default value remains.
  assert.equal(vars.dark.get('--background-modifier-hover'), 'color-mix(in srgb, white 7.5%, transparent)');
  // Theme tag background now resolves, because the accent comes from the defaults.
  assert.equal(vars.dark.get('--tag-background'), 'color-mix(in srgb, hsl(146.5, 50.3%, 36.3%) 15%, transparent)');
  for (const scheme of [vars.dark, vars.light]) for (const value of scheme.values()) assert.ok(isSafeThemeValue(value), value);
});
