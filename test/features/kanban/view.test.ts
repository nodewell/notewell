import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { formatDate, isIsoDate, parseDate, parseTime } from '../../../src/features/kanban/dates.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView, DEFAULT_LANE_WIDTH, DEFAULT_STRINGS, lineSegments, type Segment } from '../../../src/features/kanban/view.ts';

const FIXTURES = new URL('../../fixtures/kanban/', import.meta.url);
const TODAY = '2026-10-20';
const ctx = { dateFormat: 'YYYY-MM-DD', today: TODAY };

function viewOf(prefix: string, doneLanes: string[] = []) {
  const name = readdirSync(FIXTURES).find((n) => n.startsWith(prefix))!;
  const texts = lineTexts(parseLines(readFileSync(new URL(name, FIXTURES), 'utf8')));
  return { texts, view: buildBoardView(texts, parseBoard(texts, { doneLanes }), { today: TODAY }) };
}

const seg = (text: string, category = false) => lineSegments(text, ctx, category);

test('fixture 18: every token kind from the display table', () => {
  const cards = viewOf('18').view.lanes[0]!.cards.map((c) => c.segments);
  assert.deepEqual(cards[0], [
    { kind: 'text', text: '날짜 ' },
    // The card's first date token: its badge opens the date picker (kanban.md 4.8).
    { kind: 'date', text: '2026-10-20', iso: '2026-10-20', state: 'today', pick: true },
    { kind: 'text', text: ' 와 시간 ' },
    { kind: 'time', text: '09:30' },
  ]);
  assert.deepEqual(cards[1]!.filter((s) => s.kind === 'date').map((s) => (s as { iso: string }).iso), ['2026-10-21', '2026-10-22']);
  assert.deepEqual(cards[2]!.filter((s) => s.kind === 'wikilink'), [
    { kind: 'wikilink', target: '폴더/하위/노트', text: '폴더/하위/노트' },
    { kind: 'wikilink', target: '노트', text: '보이는 이름' },
  ]);
  assert.deepEqual(cards[3]!.filter((s) => s.kind === 'tag').map((s) => s.text), ['#기능', '#v2-기능', '#버그_수정']);
  assert.deepEqual(cards[4], [
    { kind: 'bold', text: '굵게' },
    { kind: 'text', text: ' ' },
    { kind: 'italic', text: '기울임' },
    { kind: 'text', text: ' ' },
    { kind: 'code', text: '코드' },
    { kind: 'text', text: ' ' },
    { kind: 'link', text: '글' },
  ]);
  // Unsupported formats stay plain text, as written.
  assert.deepEqual(cards[5], [{ kind: 'text', text: '이슈 #123 은 숫자 태그' }]);
  assert.deepEqual(cards[6], [{ kind: 'text', text: 'Dataview [기한:: 2026-10-30] (담당:: 나)' }]);
  assert.deepEqual(cards[7], [{ kind: 'text', text: 'Tasks 📅 2026-10-15 ⏫ 🔁 every week' }]);
  assert.deepEqual(cards[8], [{ kind: 'text', text: '블록 ID ^abc123' }]);
  assert.deepEqual(cards[9], [
    { kind: 'text', text: 'HTML <b>굵게</b> <script>alert(1)</script> <img src=x onerror=alert(1)>' },
  ]);
});

test('markdown link keeps only its text (no URL reaches the webview)', () => {
  const out = JSON.stringify(seg('see [docs](https://example.com/x) now'));
  assert.ok(!out.includes('example.com'));
  assert.deepEqual(seg('[a](b)'), [{ kind: 'link', text: 'a' }]);
});

test('markdown links come from the core token (links.md 10 #2)', () => {
  // Unchanged from before: an embed keeps its `!` as text, code spans win.
  assert.deepEqual(seg('![alt](img.png)'), [{ kind: 'text', text: '!' }, { kind: 'link', text: 'alt' }]);
  assert.deepEqual(seg('`[a](b)`'), [{ kind: 'code', text: '[a](b)' }]);
  // Shapes the old pattern missed: angle brackets, titles, parentheses, nested brackets.
  assert.deepEqual(seg('[a](<my note.md>)'), [{ kind: 'link', text: 'a' }]);
  assert.deepEqual(seg('[a](note.md "title")'), [{ kind: 'link', text: 'a' }]);
  assert.deepEqual(seg('[a](wiki/Foo_(bar))'), [{ kind: 'link', text: 'a' }]);
  assert.deepEqual(seg('[a [b] c](u)'), [{ kind: 'link', text: 'a [b] c' }]);
  // `==` inside a link destination is not a highlight marker.
  assert.deepEqual(seg('[a](x==y) and [b](z==w)'), [{ kind: 'link', text: 'a' }, { kind: 'text', text: ' and ' }, { kind: 'link', text: 'b' }]);
});

