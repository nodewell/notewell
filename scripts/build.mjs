// Bundles the extension host code and the webview assets.
//   dist/extension.cjs  extension entry (CommonJS, as VS Code loads it)
//   dist/webview/*      browser bundles and stylesheets loaded by webviews
import { build } from 'esbuild';

const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

// Webview entries ({ in, out } -> dist/webview/<out>.js|.css). Browser code lives under src/**/browser/.
const webviewEntries = [
  { in: 'src/webview/base.css', out: 'base' },
  { in: 'src/features/kanban/browser/main.ts', out: 'kanban' },
  { in: 'src/features/kanban/browser/kanban.css', out: 'kanban' },
  { in: 'src/features/backlog/browser/main.ts', out: 'backlog' },
  { in: 'src/features/backlog/browser/backlog.css', out: 'backlog' },
  { in: 'src/features/canvas/browser/main.ts', out: 'canvas' },
  { in: 'src/features/canvas/browser/canvas.css', out: 'canvas' },
];

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  }),
  build({
    ...common,
    entryPoints: webviewEntries,
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
]);
