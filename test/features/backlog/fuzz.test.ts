// Seeded fuzzing (backlog.md 5): random sequences of every panel operation, interleaved with
// edits by "another tool", against the fixture project; and random unicode/markup through the
// markdown renderer and the detail builders. Reproducible: a failure names its seed and step.
// NOTEWELL_FUZZ_ITERATIONS raises the steps per seed (a long run uses thousands).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { DEFAULT_CONFIG } from '../../../src/features/backlog/config.ts';
import type { ErrorReason, ExtensionMessage } from '../../../src/features/backlog/messages.ts';
import { BacklogSession, type BacklogPorts } from '../../../src/features/backlog/session.ts';
import { parseComments, parseTaskFile, SECTION_ORDER, taskData, type SectionName } from '../../../src/features/backlog/task-file.ts';
import { buildIndex, idKey } from '../../../src/features/backlog/task-index.ts';
import { buildBacklogView, buildTaskDetail } from '../../../src/features/backlog/view-build.ts';
import { DEFAULT_STRINGS, type BacklogView, type TaskSummary } from '../../../src/features/backlog/view.ts';
import { parseMarkdown } from '../../../src/webview/markdown.ts';
import { renderMarkdown } from '../../../src/webview/markdown-render.ts';
import { renderDetail } from '../../../src/features/backlog/browser/render-detail.ts';
import { fakeDocument, type FakeElement } from './browser-view.ts';

const ITERATIONS = Number(process.env['NOTEWELL_FUZZ_ITERATIONS'] ?? 250);
const SEEDS = [1, 7, 42, 2026, 31337];

