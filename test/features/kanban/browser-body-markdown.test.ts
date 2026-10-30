// Card bodies drawn as Markdown blocks (kanban.md 3): the shared Markdown display with the
// board's token rules, the first date badge still a picker button when it is in the body,
// table cells beyond the header kept (board and preview), and the line-by-line fallback over
// the 2.10 limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { renderCardPreview } from '../../../src/features/kanban/browser/preview.ts';
import { renderBoard } from '../../../src/features/kanban/browser/render.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView, MAX_FORMATTED_LINE, MAX_SEGMENTS, type BoardView } from '../../../src/features/kanban/view.ts';
import { fakeDocument as doc, type FakeElement } from '../../support/markdown.ts';

const HEAD = ['---', 'kanban-plugin: basic', '---', '', '## A', ''];

function view(lines: readonly string[], settings?: string): BoardView {
  const tail = settings === undefined ? [] : ['', '%% kanban:settings', '```', settings, '```', '%%'];
  const texts = [...HEAD, ...lines, ...tail, ''];
  return buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
}

const cards = (root: FakeElement) => root.find((e) => e.tagName === 'li' && e.classes.has('card'));
const bodyOf = (card: FakeElement) => card.find((e) => e.classes.has('card-body'))[0]!;
const picks = (root: FakeElement) => root.find((e) => e.classes.has('date-pick'));

function board(lines: readonly string[], settings?: string): FakeElement[] {
  return cards(renderBoard(doc, view(lines, settings), { collapsed: new Map() }));
}

test('the body shows headings, lists, task lists, quotes, code and tables as Markdown; HTML stays text', () => {
  const [card] = board([
    '- [ ] Title',
    '\t## Notes',
    '\t- one #tag [[Note|shown]]',
    '\t- [x] done',
    '\t> quoted',
    '\t```js',
    '\t#notag [[NotLink]] @{2026-10-21}',
    '\t```',
    '\t| a | b |',
    '\t|---|--:|',
    '\t| 1 | **2** |',
    '\t<b>bold?</b> <script>x</script>',
  ]);
  const body = bodyOf(card!);
  assert.ok(body.classes.has('card-body-md'));
  // Below the lane's h2: `##` is drawn as h4, styled smaller than the title by the stylesheet.
  assert.deepEqual(body.find((e) => e.classes.has('md-heading')).map((e) => [e.tagName, e.textContent]), [['h4', 'Notes']]);
  assert.deepEqual(body.find((e) => e.tagName === 'li').map((e) => e.textContent), ['one #tag shown', 'done']);
  const box = body.find((e) => e.classes.has('md-checkbox'))[0]!;
  assert.ok(box.attrs.has('disabled') && box.attrs.has('checked'));
  assert.equal(body.find((e) => e.classes.has('md-quote'))[0]!.textContent, 'quoted');
  // Tokens: as on the board, but not inside code.
  assert.deepEqual(body.find((e) => e.classes.has('tag')).map((e) => e.textContent), ['#tag']);
  const links = body.find((e) => e.classes.has('wikilink'));
  assert.deepEqual(links.map((e) => [e.textContent, e.attrs.get('data-target'), e.attrs.get('data-action'), e.attrs.get('tabindex')]), [['shown', 'Note', 'open-link', '0']]);
  assert.equal(body.find((e) => e.classes.has('md-code'))[0]!.textContent, 'js#notag [[NotLink]] @{2026-10-21}');
  assert.equal(body.find((e) => e.classes.has('date')).length, 0);
  const table = body.find((e) => e.classes.has('md-table'))[0]!;
  assert.equal(body.find((e) => e.classes.has('md-table-wrap'))[0]!.children[0], table);
  assert.deepEqual(table.find((e) => e.tagName === 'td').map((e) => e.textContent), ['1', '2']);
  assert.equal(body.find((e) => e.tagName === 'b' || e.tagName === 'script').length, 0);
  assert.match(body.textContent ?? '', /<b>bold\?<\/b> <script>x<\/script>/);
});

test('a date appended to a table row shows on a line below the table, and is the card date picker', () => {
  const [card] = board(['- [ ] Fruit', '\t| item | count |', '\t|---|---|', '\t| pear | 2 | @{2026-03-04}']);
  const extra = bodyOf(card!).find((e) => e.classes.has('md-table-extra'));
  assert.equal(extra.length, 1);
  const [badge] = extra[0]!.find((e) => e.classes.has('date'));
  assert.equal(badge!.textContent, '2026-03-04');
  assert.ok(badge!.classes.has('date-pick'));
  assert.equal(badge!.attrs.get('role'), 'button');
  assert.equal(badge!.attrs.get('data-action'), 'pick-date');
  assert.equal(badge!.attrs.get('tabindex'), '0');
});

