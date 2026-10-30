// Detail position and splitter sizes (backlog.md 4.1): defaults, minimums, remembered shares,
// keyboard steps and drag, plus the persisted state and the toolbar control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_UI_STATE, filterOptions, restoreUiState } from '../../../src/features/backlog/browser/filters.ts';
import {
  BIG_STEP,
  clampDetail,
  defaultDetailSize,
  detailSize,
  dragDetailSize,
  MIN_CONTENT,
  MIN_DETAIL,
  splitterKey,
  splitterValues,
  STEP,
  storedShare,
} from '../../../src/features/backlog/browser/layout.ts';
import { renderToolbar } from '../../../src/features/backlog/browser/render-board.ts';
import { validateWebviewMessage } from '../../../src/features/backlog/messages.ts';
import { fakeDocument as doc, fixtureView } from './browser-view.ts';

const keyOf = (key: string, shiftKey = false) => ({ key, shiftKey, ctrlKey: false, metaKey: false, altKey: false });

test('defaults: 45% below, as before on the right (at most 560px)', () => {
  assert.equal(defaultDetailSize('bottom', 800), 360);
  assert.equal(defaultDetailSize('right', 1000), 480);
  assert.equal(defaultDetailSize('right', 2000), 560);
});

test('both panes keep their minimum; too small for both splits in half', () => {
  assert.equal(clampDetail(50, 800), MIN_DETAIL);
  assert.equal(clampDetail(790, 800), 800 - MIN_CONTENT);
  assert.equal(clampDetail(300, 800), 300);
  assert.equal(clampDetail(200, 250), 125, 'below MIN_CONTENT + MIN_DETAIL');
  assert.equal(clampDetail(200, 0), 0);
  assert.equal(detailSize('bottom', 800, undefined), 360);
  assert.equal(detailSize('bottom', 800, 0.25), 200);
  assert.equal(detailSize('bottom', 300, 0.9), 300 - MIN_CONTENT, 'a remembered share is re-clamped for a smaller window');
});

test('remembered shares round-trip', () => {
  assert.equal(storedShare(360, 800), 0.45);
  assert.equal(storedShare(1, 3), 0.3333);
  assert.equal(storedShare(10, 0), undefined);
  assert.equal(detailSize('right', 1000, storedShare(321, 1000)), 321);
});

test('separator values: the board/list share in percent with its min and max', () => {
  assert.deepEqual(splitterValues(360, 800), { now: 55, min: 15, max: 80 });
  assert.deepEqual(splitterValues(125, 250), { now: 50, min: 50, max: 50 });
});

test('keys: arrows move by STEP, Shift by BIG_STEP, Home/End to the ends; other keys are not handled', () => {
  const total = 800;
  assert.equal(splitterKey('bottom', keyOf('ArrowUp'), 300, total), 300 + STEP, 'up grows the detail below');
  assert.equal(splitterKey('bottom', keyOf('ArrowDown'), 300, total), 300 - STEP);
  assert.equal(splitterKey('bottom', keyOf('ArrowUp', true), 300, total), 300 + BIG_STEP);
  assert.equal(splitterKey('right', keyOf('ArrowLeft'), 300, total), 300 + STEP, 'left grows the detail on the right');
  assert.equal(splitterKey('right', keyOf('ArrowRight', true), 300, total), 300 - BIG_STEP);
  assert.equal(splitterKey('bottom', keyOf('Home'), 300, total), total - MIN_CONTENT, 'Home: splitter to its start, largest detail');
  assert.equal(splitterKey('bottom', keyOf('End'), 300, total), MIN_DETAIL);
  assert.equal(splitterKey('bottom', keyOf('ArrowDown'), MIN_DETAIL, total), MIN_DETAIL, 'stops at the minimum');
  assert.equal(splitterKey('bottom', keyOf('ArrowLeft'), 300, total), undefined, 'across the split: not handled');
  assert.equal(splitterKey('right', keyOf('ArrowUp'), 300, total), undefined);
  assert.equal(splitterKey('bottom', { ...keyOf('ArrowUp'), ctrlKey: true }, 300, total), undefined);
  assert.equal(splitterKey('bottom', keyOf('Enter'), 300, total), undefined);
});

test('drag: distance from the pointer to the far edge, clamped', () => {
  assert.equal(dragDetailSize(500, 900, 6, 894), 397);
  assert.equal(dragDetailSize(890, 900, 6, 894), MIN_DETAIL);
  assert.equal(dragDetailSize(0, 900, 6, 894), 894 - MIN_CONTENT);
});

test('persisted state: pane sizes are kept per position and checked', () => {
  assert.deepEqual(DEFAULT_UI_STATE.paneSizes, {});
  assert.deepEqual(restoreUiState({ paneSizes: { bottom: 0.3, right: 0.5 } }).paneSizes, { bottom: 0.3, right: 0.5 });
  assert.deepEqual(restoreUiState({ paneSizes: { bottom: 2, right: -1, left: 0.4 } }).paneSizes, {});
  assert.deepEqual(restoreUiState({ paneSizes: 'big' }).paneSizes, {});
  assert.deepEqual(restoreUiState({}).paneSizes, {});
});

test('toolbar: two position buttons with a pressed state; the message validates', () => {
  const view = fixtureView();
  const toolbar = renderToolbar(doc, view, DEFAULT_UI_STATE, filterOptions(view, view.strings), 'bottom');
  const [group] = toolbar.byClass('detail-position');
  assert.deepEqual([group.attrs.get('role'), group.attrs.get('aria-label')], ['group', view.strings.detailPosition]);
  const buttons = toolbar.find((e) => e.attrs.get('data-action') === 'set-detail-position');
  assert.deepEqual(
    buttons.map((b) => [b.attrs.get('data-position'), b.attrs.get('aria-pressed'), b.attrs.get('aria-label')]),
    [['bottom', 'true', view.strings.detailBelow], ['right', 'false', view.strings.detailRight]],
  );
  const right = renderToolbar(doc, view, DEFAULT_UI_STATE, filterOptions(view, view.strings), 'right');
  assert.deepEqual(right.find((e) => e.attrs.get('data-action') === 'set-detail-position').map((b) => b.attrs.get('aria-pressed')), ['false', 'true']);
  assert.equal(fixtureView().detailPosition, 'bottom', 'the view default');
  assert.ok(validateWebviewMessage({ type: 'setDetailPosition', position: 'right' }).ok);
  assert.equal(validateWebviewMessage({ type: 'setDetailPosition', position: 'top' }).ok, false);
});
