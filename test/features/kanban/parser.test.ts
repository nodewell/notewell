import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { BOM, joinLines, lineTexts, parseLines } from '../../../src/core/lines.ts';
import {
  boardSegments,
  cardIdentity,
  cardTitle,
  findCardByIdentity,
  type KanbanBoard,
} from '../../../src/features/kanban/model.ts';
import { parseBoard, type ParseOptions } from '../../../src/features/kanban/parser.ts';

const FIXTURES = new URL('../../fixtures/kanban/', import.meta.url);
const fixtureNames = readdirSync(FIXTURES).filter((name) => /^\d\d-.*\.md$/.test(name));

function load(name: string) {
  const source = readFileSync(new URL(name, FIXTURES), 'utf8');
  const doc = parseLines(source);
  return { source, doc, texts: lineTexts(doc) };
}

function parseFixture(name: string, options?: ParseOptions) {
  const prefix = name.slice(0, 2);
  const file = fixtureNames.find((n) => n.startsWith(prefix));
  assert.ok(file, `fixture ${name}`);
  const { texts } = load(file);
  return { texts, board: parseBoard(Object.freeze([...texts]), options) };
}

const parse = (lines: string[], options?: ParseOptions) => parseBoard(lines, options);

/** Compact view: lanes as [name, start, end, done, cards], cards as "start-end" + check suffix (`~`: no check box). */
function shape(board: KanbanBoard) {
  return {
    isBoard: board.isBoard,
    lineCount: board.lineCount,
    frontmatter: board.frontmatter && [board.frontmatter.start, board.frontmatter.end],
    preamble: [board.preamble.start, board.preamble.end],
    lanes: board.lanes.map((lane) => [
      lane.name,
      lane.range.start,
      lane.range.end,
      lane.done,
      lane.cards.map((c) => `${c.range.start}-${c.range.end}${c.check === ' ' ? '' : (c.check ?? '~')}`),
    ]),
    archive: board.archive && [board.archive.start, board.archive.end],
    settings: board.settingsBlock && [board.settingsBlock.range.start, board.settingsBlock.range.end, board.settingsBlock.valid],
    tail: [board.tail.start, board.tail.end],
  };
}

