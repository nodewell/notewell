// Pins the project rules and backlog.md 5.1, 7 for src/features/backlog: reading modules never write,
// features stay apart, nothing talks to the network or runs processes, and panel writes go
// through WorkspaceEdit and document.save only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const SRC = new URL('../../../src/', import.meta.url);

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(new URL(dir, SRC), { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts'))
    .map((p) => {
      const path = `${dir}${p.replaceAll('\\', '/')}`;
      return { path, text: readFileSync(new URL(path, SRC), 'utf8') };
    });
}

const backlog = sources('features/backlog/');
const textOf = (name: string): string => {
  const file = backlog.find((f) => f.path === `features/backlog/${name}`);
  assert.ok(file, name);
  return file.text;
};

const WRITE_APIS = [
  /\.fs\.(?!readFile\b|stat\b|readDirectory\b)\w+/,
  /from\s+['"](node:)?fs(\/promises)?['"]/,
  /\bWorkspaceEdit\b/,
  /\bapplyEdit\b/,
  /\.save\(/,
  // Node-style names; workspace.fs writes (delete, rename, ...) are caught by the first pattern.
  /\b(writeFile|appendFile|createWriteStream|unlink|rmdir|mkdir|createDirectory)\s*\(/,
];

test('project detection, config, index and view building use no write APIs', () => {
  for (const name of ['project.ts', 'config.ts', 'task-index.ts', 'view-build.ts']) {
    const text = textOf(name);
    for (const pattern of WRITE_APIS) assert.doesNotMatch(text, pattern, `${name} matches ${pattern}`);
  }
});

test('panel writes only through applyEdit or workspace.fs.writeFile, to an indexed task file', () => {
  const panel = textOf('panel.ts');
  // backlog.md 5.1: a WorkspaceEdit (unsaved editor or saveOnEdit off), or the exact bytes written
  // directly. Never document.save: save participants (formatters, whitespace trimming) must not run.
  assert.deepEqual([...panel.matchAll(/vscode\.workspace\.applyEdit\(/g)].length, 1);
  assert.match(panel, /vscode\.workspace\.applyEdit\(toWorkspaceEdit\(uri, edits\)\)/);
  assert.deepEqual([...panel.matchAll(/\.writeFile\(/g)].length, 1, 'one direct write');
  assert.match(panel, /vscode\.workspace\.fs\.writeFile\(uri, new TextEncoder\(\)\.encode\(text\)\)/);
  assert.doesNotMatch(panel, /\.save\(/, 'no document.save');
  assert.doesNotMatch(panel, /\.fs\.(?!stat\b|readFile\b|writeFile\b|isWritableFileSystem\b)\w+/, 'workspace.fs: stat, readFile, writeFile and isWritableFileSystem only');
  assert.doesNotMatch(panel, /\b(appendFile|createWriteStream|unlink|rmdir|mkdir|createDirectory|rename)\s*\(/);
  for (const { path, text } of backlog) assert.doesNotMatch(text, /from\s+['"](node:)?fs(\/promises)?['"]/, path);
  // Both writes take `uri` from taskUri(path), which only resolves readable task files of the index.
  const write = panel.slice(panel.indexOf('write: async (path'), panel.indexOf('statuses: () =>'));
  assert.match(write, /const uri = taskUri\(path\);\s*if \(uri === undefined\) return 'stale';/);
  for (const name of ['index.ts']) {
    for (const pattern of WRITE_APIS) assert.doesNotMatch(textOf(name), pattern, `${name} matches ${pattern}`);
  }
});

test('backlog and kanban never import each other', () => {
  for (const { path, text } of backlog) assert.doesNotMatch(text, /from\s+['"][^'"]*features\/kanban\//, path);
  for (const { path, text } of sources('features/kanban/')) assert.doesNotMatch(text, /from\s+['"][^'"]*features\/backlog\//, path);
});

test('no network, process or dynamic code APIs', () => {
  const forbidden = [
    /from\s+['"](node:)?(child_process|net|http|https|http2|dgram|tls|dns|worker_threads|vm)['"]/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/,
  ];
  for (const { path, text } of backlog) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${path} matches ${pattern}`);
  }
});

test('pure modules do not import vscode', () => {
  const adapters = new Set(['project.ts', 'panel.ts', 'index.ts', 'strings.ts'].map((n) => `features/backlog/${n}`));
  for (const { path, text } of backlog) {
    if (adapters.has(path)) continue;
    assert.doesNotMatch(text, /from\s+['"]vscode['"]/, path);
  }
});
