// Renders real fixtures with a fake document and checks that card text only ever
// becomes text nodes, with no script-capable elements or event attributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lineTexts, parseLines } from '../../../src/core/lines.ts';
import { cardMenuEntries, laneChoices } from '../../../src/features/kanban/browser/card-menu.ts';
import { laneWidthText, renderBoard, renderCardEditor, renderCardMenu, renderLaneMenu } from '../../../src/features/kanban/browser/render.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView, DEFAULT_STRINGS } from '../../../src/features/kanban/view.ts';

class FakeElement {
  readonly tagName: string;
  #text: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly children: (FakeElement | string)[] = [];
  readonly classList = { add: (...tokens: string[]) => void tokens.forEach((t) => this.classes.add(t)) };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string | null {
    return this.#text ?? this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  set textContent(value: string | null) {
    this.#text = value;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }

  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) if (typeof child !== 'string') yield* child.walk();
  }

  find(predicate: (e: FakeElement) => boolean): FakeElement[] {
    return [...this.walk()].filter(predicate);
  }
}

const doc = { createElement: (tag: string) => new FakeElement(tag) };
const FIXTURES = new URL('../../fixtures/kanban/', import.meta.url);
// Card bodies are Markdown blocks (kanban.md 3): headings, lists, quotes, code and tables too.
const ALLOWED_TAGS = new Set([
  'mark', 'div', 'p', 'section', 'header', 'h2', 'button', 'span', 'ul', 'li', 'input', 'strong', 'em', 'code',
  'h3', 'h4', 'h5', 'h6', 'ol', 'blockquote', 'hr', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 's',
]);

function render(prefix: string, collapsed = new Map<number, boolean>(), showCheckboxesDefault?: boolean) {
  const name = readdirSync(FIXTURES).find((n) => n.startsWith(prefix))!;
  const texts = lineTexts(parseLines(readFileSync(new URL(name, FIXTURES), 'utf8')));
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20', ...(showCheckboxesDefault === undefined ? {} : { showCheckboxesDefault }) });
  return { view, root: renderBoard(doc, view, { collapsed }) };
}

for (const name of readdirSync(FIXTURES).filter((n) => /^\d\d-/.test(n))) {
  test(`fixture ${name}: only safe elements and attributes`, () => {
    const { root } = render(name.slice(0, 2));
    for (const element of root.walk()) {
      assert.ok(ALLOWED_TAGS.has(element.tagName), element.tagName);
      for (const attr of element.attrs.keys()) {
        assert.ok(!attr.startsWith('on') && attr !== 'style' && attr !== 'href' && attr !== 'src', attr);
      }
    }
  });
}

test('fixture 18: HTML and script text appears as literal text only', () => {
  const { root } = render('18');
  const titles = root.find((e) => e.classes.has('card-title'));
  const html = titles[9]!;
  assert.deepEqual(html.children, ['HTML <b>굵게</b> <script>alert(1)</script> <img src=x onerror=alert(1)>']);
  assert.equal(root.find((e) => e.tagName === 'b' || e.tagName === 'img' || e.tagName === 'script').length, 0);
});

test('fixture 18: tokens render as their own elements', () => {
  const { root } = render('18');
  const byClass = (cls: string) => root.find((e) => e.classes.has(cls)).map((e) => e.textContent);
  assert.deepEqual(byClass('date'), ['2026-10-20', '2026-10-21', '2026-10-22']);
  assert.deepEqual(byClass('date-today'), ['2026-10-20']);
  assert.deepEqual(byClass('time'), ['09:30']);
  assert.deepEqual(byClass('tag'), ['#기능', '#v2-기능', '#버그_수정']);
  assert.deepEqual(byClass('wikilink'), ['폴더/하위/노트', '보이는 이름']);
  assert.deepEqual(byClass('md-link'), ['글']);
  assert.deepEqual(root.find((e) => e.tagName === 'strong').map((e) => e.textContent), ['굵게']);
  assert.deepEqual(root.find((e) => e.tagName === 'em').map((e) => e.textContent), ['기울임']);
  assert.deepEqual(root.find((e) => e.tagName === 'code').map((e) => e.textContent), ['코드']);
  const link = root.find((e) => e.classes.has('wikilink'))[1]!;
  assert.equal(link.attrs.get('data-target'), '노트');
  assert.equal(link.attrs.get('data-action'), 'open-link');
});

