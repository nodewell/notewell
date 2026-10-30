// Link rewrites for renames (links.md 2.4, 3.2): path part only, original shape kept, relative
// links of moved files, ambiguity reported, byte preservation, idempotence, timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkIndex } from '../../../src/vault/link-index.ts';
import { planRename, type RenamePlan } from '../../../src/features/links/rewrite.ts';

type Vault = Record<string, string>;
const build = (vault: Vault) => LinkIndex.build(Object.keys(vault), (p) => vault[p]);

/** Applies a plan and the renames to a vault (file moves and edits). */
function apply(vault: Vault, plan: RenamePlan, renames: { from: string; to: string }[]): Vault {
  const out: Vault = {};
  const editsFor = new Map(plan.files.map((f) => [f.path, f]));
  for (const [path, text] of Object.entries(vault)) {
    let content = text;
    const fileEdits = editsFor.get(path);
    if (fileEdits) {
      const lines = content.split('\n');
      for (const e of [...fileEdits.edits].reverse()) lines[e.line] = lines[e.line]!.slice(0, e.start) + e.newText + lines[e.line]!.slice(e.end);
      content = lines.join('\n');
    }
    let target = path;
    for (const { from, to } of renames) {
      if (target === from) target = to;
      else if (target.startsWith(`${from}/`)) target = `${to}${target.slice(from.length)}`;
    }
    out[target] = content;
  }
  return out;
}

function rename(vault: Vault, renames: { from: string; to: string }[]) {
  const plan = planRename(build(vault), renames);
  const next = apply(vault, plan, renames);
  return { plan, next, again: planRename(build(next), []) };
}

test('wikilinks: only the path changes; display text, #heading, ^block, ! and .md are kept', () => {
  const vault: Vault = {
    'Note.md': '',
    'Home.md': '[[Note]] [[Note|shown]] [[Note#Head#Sub]] [[Note#^abc]] ![[Note]] [[Note.md]] [[note]]',
  };
  const { next, plan } = rename(vault, [{ from: 'Note.md', to: 'Renamed.md' }]);
  assert.equal(next['Home.md'], '[[Renamed]] [[Renamed|shown]] [[Renamed#Head#Sub]] [[Renamed#^abc]] ![[Renamed]] [[Renamed.md]] [[Renamed]]');
  assert.equal(plan.count, 7);
  assert.deepEqual(plan.unchanged, []);
});

test('path shapes: name stays a name when unique, else the full path; vault paths keep their form', () => {
  const vault: Vault = {
    'a/Note.md': '',
    'b/Other.md': '',
    'Home.md': '[[Note]] [[a/Note]] [[/a/Note]] [[Other]]',
  };
  assert.equal(rename(vault, [{ from: 'a/Note.md', to: 'c/d/Moved.md' }]).next['Home.md'], '[[Moved]] [[c/d/Moved]] [[/c/d/Moved]] [[Other]]');
  // The new name exists elsewhere: a bare name would be ambiguous, so the full path is written.
  const clash = rename({ ...vault, 'z/Other.md': '' }, [{ from: 'a/Note.md', to: 'x/Other.md' }]);
  assert.equal(clash.next['Home.md'].split(' ')[0], '[[x/Other]]');
});

test('markdown links: encoding, angle brackets, relative and rooted paths, subpaths', () => {
  const vault: Vault = {
    'folder/Note One.md': '',
    'folder/sub/Child.md': '[up](../Note%20One.md#h) [same](<../Note One.md>)',
    'Home.md': '[a](folder/Note%20One.md) [b](<folder/Note One.md>) [c](./folder/Note%20One.md#^x) [d](/folder/Note%20One.md)',
  };
  const { next } = rename(vault, [{ from: 'folder/Note One.md', to: 'other/New (1).md' }]);
  assert.equal(next['Home.md'], '[a](other/New%20%281%29.md) [b](<other/New (1).md>) [c](./other/New%20%281%29.md#^x) [d](/other/New%20%281%29.md)');
  assert.equal(next['folder/sub/Child.md'], '[up](../../other/New%20%281%29.md#h) [same](<../../other/New (1).md>)');
});

test('a moved file fixes its own relative links; name and vault-path links stay', () => {
  const vault: Vault = {
    'notes/Plan.md': '[r](../assets/pic.png) [[Home]] [v](assets/pic.png)',
    'assets/pic.png': '',
    'Home.md': '',
  };
  const { next, again } = rename(vault, [{ from: 'notes/Plan.md', to: 'notes/deep/er/Plan.md' }]);
  assert.equal(next['notes/deep/er/Plan.md'], '[r](../../../assets/pic.png) [[Home]] [v](assets/pic.png)');
  assert.equal(again.count, 0);
});