const EXPECTED: Record<string, ReturnType<typeof shape>> = {
  '01': {
    isBoard: true, lineCount: 43, frontmatter: [0, 5], preamble: [5, 6],
    lanes: [
      ['백로그', 6, 10, false, []],
      ['집중', 10, 19, false, ['12-15', '15-17']],
      ['진행중', 19, 24, false, ['21-22']],
      ['완료', 24, 31, false, ['26-27x', '27-29x']],
      ['취소', 31, 38, false, ['33-34']],
    ],
    archive: null, settings: [38, 43, true], tail: [43, 43],
  },
  '02': {
    isBoard: true, lineCount: 24, frontmatter: [0, 5], preamble: [5, 6],
    lanes: [['백로그', 6, 10, false, []], ['상시진행', 10, 14, false, []], ['완료', 14, 19, false, []]],
    archive: null, settings: [19, 24, true], tail: [24, 24],
  },
  '03': {
    isBoard: true, lineCount: 14, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['백로그', 4, 12, false, ['6-7', '7-8', '8-9', '9-10', '10-11']], ['완료', 12, 14, false, []]],
    archive: null, settings: null, tail: [14, 14],
  },
  '04': {
    isBoard: true, lineCount: 14, frontmatter: [0, 3], preamble: [3, 3],
    lanes: [['할 일', 3, 6, false, ['4-5', '5-6']], ['진행', 6, 8, false, ['7-8']], ['끝', 8, 11, true, ['10-11x']]],
    archive: null, settings: [11, 14, true], tail: [14, 14],
  },
  '05': {
    isBoard: true, lineCount: 28, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [
      ['앞쪽 표시', 4, 10, true, ['7-8x', '8-9']],
      // A `**Complete**` line right after a card is its lazy continuation, not a done mark (2.5, 2.7).
      ['중간 표시', 10, 16, false, ['12-14', '14-15']],
      ['끝 표시', 16, 21, false, ['18-20']],
      ['일반 열', 21, 25, false, ['23-24']],
    ],
    archive: null, settings: [25, 28, true], tail: [28, 28],
  },
  '06': {
    isBoard: true, lineCount: 23, frontmatter: [0, 3], preamble: [3, 4],
    // The HTML comment ends the first list; `### 소제목` is a lane (2.4, 2.5).
    lanes: [['할 일', 4, 17, false, ['6-7', '8-9']], ['소제목', 17, 20, false, ['18-19']], ['다음', 20, 23, false, ['22-23']]],
    archive: null, settings: null, tail: [23, 23],
  },
  '07': {
    isBoard: false, lineCount: 8, frontmatter: null, preamble: [0, 0],
    lanes: [['할 일', 0, 5, false, ['2-3', '3-4']], ['끝', 5, 8, false, ['7-8x']]],
    archive: null, settings: null, tail: [8, 8],
  },
  '08': {
    isBoard: true, lineCount: 11, frontmatter: [0, 3], preamble: [3, 6],
    lanes: [['큰 제목도 열', 6, 8, false, []], ['첫 열', 8, 11, false, ['10-11']]],
    archive: null, settings: null, tail: [11, 11],
  },
  '09': {
    isBoard: true, lineCount: 9, frontmatter: [0, 5], preamble: [5, 6],
    lanes: [['할 일', 6, 9, false, ['8-9']]],
    archive: null, settings: null, tail: [9, 9],
  },
  '10': {
    isBoard: false, lineCount: 6, frontmatter: null, preamble: [0, 3],
    lanes: [['할 일', 3, 6, false, ['5-6']]],
    archive: null, settings: null, tail: [6, 6],
  },
  '11': {
    isBoard: true, lineCount: 15, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['같은 이름', 4, 8, false, ['6-7']], ['같은 이름', 8, 12, false, ['10-11']], ['다른 이름', 12, 15, false, ['14-15']]],
    archive: null, settings: null, tail: [15, 15],
  },
  '12': {
    isBoard: true, lineCount: 20, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 19, false, ['6-10', '10-13', '13-17x', '17-18']], ['끝', 19, 20, false, []]],
    archive: null, settings: null, tail: [20, 20],
  },
  '13': {
    isBoard: true, lineCount: 25, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 20, false, ['6-14', '14-18', '18-19']], ['끝', 20, 25, false, ['22-25']]],
    archive: null, settings: null, tail: [25, 25],
  },
  '14': {
    isBoard: true, lineCount: 24, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 8, false, ['6-7']], ['끝', 8, 14, true, ['12-13x']]],
    archive: [14, 21], settings: [21, 24, true], tail: [24, 24],
  },
  '15': {
    isBoard: true, lineCount: 17, frontmatter: [0, 5], preamble: [5, 6],
    lanes: [['할 일', 6, 10, false, ['8-9']]],
    archive: null, settings: [10, 17, true], tail: [17, 17],
  },
  '16': {
    isBoard: true, lineCount: 13, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 8, false, ['6-7']]],
    archive: null, settings: [8, 13, false], tail: [13, 13],
  },
  '17': {
    isBoard: true, lineCount: 11, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 8, false, ['6-7']], ['끝', 8, 11, false, ['10-11x']]],
    archive: null, settings: null, tail: [11, 11],
  },
  '18': {
    isBoard: true, lineCount: 16, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 16, false, ['6-7', '7-8', '8-9', '9-10', '10-11', '11-12', '12-13', '13-14', '14-15', '15-16']]],
    archive: null, settings: null, tail: [16, 16],
  },
  '19': {
    isBoard: true, lineCount: 12, frontmatter: [0, 3], preamble: [3, 4],
    // `- [x]공백` has no check box (no space after it); lane names are trimmed at both ends (2.4, 2.5).
    lanes: [['이모지 📅 열', 4, 11, false, ['6-7', '7-8', '8-9X', '9-10~']], ['탭 섞인 열 이름', 11, 12, false, []]],
    archive: null, settings: null, tail: [12, 12],
  },
  '20': {
    isBoard: true, lineCount: 12, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 12, false, ['6-7~']]],
    archive: null, settings: null, tail: [12, 12],
  },
  '21': {
    isBoard: true, lineCount: 17, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 10, false, ['6-8', '8-9']], ['끝', 10, 14, false, ['12-13x']]],
    archive: null, settings: [14, 17, true], tail: [17, 17],
  },
  '22': {
    isBoard: true, lineCount: 7, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 7, false, ['6-7']]],
    archive: null, settings: null, tail: [7, 7],
  },
  '23': {
    isBoard: true, lineCount: 7, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 7, false, ['6-7']]],
    archive: null, settings: null, tail: [7, 7],
  },
  '24': {
    isBoard: true, lineCount: 7, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [['할 일', 4, 7, false, ['5-6', '6-7']]],
    archive: null, settings: null, tail: [7, 7],
  },
  '25': {
    isBoard: true, lineCount: 30, frontmatter: [0, 5], preamble: [5, 6],
    lanes: [
      ['TODO', 6, 19, false, ['8-15', '15-17']],
      ['완료', 19, 25, false, []],
    ],
    archive: null, settings: [25, 30, true], tail: [30, 30],
  },
  '26': {
    isBoard: true, lineCount: 47, frontmatter: [0, 4], preamble: [4, 7],
    lanes: [
      // The paragraph after the second card ends the first list (2.5).
      ['할 일', 7, 21, false, ['9-14', '14-15']],
      ['진행', 21, 30, false, ['23-29']],
      ['끝', 30, 36, true, ['33-35x']],
    ],
    archive: [36, 42], settings: [42, 47, true], tail: [47, 47],
  },
  '27': {
    isBoard: true, lineCount: 38, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [
      // `* [ ]` starts another list: the first list ends (2.5).
      ['Lane A', 4, 19, false, ['6-10']],
      ['Lane B', 19, 23, false, ['21-22']],
    ],
    archive: [23, 33], settings: [33, 38, true], tail: [38, 38],
  },
  '28': {
    isBoard: true, lineCount: 26, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [
      ['Todo', 4, 15, false, ['6-7', '7-9/', '9-10X', '10-11-', '11-12>', '12-14']],
      ['Done', 15, 21, true, ['18-19x', '19-20!']],
    ],
    archive: null, settings: [21, 26, true], tail: [26, 26],
  },
  '29': {
    isBoard: true, lineCount: 37, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [
      ['할 일', 4, 30, false, ['6-11', '11-15', '15-20', '20-29']],
      ['끝', 30, 37, false, ['32-36']],
    ],
    archive: null, settings: null, tail: [37, 37],
  },
  '30': {
    isBoard: true, lineCount: 41, frontmatter: [0, 3], preamble: [3, 6],
    lanes: [
      ['Inbox', 6, 11, false, ['8-9', '9-10']],
      ['Small heading lane', 11, 16, false, ['13-15']],
      ['Setext lane', 16, 21, false, ['19-20']],
      ['Second setext lane', 21, 30, true, ['25-26x']],
      ['Lane after text', 30, 36, false, ['32-33']],
    ],
    archive: null, settings: [36, 41, true], tail: [41, 41],
  },
  '31': {
    isBoard: true, lineCount: 46, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [
      ['Star list', 4, 11, false, ['6-7', '7-9~', '9-10/']],
      ['Plus list', 11, 17, false, ['13-15', '15-16x']],
      ['Ordered', 17, 24, false, ['19-20', '20-22']],
      ['Paren list', 24, 29, false, ['26-27', '27-28~']],
      ['Plain items', 29, 36, false, ['31-32~', '32-34~', '34-35-']],
      ['Empty lane', 36, 40, false, []],
      ['Done', 40, 46, true, ['44-45x', '45-46~']],
    ],
    archive: null, settings: null, tail: [46, 46],
  },
  '32': {
    isBoard: true, lineCount: 44, frontmatter: [0, 3], preamble: [3, 4],
    lanes: [
      ['Lazy lines', 4, 18, false, ['6-9', '9-12', '12-13']],
      ['After a comment', 18, 25, false, ['20-21', '21-22']],
      ['Quote', 25, 32, false, ['27-28', '28-29']],
      ['Multi-line comment', 32, 41, false, ['34-35', '35-36']],
      ['Last', 41, 44, false, ['43-44']],
    ],
    archive: null, settings: null, tail: [44, 44],
  },
};

