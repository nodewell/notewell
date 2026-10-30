// Markdown parsing (src/webview/markdown.ts): recognised blocks and inline syntax,
// everything else literal, and no content character ever dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, type Block, type Inline } from '../../src/webview/markdown.ts';
import { assertKeepsContent, blockText, inlineText } from '../support/markdown.ts';

test('headings, rules and paragraphs keep their source line breaks', () => {
  assert.deepEqual(parseMarkdown('# One\n###### Six ##\n####### seven\n#tag\n\n---\nline 1\nline 2'), [
    { kind: 'heading', level: 1, content: [{ kind: 'text', text: 'One' }] },
    { kind: 'heading', level: 6, content: [{ kind: 'text', text: 'Six' }] },
    {
      kind: 'paragraph',
      content: [{ kind: 'text', text: '####### seven' }, { kind: 'break' }, { kind: 'text', text: '#tag' }],
    },
    { kind: 'rule' },
    { kind: 'paragraph', content: [{ kind: 'text', text: 'line 1' }, { kind: 'break' }, { kind: 'text', text: 'line 2' }] },
  ]);
  assert.deepEqual(parseMarkdown('a\r\n***\r\nb'), [
    { kind: 'paragraph', content: [{ kind: 'text', text: 'a' }] },
    { kind: 'rule' },
    { kind: 'paragraph', content: [{ kind: 'text', text: 'b' }] },
  ]);
});

test('lists nest by indentation and carry task boxes and numbers', () => {
  const [list, ordered] = parseMarkdown('- a\n- [x] done\n  - [ ] open\n    deeper text\n- b\n\n3. three\n4. four');
  assert.equal(list.kind, 'list');
  if (list.kind !== 'list') return;
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items.map((i) => [i.checked, inlineText(i.content)]), [[null, 'a'], [true, 'done'], [null, 'b']]);
  const nested = list.items[1].blocks[0];
  assert.equal(nested.kind, 'list');
  if (nested.kind !== 'list') return;
  assert.equal(nested.items[0].checked, false);
  assert.equal(inlineText(nested.items[0].content), 'open\ndeeper text');
  assert.deepEqual(ordered, {
    kind: 'list',
    ordered: true,
    start: 3,
    items: [
      { number: 3, checked: null, content: [{ kind: 'text', text: 'three' }], blocks: [] },
      { number: 4, checked: null, content: [{ kind: 'text', text: 'four' }], blocks: [] },
    ],
  });
});

test('a list item can hold a fence and blank-separated paragraphs', () => {
  const [list] = parseMarkdown('1. step\n   ```sh\n   run it\n\n   again\n   ```\n\n   after\n2. next');
  assert.equal(list.kind, 'list');
  if (list.kind !== 'list') return;
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0].blocks, [
    { kind: 'code', lang: 'sh', info: 'sh', text: 'run it\n\nagain' },
    { kind: 'paragraph', content: [{ kind: 'text', text: 'after' }] },
  ]);
});

test('bullet and ordered runs are separate lists; "2026." inside a paragraph is text', () => {
  assert.deepEqual(parseMarkdown('- a\n1. b').map((b) => b.kind === 'list' && b.ordered), [false, true]);
  assert.deepEqual(parseMarkdown('In\n2026. was a year'), [
    { kind: 'paragraph', content: [{ kind: 'text', text: 'In' }, { kind: 'break' }, { kind: 'text', text: '2026. was a year' }] },
  ]);
});

test('quotes parse their inside, with lazy continuation', () => {
  assert.deepEqual(parseMarkdown('> # T\n> - x\n\n> p\nlazy'), [
    {
      kind: 'quote',
      blocks: [
        { kind: 'heading', level: 1, content: [{ kind: 'text', text: 'T' }] },
        { kind: 'list', ordered: false, start: 1, items: [{ number: null, checked: null, content: [{ kind: 'text', text: 'x' }], blocks: [] }] },
      ],
    },
    { kind: 'quote', blocks: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'p' }, { kind: 'break' }, { kind: 'text', text: 'lazy' }] }] },
  ]);
});