test('category prefix only at the start of a title', () => {
  assert.deepEqual(seg('[공부] 시험 범위', true), [{ kind: 'category', text: '공부' }, { kind: 'text', text: ' 시험 범위' }]);
  assert.deepEqual(seg('[공부] 시험 범위'), [{ kind: 'text', text: '[공부] 시험 범위' }], 'only when requested');
  assert.deepEqual(seg('a [공부] b', true), [{ kind: 'text', text: 'a [공부] b' }]);
  assert.deepEqual(seg('[글](url) x', true), [{ kind: 'link', text: '글' }, { kind: 'text', text: ' x' }]);
  assert.deepEqual(seg('[[노트]] x', true)[0], { kind: 'wikilink', target: '노트', text: '노트' });
  assert.deepEqual(seg('[기한:: 2026-10-30] x', true), [{ kind: 'text', text: '[기한:: 2026-10-30] x' }]);
  const titles = viewOf('03').view.lanes[0]!.cards.map((c) => c.segments[0]);
  assert.deepEqual(titles.map((s) => s), [
    { kind: 'category', text: '공부' },
    { kind: 'category', text: '운동' },
    { kind: 'category', text: '운동' },
    { kind: 'category', text: '집안일' },
    { kind: 'category', text: '여행·준비' },
  ]);
});

test('dates: past/today/future, invalid dates and times stay text', () => {
  const states = (text: string) => seg(text).filter((s): s is Extract<Segment, { kind: 'date' }> => s.kind === 'date').map((s) => s.state);
  assert.deepEqual(states('@{2026-10-19} @{2026-10-20} @{2026-10-21} @[[2025-01-01]]'), ['past', 'today', 'future', 'past']);
  assert.deepEqual(seg('@{2026-02-30}'), [{ kind: 'text', text: '@{2026-02-30}' }]);
  assert.deepEqual(seg('@@{25:00}'), [{ kind: 'text', text: '@@{25:00}' }]);
  assert.deepEqual(seg('@@{7:05}'), [{ kind: 'time', text: '07:05' }]);
  assert.deepEqual(seg('[[2026-10-20]]'), [{ kind: 'wikilink', target: '2026-10-20', text: '2026-10-20' }], 'no @: a link');
  assert.deepEqual(seg('@[[노트]]'), [{ kind: 'text', text: '@' }, { kind: 'wikilink', target: '노트', text: '노트' }]);
  assert.deepEqual(seg('`@{2026-10-20}`'), [{ kind: 'code', text: '@{2026-10-20}' }], 'not inside inline code');
});

test('times: <time-trigger>{HH:mm} as Obsidian Kanban reads them (kanban.md 3)', () => {
  assert.deepEqual(seg('회의 @@{09:30}'), [{ kind: 'text', text: '회의 ' }, { kind: 'time', text: '09:30' }]);
  assert.deepEqual(seg('@{09:30}'), [{ kind: 'text', text: '@{09:30}' }], 'one @ is not a time');
  assert.deepEqual(seg('@@{2026-10-20}'), [{ kind: 'text', text: '@@{2026-10-20}' }], 'a date after @@ is not a date');
  assert.deepEqual(seg('@{2026-10-20}@@{9:00}'), [
    { kind: 'date', text: '2026-10-20', iso: '2026-10-20', state: 'today' },
    { kind: 'time', text: '09:00' },
  ]);
  assert.deepEqual(seg('`@@{09:30}`'), [{ kind: 'code', text: '@@{09:30}' }]);
  const at = (timeTrigger: string, text: string) => lineSegments(text, { ...ctx, timeTrigger }, false);
  assert.deepEqual(at('%', '%{09:30} @@{10:00}'), [{ kind: 'time', text: '09:30' }, { kind: 'text', text: ' @@{10:00}' }]);
  assert.deepEqual(at('$(', '$({09:30}'), [{ kind: 'time', text: '09:30' }], 'regex characters in the trigger');
  assert.deepEqual(at('@', '@{09:30} @{2026-10-20}'), [
    { kind: 'text', text: '@{09:30} ' },
    { kind: 'date', text: '2026-10-20', iso: '2026-10-20', state: 'today' },
  ], 'same trigger as dates: the date reading wins');
  const texts = ['---', 'kanban-plugin: basic', '---', '## A', '- [ ] %{09:30} @@{10:00}', '%% kanban:settings', '{"time-trigger":"%"}', '%%'];
  const view = buildBoardView(texts, parseBoard(texts), { today: TODAY });
  assert.equal(view.timeTrigger, '%');
  assert.deepEqual(view.lanes[0]!.cards[0]!.segments, [{ kind: 'time', text: '09:30' }, { kind: 'text', text: ' @@{10:00}' }]);
});

