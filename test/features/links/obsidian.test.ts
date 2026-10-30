// What Obsidian 1.12.7 did in a test vault (test/fixtures/links/obsidian/, links.md 0 "실측"):
// a rename's rewritten links, same-name resolution, and the app.json values its settings write.
// Notewell must point every link at the same files; where it keeps the original link shape
// instead of Obsidian's shortest form (10 #5), the difference is spelled out here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { LinkIndex } from '../../../src/vault/link-index.ts';
import { parseAppSettings } from '../../../src/vault/settings.ts';
import { planRename, type RenamePlan } from '../../../src/features/links/rewrite.ts';
import { attachmentFolder, pastedImageName, uniqueName } from '../../../src/features/attachments/attachments.ts';

const dir = new URL('../../fixtures/links/obsidian/', import.meta.url);

type Vault = Record<string, string>;

/** Every file under a fixture folder; Markdown as text, other files as an empty string. */
function readVault(folder: string): Vault {
  const root = new URL(`${folder}/`, dir);
  const out: Vault = {};
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = name.replace(/\\/g, '/');
    if (statSync(new URL(path, root)).isDirectory()) continue;
    out[path] = path.endsWith('.md') ? readFileSync(new URL(path, root), 'utf8') : '';
  }
  return out;
}

const build = (vault: Vault) => LinkIndex.build(Object.keys(vault), (p) => vault[p]);

function apply(vault: Vault, plan: RenamePlan, from: string, to: string): Vault {
  const editsFor = new Map(plan.files.map((f) => [f.path, f]));
  const out: Vault = {};
  for (const [path, text] of Object.entries(vault)) {
    let content = text;
    const fileEdits = editsFor.get(path);
    if (fileEdits) {
      const lines = content.split('\n');
      for (const e of [...fileEdits.edits].reverse()) lines[e.line] = lines[e.line]!.slice(0, e.start) + e.newText + lines[e.line]!.slice(e.end);
      content = lines.join('\n');
    }
    out[path === from ? to : path] = content;
  }
  return out;
}

/** Where each link of every note points: `file:line:token -> target`. */
function targets(vault: Vault): string[] {
  const index = build(vault);
  const out: string[] = [];
  for (const path of Object.keys(vault).sort()) {
    for (const { link, resolution } of index.outgoing(path)) {
      const target = resolution.kind === 'found' ? resolution.path : resolution.kind;
      out.push(`${path}:${link.line} -> ${target}`);
    }
  }
  return out;
}

const before = readVault('before');
const obsidian = readVault('after-rename');
const FROM = 'Notes/프로젝트 A.md';
const TO = 'Notes/프로젝트 B.md';

test('rename: Notewell changes the same links Obsidian changed, and they point at the same files', () => {
  const plan = planRename(build(before), [{ from: FROM, to: TO }]);
  assert.deepEqual(plan.unchanged, []);
  const next = apply(before, plan, FROM, TO);
  const obsidianVault: Vault = { ...next, ...obsidian };
  assert.deepEqual(targets(next), targets(obsidianVault));
  assert.equal(plan.files.length, Object.keys(obsidian).length);
  let differing = 0;
  for (const [path, text] of Object.entries(obsidian)) {
    const ours = next[path]!.split('\n');
    const theirs = text.split('\n');
    assert.equal(ours.length, theirs.length, path);
    for (let i = 0; i < theirs.length; i++) {
      if (ours[i] === theirs[i]) continue;
      // Obsidian rewrites every link in the shortest form; Notewell keeps a vault path a vault path.
      const kept = { '- 경로: [[Notes/프로젝트 B]]': '- 경로: [[프로젝트 B]]', '- Markdown 링크(볼트 기준): [프로젝트](Notes/프로젝트%20B.md)': '- Markdown 링크(볼트 기준): [프로젝트](프로젝트%20B.md)' } as Record<string, string>;
      assert.equal(kept[ours[i]!], theirs[i], `${path}:${i}`);
      differing++;
    }
  }
  assert.equal(differing, 2);
  // Including the frontmatter property link (10 #3) and the board card.
  assert.match(next['Notes/링크 모음.md']!, /^참고: "\[\[프로젝트 B\]\]"$/m);
  assert.equal(next['Boards/06 공존 시험.md'], obsidian['Boards/06 공존 시험.md']);
});

test('move into another folder: Obsidian changed no note; every Notewell rewrite still names the moved file', () => {
  const renamed = { ...apply(before, planRename(build(before), [{ from: FROM, to: TO }]), FROM, TO), ...obsidian };
  const moved = 'Archive/프로젝트 B.md';
  const plan = planRename(build(renamed), [{ from: TO, to: moved }]);
  const next = apply(renamed, plan, TO, moved);
  // Obsidian left the notes as they were: names and the shortest-path Markdown link still resolve.
  const untouched = { ...renamed };
  delete untouched[TO];
  untouched[moved] = renamed[TO]!;
  assert.deepEqual(targets(next), targets(untouched));
  // Notewell keeps a Markdown link that worked relative to the note relative (10 #5).
  assert.match(next['Notes/링크 모음.md']!, /\[프로젝트\]\(\.\.\/Archive\/프로젝트%20B\.md\)/);
});

test('same name in three folders: the file at the written path from the vault root wins (2.2)', () => {
  const index = build(before);
  for (const source of ['루트 노트.md', 'Notes/링크 모음.md', 'Archive/2025/참조.md']) {
    const link = index.outgoing(source).find((l) => l.link.path === '회의');
    assert.deepEqual(link?.resolution, { kind: 'found', path: '회의.md' }, source);
  }
  // The property link in Notes/프로젝트 A.md too.
  assert.deepEqual(index.outgoing(FROM)[0]?.resolution, { kind: 'found', path: '회의.md' });
});

test('app.json as Obsidian writes it: update-links switch and the four attachment locations', () => {
  const read = (name: string) => parseAppSettings(readFileSync(new URL(`app-json/${name}`, dir), 'utf8')).settings;
  assert.equal(parseAppSettings('{}').settings.alwaysUpdateLinks, undefined);
  assert.equal(read('always-update-on.json').alwaysUpdateLinks, true);
  assert.equal(read('always-update-off.json').alwaysUpdateLinks, false);
  const note = 'Notes/첨부 시험.md';
  const folder = (name: string) => attachmentFolder(read(name).attachmentFolderPath, note);
  assert.equal(folder('attachments-root.json'), '');
  assert.equal(folder('attachments-current.json'), 'Notes');
  assert.equal(folder('attachments-subfolder.json'), 'Notes/첨부파일');
  assert.equal(folder('attachments-folder.json'), 'assets');
});

test('pasted images: Obsidian names and duplicate suffix', () => {
  // Obsidian pasted at 14:34:40 local time and wrote `Pasted image 20261021143440.png`.
  assert.equal(pastedImageName(new Date(2026, 9, 21, 14, 34, 40), 'png'), 'Pasted image 20261021143440.png');
  const taken = new Set(['Pasted image 20261021143440.png', '그림.png']);
  assert.equal(uniqueName('Pasted image 20261021143440.png', (n) => taken.has(n)), 'Pasted image 20261021143440 1.png');
  assert.equal(uniqueName('그림.png', (n) => taken.has(n)), '그림 1.png');
});
