// Date picker edits (kanban.md 4.8): which token is the card's date, what add / change /
// remove write, and when the board refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { applyEdits, computePatch } from '../../../src/core/patch.ts';
import { dateLineOf, datePickerEnabled, endsWithTableRow, firstDateToken } from '../../../src/features/kanban/card-dates.ts';
import { cardIdentity, type KanbanCard } from '../../../src/features/kanban/model.ts';
import { planBoardRequest, type BoardRequest } from '../../../src/features/kanban/operations.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView } from '../../../src/features/kanban/view.ts';

const HEAD = ['---', 'kanban-plugin: basic', '---', '', '## A', ''];

function board(lines: readonly string[], eol = '\n', settings?: string): string {
  const tail = settings === undefined ? [] : ['', '%% kanban:settings', '```', settings, '```', '%%'];
  return [...HEAD, ...lines, ...tail, ''].join(eol);
}

function open(source: string) {
  const texts = lineTexts(parseLines(source));
  return { source, texts, board: parseBoard(texts) };
}

function cardOf(o: ReturnType<typeof open>, index = 0): KanbanCard {
  return o.board.lanes[0]!.cards[index]!;
}

/** The plan for a request on card `index`, applied: the new source, or the refusal reason. */
function run(source: string, make: (id: ReturnType<typeof cardIdentity>) => BoardRequest, index = 0): string {
  const o = open(source);
  const plan = planBoardRequest(o.texts, o.board, make(cardIdentity(o.texts, cardOf(o, index))));
  if (!plan.ok) return `refused: ${plan.reason}`;
  const doc = parseLines(source);
  const patch = computePatch(doc, 1, { expectedVersion: 1, expectedLines: plan.expectedLines, operations: plan.operations });
  assert.ok(patch.ok);
  return applyEdits(doc, patch.edits);
}

const add = (date: string) => (card: ReturnType<typeof cardIdentity>): BoardRequest => ({ kind: 'setCardDate', card, date });
const change = (date: string, token: string) => (card: ReturnType<typeof cardIdentity>): BoardRequest => ({ kind: 'setCardDate', card, date, token });
const remove = (token: string) => (card: ReturnType<typeof cardIdentity>): BoardRequest => ({ kind: 'removeCardDate', card, token });

// --- the card's date token ---

test('first date token: Obsidian (^|\\s)@{[^}]+} over the title, then the body lines', () => {
  const token = (lines: string[]) => {
    const o = open(board(lines));
    return firstDateToken(o.texts, cardOf(o));
  };
  assert.equal(token(['- [ ] a @{2026-10-20} b @{2026-10-21}'])?.text, '@{2026-10-20}');
  assert.equal(token(['- [ ] @{2026-10-20} at the title start'])?.start, 6);
  // Without a space after `]` there is no check box: `[ ]@{...}` is title text, and the token does not follow whitespace.
  assert.equal(token(['- [ ]@{2026-10-20} no space after the check mark']), undefined);
  assert.equal(token(['- @{2026-10-20} no check box'])?.start, 2);
  // Not after whitespace: not a token (Obsidian shows these as text too).
  assert.equal(token(['- [ ] a@{2026-10-20}']), undefined);
  assert.equal(token(['- [ ] @@{09:30}']), undefined);
  // Any text inside the braces counts, as in Obsidian.
  assert.equal(token(['- [ ] meet @{09:30}'])?.value, '09:30');
  assert.equal(token(['- [ ] link @[[2026-10-20]]']), undefined);
  // Body: after the indentation or a space; the title wins.
  const body = open(board(['- [ ] a', '\tfirst', '\t@{2026-10-22} second', '    x @{2026-10-23}']));
  assert.deepEqual(firstDateToken(body.texts, cardOf(body)), { line: 8, start: 1, end: 14, value: '2026-10-22', text: '@{2026-10-22}' });
  const both = open(board(['- [ ] a @{2026-10-01}', '\t@{2026-10-22}']));
  assert.equal(firstDateToken(both.texts, cardOf(both))?.line, 6);
});

