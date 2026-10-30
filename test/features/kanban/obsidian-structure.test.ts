// Board structure as Obsidian Kanban 2.0.51 reads it (kanban.md 2.4~2.8). Each board below was
// opened in Obsidian Kanban 2.0.51; the expected lanes (name, done mark), cards (check box
// character, or null without one, and text) and archive are what Obsidian showed. The card text
// is the title plus the body with one indentation step removed, which is the board's edit text
// (card-text.ts). Where Notewell differs on purpose, the case says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { cardEditText } from '../../../src/features/kanban/card-text.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';

interface Lane {
  readonly name: string;
  readonly done?: true;
  /** [check character or null without a check box, card text]. */
  readonly cards: readonly (readonly [string | null, string])[];
}

interface Case {
  readonly title: string;
  /** Lines between the frontmatter and the settings block. */
  readonly lines: readonly string[];
  readonly lanes: readonly Lane[];
  /** Obsidian found archived cards. */
  readonly archive?: true;
}

const FRONTMATTER = ['---', '', 'kanban-plugin: board', '', '---', ''];
const SETTINGS = ['', '', '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%', ''];

const CASES: readonly Case[] = [
  {
    title: 'heading levels 1-6',
    lines: ['# H1', '', '- [ ] a', '', '## H2', '', '- [ ] b', '', '### H3', '', '- [ ] c', '', '#### H4', '', '- [ ] d', '', '##### H5', '', '- [ ] e', '', '###### H6', '', '- [ ] f'],
    lanes: [
      { name: 'H1', cards: [[' ', 'a']] },
      { name: 'H2', cards: [[' ', 'b']] },
      { name: 'H3', cards: [[' ', 'c']] },
      { name: 'H4', cards: [[' ', 'd']] },
      { name: 'H5', cards: [[' ', 'e']] },
      { name: 'H6', cards: [[' ', 'f']] },
    ],
  },
  {
    title: 'setext headings',
    lines: ['Setext one', '==========', '', '- [ ] a', '', 'Setext two', '----------', '', '- [ ] b'],
    lanes: [
      { name: 'Setext one', cards: [[' ', 'a']] },
      { name: 'Setext two', cards: [[' ', 'b']] },
    ],
  },
  {
    title: 'heading with closing hashes and extra spaces',
    lines: ['##   Spaced   ##', '', '- [ ] a'],
    lanes: [
      { name: 'Spaced', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'not headings: #tag, ####### seven, #nospace',
    lines: ['## Lane', '', '#tag line', '####### seven', '#nospace', '- [ ] a'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'list markers and plain items',
    lines: ['## Lane', '', '- plain item', '- [ ] task', '- [x] done', '- [X] big X', '- [-] dash check', '- [/] slash check'],
    lanes: [
      { name: 'Lane', cards: [[null, 'plain item'], [' ', 'task'], ['x', 'done'], ['X', 'big X'], ['-', 'dash check'], ['/', 'slash check']] },
    ],
  },
  {
    title: 'other bullet chars start new lists',
    lines: ['## Lane', '', '- [ ] dash', '* [ ] star', '+ [ ] plus'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'dash']] },
    ],
  },
  {
    title: 'ordered list',
    lines: ['## Lane', '', '1. [ ] one', '2. [ ] two', '3) [ ] paren'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'one'], [' ', 'two']] },
    ],
  },
  {
    title: 'star list only',
    lines: ['## Lane', '', '* [ ] star one', '* star two'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'star one'], [null, 'star two']] },
    ],
  },
  {
    title: 'paragraph between cards (blank separated)',
    lines: ['## Lane', '', '- [ ] a', '', 'A paragraph', '', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'lazy continuation paragraph',
    lines: ['## Lane', '', '- [ ] a', 'lazy line', '- [ ] b', 'lazy two', 'lazy three'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\nlazy line'], [' ', 'b\nlazy two\nlazy three']] },
    ],
  },
  {
    title: 'loose list (blank lines between cards)',
    lines: ['## Lane', '', '- [ ] a', '', '', '- [ ] b', '', '- [ ] c'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a'], [' ', 'b'], [' ', 'c']] },
    ],
  },
  {
    title: 'HTML comment between cards',
    lines: ['## Lane', '', '- [ ] a', '<!-- note -->', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'Obsidian comment between cards',
    lines: ['## Lane', '', '- [ ] a', '%% note %%', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\n%% note %%'], [' ', 'b']] },
    ],
  },
  {
    title: 'body indents: 2 spaces, 1 space, tab, 4 spaces',
    lines: ['## Lane', '', '- [ ] two', '  body2', '- [ ] one', ' body1', '- [ ] tab', '\tbodyT', '- [ ] four', '    body4'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'two\n  body2'], [' ', 'one\n body1'], [' ', 'tab\nbodyT'], [' ', 'four\nbody4']] },
    ],
  },
  {
    title: 'heading with no list, then lane',
    lines: ['## Empty', '', 'just text', '', '## Full', '', '- [ ] a'],
    lanes: [
      { name: 'Empty', cards: [] },
      { name: 'Full', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'content before first heading',
    lines: ['Intro paragraph', '', '- [ ] orphan', '', '## Lane', '', '- [ ] a'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'card directly followed by heading',
    lines: ['## A', '- [ ] a', '## B', '- [ ] b'],
    lanes: [
      { name: 'A', cards: [[' ', 'a']] },
      { name: 'B', cards: [[' ', 'b']] },
    ],
  },
  {
    title: 'heading inside a top-level code fence',
    lines: ['## Lane', '', '- [ ] a', '', '```', '## not a lane', '```', '', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'heading inside card body',
    lines: ['## Lane', '', '- [ ] a', '\t### body heading', '\tbody text', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\n### body heading\nbody text'], [' ', 'b']] },
    ],
  },
  {
    title: 'Complete marker after paragraph',
    lines: ['## Done', '', 'some text', '', '**Complete**', '- [x] a'],
    lanes: [
      { name: 'Done', done: true, cards: [['x', 'a']] },
    ],
  },
  {
    title: 'blockquote between cards',
    lines: ['## Lane', '', '- [ ] a', '> quote', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'indented card 1-3 spaces',
    lines: ['## Lane', '', ' - [ ] one space', '   - [ ] three spaces'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'one space\n   - [ ] three spaces']] },
    ],
  },
  {
    title: 'four-space indented list (code block)',
    lines: ['## Lane', '', '    - [ ] code?'],
    lanes: [
      { name: 'Lane', cards: [] },
    ],
  },
  {
    title: 'archive with ### heading',
    lines: ['## Lane', '', '- [ ] a', '', '***', '', '### Archive', '', '- [x] old'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
    archive: true,
  },
  {
    title: 'nested list in card body',
    lines: ['## Lane', '', '- [ ] parent', '\t- [ ] child', '\t\t- grandchild'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'parent\n- [ ] child\n\t- grandchild']] },
    ],
  },
  {
    title: 'thematic break between lanes',
    lines: ['## A', '', '- [ ] a', '', '---', '', '## B', '', '- [ ] b'],
    lanes: [
      { name: 'A', cards: [[' ', 'a']] },
      { name: 'B', cards: [[' ', 'b']] },
    ],
  },
  {
    title: 'card with blank line then indented continuation',
    lines: ['## Lane', '', '- [ ] a', '', '\tafter blank', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\n\nafter blank'], [' ', 'b']] },
    ],
  },
  {
    title: 'card then blank then unindented text then card',
    lines: ['## Lane', '', '- [ ] a', '', 'loose text', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'x01 one-space sibling marker',
    lines: ['## Lane', '', '- [ ] a', ' - [ ] b', '  - [ ] c'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a'], [' ', 'b'], [' ', 'c']] },
    ],
  },
  {
    title: 'x02 one-space other marker',
    lines: ['## Lane', '', '- [ ] a', ' * [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'x03 one-space heading after card',
    lines: ['## Lane', '', '- [ ] a', ' ## H', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
      { name: 'H', cards: [[' ', 'b']] },
    ],
  },
  {
    title: 'x04 Complete right after card',
    lines: ['## Done', '', '- [x] a', '**Complete**'],
    lanes: [
      { name: 'Done', cards: [['x', 'a\n**Complete**']] },
    ],
  },
  {
    title: 'x05 Complete before list no blank',
    lines: ['## Done', '**Complete**', '- [x] a'],
    lanes: [
      { name: 'Done', done: true, cards: [['x', 'a']] },
    ],
  },
  {
    title: 'x06 ordered 2 after paragraph',
    lines: ['## Lane', '', 'text', '2. [ ] two', '', '## B', '', 'text', '1. [ ] one'],
    lanes: [
      { name: 'Lane', cards: [] },
      { name: 'B', cards: [[' ', 'one']] },
    ],
  },
  // x07 empty bullet items: Obsidian Kanban 2.0.51 fails to open this board (no lanes); not compared.
  {
    title: 'x08 setext dash after card paragraph',
    lines: ['## Lane', '', '- [ ] a', 'lazy', '---', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\nlazy']] },
    ],
  },
  {
    title: 'x09 setext after loose paragraph',
    lines: ['## Lane', '', '- [ ] a', '', 'Para', '---', '', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
      { name: 'Para', cards: [[' ', 'b']] },
    ],
  },
  {
    title: 'x10 multi-line html comment with heading',
    lines: ['## Lane', '', '- [ ] a', '', '<!--', '## hidden', '-->', '', '## Next', '', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
      { name: 'Next', cards: [[' ', 'b']] },
    ],
  },
  {
    title: 'x11 lazy after indented body',
    lines: ['## Lane', '', '- [ ] a', '\tbody', 'lazy', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\nbody\nlazy'], [' ', 'b']] },
    ],
  },
  {
    title: 'x12 lazy after body heading',
    lines: ['## Lane', '', '- [ ] a', '\t### h', 'after', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\n### h']] },
    ],
  },
  {
    title: 'x13 equals line after card',
    lines: ['## Lane', '', '- [ ] a', '===', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a\n==='], [' ', 'b']] },
    ],
  },
  {
    title: 'x14 star thematic in lane',
    lines: ['## Lane', '', '- [ ] a', '* * *', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'x15 checkbox no space and odd chars',
    lines: ['## Lane', '', '- [x]nospace', '-  [ ] two spaces', '- [ab] not box', '- [] empty'],
    lanes: [
      { name: 'Lane', cards: [[null, '[x]nospace'], [' ', 'two spaces'], [null, '[ab] not box'], [null, '[] empty']] },
    ],
  },
  {
    title: 'x16 multi-line setext',
    lines: ['Line one', 'Line two', '===', '', '- [ ] a'],
    lanes: [
      // Obsidian keeps the line break in the name ('Line one\nLine two'); kanban.md 2.4 joins the lines with a space.
      { name: 'Line one Line two', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'x17 archive setext',
    lines: ['## Lane', '', '- [ ] a', '', '___', '', 'Archive', '=======', '', '- [x] old'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
    archive: true,
  },
  {
    title: 'x18 blank then 1-space line',
    lines: ['## Lane', '', '- [ ] a', '', ' one space', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },
  {
    title: 'x19 closing hashes variants',
    lines: ['## A #', '', '- [ ] a', '', '## B#', '', '- [ ] b', '', '##', '', '- [ ] c', '', '## C \\#', '', '- [ ] d'],
    lanes: [
      { name: 'A', cards: [[' ', 'a']] },
      { name: 'B#', cards: [[' ', 'b']] },
      { name: '', cards: [[' ', 'c']] },
      { name: 'C \\#', cards: [[' ', 'd']] },
    ],
  },
  {
    title: 'x20 complete marker lazy-like',
    lines: ['## Done', '', '**Complete**', 'more', '- [x] a'],
    lanes: [
      { name: 'Done', cards: [['x', 'a']] },
    ],
  },
  {
    title: 'y01 bare box',
    lines: ['## Lane', '', '- [ ] a', '- [ ]', '- [ ] c'],
    lanes: [
      // Obsidian shows the bare `- [ ]` as an empty card without a check box (and saves it as
      // `- [ ] `); Notewell reads the box. Unchecked either way (kanban.md 2.5).
      { name: 'Lane', cards: [[' ', 'a'], [' ', ''], [' ', 'c']] },
    ],
  },
  {
    title: 'y02 box trailing space',
    lines: ['## Lane', '', '- [ ] a', '- [x] ', '- [ ] c'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a'], [null, '[x]'], [' ', 'c']] },
    ],
  },
  // y03 dash alone: Obsidian Kanban 2.0.51 fails to open this board (no lanes); not compared.
  // y04 dash space: Obsidian Kanban 2.0.51 fails to open this board (no lanes); not compared.
  {
    title: 'y05 complete in empty lane after paragraph',
    lines: ['## Done', '', 'text', '', '**Complete**', '', '## B', '', '- [ ] b'],
    lanes: [
      { name: 'Done', done: true, cards: [] },
      { name: 'B', cards: [[' ', 'b']] },
    ],
  },
  {
    title: 'y06 tab after box',
    lines: ['## Lane', '', '- [x]\ttab', '- [ ]  two'],
    lanes: [
      { name: 'Lane', cards: [['x', 'tab'], [' ', 'two']] },
    ],
  },
  {
    title: 'y07 complete with trailing spaces and indent',
    lines: ['## Done', '', '  **Complete**  ', '- [x] a'],
    lanes: [
      { name: 'Done', done: true, cards: [['x', 'a']] },
    ],
  },
  {
    title: 'y08 html div block',
    lines: ['## Lane', '', '- [ ] a', '', '<div>', '## inside', '</div>', '', '- [ ] b'],
    lanes: [
      { name: 'Lane', cards: [[' ', 'a']] },
    ],
  },

];

for (const c of CASES) {
  test(`Obsidian structure: ${c.title}`, () => {
    const texts = lineTexts(parseLines([...FRONTMATTER, ...c.lines, ...SETTINGS].join('\n')));
    const board = parseBoard(texts);
    const lanes = board.lanes.map((lane) => ({
      name: lane.name,
      ...(lane.done ? { done: true } : {}),
      // Obsidian trims the card text; the edit text keeps trailing spaces as written.
      cards: lane.cards.map((card) => [card.check, cardEditText(texts, card).trimEnd()]),
    }));
    assert.deepEqual(lanes, c.lanes);
    for (const lane of board.lanes) {
      for (const card of lane.cards) assert.equal(card.checked, card.check !== null && card.check !== ' ');
    }
    assert.equal(board.archive !== null, c.archive === true);
  });
}