test('every fixture has an expected shape', () => {
  assert.deepEqual(fixtureNames.map((n) => n.slice(0, 2)).sort(), Object.keys(EXPECTED).sort());
});

for (const name of fixtureNames) {
  test(`fixture ${name}: structure`, () => {
    assert.deepEqual(shape(parseFixture(name).board), EXPECTED[name.slice(0, 2)]);
  });

  test(`fixture ${name}: segments tile the file, cards are ordered and inside their lane`, () => {
    const { texts, board } = parseFixture(name);
    let next = 0;
    for (const { range } of boardSegments(board)) {
      assert.equal(range.start, next, 'no gap or overlap');
      next = range.end;
    }
    assert.equal(next, texts.length, 'covers every line');
    for (const lane of board.lanes) {
      assert.equal(lane.headingLine, lane.range.start);
      let after = lane.range.start + 1;
      lane.cards.forEach((card, i) => {
        assert.equal(card.index, i);
        assert.equal(card.laneIndex, lane.index);
        assert.ok(card.range.start >= after && card.range.end <= lane.range.end);
        assert.deepEqual(card.body, { start: card.range.start + 1, end: card.range.end });
        if (card.checkOffset !== null) assert.equal(texts[card.range.start]![card.checkOffset], card.check);
        else assert.equal(card.check, null);
        after = card.range.end;
      });
    }
  });

  test(`fixture ${name}: parsing is a no-op round trip`, () => {
    const { source, doc, texts } = load(name);
    const before = [...texts];
    parseBoard(texts);
    assert.deepEqual(texts, before, 'input not mutated');
    assert.equal((doc.bom ? BOM : '') + doc.lines.map((l) => l.text + l.eol).join(''), source);
    assert.equal(joinLines(doc), source);
  });
}

