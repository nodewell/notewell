import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restoreScroll, sameScroll, SCROLL_ORIGIN } from '../../../src/features/kanban/browser/board-scroll.ts';

const css = readFileSync(new URL('../../../src/features/kanban/browser/kanban.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../../src/features/kanban/browser/main.ts', import.meta.url), 'utf8');

function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, selector);
  return css.slice(at, css.indexOf('}', at));
}

test('restoreScroll: keeps a stored position', () => {
  assert.deepEqual(restoreScroll({ left: 120.5, top: 40 }), { left: 120.5, top: 40 });
});

test('restoreScroll: anything unusable is the start of the board', () => {
  for (const stored of [undefined, null, 'x', 3]) assert.deepEqual(restoreScroll(stored), SCROLL_ORIGIN);
  assert.deepEqual(restoreScroll({ left: 'x', top: -5 }), SCROLL_ORIGIN);
  assert.deepEqual(restoreScroll({ left: Number.NaN, top: Number.POSITIVE_INFINITY }), SCROLL_ORIGIN);
  assert.deepEqual(restoreScroll({ top: 9 }), { left: 0, top: 9 });
});

test('sameScroll compares both axes', () => {
  assert.ok(sameScroll({ left: 1, top: 2 }, { left: 1, top: 2 }));
  assert.ok(!sameScroll({ left: 1, top: 2 }, { left: 1, top: 3 }));
  assert.ok(!sameScroll({ left: 0, top: 2 }, { left: 1, top: 2 }));
});

test('kanban.css: the board fills the window and scrolls by itself, so its scrollbar stays in sight', () => {
  assert.match(rule('#app'), /height: 100vh;/);
  assert.match(rule('.board-root'), /min-height: 0;/);
  assert.match(rule('.board'), /flex: 1;/);
  assert.match(rule('.board'), /min-height: 0;/);
  assert.match(rule('.board'), /overflow: auto;/);
});

test('a redraw puts the board back after the lane width and before the focus', () => {
  const draw = main.slice(main.indexOf('function draw(): void'), main.indexOf('function widthSlider()'));
  const width = draw.indexOf('showLaneWidth();');
  const scroll = draw.indexOf("querySelector('.board')?.scrollTo(boardScroll.left, boardScroll.top);");
  const focus = draw.indexOf('pendingFocus;');
  assert.ok(width >= 0 && width < scroll && scroll < focus);
});