test('add targets the last line with content; blank indented lines at the end are skipped', () => {
  const texts = ['- [ ] a', '\tbody', '\t', '  '];
  const card: KanbanCard = {
    laneIndex: 0, index: 0, range: { start: 0, end: 4 }, body: { start: 1, end: 4 },
    check: ' ', checked: false, checkOffset: 3, titleOffset: 6,
    marker: { kind: '-', start: 0, end: 1, number: undefined, contentColumn: 2 },
  };
  assert.equal(dateLineOf(texts, card), 1);
  assert.equal(dateLineOf(['- [ ] a', '\t'], { ...card, range: { start: 0, end: 2 }, body: { start: 1, end: 2 } }), 0);
  // A table row as the last line with content is still that line (endsWithTableRow tells it apart).
  assert.equal(dateLineOf(['- [ ] a', '\t| x |', '  |---|', '\t'], card), 2);
  assert.equal(endsWithTableRow(['- [ ] a', '\t| x |', '  |---|', '\t'], card), true);
  assert.equal(endsWithTableRow(['- [ ] a', '\t| x |', '\tafter', '\t'], card), false);
  assert.equal(dateLineOf(['- [ ] a', '\t| x |', '\tafter', '\t'], card), 2);
});

test('datePickerEnabled: date-trigger @ and no daily note links', () => {
  const base = { listCollapse: [], dateFormat: 'YYYY-MM-DD', dateTrigger: '@', timeTrigger: '@@', linkDateToDailyNote: false, showCheckboxes: undefined, laneWidth: undefined, laneWidthIn: { block: false, frontmatter: false } };
  assert.equal(datePickerEnabled(base), true);
  assert.equal(datePickerEnabled({ ...base, dateTrigger: '!' }), false);
  assert.equal(datePickerEnabled({ ...base, linkDateToDailyNote: true }), false);
});

// --- add ---

test('add: " @{date}" at the end of a one-line card', () => {
  assert.equal(run(board(['- [ ] a', '- [ ] b']), add('2026-10-20')), board(['- [ ] a @{2026-10-20}', '- [ ] b']));
});

test('add: at the end of the last body line, indentation kept (tab or spaces)', () => {
  assert.equal(
    run(board(['- [ ] a', '\tone', '', '\ttwo', '- [ ] b']), add('2026-10-20')),
    board(['- [ ] a', '\tone', '', '\ttwo @{2026-10-20}', '- [ ] b']),
  );
  assert.equal(
    run(board(['- [ ] a', '    one', '      two']), add('2026-10-20')),
    board(['- [ ] a', '    one', '      two @{2026-10-20}']),
  );
});

test('add: after a table, the date goes on its own body line after a blank one', () => {
  // Appended to the row it would be a cell beyond the table; right under the row Markdown
  // would read it as another row, hence the blank (indent-only) body line (kanban.md 4.8).
  assert.equal(
    run(board(['- [ ] a', '\t| x | y |', '\t| --- | --- |', '\t| 1 | 2 |', '\t', '- [ ] b']), add('2026-10-20')),
    board(['- [ ] a', '\t| x | y |', '\t| --- | --- |', '\t| 1 | 2 |', '\t', '\t@{2026-10-20}', '\t', '- [ ] b']),
  );
  assert.equal(
    run(board(['- [ ] a', '    | x |', '    | - |'], '\r\n'), add('2026-10-20')),
    board(['- [ ] a', '    | x |', '    | - |', '    ', '    @{2026-10-20}'], '\r\n'),
  );
  // A row without the leading pipe is not a row by this rule; text after a table is the last line.
  assert.equal(
    run(board(['- [ ] a', '\t| x |', '\t| - |', '\tafter']), add('2026-10-20')),
    board(['- [ ] a', '\t| x |', '\t| - |', '\tafter @{2026-10-20}']),
  );
  assert.equal(run(board(['- [ ] a', '\tx | y']), add('2026-10-20')), board(['- [ ] a', '\tx | y @{2026-10-20}']));
  // A row that leaves a comment open would swallow the date line.
  assert.equal(run(board(['- [ ] a', '\t| x %%open |']), add('2026-10-20')), 'refused: unsafe');
  // The new line is the card date: change and remove find it there.
  const added = board(['- [ ] a', '\t| x |', '\t| - |', '\t', '\t@{2026-10-20}']);
  assert.equal(run(added, change('2026-10-21', '@{2026-10-20}')), board(['- [ ] a', '\t| x |', '\t| - |', '\t', '\t@{2026-10-21}']));
  // Removing it takes the blank line added with it, so add then remove restores the card.
  assert.equal(run(added, remove('@{2026-10-20}')), board(['- [ ] a', '\t| x |', '\t| - |']));
});