test('date-format is used to read and display dates', () => {
  const dotted = { dateFormat: 'YYYY.MM.DD', today: TODAY };
  assert.deepEqual(lineSegments('@{2026.10.21} @{2026-10-19}', dotted), [
    { kind: 'date', text: '2026.10.21', iso: '2026-10-21', state: 'future' },
    { kind: 'text', text: ' ' },
    { kind: 'date', text: '2026.10.19', iso: '2026-10-19', state: 'past' },
  ]);
  assert.equal(parseDate('21/10/26', 'DD/MM/YY'), '2026-10-21');
  assert.equal(parseDate('3.4.2026', 'D.M.YYYY'), '2026-04-03');
  assert.equal(parseDate('2026-10-21', 'dddd, MMM D'), '2026-10-21', 'unsupported format: ISO still read');
  assert.equal(parseDate('nope', 'YYYY-MM-DD'), undefined);
  assert.equal(formatDate('2026-04-03', 'D.M.YY'), '3.4.26');
  assert.equal(formatDate('2026-04-03', '[Day] DD'), 'Day 03');
  assert.equal(formatDate('2026-04-03', 'MMMM Do'), '2026-04-03', 'unsupported format falls back to ISO');
  assert.equal(parseTime('9:30'), '09:30');
  assert.equal(parseTime('9:60'), undefined);
  assert.ok(isIsoDate('2024-02-29'));
  assert.ok(!isIsoDate('2026-02-29'));
});

test('bold and italic do not swallow lone asterisks', () => {
  assert.deepEqual(seg('a * b * c'), [{ kind: 'text', text: 'a * b * c' }]);
  assert.deepEqual(seg('2 ** 3'), [{ kind: 'text', text: '2 ** 3' }]);
  assert.deepEqual(seg('**#tag**'), [{ kind: 'bold', text: '#tag' }]);
});

test('card body lines: depth, code fences verbatim, blank lines dropped', () => {
  const lanes = viewOf('12').view.lanes;
  assert.deepEqual(lanes[0]!.cards[0]!.body.map((l) => [l.depth, l.code, l.segments]), [
    [0, false, [{ kind: 'text', text: '- 하위 하나' }]],
    [1, false, [{ kind: 'text', text: '- 더 깊은 하위' }]],
    [0, false, [{ kind: 'text', text: '- 하위 둘' }]],
  ]);
  assert.deepEqual(lanes[0]!.cards[2]!.body.map((l) => l.segments[0]), [
    { kind: 'text', text: '본문' },
    { kind: 'text', text: '빈 줄 뒤에도 이어지는 본문' },
  ]);
  const fenced = viewOf('13').view.lanes[0]!.cards[0]!.body;
  assert.ok(fenced.every((l) => l.code));
  assert.deepEqual(fenced.map((l) => l.segments[0]), [
    { kind: 'text', text: '```' },
    { kind: 'text', text: '## 이건 열이 아님' },
    { kind: 'text', text: '- [ ] 이건 카드가 아님' },
    { kind: 'text', text: '' },
    { kind: 'text', text: '***' },
    { kind: 'text', text: '%% kanban:settings' },
    { kind: 'text', text: '```' },
  ]);
  const linked = viewOf('01').view.lanes[1]!.cards[1]!.body[0]!.segments;
  assert.deepEqual(linked, [{ kind: 'text', text: '- 메모: ' }, { kind: 'wikilink', target: '다른 노트', text: '다른 노트' }]);
});

