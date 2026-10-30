import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cascadeThemeVariables, extractDeclarations, isSafeThemeValue, resolveVariables } from '../../src/vault/theme-css.ts';

const FIXTURE = new URL('../fixtures/obsidian-theme/.obsidian/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, FIXTURE), 'utf8');

const dark = (css: string | string[]) => cascadeThemeVariables(Array.isArray(css) ? css : [css]).dark;
const light = (css: string | string[]) => cascadeThemeVariables(Array.isArray(css) ? css : [css]).light;

test('reads custom properties from body, :root, .theme-dark and .theme-light only', () => {
  const css = `
    body { --a: #111111; color: red; }
    :root { --b: 4px; }
    .theme-dark { --c: #222222; }
    .theme-light { --c: #eeeeee; }
    .workspace { --d: #333333; }
    body .markdown { --e: #444444; }
    html body.theme-dark { --f: 1px; }
  `;
  assert.deepEqual([...dark(css)].sort(), [['--a', '#111111'], ['--b', '4px'], ['--c', '#222222'], ['--f', '1px']]);
  assert.deepEqual([...light(css)].sort(), [['--a', '#111111'], ['--b', '4px'], ['--c', '#eeeeee']]);
});

test('selector lists are judged per selector; .theme-darker is not .theme-dark', () => {
  const css = '.theme-dark, .workspace { --a: 1px; } .theme-darker { --b: 2px; } .theme-dark.theme-light { --c: 3px; }';
  assert.deepEqual([...dark(css)], [['--a', '1px']]);
});

test('cascade: !important, then specificity, then later source wins', () => {
  assert.equal(dark('.theme-dark { --x: 1px; } body { --x: 2px; }').get('--x'), '1px');
  assert.equal(dark('body { --x: 1px; } body { --x: 2px; }').get('--x'), '2px');
  assert.equal(dark(['body { --x: 1px; }', 'body { --x: 2px; }']).get('--x'), '2px');
  assert.equal(dark(['body { --x: 1px !important; }', '.theme-dark { --x: 2px; }']).get('--x'), '1px');
  assert.equal(dark(':root { --x: 1px; } body { --x: 2px; }').get('--x'), '1px');
});

test('base values are the lowest layer', () => {
  const base = { dark: new Map([['--x', '#000000'], ['--y', '#111111']]), light: new Map() };
  const result = cascadeThemeVariables(['body { --x: #ffffff; }'], base);
  assert.equal(result.dark.get('--x'), '#ffffff');
  assert.equal(result.dark.get('--y'), '#111111');
});

test('comments, strings and nested blocks do not confuse the reader', () => {
  const css = `
    /* .theme-dark { --hidden: 1px; } */
    .theme-dark {
      --font: "A; B { }", sans-serif;
      /* --commented: 2px; */
      .nested { --inner: 3px; }
      --after: 4px;
    }
  `;
  const vars = dark(css);
  assert.equal(vars.get('--hidden'), undefined);
  assert.equal(vars.get('--commented'), undefined);
  assert.equal(vars.get('--inner'), undefined);
  assert.equal(vars.get('--after'), '4px');
  // The quoted name contains ; and braces, so the shared value check rejects it.
  assert.equal(vars.get('--font'), undefined);
});

test('@media prefers-color-scheme counts for that scheme; other at-rules are skipped', () => {
  const css = `
    @import url("x.css");
    @font-face { font-family: X; src: url(x.woff); }
    @media (prefers-color-scheme: dark) { body { --m: 1px; } }
    @media (prefers-color-scheme: light) { body { --m: 2px; } }
    @media (max-width: 600px) { body { --n: 3px; } }
    @supports (display: grid) { body { --o: 4px; } }
    body { --p: 5px; }
  `;
  assert.equal(dark(css).get('--m'), '1px');
  assert.equal(light(css).get('--m'), '2px');
  assert.equal(dark(css).get('--n'), undefined);
  assert.equal(dark(css).get('--o'), undefined);
  assert.equal(dark(css).get('--p'), '5px');
});

test('values outside the allowlist are dropped', () => {
  for (const value of [
    'url(x.png)',
    'expression(alert(1))',
    '#fff\\3b',
    '"</style>"',
    'image(#000)',
    'a'.repeat(501),
    'attr(data-x)',
    'red; color: blue',
  ]) {
    assert.equal(isSafeThemeValue(value), false, value);
  }
  for (const value of ['#1a2b3c', 'rgba(255, 0, 0, 0.5)', 'hsl(258, 88%, 66%)', '4px', '1.5em', '"Inter", sans-serif', 'calc(var(--a) * 2)', 'color-mix(in srgb, var(--a) 10%, transparent)']) {
    assert.equal(isSafeThemeValue(value), true, value);
  }
});

test('var() resolves within the set; cycles and unknown references are dropped, fallbacks used', () => {
  const vars = resolveVariables(
    new Map([
      ['--a', '#101010'],
      ['--b', 'var(--a)'],
      ['--c', 'color-mix(in srgb, var(--b) 50%, transparent)'],
      ['--x', 'var(--y)'],
      ['--y', 'var(--x)'],
      ['--z', 'var(--missing)'],
      ['--f', 'var(--missing, #222222)'],
      ['--g', 'var(--missing, var(--a))'],
    ]),
  );
  assert.equal(vars.get('--b'), '#101010');
  assert.equal(vars.get('--c'), 'color-mix(in srgb, #101010 50%, transparent)');
  assert.equal(vars.has('--x'), false);
  assert.equal(vars.has('--y'), false);
  assert.equal(vars.has('--z'), false);
  assert.equal(vars.get('--f'), '#222222');
  assert.equal(vars.get('--g'), '#101010');
});

test('fixture: Sample theme + snippets', () => {
  const theme = read('themes/Sample/theme.css');
  const snippets = [read('snippets/soft-cards.css'), read('snippets/hostile.css')];
  const { dark: d, light: l } = cascadeThemeVariables([theme, ...snippets]);
  // .theme-dark beats body, var() resolved.
  assert.equal(d.get('--background-primary'), '#1b2430');
  assert.equal(l.get('--background-primary'), '#fbfaf7');
  // Snippet wins at equal weight; !important wins over the theme.
  assert.equal(d.get('--background-primary-alt'), '#26303f');
  assert.equal(d.get('--radius-s'), '8px');
  // prefers-color-scheme: dark only for dark.
  assert.equal(d.get('--text-highlight-bg'), 'rgba(255, 200, 0, 0.35)');
  assert.equal(l.has('--text-highlight-bg'), false);
  // Other selectors and @media (max-width) ignored.
  assert.equal(d.get('--text-normal'), '#e6edf3');
  // 1) No dangerous value survives anywhere: no url/expression/script/image(), no backslash,
  //    no markup or declaration-breaking characters.
  for (const vars of [d, l]) {
    for (const [name, value] of vars) {
      assert.ok(isSafeThemeValue(value), `${name}: ${value}`);
      assert.doesNotMatch(value, /url|expression|script|\\|image\(|[<>;{}]/i, name);
    }
    for (const name of ['--text-error', '--text-warning', '--interactive-accent', '--code-background', '--cycle-a', '--cycle-b', '--background-modifier-hover', '--unknown-ref', '--scrollbar-thumb-bg', '--long']) {
      assert.equal(vars.has(name), false, name);
    }
  }
  // 2) Safe declarations the attack leaves behind may apply by normal CSS rules: the early "}"
  //    only closed the block, so "--text-accent: red" before it is a valid dark declaration,
  //    and what follows is read as a body rule (still validated).
  assert.equal(d.get('--text-accent'), 'red');
  assert.equal(d.get('--with-fallback'), '#123456');
  assert.equal(l.get('--with-fallback'), '#123456');
  // The tag background refers to a variable this set does not define (--interactive-accent was rejected).
  assert.equal(d.has('--tag-background'), false);
});

test('extractDeclarations reports weight and schemes', () => {
  assert.deepEqual(extractDeclarations('body.theme-dark { --a: 1px !important; }'), [
    { name: '--a', value: '1px', important: true, specificity: 101, schemes: ['dark'] },
  ]);
});

test('fuzz: random theme and snippet CSS never throws, stays fast and yields only safe values', async () => {
  const { isSafeCssValue } = await import('../../src/webview/css-values.ts');
  const { obsidianStyleTokens, safeTokens } = await import('../../src/features/kanban/style-map.ts');
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const PIECES = ['body', 'html', ':root', '.theme-dark', '.theme-light', '.x', '{', '}', ';', ':', ',', ' ', '\n', '--background-primary', '--text-normal', '--interactive-accent', '--font-text', '--a', '--b', 'var(--a)', 'var(--b, red)', 'var(', ')', '(', 'red', '#123456', 'rgb(1,2,3)', 'calc(1px + 2px)', 'url(x)', 'expression(', '@media (prefers-color-scheme: dark)', '@import "x";', '@font-face', '/*', '*/', '"', "'", '\\', '!important', '<', '>', '</style>', 'é', '😀', '0', 'px', '%', '*', '&', '@'];
  const started = performance.now();
  let found = 0;
  for (let n = 0; n < 2000; n++) {
    let css = n % 2 === 0 ? 'body { --a: red; --b: var(--a); ' : '';
    for (let i = 0, len = 1 + Math.floor(rand() * 80); i < len; i++) css += PIECES[Math.floor(rand() * PIECES.length)];
    const vars = cascadeThemeVariables([css, css.split('').reverse().join('')]);
    for (const scheme of ['dark', 'light'] as const) {
      found += vars[scheme].size;
      for (const [name, value] of vars[scheme]) assert.ok(/^--[A-Za-z0-9_-]+$/.test(name) && isSafeCssValue(value), `${name}: ${value} from ${JSON.stringify(css)}`);
      const tokens = obsidianStyleTokens(vars[scheme]);
      assert.deepEqual(safeTokens(tokens), tokens, 'every style token is already safe');
    }
  }
  assert.ok(found > 1000, `${found} variables came through: the fuzz reaches the resolver`);
  assert.ok(performance.now() - started < 10_000, `${performance.now() - started} ms`);
});