test('add: CRLF and BOM files keep their line endings and BOM', () => {
  const crlf = board(['- [ ] a', '\tbody', '- [ ] b'], '\r\n');
  assert.equal(run(crlf, add('2026-10-20')), board(['- [ ] a', '\tbody @{2026-10-20}', '- [ ] b'], '\r\n'));
  const bom = '﻿' + board(['- [ ] a']);
  assert.equal(run(bom, add('2026-10-20')), '﻿' + board(['- [ ] a @{2026-10-20}']));
});

test('add: written in the board date-format (settings block, frontmatter, literals, unsupported -> ISO)', () => {
  assert.equal(run(board(['- [ ] a'], '\n', '{"date-format":"DD.MM.YYYY"}'), add('2026-10-05')), board(['- [ ] a @{05.10.2026}'], '\n', '{"date-format":"DD.MM.YYYY"}'));
  assert.equal(run(board(['- [ ] a'], '\n', '{"date-format":"YYYY년 M월 D일"}'), add('2026-10-05')), board(['- [ ] a @{2026년 10월 5일}'], '\n', '{"date-format":"YYYY년 M월 D일"}'));
  assert.equal(run(board(['- [ ] a'], '\n', '{"date-format":"[W]YY-MM-DD"}'), add('2026-10-05')), board(['- [ ] a @{W26-10-05}'], '\n', '{"date-format":"[W]YY-MM-DD"}'));
  assert.equal(run(board(['- [ ] a'], '\n', '{"date-format":"ddd YYYY-MM-DD"}'), add('2026-10-05')), board(['- [ ] a @{2026-10-05}'], '\n', '{"date-format":"ddd YYYY-MM-DD"}'));
  const fm = ['---', 'kanban-plugin: basic', 'date-format: DD/MM/YYYY', '---', '', '## A', '', '- [ ] a', ''].join('\n');
  assert.equal(run(fm, add('2026-10-05')), fm.replace('- [ ] a', '- [ ] a @{05/10/2026}'));
});

test('add: refused inside an open comment or a code fence (unsafe), and when the card already has a date (stale)', () => {
  // After a closed comment the date shows as one in Obsidian (checked with Kanban 2.0.51).
  assert.equal(run(board(['- [ ] a %%note%%']), add('2026-10-20')), board(['- [ ] a %%note%% @{2026-10-20}']));
  assert.equal(run(board(['- [ ] a', '\tb <!-- note -->  ']), add('2026-10-20')), board(['- [ ] a', '\tb <!-- note --> @{2026-10-20}']));
  assert.equal(run(board(['- [ ] a', '\tb %%open']), add('2026-10-20')), 'refused: unsafe');
  assert.equal(run(board(['- [ ] a', '\tb <!-- open']), add('2026-10-20')), 'refused: unsafe');
  assert.equal(run(board(['- [ ] a', '\t```', '\tcode', '\t```']), add('2026-10-20')), 'refused: unsafe');
  assert.equal(run(board(['- [ ] a @{2026-10-01}']), add('2026-10-20')), 'refused: stale');
});