test('fences: both markers, language name only, unclosed runs to the end, mermaid stays code', () => {
  assert.deepEqual(parseMarkdown('~~~mermaid\ngraph TD\n# not a heading\n~~~\n```\n<!-- SECTION:DESCRIPTION:END -->'), [
    { kind: 'code', lang: 'mermaid', info: 'mermaid', text: 'graph TD\n# not a heading' },
    { kind: 'code', lang: '', info: '', text: '<!-- SECTION:DESCRIPTION:END -->' },
  ]);
  assert.deepEqual(parseMarkdown('  ```ts title="a b"\n  const x = 1;\n    indented\n  ```'), [
    { kind: 'code', lang: 'ts', info: 'ts title="a b"', text: 'const x = 1;\n  indented' },
  ]);
});

const t = (text: string): Inline[] => (text === '' ? [] : [{ kind: 'text', text }]);

test('tables: header, delimiter with alignment, body rows with inline markdown', () => {
  assert.deepEqual(parseMarkdown('| a | **b** | c | d |\n|---|:--|:-:|--:|\n| <i>1</i> | `x` | [l](https://e.test) | 4 |\nafter'), [
    {
      kind: 'table',
      align: [null, 'left', 'center', 'right'],
      header: [t('a'), [{ kind: 'strong', children: t('b') }], t('c'), t('d')],
      rows: [[t('<i>1</i>'), [{ kind: 'code', text: 'x' }], [{ kind: 'link', url: 'https://e.test', title: null, children: t('l') }], t('4')]],
    },
    { kind: 'paragraph', content: t('after') },
  ]);
});

test('tables: outer pipes optional, escaped pipes, ragged rows padded or cut', () => {
  assert.deepEqual(parseMarkdown('a | b\n--- | ---\n1 \\| 2 | `x\\|y`\nonly |\n1 | 2 | 3'), [
    {
      kind: 'table',
      align: [null, null],
      header: [t('a'), t('b')],
      rows: [
        [t('1 | 2'), [{ kind: 'code', text: 'x|y' }]],
        [t('only'), t('')],
        [t('1'), t('2')],
      ],
    },
  ]);
  // A table may follow paragraph text directly; the paragraph ends before the header row.
  const [para, table] = parseMarkdown('Intro line\n| h |\n| - |\n| v |');
  assert.deepEqual(para, { kind: 'paragraph', content: t('Intro line') });
  assert.equal(table!.kind, 'table');
  // Inside a list item and a quote.
  assert.equal((parseMarkdown('- item\n\n  | h |\n  |---|\n  | v |')[0] as Extract<Block, { kind: 'list' }>).items[0]!.blocks[0]!.kind, 'table');
  assert.equal((parseMarkdown('> | h |\n> |---|\n> | v |')[0] as Extract<Block, { kind: 'quote' }>).blocks[0]!.kind, 'table');
});

test('tables with extraCells keep cells beyond the header after the last cell; the default still cuts', () => {
  const source = '| a | b |\n|---|--:|\n| 1 | 2 | @{2026-03-04}\n| only |\n| x | y | z | w |';
  assert.deepEqual(parseMarkdown(source, { extraCells: true }), [
    {
      kind: 'table',
      align: [null, 'right'],
      header: [t('a'), t('b')],
      rows: [
        [t('1'), t('2'), t('@{2026-03-04}')],
        [t('only'), t('')],
        [t('x'), t('y'), t('z'), t('w')],
      ],
    },
  ]);
  const [plain] = parseMarkdown(source);
  assert.ok(plain!.kind === 'table' && plain.rows.every((row) => row.length === 2));
  // Inside a list item too.
  const [list] = parseMarkdown('- item\n\n  | h |\n  |---|\n  | v | more |', { extraCells: true });
  const table = (list as Extract<Block, { kind: 'list' }>).items[0]!.blocks[0]!;
  assert.ok(table.kind === 'table' && table.rows[0]!.length === 2);
});

