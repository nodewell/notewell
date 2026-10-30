// Exercises the Backlog VS Code adapter against an in-memory fake of the `vscode` module.
import { test } from 'node:test';
import { whenQuiet } from '../../../src/features/backlog/quiescence.ts';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';

const FAKE_VSCODE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./fake-vscode.ts');
const { BacklogProjects, detectedProjects, projectPath, projectUri } = await import('../../../src/features/backlog/project.ts');

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();

/** The CLI fixture project copied under `<root>/<dir>/`. */
function fixtureFiles(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = { [`${root}/${dir}/config.yml`]: readFileSync(new URL('config.yml', PROJECT), 'utf8') };
  for (const sub of ['tasks', 'milestones']) {
    for (const name of readdirSync(new URL(`${sub}/`, PROJECT))) {
      out[`${root}/${dir}/${sub}/${name}`] = readFileSync(new URL(`${sub}/${name}`, PROJECT), 'utf8');
    }
  }
  return out;
}

async function setup(files: Record<string, string>, folders: string[]) {
  fake.files.clear();
  fake.reads.clear();
  fake.textDocuments.length = 0;
  for (const [path, text] of Object.entries(files)) fake.files.set(path, text);
  fake.workspace.workspaceFolders = folders.map((path, index) => ({ uri: fake.Uri.file(path), name: path.split('/').pop()!, index }));
  const warnings: string[] = [];
  let changes = 0;
  const projects = await BacklogProjects.create({ onBrokenConfig: (folder, file, error) => void warnings.push(`${folder.path}/${file}: ${error}`) });
  projects.onDidChange(() => void changes++);
  return { projects, warnings, changes: () => changes };
}

const TASK1 = 'backlog/tasks/task-1 - Set-up-the-build.md';

test('finds projects per workspace folder in detection order and reads them', async () => {
  const { projects, warnings } = await setup(
    {
      ...fixtureFiles('/ws', 'backlog'),
      '/two/backlog.config.yml': 'backlog_directory: plan\nstatuses: [Open, Closed]\n',
      '/two/plan/tasks/t.md': '---\nid: TASK-1\nstatus: Open\n---\n',
      '/two/plan/tasks/notes.txt': 'ignored',
      '/two/plan/tasks/sub/deep.md': '---\nid: TASK-9\n---\n',
      '/two/.backlog/config.yml': 'statuses: [Never]\n',
      '/none/docs/backlog/config.yml': 'statuses: [Deep]\n',
    },
    ['/ws', '/two', '/none'],
  );
  try {
    assert.deepEqual(
      projects.projects.map((p) => [p.name, p.directory, p.configFile, p.index.tasks.length]),
      [['ws', 'backlog', 'backlog/config.yml', 7], ['two', 'plan', 'backlog.config.yml', 1]],
    );
    const ws = projects.projects[0];
    assert.equal(ws.index.byPath.get(TASK1)?.id, 'TASK-1');
    assert.deepEqual(ws.index.milestones.map((m) => m.title), ['v1 Launch']);
    assert.deepEqual(projects.projects[1].config.statuses, ['Open', 'Closed']);
    assert.equal(projects.projectOf(fake.Uri.file('/two/plan/tasks/t.md') as never)?.name, 'two');
    assert.equal(projects.projectOf(fake.Uri.file('/none/x.md') as never), undefined);
    assert.deepEqual(warnings, []);
    assert.deepEqual((await detectedProjects()).map((d) => d.name), ['ws', 'two']);
  } finally {
    projects.dispose();
  }
  assert.equal(fake.watcherCount(), 0, 'all watchers disposed');
});

test('a changed task file is read again alone; deleted and new files follow', async () => {
  const { projects, changes } = await setup(fixtureFiles('/ws', 'backlog'), ['/ws']);
  try {
    fake.reads.clear();
    const before = changes();
    const path = `/ws/${TASK1}`;
    fake.files.set(path, fake.files.get(path)!.replace('title: Set up the build', 'title: Renamed'));
    fake.fireWatcher('change', path);
    fake.fireWatcher('change', path);
    await settle();
    assert.equal(projects.projects[0].index.byPath.get(TASK1)?.data.title, 'Renamed');
    assert.deepEqual([...fake.reads], [[path, 1]], 'only the changed file, once');
    assert.equal(changes(), before + 1);

    fake.files.delete(path);
    fake.fireWatcher('delete', path);
    fake.files.set('/ws/backlog/tasks/task-7 - New.md', '---\nid: TASK-7\ntitle: New\n---\n');
    fake.fireWatcher('create', '/ws/backlog/tasks/task-7 - New.md');
    fake.files.set('/ws/backlog/milestones/m-1 - Next.md', '---\nid: m-1\ntitle: Next\n---\n');
    fake.fireWatcher('create', '/ws/backlog/milestones/m-1 - Next.md');
    await settle();
    const index = projects.projects[0].index;
    assert.equal(index.byPath.has(TASK1), false);
    assert.equal(index.byPath.get('backlog/tasks/task-7 - New.md')?.data.title, 'New');
    assert.deepEqual(index.milestones.map((m) => m.id), ['m-0', 'm-1']);
  } finally {
    projects.dispose();
  }
});