test('add/change: dates that are not real days, and formats that would break the token, are invalid', () => {
  assert.equal(run(board(['- [ ] a']), add('2026-02-30')), 'refused: invalid');
  assert.equal(run(board(['- [ ] a']), add('20261020')), 'refused: invalid');
  assert.equal(run(board(['- [ ] a'], '\n', '{"date-format":"YYYY-MM-DD[}]"}'), add('2026-10-20')), 'refused: invalid');
  assert.equal(run(board(['- [ ] a'], '\n', '{"date-format":"YYYY-MM-DD[%%]"}'), add('2026-10-20')), 'refused: invalid');
});

test('the date picker is off with another date-trigger or daily note links (invalid)', () => {
  assert.equal(run(board(['- [ ] a'], '\n', '{"date-trigger":"!"}'), add('2026-10-20')), 'refused: invalid');
  assert.equal(run(board(['- [ ] a @{2026-10-01}'], '\n', '{"link-date-to-daily-note":true}'), change('2026-10-20', '@{2026-10-01}')), 'refused: invalid');
  assert.equal(run(board(['- [ ] a @{2026-10-01}'], '\n', '{"link-date-to-daily-note":true}'), remove('@{2026-10-01}')), 'refused: invalid');
  const fm = ['---', 'kanban-plugin: basic', 'link-date-to-daily-note: true', '---', '', '## A', '', '- [ ] a', ''].join('\n');
  assert.equal(run(fm, add('2026-10-20')), 'refused: invalid');
  // The settings block wins over the frontmatter (2.9).
  const both = fm.replace('- [ ] a\n', '- [ ] a\n\n%% kanban:settings\n```\n{"link-date-to-daily-note":false}\n```\n%%\n');
  assert.notEqual(run(both, add('2026-10-20')).slice(0, 8), 'refused:');
});

// --- change ---

test('change: only the text between the braces of the first token', () => {
  assert.equal(
    run(board(['- [ ] a @{2026-10-01} b @{2026-10-02}']), change('2026-10-20', '@{2026-10-01}')),
    board(['- [ ] a @{2026-10-20} b @{2026-10-02}']),
  );
  assert.equal(
    run(board(['- [ ] a', '\tx @{09:30} y']), change('2026-10-20', '@{09:30}')),
    board(['- [ ] a', '\tx @{2026-10-20} y']),
  );
  assert.equal(
    run(board(['- [ ] a @{01.10.2026}'], '\r\n', '{"date-format":"DD.MM.YYYY"}'), change('2026-10-20', '@{01.10.2026}')),
    board(['- [ ] a @{20.10.2026}'], '\r\n', '{"date-format":"DD.MM.YYYY"}'),
  );
});

test('change: refused when the token differs from the board (stale); the same date changes nothing', () => {
  assert.equal(run(board(['- [ ] a @{2026-10-01}']), change('2026-10-20', '@{2026-10-02}')), 'refused: stale');
  assert.equal(run(board(['- [ ] a']), change('2026-10-20', '@{2026-10-02}')), 'refused: stale');
  const o = open(board(['- [ ] a @{2026-10-01}']));
  const plan = planBoardRequest(o.texts, o.board, change('2026-10-01', '@{2026-10-01}')(cardIdentity(o.texts, cardOf(o))));
  assert.ok(plan.ok && plan.operations.length === 0);
});

// --- remove ---

test('remove: the token and one whitespace character before it', () => {
  assert.equal(run(board(['- [ ] a @{2026-10-01} b']), remove('@{2026-10-01}')), board(['- [ ] a b']));
  assert.equal(run(board(['- [ ] a\t@{2026-10-01}']), remove('@{2026-10-01}')), board(['- [ ] a']));
  // Trailing whitespace left on that line goes; other lines are untouched.
  assert.equal(run(board(['- [ ] a @{2026-10-01}   ', '\tbody  ']), remove('@{2026-10-01}')), board(['- [ ] a', '\tbody  ']));
});