test('lanes carry identity, done and collapsed; cards carry identity and raw title', () => {
  const { texts, view } = viewOf('05');
  assert.deepEqual(view.lanes.map((l) => [l.id, l.name, l.done, l.collapsed]), [
    [{ laneIndex: 0, heading: '## 앞쪽 표시' }, '앞쪽 표시', true, false],
    // A **Complete** line after a card is its lazy continuation, not a done mark (kanban.md 2.5, 2.7).
    [{ laneIndex: 1, heading: '## 중간 표시' }, '중간 표시', false, false],
    [{ laneIndex: 2, heading: '## 끝 표시' }, '끝 표시', false, false],
    [{ laneIndex: 3, heading: '## 일반 열' }, '일반 열', false, false],
  ]);
  const card = view.lanes[0]!.cards[0]!;
  assert.deepEqual(card.id, { laneIndex: 0, cardIndex: 0, firstLine: texts[7] });
  assert.equal(card.checked, true);
  assert.equal(card.title, '가');

  const named = viewOf('01', ['완료']).view;
  assert.deepEqual(named.lanes.map((l) => l.done), [false, false, false, true, false]);

  const collapse = '{"list-collapse":[false,true]}';
  const texts2 = ['---', 'kanban-plugin: basic', '---', '## A', '## B', '## C', '%% kanban:settings', collapse, '%%'];
  const v2 = buildBoardView(texts2, parseBoard(texts2), { today: TODAY });
  assert.deepEqual(v2.lanes.map((l) => l.collapsed), [false, true, false]);
  assert.equal(viewOf('19').view.lanes[1]!.name, '탭 섞인 열 이름');
});

test('view is JSON-serializable and carries strings', () => {
  const { view } = viewOf('18');
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  assert.equal(view.strings, DEFAULT_STRINGS);
  assert.equal(viewOf('07').view.isBoard, false);
  assert.throws(() => buildBoardView([], parseBoard([]), { today: '2026-13-01' }));
});

// --- highlight ==...== (kanban.md 3) ---

test('fixture 25: ==**...**== is bold and highlighted', () => {
  const { view } = viewOf('25');
  const card = view.lanes[0]!.cards[1]!;
  assert.deepEqual(card.body[0]!.segments, [{ kind: 'bold', text: '이 태스크는 매우 중요하다', highlight: true }]);
  // Inline code in the other card stays code, not highlighted.
  const code = view.lanes[0]!.cards[0]!.body.flatMap((line) => line.segments).filter((s) => s.kind === 'code');
  assert.deepEqual(code, [{ kind: 'code', text: '마크다운 표기법' }]);
});

test('highlight keeps inner formatting and tokens; markers are not shown', () => {
  assert.deepEqual(seg('a ==b *i* [[노트|별칭]] #태그== c'), [
    { kind: 'text', text: 'a ' },
    { kind: 'text', text: 'b ', highlight: true },
    { kind: 'italic', text: 'i', highlight: true },
    { kind: 'text', text: ' ', highlight: true },
    { kind: 'wikilink', target: '노트', text: '별칭', highlight: true },
    { kind: 'text', text: ' ', highlight: true },
    { kind: 'tag', text: '#태그', highlight: true },
    { kind: 'text', text: ' c' },
  ]);
  assert.deepEqual(seg('==one== and ==two=='), [
    { kind: 'text', text: 'one', highlight: true },
    { kind: 'text', text: ' and ' },
    { kind: 'text', text: 'two', highlight: true },
  ]);
});

test('== inside inline code, wikilinks or unpaired is text', () => {
  assert.deepEqual(seg('`==x==` y'), [{ kind: 'code', text: '==x==' }, { kind: 'text', text: ' y' }]);
  assert.deepEqual(seg('a == b'), [{ kind: 'text', text: 'a == b' }]);
  assert.deepEqual(seg('a ==== b'), [{ kind: 'text', text: 'a ==== b' }]);
  assert.deepEqual(seg('x = 1 == y'), [{ kind: 'text', text: 'x = 1 == y' }]);
  assert.deepEqual(seg('[[a==b]] ==c=='), [
    { kind: 'wikilink', target: 'a==b', text: 'a==b' },
    { kind: 'text', text: ' ' },
    { kind: 'text', text: 'c', highlight: true },
  ]);
  // A code span inside a highlight is highlighted code.
  assert.deepEqual(seg('==a `b`=='), [
    { kind: 'text', text: 'a ', highlight: true },
    { kind: 'code', text: 'b', highlight: true },
  ]);
});

test('category prefix still works before a highlight; fence lines are not parsed', () => {
  assert.deepEqual(seg('[공부] ==시험==', true), [
    { kind: 'category', text: '공부' },
    { kind: 'text', text: ' ' },
    { kind: 'text', text: '시험', highlight: true },
  ]);
  const texts = lineTexts(parseLines('## A\n- [ ] t\n\t```\n\t==not==\n\t```\n'));
  const view = buildBoardView(texts, parseBoard(texts), { today: TODAY });
  const fenced = view.lanes[0]!.cards[0]!.body[1]!;
  assert.equal(fenced.code, true);
  assert.deepEqual(fenced.segments, [{ kind: 'text', text: '==not==' }]);
});