/** mulberry32: small, seeded, reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

const STATUSES = ['To Do', 'In Progress', 'Done'];
const WORDS = [
  'build', 'yes', 'No', 'null', '~', '123', '1.5', 'a: b', '#tag', 'x # y', '- dash', '@alice', "it's", '"q"', '[x]', '{y}', 'a, b', '한국어', '🚀',
  'שלום', 'tab\tin', 'back\\slash', 'trailing:', '---', 'Done', 'TASK-1', 'task-2', 'https://example.com/x', 'docs/build.md',
];
const TEXTS = [
  'Plain text.', 'Two\n\nparagraphs', '- list\n- items\n  - nested', '```ts\nconst a = 1;\n```', '| a | b |\n|---|---|\n| 1 | 2 |', '> quote\n> more',
  '**bold** _em_ `code` [link](https://example.com)', '<!-- note --> after', '한국어 본문 🚀', '---\nnot frontmatter\n---', '  padded  ',
  '- [ ] #1 looks like AC', 'line   \nwith trailing spaces', '# heading\n### smaller', '<b>html</b> & entities &amp;',
];
const SECTIONS = ['description', 'plan', 'notes', 'finalSummary'] as const;
const SCALARS = ['title', 'priority', 'type', 'milestone', 'due_date', 'project', 'reporter'] as const;
const LISTS = ['assignee', 'labels', 'dependencies', 'references', 'documentation', 'modified_files'] as const;

const fixtures = new URL('../../fixtures/backlog/project/tasks/', import.meta.url);
const FIXTURE_FILES = Object.fromEntries(readdirSync(fixtures).filter((n) => n.endsWith('.md')).map((n) => [`backlog/tasks/${n}`, readFileSync(new URL(n, fixtures), 'utf8')]));

interface World {
  readonly files: Map<string, string>;
  readonly posted: ExtensionMessage[];
  session: BacklogSession;
}

function world(): World {
  const w = { files: new Map(Object.entries(FIXTURE_FILES)), posted: [] as ExtensionMessage[] } as World;
  const view = (): BacklogView => buildBacklogView(index(w), DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
  const ports: BacklogPorts = {
    view,
    detail: (path) => buildTaskDetail(index(w), path),
    readTask: async (path) => {
      const text = w.files.get(path);
      return text === undefined ? undefined : { text, version: 1 };
    },
    write: async (path, { before, after }) => {
      if (w.files.get(path) !== before) return 'stale';
      w.files.set(path, after);
      return 'written';
    },
    statuses: () => STATUSES,
    post: (m) => void w.posted.push(m),
    openTask: async () => undefined,
    openPath: async () => undefined,
    openUrl: async () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 15, 12, 0)),
    errors: new Proxy({}, { get: (_, k) => String(k) }) as Record<ErrorReason, string>,
    dependencies: () => {
      const keyOf = (id: string) => idKey(id, 'task');
      return { keyOf, tasks: new Map(index(w).tasks.map((t) => [keyOf(t.id), t.data.dependencies])) };
    },
    saveLayout: async () => undefined,
    setDetailPosition: async () => undefined,
  };
  w.session = new BacklogSession(ports);
  return w;
}

const index = (w: World) => buildIndex([...w.files].map(([path, text]) => ({ path, text })), [], DEFAULT_CONFIG);
const texts = (text: string) => lineTexts(parseLines(text));

// --- What each operation may change (the oracle for "non-target bytes unchanged") ----------------

interface Allowed {
  readonly fields: readonly string[];
  readonly sections: readonly SectionName[];
}

function structure(text: string) {
  const t = texts(text);
  const file = parseTaskFile(t);
  const fields = new Map<string, string>();
  for (const f of file.fields) fields.set(f.name, `${fields.get(f.name) ?? ''}\n${t.slice(f.line, f.end).join('\n')}`);
  const sections = new Map<string, string>();
  for (const name of SECTION_ORDER) {
    const s = file.sections[name];
    if (s !== undefined) sections.set(name, JSON.stringify([s.heading === null ? null : t[s.heading], t.slice(s.begin, s.end + 1)]));
  }
  return { bom: parseLines(text).bom, fields, sections, other: file.otherBody };
}

function assertOnlyAllowed(before: string, after: string, allowed: Allowed, label: string): void {
  const a = structure(before);
  const b = structure(after);
  assert.equal(b.bom, a.bom, `${label}: BOM`);
  const fieldNames = new Set([...a.fields.keys(), ...b.fields.keys()]);
  for (const name of fieldNames) {
    if (name === 'updated_date' || allowed.fields.includes(name)) continue;
    assert.equal(b.fields.get(name), a.fields.get(name), `${label}: field ${name} changed`);
  }
  for (const name of SECTION_ORDER) {
    if (allowed.sections.includes(name)) continue;
    assert.equal(b.sections.get(name), a.sections.get(name), `${label}: section ${name} changed`);
  }
  assert.equal(b.other, a.other, `${label}: text outside the sections changed`);
}

// --- Random operations, built from the file as the webview would see it ---------------------------

interface Op {
  readonly message: Record<string, unknown>;
  readonly path: string;
  readonly allowed: Allowed;
}

function fieldSource(text: string, name: string): string | undefined {
  const t = texts(text);
  const f = parseTaskFile(t).fields.find((x) => x.name === name);
  return f === undefined ? undefined : t.slice(f.line, f.end).join('\n');
}

function randomOp(r: Rng, w: World): Op | undefined {
  const paths = [...w.files.keys()];
  if (paths.length === 0) return undefined;
  const path = r.pick(paths);
  const text = w.files.get(path)!;
  const t = texts(text);
  const file = parseTaskFile(t);
  const data = taskData(t, file);
  const stale = r.chance(0.08);
  const none: Allowed = { fields: [], sections: [] };
  switch (r.int(9)) {
    case 0: {
      const line = fieldSource(text, 'status');
      return { path, allowed: { fields: ['status'], sections: [] }, message: r.chance(0.5) ? { type: 'setStatus', path, statusLine: stale ? 'status: Nope' : line ?? '', status: r.pick([...STATUSES, 'Bogus']), ...(line === undefined ? { fromStatus: 'To Do' } : {}) } : { type: 'setStatus', path, statusLine: '', fromStatus: data.status ?? 'To Do', status: r.pick(STATUSES) } };
    }
    case 1: {
      const list = r.pick(['ac', 'dod'] as const);
      const items = (list === 'ac' ? data.ac : data.dod)?.items ?? [];
      if (items.length === 0) return undefined;
      const item = r.pick(items);
      return { path, allowed: { fields: [], sections: [list] }, message: { type: 'toggleCheck', path, list, line: stale ? item.line + 1 : item.line, source: t[item.line], checked: r.chance(0.5) } };
    }
    case 2: {
      const name = r.pick(SCALARS);
      const expected = fieldSource(text, name);
      const value = name === 'priority' ? r.pick(['high', 'Medium', 'low', 'urgent', '']) : name === 'due_date' ? r.pick(['2026-11-01', '2026-02-30', 'soon', '']) : r.pick([...WORDS, '']);
      return { path, allowed: { fields: [name], sections: [] }, message: { type: 'setField', path, name, value, ...(expected === undefined ? {} : { expected: stale ? `${expected}x` : expected }) } };
    }
    case 3: {
      const name = r.pick(LISTS);
      const expected = fieldSource(text, name);
      const count = r.int(4);
      const values = Array.from({ length: count }, () => (name === 'dependencies' ? r.pick(['TASK-1', 'TASK-2', 'task-3', 'TASK-99', '5']) : r.pick(WORDS))).join('\n');
      return { path, allowed: { fields: [name], sections: [] }, message: { type: 'setList', path, name, values, ...(expected === undefined ? {} : { expected: stale ? `${expected}\nx` : expected }) } };
    }
    case 4: {
      const section = r.pick(SECTIONS);
      const s = file.sections[section];
      const expected = s === undefined ? undefined : t.slice(s.begin + 1, s.end).join('\n');
      const text2 = r.chance(0.15) ? '' : r.pick(TEXTS) + (r.chance(0.3) ? `\n\n${r.pick(TEXTS)}` : '');
      return { path, allowed: { fields: [], sections: [section] }, message: { type: 'setSection', path, section, text: text2, ...(expected === undefined ? {} : { expected: stale ? `${expected}!` : expected }) } };
    }
    case 5: {
      const seen = file.sections.comments === undefined ? 0 : (parseComments(t, file.sections.comments)?.length ?? 0);
      return { path, allowed: { fields: [], sections: ['comments'] }, message: { type: 'addComment', path, text: r.pick(TEXTS), seen: stale ? seen + 1 : seen } };
    }
    case 6: {
      const view = buildBacklogView(index(w), DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
      const me = view.tasks.find((x) => x.path === path);
      if (me === undefined) return undefined;
      const column = view.tasks.filter((x) => x.status === me.status && x.path !== path).sort((x, y) => (x.ordinal ?? Infinity) - (y.ordinal ?? Infinity));
      const at = r.int(column.length + 1);
      const above = column[at - 1] as TaskSummary | undefined;
      const below = column[at] as TaskSummary | undefined;
      return { path, allowed: { fields: ['ordinal'], sections: [] }, message: { type: 'moveInColumn', path, fromStatus: me.status, ...(above ? { afterPath: above.path } : {}), ...(below ? { beforePath: below.path } : {}) } };
    }
    case 7:
      return { path, allowed: none, message: { type: 'undo' } };
    default:
      // Junk and hostile messages.
      return { path, allowed: none, message: r.pick([{ type: 'setStatus', path: '../x', statusLine: '', status: 'Done' }, { type: 'nope' }, { type: 'setField', path, name: 'id', value: 'X' }, { type: 'toggleCheck', path, list: 'ac', line: -1, source: '', checked: true }, null, 'text']) as Record<string, unknown> };
  }
}

/** Another tool edits a file: plausible raw changes, or a deletion and a re-creation. */
function externalEdit(r: Rng, w: World, deleted: Map<string, string>): void {
  if (deleted.size > 0 && r.chance(0.3)) {
    const [path, text] = [...deleted][0];
    deleted.delete(path);
    w.files.set(path, text);
    return;
  }
  const paths = [...w.files.keys()];
  const path = r.pick(paths);
  const text = w.files.get(path)!;
  const edits: ((s: string) => string)[] = [
    (s) => s.replace(/^title: .*$/m, `title: Edited ${r.int(1000)}`),
    (s) => s.replace(/^status: .*$/m, `status: ${r.pick(STATUSES)}`),
    (s) => s.replace('<!-- SECTION:NOTES:END -->', `Agent line ${r.int(1000)}\n<!-- SECTION:NOTES:END -->`),
    (s) => s.replace('- [ ]', '- [x]'),
    (s) => `${s}\nTrailing agent text ${r.int(100)}\n`,
  ];
  if (r.chance(0.08) && paths.length > 2) {
    deleted.set(path, text);
    w.files.delete(path);
    return;
  }
  w.files.set(path, r.pick(edits)(text));
}