test('fixture 03: category badges', () => {
  const { root } = render('03');
  assert.deepEqual(root.find((e) => e.classes.has('category')).map((e) => e.textContent), ['공부', '운동', '운동', '집안일', '여행·준비']);
});

test('fixture 19: unicode titles, check states and lane names as text', () => {
  const { root } = render('19', new Map(), true);
  const cards = root.find((e) => e.tagName === 'li');
  // `- [x]공백` has no check box (no space after `]`), so `[x]` is title text (kanban.md 2.5).
  assert.deepEqual(cards.map((c) => c.classes.has('checked')), [false, false, true, false]);
  assert.deepEqual(cards.map((c) => c.find((e) => e.tagName === 'input')[0]!.attrs.has('checked')), [false, false, true, false]);
  assert.equal(cards[3]!.find((e) => e.classes.has('card-title'))[0]!.textContent, '[x]공백 없는 체크');
  assert.deepEqual(root.find((e) => e.tagName === 'h2').map((e) => e.textContent), ['이모지 📅 열', '탭 섞인 열 이름']);
});

test('done lanes are marked; collapsed lanes hide cards (list-collapse and local toggle)', () => {
  const { root } = render('05');
  const lanes = root.find((e) => e.tagName === 'section');
  assert.deepEqual(lanes.map((l) => l.classes.has('done')), [true, false, false, false]);
  assert.deepEqual(lanes.map((l) => l.find((e) => e.classes.has('lane-done')).length), [1, 0, 0, 0]);

  const texts = ['---', 'kanban-plugin: basic', '---', '## A', '- [ ] a', '## B', '%% kanban:settings', '{"list-collapse":[true,false]}', '%%'];
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
  const hidden = (collapsed: Map<number, boolean>) =>
    renderBoard(doc, view, { collapsed })
      .find((e) => e.tagName === 'ul')
      .map((ul) => ul.attrs.has('hidden'));
  assert.deepEqual(hidden(new Map()), [true, false]);
  assert.deepEqual(hidden(new Map([[0, false], [1, true]])), [false, true]);

  // A collapsed lane's title is cut with an ellipsis, so its tooltip carries the full name.
  const titles = renderBoard(doc, view, { collapsed: new Map() }).find((e) => e.tagName === 'h2').map((h) => h.attrs.get('title'));
  assert.deepEqual(titles, [`A — ${view.strings.renameLane}`, view.strings.renameLane]);
});

test('cards and lanes carry the data hooks used by main.ts', () => {
  const { root } = render('11');
  const cards = root.find((e) => e.tagName === 'li');
  assert.deepEqual(cards.map((c) => [c.attrs.get('data-lane'), c.attrs.get('data-card'), c.attrs.get('draggable')]), [
    ['0', '0', 'true'],
    ['1', '0', 'true'],
    ['2', '0', 'true'],
  ]);
  assert.equal(root.find((e) => e.attrs.get('data-action') === 'add-card').length, 3);
  assert.equal(root.find((e) => e.attrs.get('data-drag') === 'lane').length, 3);
});

test('notices for non-boards and boards without lanes', () => {
  const noLanes = buildBoardView([], parseBoard([]), { today: '2026-10-20' });
  const notices = renderBoard(doc, noLanes, { collapsed: new Map() }).find((e) => e.classes.has('notice'));
  assert.deepEqual(notices.map((n) => n.textContent), [noLanes.strings.notABoard, noLanes.strings.noLanes]);
});

test('card editor: a textarea whose initial value is the whole card as text', () => {
  const { view } = render('12');
  const card = view.lanes[0]!.cards[0]!;
  const area = renderCardEditor(doc, card, view.strings);
  assert.equal(area.tagName, 'textarea');
  assert.equal(area.textContent, '탭 들여쓰기 카드\n- 하위 하나\n\t- 더 깊은 하위\n- 하위 둘');
  assert.equal(area.attrs.get('rows'), '4');
  assert.equal(area.attrs.get('aria-label'), view.strings.editCard);
  assert.ok(area.classes.has('inline-edit') && area.classes.has('card-editor'));

  // Markup in a card stays text in the editor too.
  const html = render('18').view.lanes[0]!.cards[9]!;
  const htmlArea = renderCardEditor(doc, html, view.strings);
  assert.deepEqual(htmlArea.children, []);
  assert.equal(htmlArea.textContent, 'HTML <b>굵게</b> <script>alert(1)</script> <img src=x onerror=alert(1)>');
});

