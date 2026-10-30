// The extension icon: images/icon.png is what the Marketplace and VS Code show;
// images/icon.svg is the hand-written source it is rendered from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

/** Decodes an 8-bit RGBA, non-interlaced PNG (enough for the rendered icon). */
function decodePng(buffer: Buffer) {
  assert.equal(buffer.toString('latin1', 1, 4), 'PNG');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const [depth, colorType, , , interlace] = buffer.subarray(24, 29);
  const chunks: Buffer[] = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    if (buffer.toString('latin1', at + 4, at + 8) === 'IDAT') chunks.push(buffer.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predicted = a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      pixels[y * stride + x] = (value + predicted) & 255;
    }
  }
  return { width, height, depth, colorType, interlace, alpha: (x: number, y: number) => pixels[y * stride + x * 4 + 3]! };
}

test('package.json points at a 256x256 PNG with a transparent background', () => {
  assert.equal(manifest.icon, 'images/icon.png');
  const png = decodePng(readFileSync(new URL(manifest.icon, root)));
  assert.deepEqual([png.width, png.height, png.depth, png.colorType, png.interlace], [256, 256, 8, 6, 0]);
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]]) assert.equal(png.alpha(x!, y!), 0, `corner ${x},${y}`);
  assert.equal(png.alpha(128, 128), 255, 'opaque center');
});

test('the SVG source is self-contained: no text, fonts, scripts or external references', () => {
  const svg = readFileSync(new URL('images/icon.svg', root), 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256"/);
  assert.doesNotMatch(svg, /<(text|tspan|image|script|style|foreignObject|use|font)\b/i);
  assert.doesNotMatch(svg, /\b(href|xlink:href|src)\s*=|url\((?!#)|@import|font-family/i);
  // Notewell palette only; nothing in Obsidian's purple range.
  for (const [hex] of svg.matchAll(/#[0-9a-f]{6}\b/gi)) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(!(r! > b! * 0.6 && b! > g! * 1.2 && r! > g!), `purple-ish color ${hex}`);
  }
});