test('fuzz: random panel operations and outside edits never corrupt a file; undo restores exact bytes', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => void rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const w = world();
      const deleted = new Map<string, string>();
      /** Successful writes, newest last: what an undo must give back. */
      const written: { path: string; before: string }[] = [];
      let writes = 0;
      let undos = 0;
      for (let step = 0; step < ITERATIONS; step++) {
        const label = `seed ${seed} step ${step}`;
        if (r.chance(0.15)) {
          externalEdit(r, w, deleted);
          continue;
        }
        const op = randomOp(r, w);
        if (op === undefined) continue;
        const snapshot = new Map(w.files);
        const postedBefore = w.posted.length;
        await w.session.handle(op.message);
        const errors = w.posted.slice(postedBefore).filter((m) => m.type === 'error');
        const changed = [...w.files].filter(([p, s]) => snapshot.get(p) !== s).map(([p]) => p);
        assert.ok(changed.length <= 1, `${label}: more than one file changed`);
        assert.ok([...snapshot.keys()].every((p) => w.files.has(p)), `${label}: a file was deleted`);
        assert.ok([...w.files.keys()].every((p) => snapshot.has(p)), `${label}: a file was created`);
        if (op.message?.type === 'undo') {
          const entry = written.at(-1);
          if (errors.length === 0 && changed.length === 1) {
            assert.ok(entry !== undefined, `${label}: undo with nothing recorded`);
            assert.equal(changed[0], entry.path, `${label}: undo changed another file`);
            assert.equal(w.files.get(entry.path), entry.before, `${label}: undo did not restore the exact bytes`);
            undos++;
          }
          // The session drops the entry when it undoes it or finds it stale.
          if (entry !== undefined && (errors.length === 0 || errors.some((e) => (e as { reason: string }).reason === 'stale'))) written.pop();
          continue;
        }
        if (changed.length === 0) continue;
        assert.deepEqual(errors, [], `${label}: written and refused at once`);
        const before = snapshot.get(op.path)!;
        const after = w.files.get(op.path)!;
        assert.equal(changed[0], op.path, `${label}: wrote another file than the one named`);
        assertOnlyAllowed(before, after, op.allowed, `${label} ${JSON.stringify(op.message).slice(0, 120)}`);
        assert.ok(parseTaskFile(texts(after)).frontmatter !== null, `${label}: frontmatter lost`);
        written.push({ path: op.path, before });
        if (written.length > 50) written.shift();
        writes++;
        // Every file still indexes.
        buildBacklogView(index(w), DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
      }
      assert.ok(writes > ITERATIONS / 10, `seed ${seed}: only ${writes} writes; the fuzzer is not reaching the writers`);
      assert.ok(undos > 0, `seed ${seed}: no undo was exercised`);
    }
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, []);
});