test('a clean open document does not win over the disk (it may not have reloaded yet)', async () => {
  const path = `/ws/${TASK1}`;
  const { projects } = await setup(fixtureFiles('/ws', 'backlog'), ['/ws']);
  try {
    // An open, unmodified document that still has old text while the file changed on disk.
    fake.openDocument(path, fake.files.get(path)!.replace('title: Set up the build', 'title: Old text'));
    fake.files.set(path, fake.files.get(path)!.replace('title: Set up the build', 'title: On disk'));
    fake.fireWatcher('change', path);
    await settle();
    assert.equal(projects.projects[0].index.byPath.get(TASK1)?.data.title, 'On disk');
  } finally {
    projects.dispose();
  }
});

test('refresh() re-reads a task file without a watcher event (after our own writes)', async () => {
  const path = `/ws/${TASK1}`;
  const { projects } = await setup(fixtureFiles('/ws', 'backlog'), ['/ws']);
  try {
    fake.files.set(path, fake.files.get(path)!.replace('title: Set up the build', 'title: Written'));
    projects.refresh(fake.Uri.file(path) as never);
    await settle();
    assert.equal(projects.projects[0].index.byPath.get(TASK1)?.data.title, 'Written');
  } finally {
    projects.dispose();
  }
});

test('unsaved open documents win over the disk and closing one reads the disk again', async () => {
  const path = `/ws/${TASK1}`;
  const { projects } = await setup(fixtureFiles('/ws', 'backlog'), ['/ws']);
  try {
    const doc = fake.openDocument(path, fake.files.get(path)!);
    fake.editDocument(doc, doc.text.replace('title: Set up the build', 'title: Unsaved'));
    await settle();
    assert.equal(projects.projects[0].index.byPath.get(TASK1)?.data.title, 'Unsaved');
    fake.closeDocument(doc);
    await settle();
    assert.equal(projects.projects[0].index.byPath.get(TASK1)?.data.title, 'Set up the build');
    // Documents outside tasks/ and milestones/ are ignored.
    fake.reads.clear();
    fake.editDocument(fake.openDocument('/ws/backlog/docs/x.md', ''), 'x');
    await settle();
    assert.equal(fake.reads.size, 0);
  } finally {
    projects.dispose();
  }
});

test('config changes: new statuses, broken config warns once, project appears and disappears', async () => {
  const { projects, warnings } = await setup({ '/ws/readme.md': '' }, ['/ws']);
  try {
    assert.equal(projects.projects.length, 0);
    for (const [path, text] of Object.entries(fixtureFiles('/ws', '.backlog'))) fake.files.set(path, text);
    fake.fireWatcher('create', '/ws/.backlog');
    await settle();
    assert.deepEqual(projects.projects.map((p) => [p.directory, p.index.tasks.length]), [['.backlog', 7]]);

    fake.files.set('/ws/.backlog/config.yml', 'statuses: [A, B]\n');
    fake.fireWatcher('change', '/ws/.backlog/config.yml');
    await settle();
    assert.deepEqual(projects.projects[0].config.statuses, ['A', 'B']);

    fake.files.set('/ws/.backlog/config.yml', 'statuses: [A, [B]]\n');
    fake.fireWatcher('change', '/ws/.backlog/config.yml');
    await settle();
    fake.fireWatcher('change', '/ws/.backlog/config.yml');
    await settle();
    assert.deepEqual(warnings, ['/ws/.backlog/config.yml: Unreadable keys: statuses']);
    assert.deepEqual(projects.projects[0].config.statuses, ['To Do', 'In Progress', 'Done']);

    for (const path of [...fake.files.keys()]) if (path.startsWith('/ws/.backlog/')) fake.files.delete(path);
    fake.fireWatcher('delete', '/ws/.backlog');
    await settle();
    assert.equal(projects.projects.length, 0);
  } finally {
    projects.dispose();
  }
});

test('workspace folders added and removed', async () => {
  const { projects } = await setup({ ...fixtureFiles('/a', 'backlog'), ...fixtureFiles('/b', 'backlog') }, ['/a']);
  try {
    fake.workspace.workspaceFolders = [{ uri: fake.Uri.file('/b'), name: 'b', index: 0 }];
    fake.folderEvents.fire({});
    await settle();
    assert.deepEqual(projects.projects.map((p) => p.name), ['b']);
  } finally {
    projects.dispose();
  }
});

test('path helpers stay inside the folder', () => {
  const folder = fake.Uri.file('/ws') as never;
  assert.equal(projectUri(folder, 'backlog/tasks/a b.md').path, '/ws/backlog/tasks/a b.md');
  assert.equal(projectPath(folder, fake.Uri.file('/ws/backlog/x.md') as never), 'backlog/x.md');
  assert.equal(projectPath(folder, fake.Uri.file('/wsx/y.md') as never), undefined);
});

