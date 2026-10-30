// Card preview (kanban.md 3.3): content drawn through the shared Markdown display with the
// board's token rules, placement inside the window, the Ctrl+K Ctrl+I chord and the open and
// close rules in main.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canPreview,
  chordStep,
  placePreview,
  PREVIEW_CLOSE_MS,
  PREVIEW_DELAY_MS,
  previewBody,
  previewOnHover,
  renderCardPreview,
  type ChordKey,
} from '../../../src/features/kanban/browser/preview.ts';
import { parseBoard } from '../../../src/features/kanban/parser.ts';
import { buildBoardView } from '../../../src/features/kanban/view.ts';
import { fakeDocument as doc, type FakeElement } from '../../support/markdown.ts';

const LINES = [
  '---', 'kanban-plugin: basic', '---', '',
  '## Todo', '',
  '- [ ] [study] Exam prep [[Syllabus|plan]] #urgent @{2026-10-19}',
  '\t## Notes',
  '\t- [x] chapter 1 [[Ch1]]',
  '\t- [ ] chapter 2 @{2026-10-20} @@{09:30} #later',
  '\t\t- nested **bold #tag** and ==marked [[Hi]]==',
  '\t',
  '\t| a | b |',
  '\t|---|---|',
  '\t| `#notag` | [web](https://example.test) |',
  '\t',
  '\t```',
  '\t#notag [[NotLink]] @{2026-10-21}',
  '\t```',
  '\t<b>bold?</b> <script>alert(1)</script> [mail](mailto:a@b.test)',
  '- [ ] Title only',
  '- [x] Done card',
  '\tbody',
  '',
];
const view = buildBoardView(LINES, parseBoard(LINES), { today: '2026-10-20' });
const [rich, titleOnly, done] = view.lanes[0]!.cards;

const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'input', 'blockquote', 'pre', 'code', 'hr', 'br', 'strong', 'em', 's', 'mark', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ALLOWED_ATTRS = new Set(['id', 'role', 'aria-label', 'tabindex', 'data-action', 'data-target', 'data-date', 'title', 'type', 'disabled', 'checked', 'start', 'scope', 'dir']);

const render = () => renderCardPreview(doc, view, rich!, 'card-preview');
const byClass = (root: FakeElement, name: string) => root.find((e) => e.classes.has(name));

test('only safe elements and attributes; HTML stays text', () => {
  const root = render();
  for (const element of root.walk()) {
    assert.ok(ALLOWED_TAGS.has(element.tagName), element.tagName);
    for (const attr of element.attrs.keys()) assert.ok(ALLOWED_ATTRS.has(attr), attr);
  }
  assert.equal(root.find((e) => e.tagName === 'b' || e.tagName === 'script' || e.tagName === 'a').length, 0);
  assert.match(root.textContent ?? '', /<b>bold\?<\/b> <script>alert\(1\)<\/script>/);
  assert.equal(root.attrs.get('role'), 'tooltip');
  assert.equal(root.attrs.get('id'), 'card-preview');
  assert.equal(root.attrs.get('aria-label'), view.strings.cardPreview);
});

test('the title is drawn as on the board: category, wikilink, tag and date badges', () => {
  const title = byClass(render(), 'card-preview-title')[0]!;
  assert.equal(byClass(title, 'category')[0]?.textContent, 'study');
  assert.equal(byClass(title, 'tag')[0]?.textContent, '#urgent');
  const date = byClass(title, 'date')[0]!;
  assert.ok(date.classes.has('date-past'));
  const link = byClass(title, 'wikilink')[0]!;
  assert.deepEqual([link.textContent, link.attrs.get('data-action'), link.attrs.get('data-target'), link.attrs.get('tabindex')], ['plan', 'open-link', 'Syllabus', '-1']);
  const box = title.find((e) => e.tagName === 'input')[0]!;
  assert.ok(box.attrs.has('disabled') && !box.attrs.has('checked'));
});

test('the body is Markdown: heading, task list, nesting, table and code block', () => {
  const root = render();
  const body = byClass(root, 'card-preview-body')[0]!;
  assert.equal(body.find((e) => e.tagName === 'h4')[0]?.textContent, 'Notes');
  const tasks = byClass(body, 'md-task');
  assert.equal(tasks.length, 2);
  const boxes = body.find((e) => e.tagName === 'input');
  assert.ok(boxes.every((b) => b.attrs.has('disabled')), 'checkboxes cannot be pressed');
  assert.deepEqual(boxes.map((b) => b.attrs.has('checked')), [true, false]);
  assert.equal(body.find((e) => e.tagName === 'ul').length, 2, 'nested list');
  assert.equal(body.find((e) => e.tagName === 'table').length, 1);
  const code = body.find((e) => e.tagName === 'pre')[0]!;
  assert.equal(code.textContent, '#notag [[NotLink]] @{2026-10-21}');
  assert.equal(code.find((e) => e.classes.has('badge') || e.classes.has('wikilink')).length, 0, 'no tokens in code');
});

