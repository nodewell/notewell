// View models from the index (backlog.md 4.2-4.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseConfig } from '../../../src/features/backlog/config.ts';
import { buildIndex, type SourceFile } from '../../../src/features/backlog/task-index.ts';
import { buildBacklogView, buildTaskDetail } from '../../../src/features/backlog/view-build.ts';
import { DEFAULT_STRINGS } from '../../../src/features/backlog/view.ts';
import { frontmatterSane, hasStrayMarker, parseText } from '../../../src/features/backlog/write-guard.ts';

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const VARIANTS = new URL('../../fixtures/backlog/variants/', import.meta.url);
const CONFIG = parseConfig(readFileSync(new URL('config.yml', PROJECT), 'utf8')).config;

function folder(dir: URL, prefix: string, only?: (name: string) => boolean): SourceFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && (only === undefined || only(n)))
    .map((n) => ({ path: `${prefix}/${n}`, text: readFileSync(new URL(n, dir), 'utf8') }));
}

function fixtureIndex(variants: readonly string[] = []) {
  return buildIndex(
    [...folder(new URL('tasks/', PROJECT), 'backlog/tasks'), ...folder(VARIANTS, 'backlog/tasks', (n) => variants.includes(n))],
    folder(new URL('milestones/', PROJECT), 'backlog/milestones'),
    CONFIG,
  );
}

const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';

test('board view: order, statuses, AC progress, subtasks, blocked and search text', () => {
  const index = fixtureIndex(['other-status.md', 'quoted-status.md', 'no-frontmatter.md', 'no-markers.md']);
  const view = buildBacklogView(index, CONFIG, 'demo', DEFAULT_STRINGS);
  assert.equal(view.project, 'demo');
  assert.deepEqual(view.statuses, ['To Do', 'In Progress', 'Done']);
  assert.equal(view.doneStatus, 'Done');
  assert.deepEqual(view.tasks.map((t) => t.id), ['TASK-1', 'TASK-1.1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5', 'TASK-6', 'TASK-21', 'TASK-24', 'TASK-26']);
  const byId = new Map(view.tasks.map((t) => [t.id, t]));
  const t1 = byId.get('TASK-1')!;
  assert.deepEqual([t1.status, t1.statusKnown, t1.ac, t1.subtaskCount, t1.milestoneTitle, t1.blockedBy], ['In Progress', true, { done: 1, total: 2 }, 1, 'v1 Launch', []]);
  assert.deepEqual(byId.get('TASK-2')!.blockedBy, ['TASK-1'], 'TASK-1 is not done');
  assert.deepEqual([byId.get('TASK-24')!.status, byId.get('TASK-24')!.statusKnown], ['Blocked', false]);
  assert.equal(byId.get('TASK-26')!.status, 'To Do');
  assert.equal(byId.get('TASK-6')!.ac, null);
  assert.ok(t1.searchText.startsWith('task-1\nsetupthebuild\ncompilewith**esbuild**andrun`tsc`.'));
  // AC, DoD, plan, notes and comments too; then labels and assignees.
  assert.ok(t1.searchText.includes('\nbuildproducesdist/\ntypecheckpasses\ndocsupdated\n1.addscript2.wireci\nstartedwithesbuild.\n'));
  assert.ok(t1.searchText.includes('\nlooksgoodsofar\n'));
  assert.ok(t1.searchText.endsWith('\nbuild\ninfra\n@alice'));
  assert.ok(byId.get('TASK-3')!.searchText.includes('\nshippedv1.\n'), 'final summary');
  assert.deepEqual(view.unreadable, [{ path: 'backlog/tasks/no-frontmatter.md', reason: 'noFrontmatter' }]);
  assert.deepEqual(view.milestones, [{ id: 'm-0', title: 'v1 Launch' }]);
});

test('status matching is case-insensitive, missing status uses the default, Done unblocks', () => {
  const files: SourceFile[] = [
    { path: 't/a.md', text: '---\nid: TASK-1\nstatus: done\n---\n' },
    { path: 't/b.md', text: '---\nid: TASK-2\ndependencies:\n  - TASK-1\n  - TASK-9\nordinal: 5\n---\n' },
    { path: 't/c.md', text: '---\nid: TASK-10\nstatus: To Do\nordinal: 5\n---\n' },
  ];
  const view = buildBacklogView(buildIndex(files, [], CONFIG), CONFIG, 'p', DEFAULT_STRINGS);
  assert.deepEqual(view.tasks.map((t) => [t.id, t.status, t.statusKnown, t.blockedBy]), [
    ['TASK-2', 'To Do', true, ['TASK-9']],
    ['TASK-10', 'To Do', true, []],
    ['TASK-1', 'Done', true, []],
  ]);
});

