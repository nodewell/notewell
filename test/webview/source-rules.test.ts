// Source checks that pin the webview security rules (core.md 3.5 and 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CANVAS_STYLE_TOKENS } from '../../src/features/canvas/style-tokens.ts';
import { KANBAN_STYLE_TOKENS } from '../../src/features/kanban/style-tokens.ts';

const SRC = new URL('../../src/', import.meta.url);

function sourceFiles(ext: string): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith(ext))
    .map((path) => ({ path, text: readFileSync(new URL(path.replaceAll('\\', '/'), SRC), 'utf8') }));
}

test('no HTML string injection or dynamic code anywhere in src', () => {
  const forbidden = [
    /\.innerHTML\b/,
    /\.outerHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bcreateContextualFragment\b/,
    /\bparseFromString\b/,
    /\bdocument\.write(ln)?\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
  ];
  const files = sourceFiles('.ts');
  assert.ok(files.length > 0);
  for (const { path, text } of files) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${path} uses ${pattern}`);
    }
  }
});

const NAMED_COLORS =
  /:\s*[^;{}]*\b(white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia|pink|brown)\b/i;

/** No literal colors, external resources or color-mix of anything but variables. */
function assertNoLiteralColors(path: string, css: string): void {
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, `${path} has a hex color`);
  assert.doesNotMatch(css, /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i, `${path} has a color function`);
  // Variable names like --vscode-charts-green are not literal colors.
  assert.doesNotMatch(css.replace(/--[\w-]+/g, '--var'), NAMED_COLORS, `${path} has a named color`);
  assert.doesNotMatch(css, /\burl\(|@import\b/i, `${path} loads external resources`);
  for (const [mix] of css.matchAll(/color-mix\([^;]*\)/g)) {
    const args = mix
      .replace(/var\(--(vscode|nw)-[\w-]+(,\s*[^()]*)?\)/g, '')
      .replace(/linear-gradient|color-mix\(|in srgb|transparent|\d+%|[,()\s]/g, '');
    assert.equal(args, '', `${path}: ${mix}`);
  }
}

function stylesheets(): { path: string; css: string }[] {
  return sourceFiles('.css').map(({ path, text }) => ({
    path: path.replaceAll('\\', '/'),
    css: text.replace(/\/\*[\s\S]*?\*\//g, ''),
  }));
}

test('shared webview stylesheets use only --vscode-* variables and no literal colors', () => {
  const sheets = stylesheets().filter((s) => s.path.startsWith('webview/'));
  assert.ok(sheets.some((s) => s.path === 'webview/base.css'));
  for (const { path, css } of sheets) {
    for (const [, name] of css.matchAll(/var\(\s*(--[\w-]+)/g)) assert.match(name!, /^--vscode-/, `${path}: ${name}`);
    assert.doesNotMatch(css, /(^|[;{\s])--[\w-]+\s*:/, `${path} defines a custom property`);
    assertNoLiteralColors(path, css);
  }
});

/** The token list each feature stylesheet defines from; the canvas has its own (canvas.md 4). */
function tokensFor(path: string): readonly string[] {
  return path.startsWith('features/canvas/') ? CANVAS_STYLE_TOKENS : KANBAN_STYLE_TOKENS;
}

test('feature stylesheets draw only through --nw-* tokens whose defaults are --vscode-* (kanban.md 3.1)', () => {
  const sheets = stylesheets().filter((s) => s.path.startsWith('features/'));
  assert.ok(sheets.some((s) => s.path === 'features/kanban/browser/kanban.css'));
  for (const { path, css } of sheets) {
    const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    const rest = css.replace(/:root\s*\{[^}]*\}/g, '');

    // Outside :root: only token references, no definitions.
    for (const [, name] of rest.matchAll(/var\(\s*(--[\w-]+)/g)) assert.match(name!, /^--nw-/, `${path}: ${name}`);
    assert.doesNotMatch(rest, /(^|[;{\s])--[\w-]+\s*:/, `${path} defines a custom property outside :root`);

    // :root: exactly the token list, defaults from VS Code variables (or plain lengths).
    const defined = new Set<string>();
    for (const block of roots) {
      for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        assert.ok(tokensFor(path).includes(name!), `${path}: unknown token ${name}`);
        defined.add(name!);
        for (const [, ref] of value!.matchAll(/var\(\s*(--[\w-]+)/g)) assert.match(ref!, /^--vscode-/, `${path}: ${name} uses ${ref}`);
      }
    }
    if (path === 'features/kanban/browser/kanban.css') {
      assert.deepEqual([...defined].sort(), [...KANBAN_STYLE_TOKENS].sort(), 'every token has a default');
    }
    if (path === 'features/canvas/browser/canvas.css') {
      assert.deepEqual([...defined].sort(), [...CANVAS_STYLE_TOKENS].sort(), 'every canvas token has a default');
    }
    assertNoLiteralColors(path, css);
  }
});