test('help is a named button that describes the shortcuts', () => {
  const { root, view } = render('17');
  const [help] = root.find((e) => e.classes.has('board-help'));
  assert.equal(help!.tagName, 'button');
  assert.equal(help!.attrs.get('type'), 'button');
  assert.equal(help!.attrs.get('aria-label'), view.strings.keyboardHelpLabel);
  assert.equal(help!.attrs.get('aria-describedby'), 'board-help-text');
  assert.equal(root.find((e) => e.attrs.get('id') === 'board-help-text')[0]!.textContent, view.strings.keyboardHelp);
});

test('==highlight== runs render as one <mark> holding their own formatting', () => {
  const texts = ['---', 'kanban-plugin: basic', '---', '## A', '- [ ] 앞 ==**중요** 그리고 #태그 [[노트]]== 뒤 ==둘째==', '\t- 본문 ==강조=='];
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
  const root = renderBoard(doc, view, { collapsed: new Map() });
  const title = root.find((e) => e.classes.has('card-title'))[0]!;
  const marks = title.children.filter((c): c is FakeElement => typeof c !== 'string' && c.tagName === 'mark');
  assert.equal(marks.length, 2, 'two separate runs');
  assert.ok(marks.every((m) => m.classes.has('highlight')));
  const first = marks[0]!;
  assert.deepEqual(first.children.map((c) => (typeof c === 'string' ? c : `${c.tagName}.${[...c.classes].join('.')}:${c.textContent}`)), [
    'strong.:중요',
    ' 그리고 ',
    'span.badge.tag:#태그',
    ' ',
    'span.wikilink:노트',
  ]);
  assert.equal(title.textContent, '앞 중요 그리고 #태그 노트 뒤 둘째');
  const body = root.find((e) => e.classes.has('card-body'))[0]!;
  assert.equal(body.find((e) => e.tagName === 'mark')[0]!.textContent, '강조');
});

test('fixture 25: the bold highlighted body line renders inside a mark', () => {
  const { root } = render('25');
  const marks = root.find((e) => e.tagName === 'mark');
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.textContent, '이 태스크는 매우 중요하다');
  assert.equal(marks[0]!.find((e) => e.tagName === 'strong').length, 1);
});