test('detail view: fields, refs, checklists with their source lines, status line', () => {
  const index = fixtureIndex();
  const detail = buildTaskDetail(index, TASK1)!;
  assert.equal(detail.statusLine, 'status: In Progress');
  assert.equal(detail.editable, true);
  assert.deepEqual(detail.subtasks, [{ id: 'TASK-1.1', path: 'backlog/tasks/task-1.1 - Write-the-parser.md', title: 'Write the parser', status: 'To Do', archived: false }]);
  assert.deepEqual(detail.blocks.map((r) => r.id), ['TASK-2']);
  assert.equal(detail.parent, null);
  assert.equal(detail.milestoneTitle, 'v1 Launch');
  assert.deepEqual(detail.ac, {
    readOnly: false,
    items: [
      { line: 40, source: '- [x] #1 Build produces dist/', number: 1, text: 'Build produces dist/', checked: true },
      { line: 41, source: '- [ ] #2 Typecheck passes', number: 2, text: 'Typecheck passes', checked: false },
    ],
  });
  assert.deepEqual(detail.comments, [{ author: '@bob', created: '2026-10-14 09:49', body: 'Looks good so far' }]);
  assert.deepEqual(detail.references, ['https://example.com/build']);

  const child = buildTaskDetail(index, 'backlog/tasks/task-1.1 - Write-the-parser.md')!;
  assert.deepEqual(child.parent, { id: 'TASK-1', path: TASK1, title: 'Set up the build', status: 'In Progress', archived: false });
  const t2 = buildTaskDetail(index, 'backlog/tasks/task-2 - Render-the-board.md')!;
  assert.deepEqual(t2.dependencies.map((r) => [r.id, r.status]), [['TASK-1', 'In Progress']]);
  assert.equal(buildTaskDetail(index, 'backlog/tasks/missing.md'), null);
});

test('detail view: unknown updated_date or status shape is not editable; missing refs resolve to null', () => {
  const index = fixtureIndex(['updated-unknown.md', 'quoted-status.md', 'odd-check.md']);
  const unknown = buildTaskDetail(index, 'backlog/tasks/updated-unknown.md')!;
  assert.deepEqual([unknown.editable, unknown.statusLine], [false, null]);
  assert.equal(buildTaskDetail(index, 'backlog/tasks/quoted-status.md')!.statusLine, 'status: "To Do"');
  assert.equal(buildTaskDetail(index, 'backlog/tasks/odd-check.md')!.ac!.readOnly, true);

  const files: SourceFile[] = [
    { path: 't/a.md', text: '---\nid: TASK-1\nstatus:\n  - x\nparent_task_id: TASK-7\ndependencies: [TASK-8]\n---\n' },
    { path: 't/b.md', text: '---\nid: TASK-2\nstatus: To Do\n---\n' },
  ];
  const small = buildIndex(files, [], CONFIG);
  const a = buildTaskDetail(small, 't/a.md')!;
  assert.deepEqual([a.statusLine, a.editable, a.status], [null, true, 'To Do']);
  assert.deepEqual(a.parent, { id: 'TASK-7', path: null, title: null, status: null, archived: false });
  assert.deepEqual(a.dependencies, [{ id: 'TASK-8', path: null, title: null, status: null, archived: false }]);
  assert.equal(buildTaskDetail(small, 't/b.md')!.editable, true, 'updated_date is inserted after status');
});

