// Task index: lookups, relations, duplicates, unreadable files, ID order, speed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, parseConfig } from '../../../src/features/backlog/config.ts';
import { buildIndex, compareTaskIds, idKey, indexTasks, milestoneTitle, readTask, tasksWithId, type SourceFile } from '../../../src/features/backlog/task-index.ts';

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const VARIANTS = new URL('../../fixtures/backlog/variants/', import.meta.url);
const CONFIG = parseConfig(readFileSync(new URL('config.yml', PROJECT), 'utf8')).config;

function folder(dir: URL, prefix: string): SourceFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => ({ path: `${prefix}/${n}`, text: readFileSync(new URL(n, dir), 'utf8') }));
}

const tasks = () => folder(new URL('tasks/', PROJECT), 'backlog/tasks');
const milestones = () => folder(new URL('milestones/', PROJECT), 'backlog/milestones');

test('fixture project: IDs, subtasks, Blocks and milestone titles', () => {
  const index = buildIndex(tasks(), milestones(), CONFIG);
  assert.deepEqual(index.tasks.map((t) => t.id), ['TASK-1', 'TASK-1.1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5', 'TASK-6']);
  assert.equal(tasksWithId(index, 'task-2')[0]?.path, 'backlog/tasks/task-2 - Render-the-board.md');
  assert.equal(tasksWithId(index, '2')[0]?.id, 'TASK-2', 'a bare number gets the prefix');
  assert.equal(index.byPath.get('backlog/tasks/task-6 - Minimal.md')?.data.title, 'Minimal');
  assert.deepEqual(index.children.get('TASK-1')?.map((t) => t.id), ['TASK-1.1']);
  assert.deepEqual(index.blocks.get('TASK-1')?.map((t) => t.id), ['TASK-2']);
  assert.deepEqual(index.milestones.map((m) => [m.id, m.title]), [['m-0', 'v1 Launch']]);
  assert.equal(milestoneTitle(index, 'm-0'), 'v1 Launch');
  assert.equal(milestoneTitle(index, 'M-0'), 'v1 Launch');
  assert.equal(milestoneTitle(index, 'v1 launch'), 'v1 Launch', 'a milestone written by title');
  assert.equal(milestoneTitle(index, 'm-9'), null);
  assert.deepEqual(index.unreadable, []);
});

test('variants: duplicate IDs and unreadable files are marked', () => {
  const index = buildIndex([...tasks(), ...folder(VARIANTS, 'backlog/tasks')], [], CONFIG);
  assert.deepEqual(index.unreadable, [{ path: 'backlog/tasks/no-frontmatter.md', reason: 'noFrontmatter' }]);
  const dupes = [...index.byId].filter(([, list]) => list.length > 1).map(([id, list]) => [id, list.length]).sort();
  assert.deepEqual(dupes, [['TASK-1', 2], ['TASK-5', 3]]);
  assert.equal(readTask('x.md', '---\ntitle: no id\n---\n').kind, 'unreadable');
  assert.deepEqual(readTask('x.md', '---\ntitle: no id\n---\n'), { kind: 'unreadable', path: 'x.md', reason: 'noId' });
});

test('ID order: prefix, then numbers part by part', () => {
  const ids = ['TASK-10', 'task-2', 'TASK-1.10', 'TASK-1.2', 'TASK-1', 'DOC-3', 'odd', 'TASK-1.2.1'];
  assert.deepEqual([...ids].sort(compareTaskIds), ['DOC-3', 'TASK-1', 'TASK-1.2', 'TASK-1.2.1', 'TASK-1.10', 'task-2', 'TASK-10', 'odd']);
  assert.equal(compareTaskIds('task-7', 'TASK-7'), 0);
  assert.equal(idKey(' 7 ', 'proj'), 'PROJ-7');
  assert.equal(idKey('task-1.1', 'task'), 'TASK-1.1');
});

test('500 tasks index in well under a second; one changed file relinks fast', () => {
  const files: SourceFile[] = [];
  for (let n = 1; n <= 500; n++) {
    const deps = n > 1 ? `dependencies:\n  - TASK-${n - 1}\n` : 'dependencies: []\n';
    const parent = n % 10 === 0 ? `parent_task_id: TASK-${n - 1}\n` : '';
    files.push({
      path: `backlog/tasks/task-${n} - Task-${n}.md`,
      text: `---\nid: TASK-${n}\ntitle: Task ${n}\nstatus: To Do\nassignee: []\ncreated_date: '2026-10-14 09:49'\nlabels:\n  - l${n % 7}\n${deps}${parent}ordinal: ${n * 1000}\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n${'Some text with **bold** and `code`. '.repeat(20)}\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 One\n- [x] #2 Two\n<!-- AC:END -->\n`,
    });
  }
  const start = performance.now();
  const index = buildIndex(files, [], DEFAULT_CONFIG);
  const first = performance.now() - start;
  assert.equal(index.tasks.length, 500);
  assert.ok(first < 1000, `first index took ${first.toFixed(0)} ms`);

  const entries = new Map(index.tasks.map((t) => [t.path, { kind: 'task' as const, ...t }]));
  const changeStart = performance.now();
  const changed = files[250];
  entries.set(changed.path, readTask(changed.path, changed.text.replace('Task 251', 'Renamed')) as never);
  const relinked = indexTasks(entries.values(), [], DEFAULT_CONFIG);
  const change = performance.now() - changeStart;
  assert.equal(tasksWithId(relinked, 'TASK-251')[0]?.data.title, 'Renamed');
  assert.ok(change < 100, `change took ${change.toFixed(0)} ms`);
});
