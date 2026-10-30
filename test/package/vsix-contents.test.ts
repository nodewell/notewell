// What `npm run package` would put in the .vsix, via vsce's own file listing
// (same .vscodeignore rules, no process spawned).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

interface Vsce {
  listFiles(options: { cwd: string; packageManager: number }): Promise<string[]>;
}
const vsce = createRequire(import.meta.url)('@vscode/vsce') as Vsce;
const PACKAGE_MANAGER_NONE = 2;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const ALLOWED = [
  /^LICENSE$/,
  /^README(\.ko)?\.md$/,
  /^CHANGELOG\.md$/,
  /^package\.json$/,
  /^package\.nls(\.[a-z-]+)?\.json$/,
  /^l10n\/bundle\.l10n\.[a-z-]+\.json$/,
  /^dist\/extension\.cjs$/,
  /^dist\/webview\/[\w-]+\.(js|css)$/,
  /^images\/icon\.png$/,
];

const FORBIDDEN = [
  /^src\//, /^test\//, /^docs\//, /^backlog\//, /^scripts\//, /^node_modules\//,
  /^CLAUDE.*\.md$/i, /\.map$/, /\.ts$/, /^tsconfig.*\.json$/, /^\.vscodeignore$/, /^\.git/, /\.vsix$/,
  // The icon ships as PNG only; the SVG source stays in the repository.
  /\.svg$/, /^images\/(?!icon\.png$)/,
];

const files = await vsce.listFiles({ cwd: ROOT, packageManager: PACKAGE_MANAGER_NONE });

test('vsix contains only runtime files', () => {
  for (const file of files) {
    assert.ok(ALLOWED.some((p) => p.test(file)), `unexpected file in vsix: ${file}`);
    assert.ok(!FORBIDDEN.some((p) => p.test(file)), `forbidden file in vsix: ${file}`);
  }
});

test('vsix contains the manifest, docs and (when built) the bundles', (t) => {
  for (const required of ['package.json', 'package.nls.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'images/icon.png']) {
    assert.ok(files.includes(required), required);
  }
  if (!existsSync(new URL('../../dist/extension.cjs', import.meta.url))) {
    t.skip('dist/ not built');
    return;
  }
  for (const required of ['dist/extension.cjs', 'dist/webview/base.css', 'dist/webview/kanban.js', 'dist/webview/kanban.css', 'dist/webview/backlog.js', 'dist/webview/backlog.css', 'dist/webview/canvas.js', 'dist/webview/canvas.css']) {
    assert.ok(files.includes(required), required);
  }
});