test('2.2: board detection by kanban-plugin key only', () => {
  assert.equal(parse(['---', 'kanban-plugin: whatever', '---']).isBoard, true);
  assert.equal(parse(['---', 'title: x', '---', '## A']).isBoard, false);
  assert.equal(parse(['## A']).isBoard, false);
  assert.equal(parse([]).lanes.length, 0);
});

test('2.4: top-level ATX headings of any level are lanes; names are trimmed, closing #s dropped', () => {
  const lines = ['intro', '#tag', '##NoSpace', '####### seven', '# H1', '##\tTab', '### H3 ###', '   #### H4', '##   Spaced  ', '## \tTabbed\t', '##  ', '## B#', '## C \\#', '    ## code'];
  const board = parse(lines);
  assert.deepEqual(board.lanes.map((l) => l.name), ['H1', 'Tab', 'H3', 'H4', 'Spaced', 'Tabbed', '', 'B#', 'C \\#']);
  assert.deepEqual(board.lanes.map((l) => [l.headingLine, l.heading.end, l.headingKind]).slice(0, 2), [[4, 5, 'atx'], [5, 6, 'atx']]);
  assert.deepEqual(board.preamble, { start: 0, end: 4 });
  assert.equal(board.lanes.at(-1)!.range.end, lines.length, 'indented code is not a heading');
});

test('2.4: setext headings: the paragraph lines and the underline', () => {
  const board = parse(['Todo', '====', '- [ ] a', '', 'Two', 'lines', '---', '- [ ] b', '', '---', '', 'not', '- [ ] c', '---']);
  assert.deepEqual(board.lanes.map((l) => [l.name, l.headingLine, l.heading.end, l.headingKind]), [
    ['Todo', 0, 2, 'setext'],
    ['Two lines', 4, 7, 'setext'],
  ]);
  // `---` after a blank line is a thematic break; after a card it ends the list.
  assert.deepEqual(board.lanes[1]!.cards.map((c) => c.range.start), [7]);
});