// --- Registered Backlog folders (backlog.md 2.1) ---

/** BacklogProjects with registered folders from `entries` (entry -> candidate paths). */
async function setupRegistered(files: Record<string, string>, folders: string[], entries: Record<string, string[]>) {
  fake.files.clear();
  fake.reads.clear();
  fake.textDocuments.length = 0;
  for (const [path, text] of Object.entries(files)) fake.files.set(path, text);
  fake.workspace.workspaceFolders = folders.map((path, index) => ({ uri: fake.Uri.file(path), name: path.split('/').pop()!, index }));
  const registered = { entries };
  const changed = new fake.EventEmitter<void>();
  const missing: string[] = [];
  const projects = await BacklogProjects.create({
    onBrokenConfig: () => undefined,
    registered: () => Object.entries(registered.entries).map(([entry, paths]) => ({ entry, candidates: paths.map((p) => fake.Uri.file(p) as never) })),
    onDidChangeRegistered: changed.event as never,
    onMissingRegistered: (entry) => void missing.push(entry),
  });
  const update = async (next: Record<string, string[]>) => {
    registered.entries = next;
    changed.fire();
    await projects.idle();
  };
  return { projects, missing, update };
}

test('a registered Backlog folder is a project rooted at its parent, outside the workspace too', async () => {
  const { projects, missing } = await setupRegistered(
    { ...fixtureFiles('/ws', 'backlog'), ...fixtureFiles('/elsewhere/app', 'planning') },
    ['/ws'],
    { '/elsewhere/app/planning': ['/elsewhere/app/planning'] },
  );
  try {
    assert.deepEqual(
      projects.projects.map((p) => [p.name, p.folder.path, p.directory, p.configFile, p.index.tasks.length]),
      [
        ['ws', '/ws', 'backlog', 'backlog/config.yml', 7],
        ['app', '/elsewhere/app', 'planning', 'planning/config.yml', 7],
      ],
    );
    const registered = projects.projects[1];
    assert.equal(registered.id, 'file:///elsewhere/app/planning');
    assert.equal(projects.projects[0].id, 'file:///ws', 'workspace projects keep their id (stored layouts)');
    assert.ok(registered.index.byPath.has('planning/tasks/task-1 - Set-up-the-build.md'));
    assert.deepEqual(missing, []);
    // Its tasks are watched like a detected project's.
    const path = '/elsewhere/app/planning/tasks/task-1 - Set-up-the-build.md';
    fake.files.set(path, fake.files.get(path)!.replace('title: Set up the build', 'title: Watched'));
    fake.fireWatcher('change', path);
    await settle();
    assert.equal(projects.projects[1].index.byPath.get('planning/tasks/task-1 - Set-up-the-build.md')?.data.title, 'Watched');
  } finally {
    projects.dispose();
  }
  assert.equal(fake.watcherCount(), 0, 'all watchers disposed');
});

test('a registered folder that detection already found, or registered twice, counts once', async () => {
  const { projects } = await setupRegistered(fixtureFiles('/ws', 'backlog'), ['/ws'], {
    backlog: ['/ws/backlog'],
    './backlog/': ['/ws/backlog/'],
    '/ws/backlog': ['/ws/backlog'],
  });
  try {
    assert.deepEqual(projects.projects.map((p) => [p.id, p.directory]), [['file:///ws', 'backlog']]);
  } finally {
    projects.dispose();
  }
});

test('a registered folder without config.yml is ignored with one warning per entry; it appears once it has one', async () => {
  const { projects, missing, update } = await setupRegistered({ '/ws/readme.md': '' }, ['/ws', '/ws2'], {
    'team/backlog': ['/ws/team/backlog', '/ws2/team/backlog'],
    '/nowhere': ['/nowhere'],
  });
  try {
    assert.equal(projects.projects.length, 0);
    assert.deepEqual(missing.sort(), ['/nowhere', 'team/backlog']);
    await update({ 'team/backlog': ['/ws/team/backlog', '/ws2/team/backlog'], '/nowhere': ['/nowhere'] });
    assert.equal(missing.length, 2, 'warned once per entry');
    // The config appears in one of the candidates (watched).
    for (const [path, text] of Object.entries(fixtureFiles('/ws2/team', 'backlog'))) fake.files.set(path, text);
    fake.fireWatcher('create', '/ws2/team/backlog/config.yml');
    await settle();
    assert.deepEqual(projects.projects.map((p) => [p.name, p.directory]), [['team', 'backlog']]);
    // Removed from the setting: the project goes away.
    await update({});
    assert.equal(projects.projects.length, 0);
  } finally {
    projects.dispose();
  }
  assert.equal(fake.watcherCount(), 0);
});