test('card menu: role=menu with menuitem rows, separators and text-only marks', () => {
  const texts = ['---', 'kanban-plugin: basic', '---', '## A', '- [ ] a0', '- [ ] a1', '## B', '**Complete**', '- [x] b0'];
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
  const entries = cardMenuEntries(view, { lane: 0, card: 0 }, view.strings);
  const menu = renderCardMenu(doc, entries, view.strings.cardMenu);
  assert.equal(menu.attrs.get('role'), 'menu');
  assert.equal(menu.attrs.get('aria-label'), view.strings.cardMenu);
  const rows = menu.children as FakeElement[];
  assert.equal(rows.length, entries.length);
  assert.deepEqual(
    rows.map((r) => r.attrs.get('role')),
    ['menuitem', 'menuitem', 'menuitem', 'menuitem', 'menuitem', 'menuitem', 'separator', 'menuitem', 'menuitem', 'menuitem', 'separator', 'menuitem'],
  );
  // data-index points back into the entries (separators counted).
  for (const row of rows.filter((r) => r.attrs.get('role') === 'menuitem')) {
    const entry = entries[Number(row.attrs.get('data-index'))]!;
    assert.ok(entry.kind === 'item' && entry.id === row.attrs.get('data-item'));
    assert.equal(row.find((e) => e.classes.has('card-menu-label'))[0]!.textContent, entry.label);
    assert.equal(row.attrs.get('tabindex'), '-1');
  }
  const byId = (id: string) => rows.find((r) => r.attrs.get('data-item') === id)!;
  assert.equal(byId('move-top').attrs.get('aria-disabled'), 'true', 'first card cannot move up');
  assert.equal(byId('move-bottom').attrs.get('aria-disabled'), undefined);
  assert.ok(byId('delete').classes.has('danger'));
  assert.equal(byId('move-to').attrs.get('aria-haspopup'), 'menu');
  assert.equal(byId('move-to').attrs.get('aria-expanded'), 'false');
  assert.equal(byId('move-to').find((e) => e.classes.has('card-menu-chevron'))[0]!.textContent, String.fromCharCode(0x203a));
  // Shortcut hints only where a selected card has the key: F2 edits, Ctrl+Enter opens in text, Delete deletes.
  const hints = rows.flatMap((r) => r.find((e) => e.classes.has('card-menu-keybinding')).map((k) => [r.attrs.get('data-item'), k.textContent]));
  assert.deepEqual(hints, [['edit', 'F2'], ['open-text', 'Ctrl+Enter'], ['delete', 'Delete']]);
  assert.equal(byId('edit').attrs.get('aria-keyshortcuts'), 'F2');
  assert.equal(byId('open-text').attrs.get('aria-keyshortcuts'), 'Control+Enter');
  assert.equal(byId('delete').attrs.get('aria-keyshortcuts'), 'Delete');
  assert.equal(byId('duplicate').attrs.get('aria-keyshortcuts'), undefined);

  const lanes = renderLaneMenu(doc, laneChoices(view, { lane: 0, card: 0 }), view.strings.moveToLane, view.strings.done);
  assert.equal(lanes.attrs.get('role'), 'menu');
  assert.ok(lanes.classes.has('card-submenu'));
  const laneRows = lanes.children as FakeElement[];
  assert.deepEqual(laneRows.map((r) => [r.attrs.get('data-lane'), r.attrs.get('aria-disabled')]), [['0', 'true'], ['1', undefined]]);
  assert.equal(laneRows[0]!.find((e) => e.classes.has('card-menu-done')).length, 0);
  const done = laneRows[1]!.find((e) => e.classes.has('card-menu-done'))[0]!;
  assert.equal(done.textContent, '✓');
  assert.equal(done.attrs.get('aria-label'), view.strings.done);
});

test('card menu: lane names stay text', () => {
  const texts = ['---', 'kanban-plugin: basic', '---', '## <img src=x onerror=alert(1)>', '- [ ] a', '## B'];
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
  const lanes = renderLaneMenu(doc, laneChoices(view, { lane: 1, card: 0 }), view.strings.moveToLane, view.strings.done);
  const label = lanes.find((e) => e.classes.has('card-menu-label'))[0]!;
  assert.deepEqual(label.children, []);
  assert.equal(label.textContent, '<img src=x onerror=alert(1)>');
  assert.ok(lanes.find((e) => !['div', 'span'].includes(e.tagName)).length === 0);
});

test('each card has a menu button between title and body', () => {
  const { root, view } = render('12');
  const card = root.find((e) => e.tagName === 'li')[0]!;
  const kids = card.children.filter((c): c is FakeElement => typeof c !== 'string');
  const at = kids.findIndex((k) => k.classes.has('card-menu-button'));
  assert.ok(kids[at - 1]!.classes.has('card-title'));
  const button = kids[at]!;
  assert.equal(button.tagName, 'button');
  assert.equal(button.attrs.get('data-action'), 'card-menu');
  assert.equal(button.attrs.get('aria-label'), view.strings.cardMenu);
  assert.equal(button.attrs.get('aria-haspopup'), 'menu');
  assert.equal(button.attrs.get('tabindex'), '-1');
});

test('lane collapse button: one thin chevron, state in aria-expanded', () => {
  const texts = ['---', 'kanban-plugin: basic', '---', '## A', '- [ ] a', '## B'];
  const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20' });
  const root = renderBoard(doc, view, { collapsed: new Map([[1, true]]) });
  const buttons = root.find((e) => e.classes.has('lane-collapse'));
  assert.deepEqual(buttons.map((b) => [b.attrs.get('aria-expanded'), b.attrs.get('aria-label')]), [
    ['true', view.strings.collapse],
    ['false', view.strings.expand],
  ]);
  for (const button of buttons) {
    const [icon] = button.children as FakeElement[];
    assert.ok(icon!.classes.has('lane-collapse-icon'));
    assert.equal(icon!.textContent, String.fromCharCode(0x203a));
    assert.equal(icon!.attrs.get('aria-hidden'), 'true');
  }
});