test('remove: at the start of the title, the token and one whitespace character after it', () => {
  // The space after the check mark stays; the one after the token goes (Obsidian trims the text).
  assert.equal(run(board(['- [ ] @{2026-10-01} b']), remove('@{2026-10-01}')), board(['- [ ] b']));
  assert.equal(run(board(['- [ ] @{2026-10-01}\tb c']), remove('@{2026-10-01}')), board(['- [ ] b c']));
  assert.equal(run(board(['- @{2026-10-01} b']), remove('@{2026-10-01}')), board(['- b']));
  assert.equal(run(board(['- [ ] @{2026-10-01}  b']), remove('@{2026-10-01}')), board(['- [ ]  b']));
  assert.equal(run(board(['- [ ] @{2026-10-01}']), remove('@{2026-10-01}')), board(['- [ ]']));
  assert.equal(run(board(['- [ ] @{2026-10-01} b', '\tbody'], '\r\n'), remove('@{2026-10-01}')), board(['- [ ] b', '\tbody'], '\r\n'));
});

test('remove: in the body; a line that held only the token goes with its line break', () => {
  assert.equal(run(board(['- [ ] a', '\tx @{2026-10-01} y', '\tz']), remove('@{2026-10-01}')), board(['- [ ] a', '\tx y', '\tz']));
  // After the indentation with text following: the token and the space after it (the
  // indentation stays). Obsidian joins `y` onto the line above here; the board does not.
  assert.equal(run(board(['- [ ] a', '    @{2026-10-01} y']), remove('@{2026-10-01}')), board(['- [ ] a', '    y']));
  assert.equal(run(board(['- [ ] a', '	line one', '	@{2026-10-18} due soon']), remove('@{2026-10-18}')), board(['- [ ] a', '	line one', '	due soon']));
  // Only the token (and indentation or trailing whitespace): the whole line goes.
  assert.equal(run(board(['- [ ] a', '\t@{2026-10-01}', '\tz']), remove('@{2026-10-01}')), board(['- [ ] a', '\tz']));
  assert.equal(run(board(['- [ ] a', '\tz', '    @{2026-10-01}  ']), remove('@{2026-10-01}')), board(['- [ ] a', '\tz']));
  // The last body line, followed by another card; and the only body line.
  assert.equal(run(board(['- [ ] a', '\tz', '\t@{2026-10-01}', '- [ ] b']), remove('@{2026-10-01}')), board(['- [ ] a', '\tz', '- [ ] b']));
  assert.equal(run(board(['- [ ] a', '\t@{2026-10-01}', '- [ ] b']), remove('@{2026-10-01}')), board(['- [ ] a', '- [ ] b']));
  // CRLF: the line goes with its CRLF; the others keep theirs.
  assert.equal(
    run(board(['- [ ] a', '\t@{2026-10-01}', '\tz', '- [ ] b'], '\r\n'), remove('@{2026-10-01}')),
    board(['- [ ] a', '\tz', '- [ ] b'], '\r\n'),
  );
  assert.equal(run(board(['- [ ] a', '\tz', '\t@{2026-10-01}'], '\r\n'), remove('@{2026-10-01}')), board(['- [ ] a', '\tz'], '\r\n'));
  // Last line of a file without a final line break.
  const noEol = board(['- [ ] a', '\t@{2026-10-01}']).replace(/\n$/, '');
  assert.equal(run(noEol, remove('@{2026-10-01}')), board(['- [ ] a']).replace(/\n$/, ''));
});

test('remove: CRLF kept; refused when the card has no token or another one (stale)', () => {
  assert.equal(run(board(['- [ ] a @{2026-10-01}', '- [ ] b'], '\r\n'), remove('@{2026-10-01}')), board(['- [ ] a', '- [ ] b'], '\r\n'));
  assert.equal(run(board(['- [ ] a']), remove('@{2026-10-01}')), 'refused: stale');
  assert.equal(run(board(['- [ ] a @{2026-10-02}']), remove('@{2026-10-01}')), 'refused: stale');
});

