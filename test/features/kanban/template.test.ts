import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { defaultLaneNames, eolFor, newBoardText } from '../../../src/features/kanban/template.ts';

function read(text: string) {
  const doc = parseLines(text);
  const texts = lineTexts(doc);
  return { doc, texts, board: parseBoard(texts) };
}

test('a new board reads back as a board with three lanes, the last one done', () => {
  for (const locale of ['en', 'en-us', 'ko', 'ko-kr', 'ja']) {
    const { board } = read(newBoardText(locale, '\n'));
    assert.equal(board.isBoard, true, locale);
    assert.deepEqual(board.lanes.map((l) => l.name), [...defaultLaneNames(locale)], locale);
    assert.deepEqual(board.lanes.map((l) => l.done), [false, false, true], locale);
    assert.ok(board.lanes.every((l) => l.cards.length === 0));
    assert.equal(board.settingsBlock?.valid, true);
  }
});

test('lane names follow the display language', () => {
  assert.deepEqual(defaultLaneNames('ko'), ['할 일', '진행 중', '완료']);
  assert.deepEqual(defaultLaneNames('ko-KR'), ['할 일', '진행 중', '완료']);
  assert.deepEqual(defaultLaneNames('en'), ['To Do', 'Doing', 'Done']);
  assert.deepEqual(defaultLaneNames('de'), ['To Do', 'Doing', 'Done']);
});

test('the Obsidian Kanban layout, with the chosen line ending everywhere', () => {
  const lf = newBoardText('en', '\n');
  assert.ok(lf.startsWith('---\n\nkanban-plugin: board\n\n---\n\n## To Do\n'));
  assert.ok(lf.includes('## Done\n\n**Complete**\n'));
  assert.ok(lf.endsWith('%% kanban:settings\n```\n{"kanban-plugin":"board"}\n```\n%%\n'));
  assert.equal(lf.includes('\r'), false);
  const crlf = newBoardText('en', '\r\n');
  assert.equal(crlf, lf.replace(/\n/g, '\r\n'));
  const { doc } = read(crlf);
  assert.ok(doc.lines.every((line) => line.eol === '\r\n'));
});

test('files.eol: explicit values, auto by platform', () => {
  assert.equal(eolFor('\n', 'win32'), '\n');
  assert.equal(eolFor('\r\n', 'linux'), '\r\n');
  assert.equal(eolFor('auto', 'win32'), '\r\n');
  assert.equal(eolFor('auto', 'darwin'), '\n');
  assert.equal(eolFor(undefined, 'linux'), '\n');
});

test('cards can be added to the new board (empty lanes get a card after the blank line)', async () => {
  const { planBoardRequest } = await import('../../../src/features/kanban/operations.ts');
  const { texts, board } = read(newBoardText('en', '\n'));
  const lane = board.lanes[2]!;
  const plan = planBoardRequest(texts, board, { kind: 'addCard', lane: { laneIndex: 2, heading: texts[lane.headingLine]! }, title: 'first' });
  assert.equal(plan.ok, true);
});