test('highlight option: ==text== pairs only with ==, may hold emphasis; wikilinks stay whole', () => {
  assert.deepEqual(parseInline('a ==**b** c== d', true), [
    { kind: 'text', text: 'a ' },
    { kind: 'highlight', children: [{ kind: 'strong', children: [{ kind: 'text', text: 'b' }] }, { kind: 'text', text: ' c' }] },
    { kind: 'text', text: ' d' },
  ]);
  // Without the option `==` is text, as before.
  assert.deepEqual(parseInline('a ==b== c'), [{ kind: 'text', text: 'a ==b== c' }]);
  // A single `=`, `===` and an unpaired `==` stay text.
  assert.deepEqual(parseInline('x = y === z ==w', true), [{ kind: 'text', text: 'x = y === z ==w' }]);
  // Markers inside a wikilink do not pair with ones outside, and the link text stays one run.
  assert.deepEqual(parseInline('==[[a==b]] c==', true), [
    { kind: 'highlight', children: [{ kind: 'text', text: '[[a==b]] c' }] },
  ]);
  assert.deepEqual(parseInline('*see [[my*note]]', true), [{ kind: 'text', text: '*see [[my*note]]' }]);
  // Through parseMarkdown: headings, paragraphs, list items and table cells.
  const blocks = parseMarkdown('# ==h==\n\n==p==\n\n- ==i==\n\n| ==c== |\n|---|\n| ==d== | ==e== |', { highlight: true, extraCells: true });
  const kinds = JSON.stringify(blocks).match(/"highlight"/g)?.length;
  assert.equal(kinds, 6);
});

test('tables end at a blank line, another block or a line without a pipe', () => {
  const blocks = parseMarkdown('| h |\n|---|\n| 1 |\n\n| h |\n|---|\n| 1 |\n# Head\n| h |\n|---|\nno pipe here');
  assert.deepEqual(blocks.map((b) => b.kind), ['table', 'table', 'heading', 'table', 'paragraph']);
  assert.deepEqual((blocks[3] as Extract<Block, { kind: 'table' }>).rows, []);
});

test('not a table: no delimiter row, mismatched cell count, bad delimiter, fenced code', () => {
  assert.deepEqual(parseMarkdown('| a | b |\n| 1 | 2 |'), [{ kind: 'paragraph', content: [...t('| a | b |'), { kind: 'break' }, ...t('| 1 | 2 |')] }]);
  assert.equal(parseMarkdown('| a | b |\n|---|\n| 1 | 2 |')[0]!.kind, 'paragraph');
  assert.equal(parseMarkdown('| a | b |\n|---|-x-|')[0]!.kind, 'paragraph');
  assert.deepEqual(parseMarkdown('a\n---').map((b) => b.kind), ['paragraph', 'rule'], 'a rule without pipes is not a delimiter row');
  assert.equal(parseMarkdown('| a |\n|---|')[0]!.kind, 'table');
  assert.equal(parseMarkdown('    | a |\n    |---|')[0]!.kind, 'paragraph', 'indented 4+ is not a table');
  assert.deepEqual(parseMarkdown('```\n| a | b |\n|---|---|\n```'), [{ kind: 'code', lang: '', info: '', text: '| a | b |\n|---|---|' }]);
  // A list item line is a list, even when a delimiter row follows.
  assert.equal(parseMarkdown('- a | b\n--- | ---')[0]!.kind, 'list');
});

