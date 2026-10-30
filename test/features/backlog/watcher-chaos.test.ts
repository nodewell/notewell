// File watcher chaos (backlog.md 4.1): events for task, milestone and archived files arrive
// reordered, duplicated or not at all, as real watchers do under load (a burst of CLI commands, a
// git checkout). The index must converge to what is on disk: on its own for reordered and
// duplicated events, and after a rescan (panel load, panel shown, window focus) for dropped ones.
// Seeded, against the fake `vscode`.
import { test } from 'node:test';
import { whenQuiet } from '../../../src/features/backlog/quiescence.ts';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE_VSCODE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'vscode' ? { url: FAKE_VSCODE, shortCircuit: true } : next(specifier, context),
});

const fake = await import('./fake-vscode.ts');
const { BacklogProjects } = await import('../../../src/features/backlog/project.ts');
const { buildIndex } = await import('../../../src/features/backlog/task-index.ts');
const { DEFAULT_CONFIG } = await import('../../../src/features/backlog/config.ts');

const ROOT = '/ws';
// Waits for the Backlog work in flight (message queues, debounced reads and redraws, rescans),
// not for a guessed number of milliseconds: deterministic on a loaded machine.
const settle = (_ms?: number) => whenQuiet();
const ITERATIONS = Number(process.env['NOTEWELL_FUZZ_ITERATIONS'] ?? 40);

function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(l: readonly T[]) => l[Math.floor(next() * l.length)], chance: (p: number) => next() < p };
}

const task = (id: string, title: string, extra: string[] = []) => ['---', `id: ${id}`, `title: ${title}`, 'status: To Do', ...extra, '---', ''].join('\n');

/** What the index should be: everything on disk now, read afresh. */
function expected() {
  const under = (dir: string) =>
    [...fake.files].filter(([p]) => p.startsWith(`${ROOT}/backlog/${dir}/`) && p.endsWith('.md') && !p.slice(`${ROOT}/backlog/${dir}/`.length).includes('/')).map(([p, text]) => ({ path: p.slice(ROOT.length + 1), text }));
  const index = buildIndex(under('tasks'), under('milestones'), DEFAULT_CONFIG, [...under('archive/tasks'), ...under('completed')]);
  return {
    tasks: index.tasks.map((t) => `${t.path}|${t.id}|${t.data.title}|${t.data.dependencies.join(',')}`).sort(),
    unreadable: index.unreadable.map((u) => `${u.path}|${u.reason}`).sort(),
    milestones: index.milestones.map((m) => `${m.id}|${m.title}`).sort(),
    archived: [...index.archived.entries()].map(([k, list]) => `${k}|${list.map((t) => `${t.path}:${t.data.status}`).join(',')}`).sort(),
  };
}

function actual(projects: Awaited<ReturnType<typeof BacklogProjects.create>>) {
  const index = projects.projects[0].index;
  return {
    tasks: index.tasks.map((t) => `${t.path}|${t.id}|${t.data.title}|${t.data.dependencies.join(',')}`).sort(),
    unreadable: index.unreadable.map((u) => `${u.path}|${u.reason}`).sort(),
    milestones: index.milestones.map((m) => `${m.id}|${m.title}`).sort(),
    archived: [...index.archived.entries()].map(([k, list]) => `${k}|${list.map((t) => `${t.path}:${t.data.status}`).join(',')}`).sort(),
  };
}

async function setup() {
  fake.files.clear();
  fake.reads.clear();
  fake.textDocuments.length = 0;
  fake.files.set(`${ROOT}/backlog/config.yml`, 'statuses: ["To Do", "In Progress", "Done"]\n');
  for (let i = 1; i <= 5; i++) fake.files.set(`${ROOT}/backlog/tasks/task-${i} - T.md`, task(`TASK-${i}`, `Task ${i}`));
  fake.files.set(`${ROOT}/backlog/milestones/m-0 - v1.md`, '---\nid: m-0\ntitle: v1\n---\n');
  fake.workspace.workspaceFolders = [{ uri: fake.Uri.file(ROOT), name: 'ws', index: 0 }];
  const projects = await BacklogProjects.create({ onBrokenConfig: () => undefined });
  return projects;
}

type Event = { kind: 'create' | 'change' | 'delete'; path: string };