test('board tokens in the body keep their meaning; plain links are text only', () => {
  const body = byClass(render(), 'card-preview-body')[0]!;
  const links = byClass(body, 'wikilink');
  assert.deepEqual(links.map((l) => [l.textContent, l.attrs.get('data-target'), l.attrs.get('data-action'), l.attrs.get('tabindex')]), [
    ['Ch1', 'Ch1', 'open-link', '-1'],
    ['Hi', 'Hi', 'open-link', '-1'],
  ]);
  assert.deepEqual(byClass(body, 'tag').map((t) => t.textContent), ['#later', '#tag']);
  const dates = byClass(body, 'date');
  assert.equal(dates.length, 1);
  assert.ok(dates[0]!.classes.has('date-today'));
  assert.equal(byClass(body, 'time')[0]?.textContent, '09:30');
  // Inside **bold** the tag is still a badge; ==...== becomes a mark with the link inside.
  const strong = body.find((e) => e.tagName === 'strong')[0]!;
  assert.equal(byClass(strong, 'tag').length, 1);
  const mark = body.find((e) => e.tagName === 'mark')[0]!;
  assert.equal(byClass(mark, 'wikilink').length, 1);
  // Inline code stays code (no tag badge); links are inert, never open-url.
  assert.equal(body.find((e) => e.classes.has('md-code-span'))[0]?.textContent, '#notag');
  assert.equal(body.find((e) => e.attrs.get('data-action') === 'open-url' || e.attrs.has('data-url')).length, 0);
  assert.deepEqual(byClass(body, 'md-link-inert').map((l) => l.textContent), ['web', 'mail']);
  // Nothing in the popup is in the tab order.
  assert.equal(render().find((e) => e.attrs.get('tabindex') === '0').length, 0);
});

test('a checked card shows a checked box and the preview body is the edit text after the title', () => {
  const root = renderCardPreview(doc, view, done!, 'p');
  assert.ok(byClass(root, 'card-preview-title')[0]!.classes.has('checked'));
  assert.equal(previewBody(done!), 'body');
  assert.equal(previewBody(titleOnly!), '');
  assert.ok(previewBody(rich!).startsWith('## Notes\n- [x] chapter 1'));
  assert.ok(previewBody(rich!).includes('\t- nested'), 'deeper levels keep their indent');
});

test('only cards with a body, and only with the setting on', () => {
  assert.equal(canPreview(view, rich), true);
  assert.equal(canPreview(view, titleOnly), false);
  assert.equal(canPreview(view, undefined), false);
  const off = buildBoardView(LINES, parseBoard(LINES), { today: '2026-10-20', cardPreview: false });
  assert.equal(off.cardPreview, false);
  assert.equal(canPreview(off, off.lanes[0]!.cards[0]), false);
  assert.equal(view.cardPreview, true);
});

test('placement: right, then left, then below, then above, always inside the window', () => {
  const viewport = { width: 1200, height: 800 };
  const popup = { width: 400, height: 300 };
  const card = (left: number, top: number, width = 260, height = 80) => ({ left, top, right: left + width, bottom: top + height });
  assert.deepEqual(placePreview(card(20, 100), popup, viewport), { x: 288, y: 100, side: 'right' });
  assert.deepEqual(placePreview(card(800, 100), popup, viewport), { x: 392, y: 100, side: 'left' });
  // Near the bottom: moved up to stay inside.
  assert.deepEqual(placePreview(card(20, 700), popup, viewport), { x: 288, y: 492, side: 'right' });
  // A narrow window: below, else above.
  const narrow = { width: 500, height: 800 };
  assert.deepEqual(placePreview(card(40, 100, 420), popup, narrow), { x: 40, y: 188, side: 'below' });
  assert.deepEqual(placePreview(card(40, 600, 420), popup, narrow), { x: 40, y: 292, side: 'above' });
  // No room anywhere: inside the window all the same.
  const tiny = { width: 300, height: 200 };
  const placed = placePreview(card(10, 50, 280, 100), { width: 284, height: 184 }, tiny);
  assert.ok(placed.x >= 8 && placed.y >= 8 && placed.x + 284 <= 300 - 8 + 0.001 && placed.y + 184 <= 200 - 8 + 0.001, JSON.stringify(placed));
  // Scrolled partly off the top: never above the window.
  assert.ok(placePreview(card(20, -50), popup, viewport).y >= 8);
});