test('2.4: headings inside card bodies, fences and HTML blocks are not lanes', () => {
  const board = parse(['## A', '- [ ] a', '\t## body', '', '<!--', '## hidden', '-->', '', '<div>', '## inside', '</div>', '', ' ## lane']);
  assert.deepEqual(board.lanes.map((l) => l.name), ['A', 'lane']);
});

test('2.8: archive needs *** then (after blanks) ## Archive; it is not a lane', () => {
  const lines = ['## A', '- [ ] a', '***', '', '', '## Archive', '- [x] old', '%% kanban:settings', '{}', '%%'];
  const board = parse(lines);
  assert.deepEqual(board.lanes.map((l) => l.name), ['A']);
  assert.deepEqual(board.archive, { start: 2, end: 7 });
  assert.equal(parse(['## A', '***', 'text', '## Archive']).archive, null, 'other line in between');
  assert.equal(parse(['## A', '***', '## Other']).archive, null);
  assert.deepEqual(parse(['## A', '***', '## B']).lanes.length, 2, 'plain *** stays inside a lane');
  // Any thematic break and any heading level or a setext heading (Obsidian Kanban 2.0.51).
  assert.deepEqual(parse(['## A', '- [ ] a', '', '---', '', '### Archive', '- [x] old']).archive, { start: 3, end: 7 });
  assert.deepEqual(parse(['## A', '', '___', '', 'Archive', '=======', '- [x] old']).archive, { start: 2, end: 7 });
  assert.equal(parse(['## A', '', 'text', '---', '## Archive']).archive, null, 'setext underline, not a break');
});

test('2.11: column-0 fences hide ##, cards, *** and settings markers', () => {
  const board = parse([
    '## A',
    '```',
    '## not a lane',
    '- [ ] not a card',
    '***',
    '## Archive',
    '%% kanban:settings',
    '{"date-format":"X"}',
    '%%',
    '```',
    '- [ ] real',
  ]);
  assert.deepEqual(shape(board).lanes, [['A', 0, 11, false, ['10-11']]]);
  assert.equal(board.archive, null);
  assert.equal(board.settingsBlock, null);
  assert.equal(board.settings.dateFormat, 'YYYY-MM-DD');
});

test('2.11: an unclosed fence ends before the settings block', () => {
  const board = parse(['## A', '```', '## hidden', '%% kanban:settings', '{"date-format":"D"}', '%%', '']);
  assert.deepEqual(board.lanes.map((l) => l.range), [{ start: 0, end: 3 }]);
  assert.deepEqual(board.settingsBlock, { range: { start: 3, end: 6 }, valid: true });
  assert.deepEqual(board.tail, { start: 6, end: 7 });
  assert.equal(board.settings.dateFormat, 'D');
});

test('2.9: the last settings block wins; a block without closing %% is not one', () => {
  const board = parse(['## A', '%% kanban:settings', '{"date-format":"1"}', '%%', '%% kanban:settings', '{"date-format":"2"}', '%%']);
  assert.deepEqual(board.settingsBlock?.range, { start: 4, end: 7 });
  assert.equal(board.settings.dateFormat, '2');
  assert.equal(parse(['## A', '%% kanban:settings', '{}']).settingsBlock, null);
});

test('2.5: card first lines', () => {
  const texts = ['## A', '- [ ] a', '- [x] b', '- [X] c', '- [x]d', '- [ ]', '- [y] yes', '-  [ ]  two', '- [] no box', '- plain', '- [ab] no box', '-\t[/]\ttab', ' - [-] one space', '+ [ ] other list'];
  const cards = parse(texts).lanes[0]!.cards;
  assert.deepEqual(cards.map((c) => [c.range.start, c.check, c.checked, cardTitle(texts, c)]), [
    [1, ' ', false, 'a'],
    [2, 'x', true, 'b'],
    [3, 'X', true, 'c'],
    [4, null, false, '[x]d'],
    [5, ' ', false, ''],
    [6, 'y', true, 'yes'],
    [7, ' ', false, 'two'],
    [8, null, false, '[] no box'],
    [9, null, false, 'plain'],
    [10, null, false, '[ab] no box'],
    [11, '/', true, 'tab'],
    [12, '-', true, 'one space'],
  ]);
  assert.deepEqual(cards.map((c) => c.checkOffset), [3, 3, 3, null, 3, 3, 4, null, null, null, 3, 4]);
  assert.deepEqual(cards[12 - 1]!.marker, { kind: '-', start: 1, end: 2, number: undefined, contentColumn: 3 });
});

