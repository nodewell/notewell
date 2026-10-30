// Project-relative path resolution (backlog.md 4.4): nothing outside the project root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectPath } from '../../../src/features/backlog/paths.ts';

test('relative paths inside the root are normalized', () => {
  const cases: Record<string, string> = {
    'docs/build.md': 'docs/build.md',
    './docs/build.md': 'docs/build.md',
    'docs//build.md': 'docs/build.md',
    'docs/../README.md': 'README.md',
    'a/b/../../c': 'c',
    'docs\\build.md': 'docs/build.md',
    'scripts/build.mjs': 'scripts/build.mjs',
    '한국어/문서.md': '한국어/문서.md',
    'name with spaces.md': 'name with spaces.md',
    'docs/': 'docs',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(resolveProjectPath(input), expected, input);
});

test('absolute, drive, scheme and escaping paths are refused', () => {
  for (const input of [
    '',
    '.',
    './',
    '..',
    '../secret',
    'docs/../../secret',
    'a/../..',
    '..\\secret',
    '/etc/passwd',
    '\\\\server\\share',
    '//server/share',
    'C:\\Windows\\win.ini',
    'c:/x',
    'file:///etc/passwd',
    'vscode:extension/x',
    'command:workbench.action.quit',
    'https://example.com',
    'a\0b',
    // Windows reads these segments as `..` or `.` (trailing dots and spaces are dropped).
    '.. /secret',
    '... /secret',
    'docs/.. /../secret',
    '../ /secret',
    'a/ . /b',
    // NTFS alternate data streams.
    'docs/build.md:hidden',
    'docs/build.md::$DATA',
  ]) {
    assert.equal(resolveProjectPath(input), undefined, JSON.stringify(input));
  }
  assert.equal(resolveProjectPath('docs/v1.2/notes.md'), 'docs/v1.2/notes.md', 'dots inside a name are fine');
  assert.equal(resolveProjectPath('.github/workflows/ci.yml'), '.github/workflows/ci.yml', 'a leading dot is fine');
});