test('read-only before anything is tried (backlog.md 4.4): the reason and line on the card and the detail', () => {
  const head = "---\nid: TASK-1\ntitle: T\nstatus: To Do\ncreated_date: '2026-10-01 10:00'\n";
  const files: SourceFile[] = [
    { path: 't/ok.md', text: `${head}updated_date: '2026-10-01 10:00'\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nx\n<!-- SECTION:DESCRIPTION:END -->\n` },
    { path: 't/frontmatter.md', text: `${head}stray text\n---\n` },
    { path: 't/markers.md', text: `${head}---\n\ntext\n<!-- SECTION:NOTES:END -->\n` },
    { path: 't/fenced-marker.md', text: `${head}---\n\n\`\`\`\n<!-- SECTION:NOTES:END -->\n\`\`\`\n` },
    { path: 't/multi-line-date.md', text: `${head}updated_date:\n  - x\n---\n` },
    { path: 't/two-dates.md', text: `${head}updated_date: '2026-10-01 10:00'\nupdated_date: '2026-10-02 10:00'\n---\n` },
    { path: 't/no-anchor.md', text: '---\nid: TASK-9\ntitle: T\n---\n' },
  ];
  const index = buildIndex(files, [], CONFIG);
  const expected: Record<string, unknown> = {
    't/ok.md': null,
    't/frontmatter.md': { reason: 'frontmatter', line: 6 },
    't/markers.md': { reason: 'markers', line: 9 },
    't/fenced-marker.md': null,
    't/multi-line-date.md': { reason: 'updatedDate', line: null },
    't/two-dates.md': { reason: 'updatedDate', line: null },
    't/no-anchor.md': { reason: 'updatedDate', line: null },
  };
  const view = buildBacklogView(index, CONFIG, 'demo', DEFAULT_STRINGS);
  for (const [path, notice] of Object.entries(expected)) {
    assert.deepEqual(view.tasks.find((t) => t.path === path)!.readOnly, notice, `card ${path}`);
    const detail = buildTaskDetail(index, path)!;
    assert.deepEqual([detail.readOnly, detail.editable], [notice, notice === null], `detail ${path}`);
  }
  // The whole project on a file system that cannot be written; archived tasks say archived first.
  const locked = buildBacklogView(index, CONFIG, 'demo', DEFAULT_STRINGS, 'bottom', undefined, false);
  assert.ok(locked.tasks.every((t) => t.readOnly?.reason === 'fileSystem'));
  assert.deepEqual(buildTaskDetail(index, 't/ok.md', false)!.readOnly, { reason: 'fileSystem', line: null });
  const archive = buildIndex([], [], CONFIG, [{ path: 'backlog/archive/tasks/task-9.md', text: files[0].text }]);
  assert.deepEqual(buildTaskDetail(archive, 'backlog/archive/tasks/task-9.md', false)!.readOnly, { reason: 'archived', line: null });
  assert.equal(buildBacklogView(archive, CONFIG, 'demo', DEFAULT_STRINGS).archived[0].readOnly?.reason, 'archived');
});

test('read-only notices match what the write guard refuses for every fixture', () => {
  const index = fixtureIndex(readdirSync(VARIANTS));
  for (const task of index.tasks) {
    const parsed = parseText(task.texts.join('\n'));
    const refused = !frontmatterSane(parsed.texts, parsed.file.frontmatter!) || hasStrayMarker(parsed);
    const notice = buildTaskDetail(index, task.path)!.readOnly;
    assert.equal(refused, notice?.reason === 'frontmatter' || notice?.reason === 'markers', task.path);
  }
  assert.equal(buildTaskDetail(index, 'backlog/tasks/unbalanced.md')!.readOnly?.reason, 'markers', 'a fixture with unpaired markers');
});

test('board view: task types from the config, CLI defaults otherwise', () => {
  assert.deepEqual(buildBacklogView(fixtureIndex(), CONFIG, 'demo', DEFAULT_STRINGS).taskTypes, ['bug', 'feature', 'enhancement', 'task', 'chore', 'docs', 'spike']);
  const custom = parseConfig('types: [bug, Research]\n').config;
  assert.deepEqual(buildBacklogView(fixtureIndex(), custom, 'demo', DEFAULT_STRINGS).taskTypes, ['bug', 'Research']);
});

test('detail view: stage 2 field and section sources', () => {
  const detail = buildTaskDetail(fixtureIndex(), TASK1)!;
  assert.deepEqual(detail.fieldSources, {
    title: 'title: Set up the build',
    priority: 'priority: high',
    type: 'type: feature',
    milestone: 'milestone: m-0',
    due_date: null,
    project: null,
    reporter: null,
    assignee: "assignee:\n  - '@alice'",
    labels: 'labels:\n  - build\n  - infra',
    dependencies: 'dependencies: []',
    references: "references:\n  - 'https://example.com/build'",
    documentation: 'documentation:\n  - docs/build.md',
    modified_files: 'modified_files:\n  - scripts/build.mjs',
  });
  assert.deepEqual(detail.lockedFields, []);
  assert.deepEqual(detail.sectionSources, {
    description: detail.sectionSources.description,
    plan: '1. Add script\n2. Wire CI',
    notes: 'Started with esbuild.',
    finalSummary: null,
  });
  assert.ok(detail.sectionSources.description!.startsWith('Compile with **esbuild**'));
  assert.ok(detail.sectionSources.description!.endsWith('```'));

  const index = fixtureIndex(['unknown-keys.md']);
  const unknown = buildTaskDetail(index, 'backlog/tasks/unknown-keys.md')!;
  assert.deepEqual(unknown.lockedFields, ['priority', 'assignee', 'labels'], 'unknown shapes and flow lists');
  assert.equal('priority' in unknown.fieldSources, false);
  assert.equal(unknown.sectionSources.description, 'Body.');

  const spaced = buildIndex([{ path: 't/s.md', text: '---\nid: TASK-9\nstatus: To Do\n---\n<!-- SECTION:NOTES:BEGIN -->\n\nkept as is\n\n<!-- SECTION:NOTES:END -->\n' }], [], CONFIG);
  assert.equal(buildTaskDetail(spaced, 't/s.md')!.sectionSources.notes, '\nkept as is\n', 'raw text between the markers');
});