test('2.5: ordered lists, other markers and the first list only', () => {
  const ordered = ['## A', '1. [ ] one', '2) [ ] other delimiter', '## B', '* [ ] star', '* plain star', '- [ ] dash', '## C', 'text', '2. [ ] lazy', '1. [ ] list'];
  const board = parse(ordered);
  assert.deepEqual(board.lanes.map((l) => l.cards.map((c) => [c.range.start, c.marker.kind, c.marker.number ?? null])), [
    [[1, '.', 1]],
    [[4, '*', null], [5, '*', null]],
    // An ordered item may interrupt a paragraph only from 1.
    [[10, '.', 1]],
  ]);
  // A second list after a paragraph, comment, quote or break is not cards.
  for (const between of ['paragraph', '<!-- note -->', '> quote', '***', '```\n```']) {
    const lines = ['## A', '- [ ] a', '', ...between.split('\n'), '', '- [ ] b'];
    assert.deepEqual(parse(lines).lanes[0]!.cards.map((c) => c.range.start), [1], between);
  }
});

test('2.5: lazy continuation lines', () => {
  const lines = ['## A', '- [ ] a', 'lazy', '%% note %%', '- [ ] b', '\tbody', 'lazy after body', '- [ ] c', '\t### h', 'not lazy'];
  assert.deepEqual(shape(parse(lines)).lanes[0]![4], ['1-4', '4-7', '7-9']);
  for (const stop of ['## H', '> q', '<!-- c -->', '---', '* x', '```']) {
    assert.deepEqual(shape(parse(['## A', '- [ ] a', stop])).lanes[0]![4], ['1-2'], stop);
  }
  assert.deepEqual(shape(parse(['## A', '- [ ] a', '==='])).lanes[0]![4], ['1-3'], 'no setext heading in a list item');
});

test('2.5: card body rules', () => {
  const lines = [
    '## A',
    '- [ ] one', // 1
    '\tbody', // 2
    '', // 3
    '  more', // 4
    '', // 5
    '', // 6: blanks 5-6 are not body
    '- [ ] two', // 7
    '\t```', // 8
    '', // 9
    'column 0 inside indented fence', // 10
    '\t```', // 11
    '', // 12
    '- [ ] three', // 13
    '   ', // 14: whitespace-only is blank
    '- [ ] four', // 15
  ];
  assert.deepEqual(shape(parse(lines)).lanes[0]![4], ['1-5', '7-12', '13-14', '15-16']);
  // After a blank line, a line indented less than the content column ends the list (CommonMark).
  assert.deepEqual(shape(parse(['## A', '- [ ] a', '', ' one space', '- [ ] b'])).lanes[0]![4], ['1-2']);
  // A marker indented less than the content column is the next card; more is the body.
  assert.deepEqual(shape(parse(['## A', '- [ ] a', ' - [ ] b', '  - [ ] c', ' - [ ] d', '   - [ ] body of d'])).lanes[0]![4], ['1-2', '2-3', '3-4', '4-6']);
});

test('2.6: indented lines without a preceding card are other lines', () => {
  assert.deepEqual(parse(['## A', '\t- [ ] x', '  text', '- [ ] y']).lanes[0]!.cards.map((c) => c.range.start), [3]);
});

