// Hover and go-to (links.md 6) against a fake `vscode` and a real LinkIndex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const FAKE = new URL('./fake-vscode.ts', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'vscode' ? { url: FAKE, shortCircuit: true } : next(specifier, context)) });

const fake = await import('./fake-vscode.ts');
const { registerLinkPreview } = await import('../../../src/features/link-preview/index.ts');
const { LinkIndex } = await import('../../../src/vault/link-index.ts');

const ROOT = '/vault';
const TEXTS: Record<string, string> = {
  'Target.md': '---\ntags: [x]\n---\n# Target\nIntro with ![remote](https://example.com/a.png)\n## Setup\nDo this ^b1\n## Other\nmore\n',
  'a/Dup.md': 'one\n',
  'b/Dup.md': 'two\n',
  'pic.png': 'PNGDATA',
};
const SOURCE = 'See [[Target#Setup]], [[Dup]], [[Missing]], ![[pic.png]] and [[Target#^b1]].';

type Hover = { contents: { value: string; isTrusted?: boolean; supportHtml?: boolean } };
type LocationLink = { targetUri: { path: string }; targetRange: { startLine: number } };

function setup() {
  fake.files.clear();
  fake.settings.clear();
  for (const [p, t] of Object.entries(TEXTS)) fake.files.set(`${ROOT}/${p}`, t);
  const index = LinkIndex.build([...Object.keys(TEXTS), 'note.md'], (p) => TEXTS[p] ?? SOURCE);
  const rel = (uri: { path: string }) => (uri.path.startsWith(`${ROOT}/`) ? uri.path.slice(ROOT.length + 1) : undefined);
  const store = { indexFor: (uri: { path: string }) => (rel(uri) !== undefined ? { root: fake.Uri.file(ROOT), index } : undefined), relativePath: rel };
  registerLinkPreview({ subscriptions: [] } as never, { links: () => store as never });
  return {
    hover: (ch: number) => (fake.providers.hover as { provideHover: (...a: unknown[]) => Promise<Hover | undefined> }).provideHover(doc(), { line: 0, character: ch }),
    definition: (ch: number) => (fake.providers.definition as { provideDefinition: (...a: unknown[]) => Promise<LocationLink[] | undefined> }).provideDefinition(doc(), { line: 0, character: ch }),
  };
}
const doc = (path = `${ROOT}/note.md`) => ({ uri: fake.Uri.file(path), getText: () => SOURCE });
const at = (needle: string) => SOURCE.indexOf(needle) + 2;

test('hover: the heading section, untrusted, no HTML, remote images not loaded', async () => {
  const { hover } = setup();
  const h = (await hover(at('[[Target#Setup')))!;
  assert.equal(h.contents.isTrusted, false);
  assert.equal(h.contents.supportHtml, false);
  assert.ok(h.contents.value.startsWith('**Target.md**'));
  assert.ok(h.contents.value.includes('## Setup\nDo this ^b1'));
  assert.ok(!h.contents.value.includes('## Other'));
  assert.ok(!h.contents.value.includes('https://'));
});

test('hover: ambiguous lists the candidates, missing says so, attachments show name and size', async () => {
  const { hover } = setup();
  assert.match((await hover(at('[[Dup')))!.contents.value, /Several files match this link:\n\n- a\/Dup\.md\n- b\/Dup\.md/);
  assert.match((await hover(at('[[Missing')))!.contents.value, /Missing.*does not exist/);
  assert.equal((await hover(at('![[pic')))!.contents.value, '**pic.png** — 7 B');
  assert.equal(await hover(1), undefined, 'not on a link');
});

test('Ctrl+click: the target at the heading or block line; several for ambiguous; none for missing', async () => {
  const { definition } = setup();
  const heading = (await definition(at('[[Target#Setup')))!;
  assert.deepEqual(heading.map((l) => [l.targetUri.path, l.targetRange.startLine]), [[`${ROOT}/Target.md`, 5]]);
  const block = (await definition(at('[[Target#^b1')))!;
  assert.equal(block[0].targetRange.startLine, 6);
  assert.deepEqual((await definition(at('[[Dup')))!.map((l) => l.targetUri.path), [`${ROOT}/a/Dup.md`, `${ROOT}/b/Dup.md`]);
  assert.equal(await definition(at('[[Missing')), undefined, 'no note is created or opened');
});