test('inline: emphasis, strike, code spans and escapes', () => {
  assert.deepEqual(parseInline('**b** __b__ *i* _i_ ~~s~~'), [
    { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
    { kind: 'text', text: ' ' },
    { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
    { kind: 'text', text: ' ' },
    { kind: 'em', children: [{ kind: 'text', text: 'i' }] },
    { kind: 'text', text: ' ' },
    { kind: 'em', children: [{ kind: 'text', text: 'i' }] },
    { kind: 'text', text: ' ' },
    { kind: 'strike', children: [{ kind: 'text', text: 's' }] },
  ]);
  assert.deepEqual(parseInline('***x***'), [{ kind: 'em', children: [{ kind: 'strong', children: [{ kind: 'text', text: 'x' }] }] }]);
  assert.deepEqual(parseInline('snake_case_name and 2*3*4 and ~one~ and ~~~three~~~'), [
    { kind: 'text', text: 'snake_case_name and 2' },
    { kind: 'em', children: [{ kind: 'text', text: '3' }] },
    { kind: 'text', text: '4 and ~one~ and ~~~three~~~' },
  ]);
  assert.deepEqual(parseInline('**한국어**다 *a **b** c*'), [
    { kind: 'strong', children: [{ kind: 'text', text: '한국어' }] },
    { kind: 'text', text: '다 ' },
    { kind: 'em', children: [{ kind: 'text', text: 'a ' }, { kind: 'strong', children: [{ kind: 'text', text: 'b' }] }, { kind: 'text', text: ' c' }] },
  ]);
  const bs = String.fromCharCode(92);
  assert.deepEqual(parseInline(`${bs}*not${bs}* ${bs}a ${'`'}${bs}*${'`'}`), [
    { kind: 'text', text: `*not* ${bs}a ` },
    { kind: 'code', text: `${bs}*` },
  ]);
  assert.deepEqual(parseInline('`` a ` b `` and ```unclosed'), [
    { kind: 'code', text: 'a ` b' },
    { kind: 'text', text: ' and ```unclosed' },
  ]);
  assert.deepEqual(parseInline('**unclosed and *also'), [{ kind: 'text', text: '**unclosed and *also' }]);
});

test('inline: links, autolinks and images', () => {
  assert.deepEqual(parseInline('[a *b*](https://x.test/p_(1) "T") <https://y.test/q?a=1> ![pic](img.png) [x](<a b>)'), [
    { kind: 'link', url: 'https://x.test/p_(1)', title: 'T', children: [{ kind: 'text', text: 'a ' }, { kind: 'em', children: [{ kind: 'text', text: 'b' }] }] },
    { kind: 'text', text: ' ' },
    { kind: 'link', url: 'https://y.test/q?a=1', title: null, children: [{ kind: 'text', text: 'https://y.test/q?a=1' }] },
    { kind: 'text', text: ' ' },
    { kind: 'image', src: 'img.png', alt: 'pic' },
    { kind: 'text', text: ' ' },
    { kind: 'link', url: 'a b', title: null, children: [{ kind: 'text', text: 'x' }] },
  ]);
  assert.deepEqual(parseInline('[ref][1] [no url] [open(x'), [{ kind: 'text', text: '[ref][1] [no url] [open(x' }]);
  assert.deepEqual(parseInline('[[nested](u)](v)')[0], {
    kind: 'link',
    url: 'v',
    title: null,
    children: [{ kind: 'text', text: '[nested](u)' }],
  });
});

test('HTML-like text and comments stay literal', () => {
  const source = '<b>x</b> <script>alert(1)</script> <img src=x onerror=alert(1)> <!-- SECTION:NOTES:END --> & &amp; " \'';
  assert.deepEqual(parseMarkdown(source), [{ kind: 'paragraph', content: [{ kind: 'text', text: source }] }]);
  assert.deepEqual(parseMarkdown('<!--\ncomment\n-->'), [
    { kind: 'paragraph', content: [{ kind: 'text', text: '<!--' }, { kind: 'break' }, { kind: 'text', text: 'comment' }, { kind: 'break' }, { kind: 'text', text: '-->' }] },
  ]);
});

test('long lines and deep nesting neither throw nor lose text', () => {
  const long = 'x'.repeat(20000);
  assert.deepEqual(parseMarkdown(long), [{ kind: 'paragraph', content: [{ kind: 'text', text: long }] }]);
  for (const source of ['>'.repeat(5000) + ' deep', '- '.repeat(3000) + 'deep', '*'.repeat(5000) + 'a' + '_'.repeat(5000), '[('.repeat(3000) + 'z', '[a]('.repeat(5000) + 'z', '`'.repeat(3001) + 'q']) {
    assertKeepsContent(source, blockText(parseMarkdown(source)));
  }
});

test('random input never throws and keeps every letter and digit', () => {
  let seed = 42;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pieces = ['*', '**', '_', '__', '~~', '~', '`', '```', '~~~', '\n', '\n\n', ' ', '  ', '\t', '#', '# ', '> ', '- ', '1. ', '[ ] ', '[x] ',
    '[', ']', '(', ')', '![', '<', '>', '<b>', '<!--', '-->', '|', '---', String.fromCharCode(92), 'http://a.b', 'a', 'Bc', '9', '한', '🚀', '"', "'", '&'];
  for (let n = 0; n < 2000; n++) {
    let source = '';
    const len = 1 + Math.floor(random() * 40);
    for (let k = 0; k < len; k++) source += pieces[Math.floor(random() * pieces.length)];
    let blocks: Block[] = [];
    assert.doesNotThrow(() => {
      blocks = parseMarkdown(source);
    }, JSON.stringify(source));
    assertKeepsContent(source, blockText(blocks));
    // The kanban options (extra table cells, ==highlight==, whole wikilinks) keep content too.
    const kanban = `${source.replace(/~/g, '=')} [[x${source.slice(0, 5)}]]`;
    let options: Block[] = [];
    assert.doesNotThrow(() => {
      options = parseMarkdown(kanban, { extraCells: true, highlight: true });
    }, JSON.stringify(kanban));
    assertKeepsContent(kanban, blockText(options));
  }
});