test('2.7: a **Complete** paragraph before the first list, or doneLanes by exact name', () => {
  const board = parse(['## A', '- [ ] a', '\t**Complete**', '## B', '```', '**Complete**', '```', '## C', '  **Complete**  ']);
  assert.deepEqual(board.lanes.map((l) => [l.done, l.completeMarkerLines]), [[false, []], [false, []], [true, [8]]]);
  const more = parse(['## D', 'text', '', '**Complete**', '- [x] a', '## E', '- [x] a', '', '**Complete**', '## F', '**Complete**', 'more', '- [x] a']);
  assert.deepEqual(more.lanes.map((l) => [l.done, l.completeMarkerLines]), [[true, [3]], [false, []], [false, []]]);

  const { board: named } = parseFixture('01', { doneLanes: ['완료'] });
  assert.deepEqual(named.lanes.map((l) => l.done), [false, false, false, true, false]);
  assert.deepEqual(named.lanes.map((l) => l.doneByName), [false, false, false, true, false]);
  assert.equal(parseFixture('01', { doneLanes: ['완료 '] }).board.lanes[3]!.done, false, 'exact match');
  assert.equal(parseFixture('04', { doneLanes: ['끝'] }).board.lanes[2]!.completeMarkerLines.length, 1);
});

const NO_WIDTH = { laneWidth: undefined, laneWidthIn: { block: false, frontmatter: false } };

test('2.9: settings values', () => {
  const s01 = parseFixture('01').board.settings;
  assert.equal(s01.dateFormat, 'YYYY-MM-DD');
  assert.ok(s01.listCollapse.length > 0 && s01.listCollapse.every((v) => v === false));
  assert.deepEqual(parseFixture('02').board.settings, { listCollapse: [false, false, false], dateFormat: 'YYYY-MM-DD', dateTrigger: '@', timeTrigger: '@@', linkDateToDailyNote: false, showCheckboxes: undefined, ...NO_WIDTH });
  assert.equal(parseFixture('15').board.settings.dateFormat, 'YYYY.MM.DD', 'block wins over frontmatter');
  assert.deepEqual(parseFixture('16').board.settings, { listCollapse: [], dateFormat: 'YYYY-MM-DD', dateTrigger: '@', timeTrigger: '@@', linkDateToDailyNote: false, showCheckboxes: undefined, ...NO_WIDTH }, 'broken JSON');
  assert.deepEqual(parseFixture('17').board.settings, { listCollapse: [], dateFormat: 'YYYY-MM-DD', dateTrigger: '@', timeTrigger: '@@', linkDateToDailyNote: false, showCheckboxes: undefined, ...NO_WIDTH });

  const fm = (line: string, block?: string) =>
    parse(['---', 'kanban-plugin: basic', line, '---', '## A', ...(block ? ['%% kanban:settings', block, '%%'] : [])]).settings;
  assert.equal(fm('date-format: DD.MM').dateFormat, 'DD.MM');
  assert.equal(fm('date-format: "DD/MM"').dateFormat, 'DD/MM');
  assert.equal(fm("date-format: 'MM'").dateFormat, 'MM');
  assert.equal(fm('date-format:').dateFormat, 'YYYY-MM-DD');
  assert.equal(fm('date-format: DD', '{"date-format":"BLOCK"}').dateFormat, 'BLOCK');
  assert.equal(fm('date-format: DD', '[1,2]').dateFormat, 'DD', 'non-object block = no settings');
  assert.deepEqual(fm('x: 1', '{"list-collapse":[true,0,"x",false]}').listCollapse, [true, false, false, false]);
  assert.equal(fm('x: 1').timeTrigger, '@@');
  assert.equal(fm("time-trigger: '%%'").timeTrigger, '%%');
  assert.equal(fm("time-trigger: '%%'", '{"time-trigger":"!"}').timeTrigger, '!', 'block wins');
  assert.equal(fm('x: 1', '{"time-trigger":""}').timeTrigger, '@@', 'empty = default');
  assert.equal(fm('x: 1', '{"time-trigger":5}').timeTrigger, '@@');
  assert.equal(fm('x: 1').showCheckboxes, undefined, 'not set: the plugin default applies');
  assert.equal(fm('x: 1', '{"show-checkboxes":true}').showCheckboxes, true);
  assert.equal(fm('show-checkboxes: true', '{"show-checkboxes":false}').showCheckboxes, false, 'block wins');
  assert.equal(fm('show-checkboxes: true').showCheckboxes, true);
  assert.equal(fm('show-checkboxes: yes').showCheckboxes, undefined);
  assert.equal(fm('x: 1', '{"show-checkboxes":"true"}').showCheckboxes, undefined);
  // Vault defaults (the Kanban plugin's settings, Obsidian's date format fallback) when the board says nothing.
  const defaults = { dateFormat: 'DD.MM.YYYY', dateTrigger: '$', timeTrigger: '!!', linkDateToDailyNote: true };
  const withDefaults = (line: string, block?: string) =>
    parseBoard(['---', 'kanban-plugin: basic', line, '---', '## A', ...(block ? ['%% kanban:settings', block, '%%'] : [])], { defaults }).settings;
  assert.deepEqual(
    (({ dateFormat, dateTrigger, timeTrigger, linkDateToDailyNote }) => ({ dateFormat, dateTrigger, timeTrigger, linkDateToDailyNote }))(withDefaults('x: 1')),
    defaults,
  );
  assert.equal(withDefaults('date-format: YYYY').dateFormat, 'YYYY', 'frontmatter before the vault default');
  assert.equal(withDefaults('x: 1', '{"date-format":"MM/DD","link-date-to-daily-note":false}').dateFormat, 'MM/DD', 'the board wins');
  assert.equal(withDefaults('x: 1', '{"link-date-to-daily-note":false}').linkDateToDailyNote, false);
  assert.equal(withDefaults('link-date-to-daily-note: false').linkDateToDailyNote, false);
  assert.equal(parse(['## A', '%% kanban:settings', '[]', '%%']).settingsBlock?.valid, false);
});

