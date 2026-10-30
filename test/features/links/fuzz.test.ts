// Random renames and moves of notes, attachments and folders in a synthetic vault (links.md 3):
// after every step each link that named a file names the same file at its new path, or is
// counted in the "left unchanged" notice; the text around links never changes; no link is
// silently redirected to another file. Seeded, so a failure repeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinLines, parseLines } from '../../../src/core/lines.ts';
import { extractLinks, LinkIndex } from '../../../src/vault/link-index.ts';
import { planFileRenames } from '../../../src/features/links/rename.ts';

const V = '/v';

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p: string) => basename(p).replace(/\.md$/, '');
function relative(from: string, to: string): string {
  const a = from === '' ? [] : from.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const rel = [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  return rel.startsWith('../') ? rel : `./${rel}`;
}
const encode = (p: string) => p.replace(/[ %()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const FOLDERS = ['', 'a', 'a/b', 'c', 'c d', '한글'];
const NAMES = ['note', 'Note two', '노트', 'plan (v2)', 'x', 'y', '100%', 'z.v1'];

/** A link to `target` from `source` in one of the forms people write. */
function linkTo(rand: () => number, source: string, target: string): string {
  const md = target.endsWith('.md');
  const form = Math.floor(rand() * 8);
  const shown = md ? target.slice(0, -3) : target;
  switch (form) {
    case 0: return `[[${md ? stem(target) : basename(target)}]]`;
    case 1: return `[[${shown}]]`;
    case 2: return `[[${relative(dirname(source), target).replace(/\.md$/, '')}|alias]]`;
    case 3: return `[t](${encode(relative(dirname(source), target))})`;
    case 4: return `[t](${encode(target)})`;
    case 5: return `![[${basename(target)}]]`;
    case 6: return `[[${shown}#Heading]]`;
    default: return `[t](<${relative(dirname(source), target)}>)`;
  }
}

function buildVault(rand: () => number): Map<string, string> {
  const paths: string[] = [];
  for (const folder of FOLDERS) {
    for (const name of NAMES) if (rand() < 0.35) paths.push(`${folder ? `${folder}/` : ''}${name}.md`);
    if (rand() < 0.5) paths.push(`${folder ? `${folder}/` : ''}img ${Math.floor(rand() * 3)}.png`);
  }
  const unique = [...new Set(paths)];
  const disk = new Map<string, string>();
  for (const path of unique) {
    if (!path.endsWith('.md')) {
      disk.set(path, '');
      continue;
    }
    const lines = [`# ${stem(path)}`];
    for (let i = 0; i < 6; i++) {
      const target = unique[Math.floor(rand() * unique.length)]!;
      lines.push(`text ${i} ${linkTo(rand, path, target)} end`);
    }
    disk.set(path, `${lines.join('\n')}\n`);
  }
  return disk;
}

/** Each note's links with what they resolve to. */
function resolutions(disk: ReadonlyMap<string, string>): Map<string, string[]> {
  const index = LinkIndex.build(disk.keys(), (p) => disk.get(p));
  const out = new Map<string, string[]>();
  for (const path of disk.keys()) {
    if (!path.endsWith('.md')) continue;
    out.set(path, index.outgoing(path).map((o) => (o.resolution.kind === 'found' ? o.resolution.path : o.resolution.kind)));
  }
  return out;
}

/** The text with every link token replaced by a marker: what must never change. */
function skeleton(text: string): string {
  const lines = text.split('\n');
  const links = extractLinks(text);
  for (const link of [...links].reverse()) {
    const line = lines[link.line]!;
    lines[link.line] = `${line.slice(0, link.start)}<LINK>${line.slice(link.end)}`;
  }
  return lines.join('\n');
}

function applyEdits(disk: Map<string, string>, edits: readonly { path: string; line: number; start: number; end: number; newText: string }[]): void {
  const byFile = new Map<string, typeof edits[number][]>();
  for (const e of edits) byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
  for (const [path, list] of byFile) {
    const rel = path.slice(V.length + 1);
    const doc = parseLines(disk.get(rel)!);
    const lines = doc.lines.map((l) => ({ ...l }));
    for (const e of [...list].sort((a, b) => b.line - a.line || b.start - a.start)) {
      const line = lines[e.line]!;
      line.text = line.text.slice(0, e.start) + e.newText + line.text.slice(e.end);
    }
    disk.set(rel, joinLines({ bom: doc.bom, lines }));
  }
}

const STEPS = 500;

for (const seed of [1, 2, 3]) {
  test(`fuzz (seed ${seed}): ${STEPS} random renames and moves keep every link on its file or report it`, async () => {
    const rand = random(seed);
    const disk = buildVault(rand);
    let applied = 0;
    let edited = 0;
    let reportedTotal = 0;
    for (let step = 0; step < STEPS; step++) {
      const before = resolutions(disk);
      const skeletons = new Map([...disk].filter(([p]) => p.endsWith('.md')).map(([p, t]) => [p, skeleton(t)]));
      // A file or a folder, to a new name and/or another folder (sometimes an existing name elsewhere).
      const files = [...disk.keys()];
      const folders = [...new Set(files.map(dirname).filter((d) => d !== ''))];
      let from: string;
      let to: string;
      if (rand() < 0.25 && folders.length > 0) {
        from = folders[Math.floor(rand() * folders.length)]!;
        const parent = FOLDERS[Math.floor(rand() * FOLDERS.length)]!;
        to = `${parent ? `${parent}/` : ''}${['moved', 'e', '새 폴더'][Math.floor(rand() * 3)]}${step}`;
        if (to === from || to.startsWith(`${from}/`)) continue;
      } else {
        from = files[Math.floor(rand() * files.length)]!;
        const ext = from.endsWith('.md') ? '.md' : '.png';
        const folder = FOLDERS[Math.floor(rand() * FOLDERS.length)]!;
        const name = rand() < 0.3 ? stem(files[Math.floor(rand() * files.length)]!).replace(/\.png$/, '') : `${NAMES[Math.floor(rand() * NAMES.length)]} ${step}`;
        to = `${folder ? `${folder}/` : ''}${name}${ext}`;
      }
      if (files.some((f) => f === to || f.startsWith(`${to}/`))) continue; // the target is taken
      const index = LinkIndex.build(disk.keys(), (p) => disk.get(p));
      const outcome = await planFileRenames([{ oldPath: `${V}/${from}`, newPath: `${V}/${to}` }], {
        vaultOf: (p) => (p.startsWith(`${V}/`) ? V : undefined),
        indexFor: () => index,
        mode: () => 'always',
        trusted: () => true,
        confirm: async () => true,
        readText: async (p) => disk.get(p.slice(V.length + 1)),
        reindex: () => undefined,
      });
      applyEdits(disk, outcome.edits);
      edited += outcome.edits.length;
      const moved = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p);
      for (const [path, text] of [...disk]) {
        if (path === from || path.startsWith(`${from}/`)) {
          disk.delete(path);
          disk.set(moved(path), text);
        }
      }
      const label = `seed ${seed} step ${step}: ${from} -> ${to}`;
      assert.ok(!outcome.notices.some((n) => n.kind === 'stale'), `nothing stale: ${label}`);
      const after = resolutions(disk);
      const reported = outcome.notices.find((n) => n.kind === 'unchanged');
      let lost = 0;
      for (const [path, targets] of before) {
        const now = after.get(moved(path))!;
        assert.equal(now.length, targets.length, `same number of links in ${path}: ${label}`);
        assert.equal(skeleton(disk.get(moved(path))!), skeletons.get(path), `only link paths change in ${path}: ${label}`);
        targets.forEach((target, i) => {
          if (target === 'missing' || target === 'ambiguous') return;
          if (now[i] !== moved(target)) lost++;
        });
      }
      assert.ok(lost <= (reported?.kind === 'unchanged' ? reported.links : 0), `${lost} links no longer name their file but only ${reported?.kind === 'unchanged' ? reported.links : 0} were reported: ${label}`);
      reportedTotal += reported?.kind === 'unchanged' ? reported.links : 0;
      applied++;
    }
    // The run really exercised rewrites (and the reporting path).
    assert.ok(edited > 200, `${edited} link edits`);
    assert.ok(reportedTotal > 0, 'some links were left unchanged and reported');
    assert.ok(applied > STEPS / 2, `${applied} renames applied`);
  });
}

const SOUP = ['[[', ']]', '[', ']', '(', ')', '](', '<', '>', '`', '``', '\\', '|', '#', '^', '%%', '$', '$$', '!', 'a', 'b c', '.md', '../', './', '/', '%20', 'é', '한', '😀', ' ', '\t', '\n', '---', '```', '<!--', '-->', 'http://x', '"', "'"];

test('fuzz: link extraction on random token soup never throws and every offset matches the text', () => {
  const rand = random(42);
  const started = performance.now();
  for (let n = 0; n < 3000; n++) {
    let text = '';
    const length = 1 + Math.floor(rand() * 60);
    for (let i = 0; i < length; i++) text += SOUP[Math.floor(rand() * SOUP.length)];
    const lines = text.split(/\r?\n/);
    for (const link of extractLinks(text)) {
      const line = lines[link.line] ?? '';
      assert.equal(line.slice(link.start, link.end), link.token, JSON.stringify(text));
      assert.ok(link.start <= link.pathStart && link.pathStart <= link.pathEnd && link.pathEnd <= link.end, JSON.stringify(text));
      assert.equal(line.slice(link.pathStart, link.pathEnd), link.rawPath, JSON.stringify(text));
    }
  }
  assert.ok(performance.now() - started < 10_000, `${performance.now() - started} ms`);
});

test('fuzz: notes edited while a rename waits for its answer keep those edits; only verified link paths change', async () => {
  for (const seed of [4, 5, 6]) {
    const rand = random(seed);
    for (let round = 0; round < 60; round++) {
      const disk = buildVault(rand);
      const files = [...disk.keys()];
      const from = files[Math.floor(rand() * files.length)]!;
      const to = `moved ${round}${from.endsWith('.md') ? '.md' : '.png'}`;
      if (files.includes(to)) continue;
      const index = LinkIndex.build(disk.keys(), (p) => disk.get(p));
      const touched = new Set<string>();
      const outcome = await planFileRenames([{ oldPath: `${V}/${from}`, newPath: `${V}/${to}` }], {
        vaultOf: (p) => (p.startsWith(`${V}/`) ? V : undefined),
        indexFor: () => index,
        mode: () => 'prompt',
        trusted: () => true,
        confirm: async () => {
          // Other editors change some notes meanwhile: a line inserted, a link retyped, text appended.
          for (const path of files.filter((p) => p.endsWith('.md'))) {
            if (rand() > 0.3) continue;
            const text = disk.get(path)!;
            const kind = Math.floor(rand() * 3);
            disk.set(path, kind === 0 ? `inserted\n${text}` : kind === 1 ? text.replace('[[', '[[ ') : `${text}more\n`);
            if (disk.get(path) !== text) touched.add(path);
          }
          return true;
        },
        readText: async (p) => disk.get(p.slice(V.length + 1)),
        reindex: () => undefined,
      });
      const snapshot = new Map(disk);
      applyEdits(disk, outcome.edits);
      // A note changed meanwhile keeps that change: at most link paths at verified places change
      // (range edits, as VS Code applies them); a change that moved the links makes it skipped.
      for (const path of touched) {
        assert.equal(skeleton(disk.get(path)!), skeleton(snapshot.get(path)!), `only link paths change in ${path}`);
        if (snapshot.get(path)!.startsWith('inserted\n')) assert.equal(disk.get(path), snapshot.get(path), `shifted lines: skipped ${path}`);
      }
    }
  }
});
