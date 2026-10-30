// Backlog UI strings: viewStrings() localizes exactly DEFAULT_STRINGS (core.md 5). The Korean
// bundle check in the kanban l10n test covers every l10n.t literal in src.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_STRINGS } from '../../../src/features/backlog/view.ts';

const source = readFileSync(new URL('../../../src/features/backlog/strings.ts', import.meta.url), 'utf8');

test('viewStrings() covers DEFAULT_STRINGS with the same English text', () => {
  const body = source.slice(source.indexOf('export function viewStrings'), source.indexOf('export function errorStrings'));
  const entries = [...body.matchAll(/(\w+): vscode\.l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2].replace(/\\'/g, "'")]);
  assert.deepEqual(Object.fromEntries(entries), { ...DEFAULT_STRINGS });
});

test('errorStrings() has one message per ErrorReason', () => {
  const body = source.slice(source.indexOf('export function errorStrings'), source.indexOf('export const messages'));
  const names = [...body.matchAll(/(\w+): vscode\.l10n\.t\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['encoding', 'failed', 'invalid', 'nothingToUndo', 'readOnly', 'stale', 'unsafe']);
});