/** One random change on disk, like a CLI command, with the events a watcher would report. */
function change(r: ReturnType<typeof rng>, n: number): Event[] {
  const tasks = [...fake.files.keys()].filter((p) => p.includes('/backlog/tasks/'));
  const path = r.pick(tasks.length > 0 ? tasks : [`${ROOT}/backlog/tasks/task-1 - T.md`]);
  switch (r.int(8)) {
    case 0: {
      const created = `${ROOT}/backlog/tasks/task-${100 + n} - New.md`;
      fake.files.set(created, task(`TASK-${100 + n}`, `New ${n}`, r.chance(0.5) ? ['dependencies:', '  - TASK-1'] : []));
      return [{ kind: 'create', path: created }];
    }
    case 1:
      if (!fake.files.has(path)) return [];
      fake.files.set(path, fake.files.get(path)!.replace(/^title: .*$/m, `title: Edited ${n}`));
      return [{ kind: 'change', path }];
    case 2:
      // An atomic replace: delete then create.
      if (!fake.files.has(path)) return [];
      fake.files.set(path, fake.files.get(path)!.replace(/^title: .*$/m, `title: Replaced ${n}`));
      return [{ kind: 'delete', path }, { kind: 'create', path }];
    case 3: {
      // `backlog task archive` (CLI 1.54.0), or `task complete` before it: moved out of the board.
      if (!fake.files.has(path)) return [];
      const moved = path.replace('/backlog/tasks/', r.chance(0.5) ? '/backlog/archive/tasks/' : '/backlog/completed/');
      fake.files.set(moved, fake.files.get(path)!);
      fake.files.delete(path);
      return [{ kind: 'delete', path }, { kind: 'create', path: moved }];
    }
    case 4: {
      // A rename (ID renumbering or a new title in the file name).
      if (!fake.files.has(path)) return [];
      const renamed = path.replace(' - T.md', ` - Renamed-${n}.md`).replace(/ - New\.md$/, ` - Renamed-${n}.md`);
      if (renamed === path) return [];
      fake.files.set(renamed, fake.files.get(path)!);
      fake.files.delete(path);
      return [{ kind: 'delete', path }, { kind: 'create', path: renamed }];
    }
    case 5: {
      const m = `${ROOT}/backlog/milestones/m-${n} - M.md`;
      fake.files.set(m, `---\nid: m-${n}\ntitle: Milestone ${n}\n---\n`);
      return [{ kind: 'create', path: m }];
    }
    case 6: {
      // `backlog task restore`: an archived task goes back to the board under the same name.
      const archived = [...fake.files.keys()].filter((p) => p.includes('/backlog/archive/tasks/') || p.includes('/backlog/completed/'));
      if (archived.length === 0) return [];
      const from = r.pick(archived);
      const to = from.replace(/\/backlog\/(archive\/tasks|completed)\//, '/backlog/tasks/');
      if (fake.files.has(to)) return [];
      fake.files.set(to, fake.files.get(from)!);
      fake.files.delete(from);
      return [{ kind: 'delete', path: from }, { kind: 'create', path: to }];
    }
    default:
      // A half-written file that is fixed a moment later.
      if (!fake.files.has(path)) return [];
      fake.files.set(path, '---\nid: TASK-');
      return [{ kind: 'change', path }];
  }
}

async function deliver(events: Event[]): Promise<void> {
  for (const e of events) fake.fireWatcher(e.kind, e.path);
  await settle(80);
}

for (const [mode, drop] of [['reordered and duplicated', 0], ['dropped', 0.3]] as const) {
  test(`watcher events ${mode}: the index converges to the disk${drop > 0 ? ' after a rescan' : ''}`, async () => {
    for (const seed of [3, 17, 99]) {
      const r = rng(seed + (drop > 0 ? 1000 : 0));
      const projects = await setup();
      try {
        for (let n = 0; n < ITERATIONS; n++) {
          const events = change(r, n);
          // Half-written files are completed (fixed) after their first event.
          const pending: Event[] = [];
          for (const e of events) {
            if (r.chance(drop)) continue;
            pending.push(e);
            if (r.chance(0.3)) pending.push(e);
          }
          for (let i = pending.length - 1; i > 0; i--) {
            const j = r.int(i + 1);
            [pending[i], pending[j]] = [pending[j], pending[i]];
          }
          await deliver(pending);
          for (const [p, text] of fake.files) {
            if (text === '---\nid: TASK-') {
              fake.files.set(p, task('TASK-77', `Fixed ${n}`));
              if (!r.chance(drop)) await deliver([{ kind: 'change', path: p }]);
            }
          }
        }
        await settle(200);
        await projects.idle();
        if (drop > 0) {
          await projects.rescan();
          await projects.idle();
        }
        assert.deepEqual(actual(projects), expected(), `seed ${seed}`);
      } finally {
        projects.dispose();
      }
    }
  });
}

test('a rescan reads only what changed (unchanged files are not read again)', async () => {
  const projects = await setup();
  try {
    fake.reads.clear();
    await projects.rescan();
    await projects.idle();
    assert.equal([...fake.reads.values()].reduce((a, b) => a + b, 0), 0, 'nothing changed, nothing read');
    fake.files.set(`${ROOT}/backlog/tasks/task-2 - T.md`, task('TASK-2', 'Changed silently'));
    await projects.rescan();
    await projects.idle();
    assert.deepEqual([...fake.reads.keys()], [`${ROOT}/backlog/tasks/task-2 - T.md`]);
    assert.equal(projects.projects[0].index.byPath.get('backlog/tasks/task-2 - T.md')?.data.title, 'Changed silently');
  } finally {
    projects.dispose();
  }
});