test('folder renames move everything under the folder, links both ways', () => {
  const vault: Vault = {
    'proj/A.md': '[b](./B.md) [[B]]',
    'proj/B.md': '[out](../Home.md)',
    'Home.md': '[[proj/A]] [x](proj/B.md)',
  };
  const { next, again } = rename(vault, [{ from: 'proj', to: 'archive/2026/proj' }]);
  assert.equal(next['Home.md'], '[[archive/2026/proj/A]] [x](archive/2026/proj/B.md)');
  assert.equal(next['archive/2026/proj/A.md'], '[b](./B.md) [[B]]', 'links inside the moved folder still fit');
  assert.equal(next['archive/2026/proj/B.md'], '[out](../../../Home.md)');
  assert.equal(again.count, 0);
});

test('attachments keep their extension', () => {
  const vault: Vault = { 'img.png': '', 'Home.md': '![[img.png]] ![](img.png)' };
  // The wikilink stays shortest; the bare Markdown path matched next to the note, so it stays
  // note-relative (2.4 #2).
  assert.equal(rename(vault, [{ from: 'img.png', to: 'pics/photo.png' }]).next['Home.md'], '![[photo.png]] ![](pics/photo.png)');
});

test('ambiguity is reported, not changed', () => {
  // Already ambiguous: [[Leaf]] fits two files, one of them renamed.
  const before: Vault = { 'x/Leaf.md': '', 'y/Leaf.md': '', 'Home.md': '[[Leaf]] [[x/Leaf]]' };
  const a = rename(before, [{ from: 'x/Leaf.md', to: 'x/Branch.md' }]);
  assert.equal(a.next['Home.md'], '[[Leaf]] [[x/Branch]]');
  assert.deepEqual(a.plan.unchanged.map((u) => [u.link.rawPath, u.reason]), [['Leaf', 'ambiguous']]);
  // Would change: renaming to an existing name makes another link ambiguous.
  const clash: Vault = { 'y/Leaf.md': '', 'Note.md': '', 'Home.md': '[[Leaf]] [[Note]]' };
  const b = rename(clash, [{ from: 'Note.md', to: 'z/Leaf.md' }]);
  assert.equal(b.next['Home.md'], '[[Leaf]] [[z/Leaf]]');
  assert.deepEqual(b.plan.unchanged.map((u) => [u.link.rawPath, u.reason]), [['Leaf', 'wouldChange']]);
});

test('bytes outside the link paths stay; Unicode form of the link is kept', () => {
  const nfd = '노트'.normalize('NFD');
  const vault: Vault = {
    '노트.md': '',
    'Home.md': `# Title\n\n- item [[노트|표시]] and \`[[노트]]\` in code\n\n\`\`\`\n[[노트]]\n\`\`\`\nNFD: [[${nfd}]]\n`,
  };
  const { next } = rename(vault, [{ from: '노트.md', to: '새 노트.md' }]);
  assert.equal(next['Home.md'], `# Title\n\n- item [[새 노트|표시]] and \`[[노트]]\` in code\n\n\`\`\`\n[[노트]]\n\`\`\`\nNFD: [[${'새 노트'.normalize('NFD')}]]\n`);
});

test('frontmatter property links are rewritten too (10 #3)', () => {
  const vault: Vault = { 'Note.md': '', 'Home.md': '---\nrelated: "[[Note]]"\n---\nbody' };
  assert.equal(rename(vault, [{ from: 'Note.md', to: 'Renamed.md' }]).next['Home.md'], '---\nrelated: "[[Renamed]]"\n---\nbody');
});

test('10,000-file vault: a rename plan is computed in under 300 ms (links.md 10 #14)', () => {
  const vault: Vault = {};
  for (let i = 0; i < 10_000; i++) vault[`f${i % 100}/Note ${i}.md`] = `[[Hub]] [[Note ${(i + 1) % 10_000}]] [x](../f${(i + 7) % 100}/Note%20${(i + 7) % 10_000}.md)`;
  vault['Hub.md'] = '';
  const index = build(vault);
  const started = performance.now();
  const plan = planRename(index, [{ from: 'Hub.md', to: 'hubs/Main Hub.md' }]);
  const ms = performance.now() - started;
  assert.equal(plan.count, 10_000, 'every note links the hub');
  assert.ok(ms < 300, `plan took ${ms.toFixed(0)} ms`);
});