test('check box switch (kanban.md 4.9): pressed state follows the board, hidden boxes keep the column', () => {
  const build = (settings: string | undefined, showCheckboxesDefault?: boolean) => {
    const texts = ['---', 'kanban-plugin: board', '---', '## A', '- [x] done', ...(settings === undefined ? [] : ['%% kanban:settings', '```', settings, '```', '%%'])];
    const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20', ...(showCheckboxesDefault === undefined ? {} : { showCheckboxesDefault }) });
    return renderBoard(doc, view, { collapsed: new Map() });
  };
  const switchOf = (root: ReturnType<typeof build>) => root.find((e) => e.classes.has('board-checkboxes'))[0];
  const hidden = build('{"kanban-plugin":"board"}');
  assert.equal(switchOf(hidden)?.attrs.get('aria-pressed'), 'false');
  assert.equal(switchOf(hidden)?.attrs.get('data-action'), 'toggle-checkboxes');
  assert.equal(hidden.find((e) => e.tagName === 'input' && e.classes.has('card-check')).length, 0, 'no check box');
  assert.equal(hidden.find((e) => e.classes.has('card-check-space')).length, 1, 'the column stays');
  assert.ok(hidden.find((e) => e.tagName === 'li')[0]!.classes.has('checked'), 'the checked state still shows');
  const shown = build('{"show-checkboxes":true}');
  assert.equal(switchOf(shown)?.attrs.get('aria-pressed'), 'true');
  assert.equal(shown.find((e) => e.tagName === 'input' && e.classes.has('card-check'))[0]?.attrs.has('checked'), true);
  assert.equal(switchOf(build(undefined, true)), undefined, 'no settings block: no switch');
});

test('width slider (kanban.md 4.10): a named range left of the check box switch, only where it can write', () => {
  const build = (settings: string | undefined, frontmatter?: string) => {
    const texts = ['---', 'kanban-plugin: board', ...(frontmatter ? [frontmatter] : []), '---', '## A', '- [ ] a', ...(settings === undefined ? [] : ['%% kanban:settings', '```', settings, '```', '%%'])];
    const view = buildBoardView(texts, parseBoard(texts), { today: '2026-10-20', strings: { ...DEFAULT_STRINGS, laneWidthValue: '{0}px', laneWidthTitle: 'W {0}' } });
    return renderBoard(doc, view, { collapsed: new Map() });
  };
  const sliderOf = (root: ReturnType<typeof build>) => root.find((e) => e.classes.has('board-lane-width'))[0];
  const root = build('{"lane-width":312.25}');
  const slider = sliderOf(root)!;
  assert.equal(slider.tagName, 'input');
  assert.deepEqual(
    ['type', 'min', 'max', 'step', 'value', 'aria-label', 'aria-valuetext', 'title'].map((name) => slider.attrs.get(name)),
    ['range', '200', '600', '8', '312.25', 'Lane width', '312.3px', 'W 312.3'],
  );
  const toolbar = root.find((e) => e.classes.has('board-toolbar'))[0]!;
  assert.deepEqual(
    toolbar.children.map((c) => (typeof c === 'string' ? c : [...c.classes][0])),
    ['board-lane-width', 'board-checkboxes', 'board-help'],
    'slider, check box switch, help',
  );
  assert.equal(sliderOf(build('{"kanban-plugin":"board"}'))?.attrs.get('value'), '272');
  assert.equal(sliderOf(build(undefined)), undefined, 'no settings block');
  assert.equal(sliderOf(build('{broken')), undefined, 'broken JSON');
  assert.equal(sliderOf(build('{"a":1}', 'lane-width: 250')), undefined, 'frontmatter lane-width');
  assert.deepEqual(laneWidthText(DEFAULT_STRINGS, 296), { 'aria-valuetext': '296 px', title: 'Lane width: 296 px. Double-click for the default width.' });
});
