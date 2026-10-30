// Edge geometry, viewport math and keyboard/wheel decisions of the canvas webview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrowHead,
  bounds,
  edgeGeometry,
  ensureVisible,
  facingSide,
  fitViewport,
  MAX_SCALE,
  MIN_SCALE,
  readingOrder,
  sidePoint,
  zoomAt,
  zoomTo,
} from '../../../src/features/canvas/browser/geometry.ts';
import { keyAction, wheelAction, PAN_STEP, PAN_STEP_FAST } from '../../../src/features/canvas/browser/keys.ts';

const A = { x: 0, y: 0, width: 100, height: 50 };
const B = { x: 300, y: 0, width: 100, height: 50 };
const C = { x: 0, y: 300, width: 100, height: 50 };

test('side points and the side facing another card', () => {
  assert.deepEqual(sidePoint(A, 'top'), { x: 50, y: 0 });
  assert.deepEqual(sidePoint(A, 'right'), { x: 100, y: 25 });
  assert.deepEqual(sidePoint(A, 'bottom'), { x: 50, y: 50 });
  assert.deepEqual(sidePoint(A, 'left'), { x: 0, y: 25 });
  assert.equal(facingSide(A, { x: 350, y: 25 }), 'right');
  assert.equal(facingSide(B, { x: 50, y: 25 }), 'left');
  assert.equal(facingSide(A, { x: 50, y: 325 }), 'bottom');
  assert.equal(facingSide(C, { x: 50, y: 25 }), 'top');
});

test('edges start and end on the named or facing sides; arrows follow the ends', () => {
  const plain = edgeGeometry(A, B, { fromEnd: 'none', toEnd: 'none' });
  assert.match(plain.path, /^M 100 25 C .*, 300 25$/);
  assert.deepEqual(plain.arrows, []);
  assert.deepEqual(plain.middle, { x: 200, y: 25 });

  const arrow = edgeGeometry(A, B, { fromEnd: 'none', toEnd: 'arrow' });
  // The curve stops at the arrow's base; the tip touches the card.
  assert.match(arrow.path, /, 286 25$/);
  assert.deepEqual(arrow.arrows, [arrowHead({ x: 300, y: 25 }, { x: -1, y: 0 })]);
  assert.equal(arrow.arrows[0], '300,25 286,19 286,31');

  const both = edgeGeometry(A, C, { fromSide: 'right', toSide: 'right', fromEnd: 'arrow', toEnd: 'arrow' });
  assert.match(both.path, /^M 114 25 C /);
  assert.equal(both.arrows.length, 2);
  // One side named: the other faces it.
  const half = edgeGeometry(A, C, { toSide: 'top', fromEnd: 'none', toEnd: 'none' });
  assert.match(half.path, /^M 50 50 C .*, 50 300$/);
});

test('bounds, fit and zoom keep the point under the cursor', () => {
  assert.equal(bounds([]), undefined);
  assert.deepEqual(bounds([A, B, C]), { x: 0, y: 0, width: 400, height: 350 });
  const fitted = fitViewport({ x: 0, y: 0, width: 400, height: 350 }, 1000, 800);
  assert.equal(fitted.scale, 1, 'never enlarged');
  assert.deepEqual([fitted.x, fitted.y], [300, 225]);
  const small = fitViewport({ x: -5000, y: 0, width: 10000, height: 100 }, 1000, 800);
  assert.ok(small.scale < 0.1);
  assert.ok(Math.abs(small.x + 0 * small.scale - 500) < 1e-6, 'centered');
  assert.equal(fitViewport({ x: 0, y: 0, width: 1e9, height: 1 }, 1000, 800).scale, MIN_SCALE);

  const vp = { x: 10, y: 20, scale: 1 };
  const zoomed = zoomAt(vp, 2, 110, 120);
  // The canvas point under (110, 120) was (100, 100) and still is.
  assert.deepEqual([(110 - zoomed.x) / zoomed.scale, (120 - zoomed.y) / zoomed.scale], [100, 100]);
  assert.equal(zoomAt(vp, 1000, 0, 0).scale, MAX_SCALE);
  assert.equal(zoomAt(vp, 0, 0, 0).scale, MIN_SCALE);
  assert.equal(zoomTo({ x: 0, y: 0, scale: 0.5 }, 1, 0, 0).scale, 1);
});