test('dates follow the board date-trigger, as Obsidian Kanban reads them (kanban.md 3)', () => {
  const at = (dateTrigger: string, text: string) => lineSegments(text, { ...ctx, dateTrigger }, false);
  const today = { kind: 'date', text: '2026-10-20', iso: '2026-10-20', state: 'today' } as const;
  assert.deepEqual(at('$', '${2026-10-20} @{2026-10-20}'), [today, { kind: 'text', text: ' @{2026-10-20}' }]);
  assert.deepEqual(at('$', '$[[2026-10-20]] @[[2026-10-20]]'), [
    today,
    { kind: 'text', text: ' @' },
    { kind: 'wikilink', target: '2026-10-20', text: '2026-10-20' },
  ]);
  assert.deepEqual(at('$$', 'x $$[[2026-10-20]]'), [{ kind: 'text', text: 'x ' }, today], 'longer triggers before a link');
  assert.deepEqual(at('', '@{2026-10-20}'), [today], 'an empty trigger reads as the default');
  const texts = ['---', 'kanban-plugin: board', '---', '## A', '- [ ] ${2026-10-20} @{2026-10-21}', '%% kanban:settings', '{"date-trigger":"$"}', '%%'];
  const view = buildBoardView(texts, parseBoard(texts), { today: TODAY });
  assert.equal(view.dateTrigger, '$');
  assert.deepEqual(view.lanes[0]!.cards[0]!.segments, [today, { kind: 'text', text: ' @{2026-10-21}' }]);
  assert.equal(view.datePicker, false, 'the picker writes @{…} only');
});

test('check boxes: the board setting, else the Kanban plugin default, else hidden (kanban.md 2.9)', () => {
  const board = (settings?: string) => {
    const texts = ['---', 'kanban-plugin: board', '---', '## A', '- [ ] a', ...(settings === undefined ? [] : ['%% kanban:settings', '```', settings, '```', '%%'])];
    return { texts, board: parseBoard(texts) };
  };
  const show = (settings: string | undefined, showCheckboxesDefault?: boolean) => {
    const { texts, board: b } = board(settings);
    const view = buildBoardView(texts, b, { today: TODAY, ...(showCheckboxesDefault === undefined ? {} : { showCheckboxesDefault }) });
    return [view.showCheckboxes, view.checkboxSwitch];
  };
  assert.deepEqual(show('{"kanban-plugin":"board"}'), [false, true], 'Obsidian hides them by default');
  assert.deepEqual(show('{"kanban-plugin":"board"}', true), [true, true], 'plugin default');
  assert.deepEqual(show('{"show-checkboxes":false}', true), [false, true], 'the board wins');
  assert.deepEqual(show('{"show-checkboxes":true}', false), [true, true]);
  assert.deepEqual(show(undefined, true), [true, false], 'no settings block: no switch');
  assert.deepEqual(show('{broken'), [false, false], 'broken JSON: no switch');
});

test('lane width: the board value, else the Kanban plugin default, else 272px (kanban.md 2.9, 4.10)', () => {
  const width = (settings: string | undefined, laneWidthDefault?: number | null, frontmatter?: string) => {
    const texts = ['---', 'kanban-plugin: board', ...(frontmatter ? [frontmatter] : []), '---', '## A', '- [ ] a', ...(settings === undefined ? [] : ['%% kanban:settings', '```', settings, '```', '%%'])];
    const view = buildBoardView(texts, parseBoard(texts), { today: TODAY, ...(laneWidthDefault === undefined ? {} : { laneWidthDefault }) });
    return [view.laneWidth, view.laneWidthSlider, view.laneWidthSet];
  };
  assert.equal(DEFAULT_LANE_WIDTH, 272);
  assert.deepEqual(width('{"kanban-plugin":"board"}'), [272, true, false], "Obsidian's own width");
  assert.deepEqual(width('{"kanban-plugin":"board"}', 350), [350, true, false], 'plugin default');
  assert.deepEqual(width('{"kanban-plugin":"board"}', null), [272, true, false], 'plugin value that is not a width');
  assert.deepEqual(width('{"lane-width":420}', 350), [420, true, true], 'the board wins');
  assert.deepEqual(width('{"lane-width":"wide"}', 350), [272, true, true], 'a board value that is not a width: 272px, not the plugin default');
  assert.deepEqual(width('{"lane-width":1200}'), [1200, true, true], 'outside the slider range: shown as it is');
  assert.deepEqual(width(undefined, 350), [350, false, false], 'no settings block: no slider');
  assert.deepEqual(width('{broken'), [272, false, false], 'broken JSON: no slider');
  assert.deepEqual(width('{"lane-width":420}', undefined, 'lane-width: 250'), [420, false, true], 'frontmatter value: no slider');
});