test('2.9: lane-width as Obsidian uses it (block, else frontmatter)', () => {
  const fm = (line: string, block?: string) =>
    parse(['---', 'kanban-plugin: basic', line, '---', '## A', ...(block ? ['%% kanban:settings', block, '%%'] : [])]).settings;
  const width = (line: string, block?: string) => {
    const s = fm(line, block);
    return [s.laneWidth, s.laneWidthIn.block, s.laneWidthIn.frontmatter];
  };
  assert.deepEqual(width('x: 1'), [undefined, false, false], 'not set: the plugin default applies');
  assert.deepEqual(width('x: 1', '{"lane-width":300}'), [300, true, false]);
  assert.deepEqual(width('x: 1', '{"lane-width":"272"}'), [272, true, false], 'older boards store a string');
  assert.deepEqual(width('x: 1', '{"lane-width":312.5}'), [312.5, true, false]);
  // Values Obsidian cannot turn into a width leave its own 272px (null), not the plugin default.
  for (const bad of ['0', '-5', '"wide"', '"300px"', 'true', 'null', '[300]', '""']) {
    assert.deepEqual(width('x: 1', `{"lane-width":${bad}}`), [null, true, false], bad);
  }
  assert.deepEqual(width('lane-width: 250'), [250, false, true]);
  assert.deepEqual(width('lane-width: wide'), [null, false, true]);
  assert.deepEqual(width('lane-width: 250', '{"lane-width":300}'), [300, true, true], 'block wins');
  assert.deepEqual(width('lane-width: 250', '{"a":1}'), [250, false, true]);
  const s15 = parseFixture('15').board.settings;
  assert.deepEqual([s15.laneWidth, s15.laneWidthIn], [300, { block: true, frontmatter: true }]);
});

test('card identity round-trips and rejects stale identities', () => {
  const { texts, board } = parseFixture('11');
  const card = board.lanes[1]!.cards[0]!;
  const id = cardIdentity(texts, card);
  assert.deepEqual(id, { laneIndex: 1, cardIndex: 0, firstLine: '- [ ] 둘째 열 카드' });
  assert.equal(findCardByIdentity(board, texts, id), card);
  assert.equal(findCardByIdentity(board, texts, { ...id, laneIndex: 0 }), undefined);
  assert.equal(findCardByIdentity(board, texts, { ...id, cardIndex: 1 }), undefined);
  assert.equal(findCardByIdentity(board, texts, { ...id, firstLine: '- [x] 둘째 열 카드' }), undefined);
  assert.equal(findCardByIdentity(board, texts, { ...id, laneIndex: 9 }), undefined);
});
