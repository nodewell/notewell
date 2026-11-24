// The file name a title change gives a task (backlog.md 5.2), as the Backlog.md CLI 1.57.4 names
// it: every pair below was produced by `backlog task edit <id> -t <title>` (2026-11-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renamedTaskPath, titleForFilename } from '../../../src/features/backlog/task-filename.ts';

const task = (id: string, title: string): string => ['---', `id: ${id}`, `title: ${title}`, 'status: To Do', '---', ''].join('\n');

/** Title -> the title part of the file name the CLI gave it. */
const CLI_NAMES: readonly [string, string][] = [
  ['Renamed title', 'Renamed-title'],
  ['New: title', 'New-title'],
  ['Title: with colon & "quotes"', 'Title-with-colon-quotes'],
  ['한국어 작업 — 두 번째', '한국어-작업-—-두-번째'],
  ['a/b\\c|d?e*f<g>h', 'a-b-c-d-e-f-g-h'],
  ["It's (done), ok!", 'Its-done-ok'],
  ['!!!', 'untitled'],
  ['C++ & C# [draft] {x}; y=z', 'C-C-draft-x-yz'],
  ['emoji 🚀 here', 'emoji-🚀-here'],
  ['trailing dash -', 'trailing-dash'],
  ['v1.2.3 release', 'v1.2.3-release'],
  ['tab\there', 'tab-here'],
];

test('titles become file names exactly as the CLI makes them', () => {
  for (const [title, name] of CLI_NAMES) assert.equal(titleForFilename(title), name, title);
});

test('a title change moves the task to `<id> - <title>.md` in the same folder', () => {
  const path = 'backlog/tasks/task-1 - Set-up-the-build.md';
  assert.equal(renamedTaskPath(path, task('TASK-1', 'Set up the build'), task('TASK-1', "'New: title'"), 'task'), 'backlog/tasks/task-1 - New-title.md');
  // Sub-tasks, other prefixes and an upper-case name part: the ID part is lowercased, as the CLI does.
  assert.equal(renamedTaskPath('tasks/task-1.1 - A.md', task('TASK-1.1', 'A'), task('TASK-1.1', 'B c'), 'task'), 'tasks/task-1.1 - B-c.md');
  assert.equal(renamedTaskPath('JIRA-7 - Old.md', task('JIRA-7', 'Old'), task('JIRA-7', 'New'), 'jira'), 'jira-7 - New.md');
});

test('the name stays: same title, name already right, or a name whose ID part is not the task ID', () => {
  const path = 'backlog/tasks/task-1 - Old.md';
  assert.equal(renamedTaskPath(path, task('TASK-1', 'Old'), task('TASK-1', 'Old'), 'task'), undefined, 'title unchanged');
  assert.equal(renamedTaskPath('backlog/tasks/task-1 - New.md', task('TASK-1', 'Old'), task('TASK-1', 'New'), 'task'), undefined, 'already the name');
  assert.equal(renamedTaskPath('backlog/tasks/task-2 - Old.md', task('TASK-1', 'Old'), task('TASK-1', 'New'), 'task'), undefined, 'another ID in the name');
  assert.equal(renamedTaskPath('backlog/tasks/notes.md', task('TASK-1', 'Old'), task('TASK-1', 'New'), 'task'), undefined, 'no ID part');
  assert.equal(renamedTaskPath('backlog/tasks/task-1.md', task('TASK-1', 'Old'), task('TASK-1', 'New'), 'task'), undefined, 'no " - " after the ID');
  // A bare number ID is the configured prefix's (task-index.ts idKey).
  assert.equal(renamedTaskPath('task-3 - A.md', task('3', 'A'), task('3', 'B'), 'task'), 'task-3 - B.md');
});
