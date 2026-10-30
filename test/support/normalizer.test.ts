import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readNormalized, writeNormalized, type NormalBoard } from './normalizer.ts';

const fixtureDir = new URL('../fixtures/kanban/', import.meta.url);
const fixtureNames = readdirSync(fixtureDir).filter((name) => /^\d\d-.*\.md$/.test(name));

function fixture(name: string): NormalBoard {
  return readNormalized(readFileSync(new URL(name, fixtureDir), 'utf8'));
}

function shape(board: NormalBoard): [string, number][] {
  return board.lanes.map((lane) => [lane.title, lane.cards.length]);
}

test('basic layout', () => {
  const board = readNormalized(
    ['---', 'kanban-plugin: basic', '---', 'preamble', '## A', '- [ ] one', '\t- body', '## B', '**Complete**', '- [x] two', ''].join('\n'),
  );
  assert.deepEqual(board, {
    frontmatter: ['---', 'kanban-plugin: basic', '---'],
    lanes: [
      { title: 'A', complete: false, cards: [{ line: '- [ ] one', body: ['\t- body'] }] },
      { title: 'B', complete: true, cards: [{ line: '- [x] two', body: [] }] },
    ],
    tail: [],
  });
  assert.equal(
    writeNormalized(board),
    ['---', 'kanban-plugin: basic', '---', '', '## A', '', '- [ ] one', '\t- body', '', '## B', '', '**Complete**', '- [x] two', ''].join(
      '\n',
    ) + '\n',
  );
});

test('fixture 04: compact board without blank lines', () => {
  const board = fixture('04-basic-no-blank.md');
  assert.ok(board.lanes.length >= 2);
  assert.ok(board.lanes.some((lane) => lane.complete));
});

test('fixture 05: **Complete** before the first list only (after a card it is a lazy body line)', () => {
  assert.deepEqual(
    fixture('05-complete-marker-positions.md').lanes.map((lane) => lane.complete),
    [true, false, false, false],
  );
});

test('fixture 06: interstitial lines are dropped, cards of the first list kept', () => {
  const board = fixture('06-interstitial.md');
  assert.deepEqual(shape(board).map(([, n]) => n), [2, 1, 1]);
  assert.ok(board.lanes[0].cards.every((card) => card.body.length === 0));
});

test('fixture 12: bodies with tabs, spaces, depth and inner blank line', () => {
  const cards = fixture('12-multiline-cards.md').lanes[0].cards;
  assert.deepEqual(
    cards.map((card) => card.body.length),
    [3, 2, 3, 0],
  );
  assert.equal(cards[2].body[1], '');
});

test('fixture 14: archive goes to the tail, not to lanes', () => {
  const board = fixture('14-archive.md');
  assert.equal(board.lanes.length, 2);
  assert.equal(board.tail[0], '***');
  assert.ok(board.tail.includes('## Archive'));
});

test('fixture 01: settings block in the tail', () => {
  const board = fixture('01-workspace-style.md');
  assert.equal(board.tail[0], '%% kanban:settings');
  assert.equal(board.tail[board.tail.length - 1], '%%');
  assert.deepEqual(board.lanes[1].cards[0].body.length, 2);
});

test('fixture 20: only the first list is cards', () => {
  const lane = fixture('20-not-cards.md').lanes[0];
  assert.equal(lane.cards.length, 1);
  assert.equal(lane.cards[0].body.length, 0);
});

test('fixture 21/22: CRLF and BOM read the same as LF', () => {
  const crlf = readFileSync(new URL('21-crlf.md', fixtureDir), 'utf8');
  assert.deepEqual(readNormalized(crlf), readNormalized(crlf.replace(/\r\n/g, '\n')));
  assert.equal(fixture('22-bom.md').frontmatter?.[0], '---');
});

test('normalizing keeps the structure and is idempotent on every fixture', () => {
  for (const name of fixtureNames) {
    const board = fixture(name);
    const once = writeNormalized(board);
    assert.deepEqual(readNormalized(once), board, name);
    assert.equal(writeNormalized(readNormalized(once)), once, name);
  }
});

test('CRLF output', () => {
  const out = writeNormalized(readNormalized('## A\n- [ ] x\n'), '\r\n');
  assert.equal(out, '## A\r\n\r\n- [ ] x\r\n\r\n');
});
