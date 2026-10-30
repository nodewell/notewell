// Shared helpers for the canvas tests: fixture variants and reading.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BOM } from '../../../src/core/lines.ts';
import { readCanvas, type Canvas } from '../../../src/features/canvas/model.ts';
import type { JsonDocument } from '../../../src/core/json-positions.ts';

const fixtureDir = new URL('../../fixtures/canvas/', import.meta.url);
export const fixtureNames = readdirSync(fixtureDir).filter((name) => name.endsWith('.canvas'));

export function readFixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), 'utf8');
}

/** Each fixture as written plus CRLF, BOM and no-final-newline variants. */
export function variants(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  for (const name of fixtureNames) {
    const lf = readFixture(name);
    const crlf = lf.replace(/\n/g, '\r\n');
    out.push(
      { name, source: lf },
      { name: `${name} CRLF`, source: crlf },
      { name: `${name} BOM`, source: BOM + lf },
      { name: `${name} BOM CRLF`, source: BOM + crlf },
      { name: `${name} no final newline`, source: lf.replace(/\n$/, '') },
    );
  }
  return out;
}

export function stripBom(source: string): string {
  return source.startsWith(BOM) ? source.slice(1) : source;
}

/** Reads a canvas that must be readable. */
export function read(source: string): { canvas: Canvas; doc: JsonDocument | null } {
  const result = readCanvas(source);
  assert.ok(result.ok, result.ok ? '' : result.issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  return { canvas: result.canvas, doc: result.doc };
}