test('ensureVisible pans only as far as needed', () => {
  const vp = { x: 0, y: 0, scale: 1 };
  assert.equal(ensureVisible(vp, { x: 100, y: 100, width: 50, height: 50 }, 800, 600), vp);
  assert.deepEqual(ensureVisible(vp, { x: 900, y: 100, width: 50, height: 50 }, 800, 600), { x: -174, y: 0, scale: 1 });
  assert.deepEqual(ensureVisible(vp, { x: -100, y: -100, width: 50, height: 50 }, 800, 600), { x: 124, y: 124, scale: 1 });
  // Larger than the pane: its top left comes first.
  assert.deepEqual(ensureVisible(vp, { x: 0, y: 0, width: 2000, height: 2000 }, 800, 600), { x: 24, y: 24, scale: 1 });
});

test('reading order is top to bottom, then left to right', () => {
  assert.deepEqual(readingOrder([C, B, A]).map((r) => r), [A, B, C]);
});

const key = (name: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; code: string }> = {}) => ({
  key: name,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
});

test('keys: arrows pan only without a selected card; zoom, fit, open, clear', () => {
  assert.deepEqual(keyAction(key('ArrowLeft'), false), { kind: 'pan', dx: -PAN_STEP, dy: 0 });
  assert.deepEqual(keyAction(key('ArrowDown', { shiftKey: true }), false), { kind: 'pan', dx: 0, dy: PAN_STEP_FAST });
  assert.equal(keyAction(key('ArrowLeft'), true), undefined);
  assert.equal(keyAction(key('ArrowLeft', { altKey: true }), false), undefined);
  assert.equal(keyAction(key('+'), false)?.kind, 'zoom');
  assert.ok((keyAction(key('-'), false) as { factor: number }).factor < 1);
  assert.equal(keyAction(key('='), true)?.kind, 'zoom');
  assert.equal(keyAction(key('+', { ctrlKey: true }), false), undefined, 'Ctrl+= is VS Code zoom');
  assert.deepEqual(keyAction(key('0'), false), { kind: 'zoomReset' });
  assert.deepEqual(keyAction(key('!', { shiftKey: true }), false), { kind: 'fit' });
  assert.deepEqual(keyAction(key('&', { shiftKey: true, code: 'Digit1' }), false), { kind: 'fit' });
  assert.deepEqual(keyAction(key('Enter'), true), { kind: 'open' });
  assert.equal(keyAction(key('Enter'), false), undefined);
  assert.deepEqual(keyAction(key('Escape'), true), { kind: 'clear' });
  assert.equal(keyAction(key('a'), false), undefined);
});

test('wheel: pans by default, zooms with Ctrl or Cmd, lines and pages scaled', () => {
  const wheel = (deltaX: number, deltaY: number, extra = {}) => wheelAction({ deltaX, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...extra });
  assert.deepEqual(wheel(3, 40), { kind: 'pan', dx: 3, dy: 40 });
  assert.deepEqual(wheel(0, 40, { shiftKey: true }), { kind: 'pan', dx: 40, dy: 0 });
  assert.deepEqual(wheel(0, 3, { deltaMode: 1 }), { kind: 'pan', dx: 0, dy: 48 });
  const zoomIn = wheel(0, -100, { ctrlKey: true });
  const zoomOut = wheel(0, 100, { metaKey: true });
  assert.equal(zoomIn.kind, 'zoom');
  assert.ok((zoomIn as { factor: number }).factor > 1 && (zoomOut as { factor: number }).factor < 1);
  // A huge delta is bounded.
  assert.ok((wheel(0, -1e9, { ctrlKey: true }) as { factor: number }).factor < 3);
});
