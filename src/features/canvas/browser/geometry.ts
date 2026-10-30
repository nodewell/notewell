// Canvas geometry (canvas.md 4): edge end points and curves, arrow heads, and the viewport
// (pan and zoom) math. Pure, so it runs under node:test.

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** screen = world * scale + (x, y). */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 4;
/** Arrow head length and half width, in canvas pixels. */
export const ARROW_LENGTH = 14;
export const ARROW_HALF_WIDTH = 6;

const NORMALS: Readonly<Record<Side, Point>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** The middle of one side of a rectangle. */
export function sidePoint(r: Rect, side: Side): Point {
  switch (side) {
    case 'top':
      return { x: r.x + r.width / 2, y: r.y };
    case 'right':
      return { x: r.x + r.width, y: r.y + r.height / 2 };
    case 'bottom':
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case 'left':
      return { x: r.x, y: r.y + r.height / 2 };
  }
}

/** The side of `r` that faces `target` (used when an edge names no side). */
export function facingSide(r: Rect, target: Point): Side {
  const c = center(r);
  // Relative to the rectangle's shape, so a wide card prefers its long sides less.
  const dx = (target.x - c.x) / Math.max(r.width, 1);
  const dy = (target.y - c.y) / Math.max(r.height, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

export interface EdgeInput {
  readonly fromSide?: Side;
  readonly toSide?: Side;
  readonly fromEnd: 'none' | 'arrow';
  readonly toEnd: 'none' | 'arrow';
}

export interface EdgeGeometry {
  /** SVG path data of the curve. */
  readonly path: string;
  /** SVG polygon points of each arrow head. */
  readonly arrows: readonly string[];
  /**
   * Where the label goes: the point of the curve nearest its middle that stays clear of both
   * cards (so a label never sits on a card's border or an arrow head when there is room).
   */
  readonly middle: Point;
  /**
   * Where the label sits: centered on the middle, or, on a short edge where a centered label
   * would cover the arrow heads, above a mostly horizontal curve or beside a vertical one.
   */
  readonly labelPlacement: 'center' | 'above' | 'beside';
}

/** Edges shorter than this (end to end, canvas pixels) move their label off the line. */
export const SHORT_EDGE = 160;

const round = (n: number): number => Math.round(n * 100) / 100;
const pt = (p: Point): string => `${round(p.x)} ${round(p.y)}`;

/** Polygon points of an arrow head whose tip touches `tip`, pointing against `outward`. */
export function arrowHead(tip: Point, outward: Point): string {
  const base = { x: tip.x + outward.x * ARROW_LENGTH, y: tip.y + outward.y * ARROW_LENGTH };
  const across = { x: -outward.y, y: outward.x };
  const a = { x: base.x + across.x * ARROW_HALF_WIDTH, y: base.y + across.y * ARROW_HALF_WIDTH };
  const b = { x: base.x - across.x * ARROW_HALF_WIDTH, y: base.y - across.y * ARROW_HALF_WIDTH };
  return `${round(tip.x)},${round(tip.y)} ${round(a.x)},${round(a.y)} ${round(b.x)},${round(b.y)}`;
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y };
}

/**
 * The curve between two cards: from the middle of one side to the middle of the other, leaving
 * and entering perpendicular to the sides. A side the edge does not name is the one facing the
 * other card. Arrow heads sit on the card's border; the curve stops at their base.
 */
export function edgeGeometry(from: Rect, to: Rect, edge: EdgeInput): EdgeGeometry {
  const fromSide = edge.fromSide ?? facingSide(from, edge.toSide !== undefined ? sidePoint(to, edge.toSide) : center(to));
  const toSide = edge.toSide ?? facingSide(to, edge.fromSide !== undefined ? sidePoint(from, edge.fromSide) : center(from));
  const startTip = sidePoint(from, fromSide);
  const endTip = sidePoint(to, toSide);
  const n0 = NORMALS[fromSide];
  const n1 = NORMALS[toSide];
  const start = edge.fromEnd === 'arrow' ? { x: startTip.x + n0.x * ARROW_LENGTH, y: startTip.y + n0.y * ARROW_LENGTH } : startTip;
  const end = edge.toEnd === 'arrow' ? { x: endTip.x + n1.x * ARROW_LENGTH, y: endTip.y + n1.y * ARROW_LENGTH } : endTip;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const pull = Math.min(Math.max(distance / 2, 40), 200);
  const c0 = { x: start.x + n0.x * pull, y: start.y + n0.y * pull };
  const c1 = { x: end.x + n1.x * pull, y: end.y + n1.y * pull };
  const arrows: string[] = [];
  if (edge.fromEnd === 'arrow') arrows.push(arrowHead(startTip, n0));
  if (edge.toEnd === 'arrow') arrows.push(arrowHead(endTip, n1));
  let labelPlacement: EdgeGeometry['labelPlacement'] = 'center';
  if (Math.hypot(endTip.x - startTip.x, endTip.y - startTip.y) < SHORT_EDGE) {
    // Direction of the curve at its middle (proportional to the derivative at t = 0.5).
    const dx = end.x + c1.x - c0.x - start.x;
    const dy = end.y + c1.y - c0.y - start.y;
    labelPlacement = Math.abs(dx) >= Math.abs(dy) ? 'above' : 'beside';
  }
  const at = (t: number): Point => cubic(start, c0, c1, end, t);
  return { path: `M ${pt(start)} C ${pt(c0)}, ${pt(c1)}, ${pt(end)}`, arrows, middle: labelPoint(at, from, to), labelPlacement };
}

/** How far a point lies outside a rectangle (0 inside or on it), along the farther axis. */
function clearance(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.max(dx, dy);
}

/** Clearance a label point should keep from both cards, in canvas pixels. */
const LABEL_CLEARANCE = 24;

function labelPoint(at: (t: number) => Point, from: Rect, to: Rect): Point {
  let best = at(0.5);
  let bestClearance = -1;
  // From the middle outwards: the first point clear of both cards wins, else the clearest one.
  for (let step = 0; step <= 8; step++) {
    for (const t of step === 0 ? [0.5] : [0.5 - step * 0.05, 0.5 + step * 0.05]) {
      const p = at(t);
      const c = Math.min(clearance(p, from), clearance(p, to));
      if (c >= LABEL_CLEARANCE) return p;
      if (c > bestClearance) {
        best = p;
        bestClearance = c;
      }
    }
  }
  return best;
}

/** The smallest rectangle around all `rects`, or undefined for none. */
export function bounds(rects: Iterable<Rect>): Rect | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return minX === Infinity ? undefined : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function clampScale(scale: number): number {
  return Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : 1;
}

/** Shows all of `area` centered in a `width` x `height` pane, never enlarged beyond 100%. */
export function fitViewport(area: Rect | undefined, width: number, height: number, padding = 48): Viewport {
  if (area === undefined) return { x: width / 2, y: height / 2, scale: 1 };
  const scale = clampScale(Math.min(1, (width - 2 * padding) / Math.max(area.width, 1), (height - 2 * padding) / Math.max(area.height, 1)));
  const c = center(area);
  return { x: width / 2 - c.x * scale, y: height / 2 - c.y * scale, scale };
}

/** Zooms by `factor` keeping the canvas point under (`cx`, `cy`) in place. */
export function zoomAt(vp: Viewport, factor: number, cx: number, cy: number): Viewport {
  const scale = clampScale(vp.scale * factor);
  const k = scale / vp.scale;
  return { x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k, scale };
}

/** Sets the zoom to `scale` around (`cx`, `cy`). */
export function zoomTo(vp: Viewport, scale: number, cx: number, cy: number): Viewport {
  return zoomAt(vp, clampScale(scale) / vp.scale, cx, cy);
}

/** Pans as little as possible so `r` is inside the pane (its top left first when it is larger). */
export function ensureVisible(vp: Viewport, r: Rect, width: number, height: number, margin = 24): Viewport {
  const left = r.x * vp.scale + vp.x;
  const top = r.y * vp.scale + vp.y;
  const right = left + r.width * vp.scale;
  const bottom = top + r.height * vp.scale;
  let dx = 0;
  let dy = 0;
  if (right > width - margin) dx = width - margin - right;
  if (left + dx < margin) dx = margin - left;
  if (bottom > height - margin) dy = height - margin - bottom;
  if (top + dy < margin) dy = margin - top;
  return dx === 0 && dy === 0 ? vp : { x: vp.x + dx, y: vp.y + dy, scale: vp.scale };
}

/** Reading order for lists and keyboard order: top to bottom, then left to right. */
export function readingOrder<T extends Rect>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}