test('requests name the card by identity: a changed first line is stale', () => {
  const o = open(board(['- [ ] a']));
  const id = { ...cardIdentity(o.texts, cardOf(o)), firstLine: '- [ ] other' };
  const plan = planBoardRequest(o.texts, o.board, { kind: 'setCardDate', card: id, date: '2026-10-20' });
  assert.ok(!plan.ok && plan.reason === 'stale');
});

// --- view ---

test('view: card date, picker flag, and only the first token badge is pickable', () => {
  const texts = lineTexts(parseLines(board([
    '- [ ] [분류] a @{2026-10-01} b @{2026-10-02}',
    '- [ ] none@{2026-10-01} == @{2026-10-03}==',
    '- [ ] in body',
    '\tx @{09:30} then',
    '\t@{2026-10-04}',
    '- [ ] ==hi @{2026-10-05}==',
  ])));
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-02' });
  assert.equal(view.datePicker, true);
  const [first, second, body, highlight] = view.lanes[0]!.cards;
  assert.deepEqual(first!.date, { token: '@{2026-10-01}', iso: '2026-10-01' });
  const picks = (segments: readonly { kind: string; pick?: true; text: string }[]) => segments.filter((s) => s.pick).map((s) => s.text);
  assert.deepEqual(picks(first!.segments), ['2026-10-01']);
  assert.deepEqual(first!.segments.filter((s) => s.kind === 'date').length, 2);
  // The first token is inside ==...== (the badge right after "none" is not a token).
  assert.deepEqual(second!.date, { token: '@{2026-10-03}', iso: '2026-10-03' });
  assert.deepEqual(picks(second!.segments), ['2026-10-03']);
  // A time is the first token: no date badge to pick, but the card has a date token.
  assert.deepEqual(body!.date, { token: '@{09:30}' });
  assert.deepEqual(body!.body.flatMap((l) => picks(l.segments)), []);
  assert.deepEqual(picks(highlight!.segments), ['2026-10-05']);

  const off = parseBoard(lineTexts(parseLines(board(['- [ ] a @{2026-10-01}'], '\n', '{"date-trigger":"!"}'))));
  const offView = buildBoardView(lineTexts(parseLines(board(['- [ ] a @{2026-10-01}'], '\n', '{"date-trigger":"!"}'))), off, { today: '2026-10-02' });
  assert.equal(offView.datePicker, false);
  assert.deepEqual(offView.lanes[0]!.cards[0]!.segments.filter((s) => s.kind === 'date' && s.pick), []);
});

test('view: a token in a body line is pickable at its own place', () => {
  const texts = lineTexts(parseLines(board(['- [ ] a', '\tx @{2026-10-01} @{2026-10-04}'])));
  const card = buildBoardView(texts, parseBoard(texts), { today: '2026-10-02' }).lanes[0]!.cards[0]!;
  const dates = card.body[0]!.segments.filter((s) => s.kind === 'date');
  assert.deepEqual(dates.map((s) => s.kind === 'date' && s.pick === true), [true, false]);
});

// Cases checked against Obsidian Kanban 2.0.51 (kanban.md 4.8).
test('add: whitespace at the end of the line is replaced by the one space before the date', () => {
  assert.equal(run(board(['- [ ] Trailing space ']), add('2026-10-25')), board(['- [ ] Trailing space @{2026-10-25}']));
  assert.equal(run(board(['- [ ] a', '\tbody\t ']), add('2026-10-25')), board(['- [ ] a', '\tbody @{2026-10-25}']));
});

test('add: refused on a card dated by a daily note link (@[[...]])', () => {
  assert.equal(run(board(['- [ ] Linked @[[2026-10-18]]']), add('2026-10-25')), 'refused: unsafe');
  assert.equal(run(board(['- [ ] a', '\tdue @[[2026-10-18]]']), add('2026-10-25')), 'refused: unsafe');
  // Not a token: no whitespace before `@`.
  assert.equal(run(board(['- [ ] x@[[2026-10-18]]']), add('2026-10-25')), board(['- [ ] x@[[2026-10-18]] @{2026-10-25}']));
});