test('only the first date token of the card opens the picker: title first, then the body in order', () => {
  // In the body: the first badge; a later one is a plain badge.
  const [inBody] = board(['- [ ] t', '\t- a @{2026-10-21}', '\t- b @{2026-10-22}']);
  assert.deepEqual(picks(inBody!).map((e) => e.textContent), ['2026-10-21']);
  assert.equal(inBody!.find((e) => e.classes.has('date')).length, 2);
  // Not after whitespace is no token (Obsidian): the next one with the same text is.
  const [glued] = board(['- [ ] t', '\tx@{2026-10-21} and **b** @{2026-10-21}']);
  const dates = glued!.find((e) => e.classes.has('date'));
  assert.deepEqual(dates.map((e) => e.classes.has('date-pick')), [false, true]);
  // In the title: no body badge picks.
  const [inTitle] = board(['- [ ] t @{2026-10-19}', '\t- @{2026-10-21}']);
  assert.equal(picks(inTitle!).length, 1);
  assert.equal(picks(inTitle!)[0]!.textContent, '2026-10-19');
  assert.equal(bodyOf(inTitle!).find((e) => e.classes.has('date-pick')).length, 0);
  // A first token that is not a date (a time): no picker anywhere.
  const [time] = board(['- [ ] t', '\t@{09:30} then @{2026-10-21}']);
  assert.equal(picks(time!).length, 0);
  // Date picker off (another date-trigger): no picker.
  const [off] = board(['- [ ] t', '\t- $${2026-10-21} @{2026-10-22}'], '{"date-trigger":"$$"}');
  assert.equal(off!.find((e) => e.classes.has('date')).length, 1, 'only the board trigger reads as a date');
  assert.equal(picks(off!).length, 0);
});

test('==highlight== in the body may hold bold text and tokens', () => {
  const [card] = board(['- [ ] t', '\t==**very** important #tag [[N]]== after']);
  const [mark] = bodyOf(card!).find((e) => e.tagName === 'mark');
  assert.equal(mark!.textContent, 'very important #tag N');
  assert.equal(mark!.find((e) => e.tagName === 'strong').length, 1);
  assert.equal(mark!.find((e) => e.classes.has('tag')).length, 1);
  assert.equal(mark!.find((e) => e.classes.has('wikilink')).length, 1);
});

test('over the 2.10 one-line limits the body is drawn line by line, as before', () => {
  const long = `\t${'x'.repeat(MAX_FORMATTED_LINE + 1)}`;
  const many = `\t${'#a '.repeat(MAX_SEGMENTS + 1)}`;
  for (const line of [long, many]) {
    const v = view(['- [ ] t', '\t| a |', '\t|---|', line]);
    assert.equal(v.lanes[0]!.cards[0]!.plainBody, true);
    const [card] = cards(renderBoard(doc, v, { collapsed: new Map() }));
    const body = bodyOf(card!);
    assert.ok(!body.classes.has('card-body-md'));
    assert.equal(body.find((e) => e.classes.has('md-table')).length, 0);
    assert.equal(body.find((e) => e.classes.has('body-line')).length, 3);
  }
  // At the limits: Markdown.
  const v = view(['- [ ] t', `\t${'x'.repeat(MAX_FORMATTED_LINE - 1)}`]);
  assert.equal(v.lanes[0]!.cards[0]!.plainBody, undefined);
  // A long line in a code fence counts too.
  assert.equal(view(['- [ ] t', '\t```', long, '\t```']).lanes[0]!.cards[0]!.plainBody, true);
});

test('preview: extra table cells show below the table there too, without a picker', () => {
  const v = view(['- [ ] Fruit', '\t| item | count |', '\t|---|---|', '\t| pear | 2 | @{2026-03-04}']);
  const popup = renderCardPreview(doc, v, v.lanes[0]!.cards[0]!, 'p');
  const extra = popup.find((e) => e.classes.has('md-table-extra'));
  assert.equal(extra.length, 1);
  assert.equal(extra[0]!.find((e) => e.classes.has('date'))[0]!.textContent, '2026-03-04');
  assert.equal(popup.find((e) => e.classes.has('date-pick')).length, 0);
  assert.equal(popup.find((e) => e.attrs.get('tabindex') === '0').length, 0);
});

test('fixture 29: every card body renders, extra table cells show below their table', () => {
  const texts = lineTexts(parseLines(readFileSync(new URL('../../fixtures/kanban/29-card-bodies.md', import.meta.url), 'utf8')));
  const v = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
  const root = renderBoard(doc, v, { collapsed: new Map() });
  const bodies = root.find((e) => e.classes.has('card-body-md'));
  assert.equal(bodies.length, 5);
  assert.equal(root.find((e) => e.classes.has('md-table')).length, 4);
  assert.equal(root.find((e) => e.classes.has('md-table-extra')).length, 1);
  assert.deepEqual(picks(root).map((e) => e.textContent), ['2026-03-04', '2026-05-06']);
});

test("body times follow the board's time-trigger (kanban.md 3)", () => {
  const times = (card: FakeElement) => bodyOf(card).find((e) => e.classes.has('time')).map((e) => e.textContent);
  const [plain] = board(['- [ ] t', '\tat @@{09:30} not @{10:00}']);
  assert.deepEqual(times(plain!), ['09:30']);
  const [custom] = board(['- [ ] t', '\tat !!{09:30} not @@{10:00}'], '{"time-trigger":"!!"}');
  assert.deepEqual(times(custom!), ['09:30']);
});