// --- Renderers ---------------------------------------------------------------------------------------

const PIECES = [
  '*', '_', '~~', '`', '```', '~~~', '[', ']', '(', ')', '![', '<', '>', '#', '##', '-', '+', '1.', '|', '---', '\\', '\n', '\n\n', '  ', '\t',
  'a', 'Z', '0', 'han', 'geul', 'cafe', ...[0xd55c, 0xae00, 0x1f680, 0xe9, 0xfdfa, 0xfffd, 0xa0, 0x200f, 0x202e, 0x200b].map((c) => String.fromCodePoint(c)),
  // A family emoji (joined with U+200D) and a combining accent.
  String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb), `e${String.fromCodePoint(0x301)}`, '&amp;', '<script>', 'javascript:', 'https://x.y/z', 'vscode://a',
  '- [ ] ', '- [x] ', '> ', '    ',
];

function randomMarkup(r: Rng, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += r.pick(PIECES);
  return s;
}

const ALLOWED_TAGS = new Set(['div', 'p', 'span', 'strong', 'em', 's', 'code', 'pre', 'br', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'input', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);

test('fuzz: random unicode and markup through the markdown renderer: no throw, whitelisted output, letters kept', () => {
  for (const seed of SEEDS) {
    const r = rng(seed * 101);
    for (let i = 0; i < ITERATIONS; i++) {
      const text = randomMarkup(r, 1 + r.int(80));
      const label = `seed ${seed} #${i} ${JSON.stringify(text)}`;
      const root = renderMarkdown(fakeDocument as never, parseMarkdown(text), { headingOffset: 2 }) as unknown as FakeElement;
      const shown: string[] = [];
      for (const e of root.walk()) {
        assert.ok(ALLOWED_TAGS.has(e.tagName), `${label}: <${e.tagName}>`);
        for (const [name, value] of e.attrs) {
          assert.ok(!name.startsWith('on') && name !== 'href' && name !== 'src' && name !== 'style', `${label}: ${name}`);
          if (name === 'data-url') assert.match(value, /^https?:\/\//i, label);
          shown.push(value);
        }
      }
      shown.push(root.textContent ?? '');
      // Letters are never dropped. Markup characters may be, and so may digits: `1.` starts an
      // ordered list, whose numbers the <ol> draws.
      const letters = (s: string) => [...s].filter((c) => /\p{L}/u.test(c)).sort().join('');
      const kept = letters(shown.join(''));
      for (const [c, n] of Object.entries(count(letters(text)))) assert.ok((count(kept)[c] ?? 0) >= n, `${label}: lost ${c}`);
    }
  }
});

function count(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of s) out[c] = (out[c] ?? 0) + 1;
  return out;
}

test('fuzz: random task files through the index, the detail model and the detail renderer (edit mode)', () => {
  for (const seed of SEEDS) {
    const r = rng(seed * 977);
    for (let i = 0; i < ITERATIONS; i++) {
      const field = (name: string) => (r.chance(0.6) ? [`${name}: ${randomMarkup(r, r.int(6)).replace(/\n/g, ' ')}`] : []);
      const list = (name: string) => (r.chance(0.5) ? [`${name}:`, ...Array.from({ length: r.int(3) }, () => `  - ${randomMarkup(r, 1 + r.int(4)).replace(/\n/g, ' ')}`)] : []);
      const section = (marker: string) => (r.chance(0.6) ? ['', `<!-- ${marker}:BEGIN -->`, randomMarkup(r, r.int(40)), `<!-- ${marker}:END -->`] : []);
      const checklist = (marker: string) =>
        r.chance(0.5) ? ['', `<!-- ${marker}:BEGIN -->`, ...Array.from({ length: r.int(4) }, (_, k) => `- [${r.chance(0.5) ? 'x' : ' '}] #${k + 1} ${randomMarkup(r, r.int(5)).replace(/\n/g, ' ')}`), `<!-- ${marker}:END -->`] : [];
      const text = [
        '---', `id: TASK-${i}`, ...field('title'), ...field('status'), ...field('priority'), ...list('labels'), ...list('assignee'), ...list('dependencies'), ...field('milestone'), ...field('due_date'), '---',
        ...section('SECTION:DESCRIPTION'), ...checklist('AC'), ...checklist('DOD'), ...section('SECTION:PLAN'), ...section('SECTION:NOTES'), ...section('COMMENTS'), ...section('SECTION:FINAL_SUMMARY'),
        r.chance(0.3) ? randomMarkup(r, 20) : '',
      ].join(r.chance(0.2) ? '\r\n' : '\n');
      const label = `seed ${seed} #${i}`;
      const index = buildIndex([{ path: 'backlog/tasks/t.md', text }], [], DEFAULT_CONFIG);
      const view = buildBacklogView(index, DEFAULT_CONFIG, 'demo', DEFAULT_STRINGS);
      const detail = buildTaskDetail(index, 'backlog/tasks/t.md');
      if (detail === null) {
        assert.equal(view.tasks.length, 0, label);
        continue;
      }
      const root = renderDetail(fakeDocument as never, detail, DEFAULT_STRINGS, STATUSES, {
        taskTypes: ['bug'], priorities: ['High', 'Medium', 'Low'], milestones: [], labels: [], assignees: [], tasks: [], editor: r.chance(0.3) ? { kind: 'section', name: 'notes', draft: randomMarkup(r, 20) } : null,
        commentDraft: '', chipDrafts: {}, error: null,
      }) as unknown as FakeElement;
      for (const e of root.walk()) for (const name of e.attrs.keys()) assert.ok(!name.startsWith('on') && name !== 'href' && name !== 'src', `${label}: ${name}`);
    }
  }
});
