// Second hardening round (kanban.md 3, 4, 6; links.md 3; core.md 3.6): link updates racing board
// requests on an open board, hostile vault styles and link targets, and hostile card content in
// the rendered board. Pure: no VS Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTexts, parseLines, joinLines } from '../../../src/core/lines.ts';
import { applyEdits, type TextEdit } from '../../../src/core/patch.ts';
import { renderBoard } from '../../../src/features/kanban/browser/render.ts';
import type { ExtensionMessage } from '../../../src/features/kanban/messages.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { BoardSession, type ErrorStrings } from '../../../src/features/kanban/session.ts';
import { obsidianStyleTokens, safeTokens } from '../../../src/features/kanban/style-map.ts';
import { buildBoardView, DEFAULT_STRINGS } from '../../../src/features/kanban/view.ts';
import { planFileRenames, type PlannedEdit } from '../../../src/features/links/rename.ts';
import { cascadeThemeVariables } from '../../../src/vault/theme-css.ts';
import { LinkIndex } from '../../../src/vault/link-index.ts';
import { resolveLink } from '../../../src/vault/links.ts';

const ERRORS: ErrorStrings = { stale: 'stale', invalid: 'invalid', unsafe: 'unsafe', failed: 'failed', unreadable: 'unreadable', gone: 'gone', encoding: 'encoding', disabled: 'disabled' };

const BOARD = [
  '---',
  'kanban-plugin: basic',
  '---',
  '',
  '## Todo',
  '',
  '- [ ] see [[대상]]',
  '- [ ] [doc](대상.md)',
  '\tbody [[대상|alias]]',
  '',
  '## Done',
  '',
  '**Complete**',
  '',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"basic","note":"[[대상]]"}',
  '```',
  '%%',
  '',
].join('\n');

/** One open board document shared by the board session and the link updater. */
function sharedDocument(text = BOARD) {
  const doc = { text, version: 1 };
  const posts: ExtensionMessage[] = [];
  const session = new BoardSession({
    document: {
      text: () => doc.text,
      version: () => doc.version,
      applyEdits: async (edits) => {
        doc.text = applyEdits(parseLines(doc.text), edits);
        doc.version++;
        return true;
      },
      save: async () => undefined,
    },
    host: { post: (m) => void posts.push(m), openLink: async () => undefined },
    settings: () => ({ doneLanes: [], saveOnEdit: false, useTab: true }),
    strings: DEFAULT_STRINGS,
    errors: ERRORS,
    today: () => '2026-10-15',
  });
  const index = () => LinkIndex.build(['board.md', '대상.md'], (p) => (p === 'board.md' ? doc.text : ''));
  /** Plans the link update now; `apply` applies it later, as VS Code would (by line and character). */
  const planLinks = async (between?: () => Promise<void>) => {
    const built = index();
    const outcome = await planFileRenames([{ oldPath: '/v/대상.md', newPath: '/v/새.md' }], {
      vaultOf: () => '/v',
      indexFor: () => built,
      mode: () => 'prompt',
      trusted: () => true,
      confirm: async () => {
        await between?.();
        return true;
      },
      readText: async () => doc.text,
      reindex: () => undefined,
    });
    return outcome;
  };
  const applyLinks = (edits: readonly PlannedEdit[]) => {
    const lines = parseLines(doc.text);
    const out = lines.lines.map((l) => ({ ...l }));
    for (const e of [...edits].sort((a, b) => b.line - a.line || b.start - a.start)) {
      const line = out[e.line]!;
      line.text = line.text.slice(0, e.start) + e.newText + line.text.slice(e.end);
    }
    doc.text = joinLines({ bom: lines.bom, lines: out });
    doc.version++;
  };
  const errors = () => posts.flatMap((p) => (p.type === 'error' ? [p.reason] : []));
  return { doc, session, planLinks, applyLinks, errors };
}

const shape = (text: string) => parseBoard(lineTexts(parseLines(text))).lanes.map((l) => [l.name, l.cards.length]);
const settingsOf = (text: string) => {
  const texts = lineTexts(parseLines(text));
  const block = parseBoard(texts).settingsBlock!.range;
  return texts.slice(block.start, block.end);
};