test('outside a vault or disabled: nothing', async () => {
  const { hover } = setup();
  fake.settings.set('notewell.linkPreview.enabled', false);
  assert.equal(await hover(at('[[Target#Setup')), undefined);
  fake.settings.clear();
  const outside = await (fake.providers.hover as { provideHover: (...a: unknown[]) => Promise<unknown> }).provideHover(doc('/elsewhere/n.md'), { line: 0, character: at('[[Target') });
  assert.equal(outside, undefined);
});

test('round 4: a huge or binary note target is never read in full; the hover shows its name and size', async () => {
  const { hover, definition } = setup();
  fake.files.set(`${ROOT}/Target.md`, `# Target\n${'x'.repeat(100)}`);
  fake.sizes.set(`${ROOT}/Target.md`, 500 * 1024 * 1024);
  fake.reads.length = 0;
  const h = (await hover(at('[[Target#Setup')))!;
  assert.match(h.contents.value, /^\*\*Target\.md\*\* — 500(\.0)? MB/);
  const links = (await definition(at('[[Target#Setup')))!;
  assert.equal(links[0]!.targetRange.startLine, 0, 'opened at the top instead of searching the heading');
  assert.deepEqual(fake.reads, [], 'not read');
  fake.sizes.clear();
  fake.files.set(`${ROOT}/Target.md`, `# Target\n\u0000\u0001binary`);
  const b = (await hover(at('[[Target#Setup')))!;
  assert.ok(!b.contents.value.includes('binary'), 'binary content is not shown');
});

test('round 5: hovering repeatedly in a very large open document stays fast', async () => {
  setup();
  const big = `${SOURCE}\n${Array.from({ length: 100_000 }, (_, i) => `line ${i} [[Target]] and [x](Target.md)`).join('\n')}`;
  const document = { uri: fake.Uri.file(`${ROOT}/note.md`), getText: () => big, version: 7 };
  const provider = fake.providers.hover as { provideHover: (...a: unknown[]) => Promise<unknown> };
  const started = performance.now();
  for (let i = 0; i < 20; i++) await provider.provideHover(document, { line: 0, character: at('[[Target#Setup') });
  assert.ok(performance.now() - started < 3000, `${performance.now() - started} ms for 20 hovers`);
});

test('fuzz: hover and Ctrl+click at random positions on random vault states never throw and stay untrusted', async () => {
  let seed = 3;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const SOUP = ['[[a]]', '[[a#h]]', '[[a#^b]]', '[[x/b|alias]]', '[t](a.md)', '[t](../a.md#h)', '![[p.png]]', '[[missing]]', '[[', ']]', '`', '<b>x</b>', '# h', '^b', '\n', ' text ', '---', '<script>', '](', '%%', '😀'];
  const provider = fake.providers.hover as { provideHover: (...a: unknown[]) => Promise<Hover | undefined> } | undefined;
  for (let round = 0; round < 150; round++) {
    fake.files.clear();
    const texts: Record<string, string> = {};
    for (const path of ['a.md', 'x/b.md', 'x/a.md', 'p.png', 'note.md']) {
      if (rand() < 0.8) texts[path] = Array.from({ length: 1 + Math.floor(rand() * 15) }, () => pick(SOUP)).join('');
    }
    for (const [p, t] of Object.entries(texts)) fake.files.set(`${ROOT}/${p}`, t);
    const index = LinkIndex.build(Object.keys(texts), (p) => texts[p]);
    const rel = (uri: { path: string }) => (uri.path.startsWith(`${ROOT}/`) ? uri.path.slice(ROOT.length + 1) : undefined);
    const store = { indexFor: (uri: { path: string }) => (rel(uri) !== undefined ? { root: fake.Uri.file(ROOT), index } : undefined), relativePath: rel };
    registerLinkPreview({ subscriptions: [] } as never, { links: () => store as never });
    const source = texts['note.md'] ?? pick(SOUP);
    const lines = source.split('\n');
    const document = { uri: fake.Uri.file(`${ROOT}/note.md`), getText: () => source, version: round };
    for (let k = 0; k < 10; k++) {
      const line = Math.floor(rand() * lines.length);
      const character = Math.floor(rand() * ((lines[line]?.length ?? 0) + 1));
      const hover = await (fake.providers.hover as typeof provider)!.provideHover(document, { line, character });
      if (hover !== undefined) {
        assert.equal(hover.contents.isTrusted, false);
        assert.equal(hover.contents.supportHtml, false);
      }
      await (fake.providers.definition as { provideDefinition: (...a: unknown[]) => Promise<unknown> }).provideDefinition(document, { line, character });
    }
  }
});
