// UI strings: English source text in code, Korean in l10n/ and package.nls.ko.json (core.md 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { DEFAULT_STRINGS } from '../../../src/features/kanban/view.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const json = (path: string): Record<string, string> => JSON.parse(read(path)) as Record<string, string>;

/** Extension-host sources (browser code gets its strings from the extension). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(new URL(dir, root))) {
    const path = `${dir}/${name}`;
    if (statSync(new URL(path, root)).isDirectory()) {
      if (name !== 'browser') out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Literal first arguments of `l10n.t(...)`, single-quoted, possibly on the next line. */
function l10nLiterals(source: string): string[] {
  return [...source.matchAll(/l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
}

test('every l10n.t string has a Korean translation', () => {
  const ko = json('l10n/bundle.l10n.ko.json');
  const literals = sourceFiles('src').flatMap((path) => l10nLiterals(read(path)));
  assert.ok(literals.length >= 15);
  for (const text of literals) assert.ok(typeof ko[text] === 'string' && ko[text] !== '', `missing ko: ${text}`);
  // Placeholders survive translation.
  for (const [en, translated] of Object.entries(ko)) {
    const holes = (s: string): string[] => (s.match(/\{\d+\}/g) ?? []).sort();
    assert.deepEqual(holes(translated), holes(en), en);
  }
});

test('viewStrings() covers DEFAULT_STRINGS with the same English text', () => {
  const source = read('src/features/kanban/strings.ts');
  const body = source.slice(source.indexOf('export function viewStrings'), source.indexOf('export function errorStrings'));
  const entries = [...body.matchAll(/(\w+): vscode\.l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(Object.fromEntries(entries), { ...DEFAULT_STRINGS });
});

test('package.json %placeholders% exist in both nls files', () => {
  const manifest = read('package.json');
  const names = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
  assert.ok(names.length >= 8);
  const en = json('package.nls.json');
  const ko = json('package.nls.ko.json');
  for (const name of names) {
    assert.ok(typeof en[name] === 'string', `missing en: ${name}`);
    assert.ok(typeof ko[name] === 'string', `missing ko: ${name}`);
  }
  assert.deepEqual(Object.getOwnPropertyNames(ko).sort(), Object.getOwnPropertyNames(en).sort());
});