// 2. Link updates and board requests on the same open board.
test('case 2: a link update on an open board keeps it a valid board; the settings block is not a link', async () => {
  const { doc, planLinks, applyLinks } = sharedDocument();
  const outcome = await planLinks();
  applyLinks(outcome.edits);
  assert.deepEqual(shape(doc.text), [['Todo', 2], ['Done', 0]]);
  assert.ok(doc.text.includes('- [ ] see [[새]]') && doc.text.includes('- [ ] [doc](새.md)') && doc.text.includes('\tbody [[새|alias]]'));
  assert.deepEqual(settingsOf(doc.text), settingsOf(BOARD), 'links inside %% settings %% are never rewritten');
});

test('case 2: a card dragged while the link question is open: the link update skips the file', async () => {
  const { doc, session, planLinks, applyLinks } = sharedDocument();
  const outcome = await planLinks(async () => {
    await session.handle({ type: 'moveCard', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] see [[대상]]', toLaneIndex: 1, toHeading: '## Done', toIndex: 0 });
  });
  assert.deepEqual(outcome.edits, [], 'the board changed after the links were planned');
  assert.deepEqual(outcome.notices, [{ kind: 'stale', files: 1 }]);
  applyLinks(outcome.edits);
  assert.deepEqual(shape(doc.text), [['Todo', 1], ['Done', 1]]);
});

test('case 2: a link update landing between a board render and a board request: the request is refused', async () => {
  const { doc, session, planLinks, applyLinks, errors } = sharedDocument();
  applyLinks((await planLinks()).edits); // version 2
  const before = doc.text;
  await session.handle({ type: 'editCardText', version: 1, laneIndex: 0, cardIndex: 0, firstLine: '- [ ] see [[대상]]', text: 'see [[대상]] edited' });
  assert.equal(doc.text, before);
  assert.deepEqual(errors(), ['stale']);
});

// 4. Hostile vault styles and link targets.
test('case 4: hostile theme values never become style tokens', () => {
  const hostile = [
    'url(https://x/y.png)',
    'URL(x)',
    'expression(alert(1))',
    '@import "x"',
    'red; background: url(x)',
    'red}</style><script>alert(1)</script>',
    '\\75 rl(x)',
    'u\\72l(x)',
    'image-set("x" 1x)',
    'element(#x)',
    '"\\"x"',
    `${'a'.repeat(600)}`,
    'red !important',
    'rgb(1,2,3) /* x */',
    'javascript:alert(1)',
    'attr(data-x)',
    'env(x)',
    'paint(x)',
  ];
  const css = `body { ${hostile.map((v, i) => `--background-primary-${i}: ${v};`).join(' ')} --text-normal: ${hostile[0]}; --interactive-accent: ${hostile[5]}; }`;
  const vars = cascadeThemeVariables([css]);
  for (const scheme of ['dark', 'light'] as const) {
    for (const value of vars[scheme].values()) assert.ok(!/url|expression|import|script|\\|javascript|attr|env|paint|image|element|[<>;{}@!]/i.test(value), value);
    assert.deepEqual(obsidianStyleTokens(vars[scheme]), {}, 'nothing usable reaches the board');
  }
  assert.deepEqual(safeTokens({ '--nw-board-bg': 'url(x)', '--nw-card-bg': 'red', '--not-a-token': 'red', '--nw-border': '</style>' }), { '--nw-card-bg': 'red' });
});

test('case 4: var() bombs, cycles and a 2 MB theme resolve quickly', () => {
  // Each level doubles the length of the one below: resolving must not take exponential time.
  const levels = Array.from({ length: 40 }, (_, i) => `--l${i + 1}: var(--l${i}) var(--l${i});`).join(' ');
  const bomb = `:root { --l0: red; ${levels} --a: var(--b); --b: var(--a); --c: var(--c, var(--c)); }`;
  const huge = `body { ${Array.from({ length: 40_000 }, (_, i) => `--v${i}: #${(i % 0xffffff).toString(16).padStart(6, '0')};`).join(' ')} }`;
  let started = performance.now();
  const vars = cascadeThemeVariables([bomb]);
  assert.ok(performance.now() - started < 2000, `bomb ${performance.now() - started} ms`);
  assert.equal(vars.dark.get('--l1'), 'red red');
  assert.equal(vars.dark.has('--l40'), false, 'too long to be a value');
  assert.equal(vars.dark.has('--a'), false, 'cycle dropped');
  started = performance.now();
  cascadeThemeVariables([huge]);
  assert.ok(performance.now() - started < 3000, `huge ${performance.now() - started} ms`);
});

test('case 4: wikilink targets never leave the vault (no ../, absolute, drive, UNC or scheme paths)', () => {
  const files = ['a.md', 'notes/b.md', 'C/Windows/x.md', 'javascript/x.md'];
  const hostile = ['../../etc/passwd', '../a', '/etc/passwd', 'C:/Windows/System32/x', 'C:\\Windows\\x', '\\\\server\\share\\x', '//server/share/x', 'javascript:alert(1)', 'command:workbench.action.reloadWindow', 'file:///etc/passwd', 'vscode://x', '%2e%2e/a', 'notes/../../a'];
  for (const target of hostile) {
    const result = resolveLink({ form: 'wikilink', path: target }, files, 'notes/board.md');
    if (result.kind === 'found') assert.ok(files.includes(result.path), `${target} -> ${result.path}`);
    if (result.kind === 'ambiguous') assert.ok(result.paths.every((p) => files.includes(p)), target);
  }
});

// 5. Hostile card content.
class El {
  readonly tagName: string;
  text: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly children: (El | string)[] = [];
  readonly classList = { add: () => undefined };
  className = '';
  constructor(tag: string) {
    this.tagName = tag;
  }
  get textContent(): string | null {
    return this.text ?? this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v: string | null) {
    this.text = v;
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  append(...nodes: (El | string)[]) {
    this.children.push(...nodes);
  }
  addEventListener() {}
}
const fakeDoc = { createElement: (tag: string) => new El(tag), createTextNode: (t: string) => t } as never;

function walk(el: El, visit: (el: El) => void): void {
  visit(el);
  for (const c of el.children) if (typeof c !== 'string') walk(c, visit);
}

test('case 5: hostile card content renders as text only, quickly', () => {
  const nasty = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'onclick="alert(1)" <a href="javascript:alert(1)">x</a>',
    '<style>body{display:none}</style>',
    '<iframe src="https://x">',
    `${'**'.repeat(5000)}deep${'**'.repeat(5000)}`,
    `${'=='.repeat(5000)} ${'`'.repeat(5000)} ${'[['.repeat(5000)}`,
    Array.from({ length: 50_000 }, (_, i) => `#t${i} @{2026-01-${String((i % 28) + 1).padStart(2, '0')}} [[n${i}]]`).join(' '),
    'x'.repeat(1_000_000),
  ];
  const text = `---\nkanban-plugin: basic\n---\n\n## Lane\n\n${nasty.map((n) => `- [ ] ${n}\n\t${n}`).join('\n')}\n`;
  const started = performance.now();
  const texts = lineTexts(parseLines(text));
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-15' });
  const root = renderBoard(fakeDoc, view, { collapsed: new Map() }) as unknown as El;
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);
  const allowed = new Set(['div', 'section', 'header', 'h2', 'ul', 'li', 'span', 'strong', 'em', 'code', 'mark', 'input', 'button', 'p', 'footer', 'textarea', 'label', 'details', 'summary', 'del', 's']);
  walk(root, (el) => {
    assert.ok(allowed.has(el.tagName), `element ${el.tagName}`);
    for (const name of el.attrs.keys()) assert.ok(!/^on|^href$|^src$|^style$|^srcdoc$/i.test(name), `attribute ${name}`);
  });
  assert.ok((root.textContent ?? '').includes('<script>alert(1)</script>'), 'shown as text');
});

// Round 3 case 4: hostile board settings.
test('round 3 case 4: a pathological date-format, deep or huge settings JSON never stall the board', () => {
  const digits = '1'.repeat(60);
  const cards = Array.from({ length: 200 }, (_, i) => `- [ ] task ${i} @{${digits}} @{2026-01-02}`).join('\n');
  const formats = ['M'.repeat(40), 'D'.repeat(40), 'MDMDMDMDMDMDMDMDMDMDMDMDMDMD', `${'YYYY'.repeat(10_000)}`, '[x]'.repeat(50_000)];
  for (const format of formats) {
    const settings = JSON.stringify({ 'kanban-plugin': 'basic', 'date-format': format });
    const text = `---\nkanban-plugin: basic\n---\n\n## A\n\n${cards}\n\n%% kanban:settings\n\`\`\`\n${settings}\n\`\`\`\n%%\n`;
    const started = performance.now();
    const texts = lineTexts(parseLines(text));
    buildBoardView(texts, parseBoard(texts), { today: '2026-10-15' });
    assert.ok(performance.now() - started < 2000, `format ${format.slice(0, 20)}: ${performance.now() - started} ms`);
  }
  const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
  const huge = JSON.stringify({ 'kanban-plugin': 'basic', 'list-collapse': Array.from({ length: 200_000 }, () => true) });
  for (const json of [deep, huge]) {
    const text = `---\nkanban-plugin: basic\n---\n\n## A\n\n- [ ] x\n\n%% kanban:settings\n${json}\n%%\n`;
    const started = performance.now();
    const texts = lineTexts(parseLines(text));
    const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-15' });
    assert.equal(view.lanes.length, 1);
    assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
  }
});

// Round 4 case 4: adversarial lines just under the formatting limit.
test('round 4 case 4: adversarial token patterns in a card line format quickly', () => {
  const n = 2400;
  const patterns = [
    '@{'.repeat(n * 2),
    '@[['.repeat(n * 2),
    `${'#'.repeat(9_000)}a`,
    '#a'.repeat(n * 2),
    '**'.repeat(n * 2),
    '*a'.repeat(n * 2),
    '_a'.repeat(n * 2),
    '~~'.repeat(n * 2),
    '[x]('.repeat(n),
    '[['.repeat(n * 2),
    '[[a|'.repeat(n),
    '==a'.repeat(n * 1),
    '`a'.repeat(n * 2),
    '@{2026-01-01'.repeat(800),
    '[[a]]'.repeat(n),
    '#tag '.repeat(n),
    '@@{{'.repeat(n),
    `${'a'.repeat(9_990)}@{`,
  ];
  for (const pattern of patterns) {
    const line = pattern.slice(0, 9_999);
    const text = `---\nkanban-plugin: basic\n---\n\n## A\n\n- [ ] ${line}\n\t${line}\n`;
    const started = performance.now();
    const texts = lineTexts(parseLines(text));
    buildBoardView(texts, parseBoard(texts), { today: '2026-10-15' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `${pattern.slice(0, 12)}: ${elapsed} ms`);
  }
});

// Round 5 case 4: 500 lanes; lane names that look like structure.
test('round 5 case 4: a board with 500 lanes renders and takes lane and card moves quickly', async () => {
  const lanes = Array.from({ length: 500 }, (_, i) => `## Lane ${i}\n\n${Array.from({ length: 10 }, (_, j) => `- [ ] c${i}-${j}`).join('\n')}\n`).join('\n');
  const { doc, session, errors } = sharedDocument(`---\nkanban-plugin: basic\n---\n\n${lanes}`);
  const started = performance.now();
  await session.handle({ type: 'ready' });
  await session.handle({ type: 'moveLane', version: 1, laneIndex: 499, heading: '## Lane 499', toIndex: 0 });
  await session.handle({ type: 'moveCard', version: 2, laneIndex: 1, cardIndex: 0, firstLine: '- [ ] c0-0', toLaneIndex: 498, toHeading: '## Lane 497', toIndex: 5 });
  await session.handle({ type: 'renameLane', version: 3, laneIndex: 0, heading: '## Lane 499', name: 'Lane 0' });
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);
  assert.deepEqual(errors(), []);
  const names = parseBoard(lineTexts(parseLines(doc.text))).lanes.map((l) => l.name);
  assert.equal(names.length, 500);
  assert.equal(names[0], 'Lane 0', 'a duplicate lane name is allowed (lanes are told apart by position)');
  for (const name of ['## Lane 1', '***', 'Archive', '%% kanban:settings', '   ']) {
    const before = doc.text;
    await session.handle({ type: 'renameLane', version: doc.version, laneIndex: 1, heading: '## Lane 0', name });
    if (doc.text !== before) {
      assert.equal(parseBoard(lineTexts(parseLines(doc.text))).lanes.length, 500, name);
      doc.text = before;
      doc.version++;
    }
  }
});
