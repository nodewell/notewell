// Pins core.md 2.4: `.obsidian/` (and the vault in general) is read-only for src/vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const VAULT = new URL('../../src/vault/', import.meta.url);

test('src/vault uses no write, delete or rename APIs', () => {
  const files = readdirSync(VAULT, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.ts'));
  assert.ok(files.length > 0);
  const forbidden = [
    // workspace.fs: only read-only members are allowed.
    /\.fs\.(?!readFile\b|stat\b|readDirectory\b)\w+/,
    // Node file system and process APIs (writes go through nothing here).
    /from\s+['"](node:)?fs(\/promises)?['"]/,
    /from\s+['"](node:)?child_process['"]/,
    /\bWorkspaceEdit\b/,
    /\bapplyEdit\b/,
    /\b(writeFile|appendFile|createWriteStream|unlink|rmdir|mkdir|createDirectory)\b/,
  ];
  for (const path of files) {
    const text = readFileSync(new URL(path.replaceAll('\\', '/'), VAULT), 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${path} matches ${pattern}`);
    }
  }
});