test('Ctrl+K Ctrl+I chord: starts only on a card, opens on Ctrl+I, waits on modifiers, otherwise replays', () => {
  const key = (k: string, code: string, mods: Partial<Pick<ChordKey, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}): ChordKey => ({
    key: k, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods,
  });
  assert.equal(chordStep(false, key('k', 'KeyK', { ctrlKey: true }), true), 'start');
  assert.equal(chordStep(false, key('k', 'KeyK', { metaKey: true }), true), 'start');
  assert.equal(chordStep(false, key('k', 'KeyK', { ctrlKey: true }), false), 'none');
  assert.equal(chordStep(false, key('K', 'KeyK', { ctrlKey: true, shiftKey: true }), true), 'none');
  assert.equal(chordStep(false, key('i', 'KeyI', { ctrlKey: true }), true), 'none');
  assert.equal(chordStep(true, key('i', 'KeyI', { ctrlKey: true }), true), 'open');
  assert.equal(chordStep(true, key('Control', 'ControlLeft', { ctrlKey: true }), true), 'wait');
  assert.equal(chordStep(true, key('i', 'KeyI'), true), 'replay');
  assert.equal(chordStep(true, key('w', 'KeyW', { ctrlKey: true }), true), 'replay');
  assert.equal(chordStep(true, key('ArrowDown', 'ArrowDown'), true), 'replay');
});

test('main.ts: 500ms rest to open, 150ms grace to close, and every close route', () => {
  assert.equal(PREVIEW_DELAY_MS, 500);
  assert.equal(PREVIEW_CLOSE_MS, 150);
  const main = readFileSync(new URL('../../../src/features/kanban/browser/main.ts', import.meta.url), 'utf8');
  const fn = (name: string) => {
    const body = new RegExp(`function ${name}\\([^)]*\\): void \\{([\\s\\S]*?)\\n\\}`).exec(main)?.[1];
    assert.ok(body, name);
    return body;
  };
  // Not while dragging, with the date picker open (kanban.md 3.3), editing, with the card menu
  // open, or (pointer) with a button held.
  assert.match(fn('openPreview'), /if \(drag \|\| datePicker \|\| host\.classList\.contains\('editing'\) \|\| host\.classList\.contains\('menu-open'\) \|\| \(!byKeyboard && pointerDown\)\) return;/);
  assert.match(fn('openPreview'), /closePreview\(\);/, 'one at a time');
  assert.match(fn('openPreview'), /placePreview\(/);
  assert.match(fn('openPreview'), /post\(\{ type: 'openLink'/, 'wikilinks open the note');
  assert.match(fn('editCard'), /closePreview\(\);/);
  assert.match(fn('openCardMenu'), /closePreview\(\);/);
  assert.match(fn('draw'), /locateEditor\(current\.view, \{ kind: 'card', id: keepPreview\.id \}\)/, 'redraw keeps it only for the same card');
  assert.match(main, /if \(key === 'Escape'\) \{[\s\S]*?closePreview\(\);/);
  assert.match(main, /'scroll',\s*\(event\) => \{\s*if \(preview && !preview\.root\.contains\(event\.target as Node\)\) closePreview\(\);/);
  assert.match(main, /app\.addEventListener\('dragstart', \(event\) => \{\s*drag = undefined;\s*closePreview\(\);/);
  assert.match(main, /previewTimer = setTimeout\(\(\) => \{[\s\S]*?openPreview\(ref, false\);[\s\S]*?\}, PREVIEW_DELAY_MS\);/);
  // The grace close removes the open popup only: cancelling the pending open timer too would
  // leave the card the pointer moved on to without a preview.
  assert.match(fn('schedulePreviewClose'), /setTimeout\(removePreview, PREVIEW_CLOSE_MS\)/);
  assert.doesNotMatch(fn('removePreview'), /previewTimer\)/);
  assert.match(fn('closePreview'), /clearTimeout\(previewTimer\)/);
  // The chord replays Ctrl+K to VS Code when the second key is not Ctrl+I.
  assert.match(fn('replayChordStart'), /window\.dispatchEvent\(replay\);/);
});

test('kanban.css: the popup is capped at 480px and 60% of the window and scrolls inside', () => {
  const css = readFileSync(new URL('../../../src/features/kanban/browser/kanban.css', import.meta.url), 'utf8');
  const rule = /\.card-preview \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /position: fixed;/);
  assert.match(rule, /max-width: min\(480px, calc\(100vw - 16px\)\);/);
  assert.match(rule, /max-height: 60vh;/);
  assert.match(rule, /overflow-y: auto;/);
});

test('the pointer opens the preview only over a folded card; the keyboard on any card with a body', () => {
  assert.equal(previewOnHover(true, false), true);
  assert.equal(previewOnHover(false, false), false);
  assert.equal(previewOnHover(false, true), true);
  const main = readFileSync(new URL('../../../src/features/kanban/browser/main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(!previewOnHover\(isFolded\(folds, view, card\), byKeyboard\)\) return;/);
});
