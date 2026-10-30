// Daily notes and templates strings and manifest (daily-notes.md 7, core.md 5): every UI string
// in English and Korean, the commands and settings the spec lists, shown only when detected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const json = <T = Record<string, string>>(path: string): T => JSON.parse(read(path)) as T;

function literals(source: string): string[] {
  return [...source.matchAll(/l10n\.t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => (m[1] ?? m[2]!).replace(/\\(['"\\])/g, '$1'));
}

test('every daily notes string has a Korean translation', () => {
  const ko = json('l10n/bundle.l10n.ko.json');
  const strings = literals(read('src/features/daily-notes/index.ts'));
  assert.ok(strings.length >= 20, String(strings.length));
  for (const text of strings) assert.ok(typeof ko[text] === 'string' && ko[text] !== '', `missing ko: ${text}`);
});

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: { commandPalette: { command: string; when?: string }[] };
    configuration: { properties: Record<string, { type: string; default: unknown; enum?: string[] }> };
  };
}

test('package.json: commands shown only when detected, settings of daily-notes.md 7, localized', () => {
  const { contributes } = json<Manifest>('package.json');
  const when = (id: string) => contributes.menus.commandPalette.find((m) => m.command === id)?.when;
  assert.equal(when('notewell.dailyNotes.openToday'), 'notewell.dailyNotes.available');
  assert.equal(when('notewell.dailyNotes.openForDate'), 'notewell.dailyNotes.available');
  for (const id of ['notewell.templates.insert', 'notewell.templates.insertDate', 'notewell.templates.insertTime']) {
    assert.equal(when(id), 'notewell.templates.available && editorLangId == markdown', id);
  }
  assert.equal(when('notewell.notes.createFromLink'), 'false');
  const props = contributes.configuration.properties;
  assert.deepEqual([props['notewell.dailyNotes.enabled']?.default, props['notewell.templates.enabled']?.default], [true, true]);
  assert.deepEqual([props['notewell.links.createMissingNotes']?.enum, props['notewell.links.createMissingNotes']?.default], [['ask', 'never'], 'ask']);
  for (const file of ['package.nls.json', 'package.nls.ko.json']) {
    const nls = json(file);
    for (const c of contributes.commands.filter((c) => /dailyNotes|templates|notes\./.test(c.command))) {
      const name = c.title.slice(1, -1);
      assert.ok(typeof nls[name] === 'string' && nls[name] !== '', `${file}: ${name}`);
    }
  }
});
