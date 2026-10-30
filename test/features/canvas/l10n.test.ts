// Canvas strings and manifest (canvas.md 6, core.md 5): every UI string in English and Korean,
// no obsolete translations, and the settings and editor the spec lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const json = <T = Record<string, string>>(path: string): T => JSON.parse(read(path)) as T;

/** Extension-host sources under `dir` (browser code gets its strings from the extension). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(new URL(dir, root))) {
    const path = `${dir}/${name}`;
    if (statSync(new URL(path, root)).isDirectory()) {
      if (name !== 'browser') out.push(...sources(path));
    } else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** First arguments of `l10n.t(...)` written as single- or double-quoted literals. */
function literals(source: string): string[] {
  return [...source.matchAll(/l10n\.t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) =>
    (m[1] ?? m[2]!).replace(/\\(['"\\])/g, '$1'),
  );
}

test('every canvas string has a Korean translation', () => {
  const ko = json('l10n/bundle.l10n.ko.json');
  const canvas = sources('src/features/canvas').flatMap((path) => literals(read(path)));
  assert.ok(canvas.length >= 60, String(canvas.length));
  for (const text of canvas) assert.ok(typeof ko[text] === 'string' && ko[text] !== '', `missing ko: ${text}`);
});

test('the Korean bundle has no entries that no code uses any more', () => {
  const used = new Set(sources('src').flatMap((path) => literals(read(path))));
  const unused = Object.keys(json('l10n/bundle.l10n.ko.json')).filter((text) => !used.has(text));
  assert.deepEqual(unused, []);
});

test('package.nls has no unused keys; canvas manifest entries are localized', () => {
  const manifest = read('package.json');
  for (const file of ['package.nls.json', 'package.nls.ko.json']) {
    const nls = json(file);
    assert.deepEqual(Object.keys(nls).filter((name) => !manifest.includes(`%${name}%`)), [], file);
    for (const name of ['customEditor.canvas.displayName', 'config.canvas.enabled', 'config.canvas.editable', 'config.canvas.snapToGrid']) {
      assert.ok(typeof nls[name] === 'string' && nls[name] !== '', `${file}: ${name}`);
    }
  }
});

interface Manifest {
  contributes: {
    customEditors: { viewType: string; selector: { filenamePattern: string }[]; priority: string }[];
    configuration: { properties: Record<string, { type: string; default: unknown; scope?: string }> };
  };
}

test('package.json registers the canvas editor and the settings of canvas.md 6', () => {
  const { contributes } = json<Manifest>('package.json');
  const editor = contributes.customEditors.find((e) => e.viewType === 'notewell.canvas');
  assert.deepEqual([editor?.selector, editor?.priority], [[{ filenamePattern: '*.canvas' }], 'default']);
  const settings = Object.entries(contributes.configuration.properties).filter(([name]) => name.startsWith('notewell.canvas.'));
  assert.deepEqual(
    settings.map(([name, s]) => [name, s.type, s.default]),
    [
      ['notewell.canvas.enabled', 'boolean', true],
      ['notewell.canvas.editable', 'boolean', true],
      ['notewell.canvas.snapToGrid', 'boolean', false],
    ],
  );
});
