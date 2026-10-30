// Code fence detection (core.md 3.3, kanban.md 2.11). Lines inside a fence are never
// read as structure.

export interface FenceBlock {
  /** Index of the opening fence line. */
  readonly open: number;
  /** Index of the closing fence line, or `null` when the fence is never closed. */
  readonly close: number | null;
  /** Last line index covered by the block: `close`, or the last scanned line when unclosed. */
  readonly last: number;
  readonly marker: '`' | '~';
  /** Length of the opening marker run (3 or more). */
  readonly length: number;
  /** Leading whitespace of the opening line, kept as written. */
  readonly indent: string;
}

interface Opener {
  readonly marker: '`' | '~';
  readonly length: number;
  readonly indent: string;
}

// Any indentation is allowed: fences inside indented card bodies count (kanban.md 2.5).
const OPENER = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

function parseOpener(text: string): Opener | null {
  const match = OPENER.exec(text);
  if (match === null) return null;
  const indent = match[1];
  const run = match[2];
  const info = match[3];
  const marker = run[0] === '`' ? '`' : '~';
  // As in CommonMark, a backtick fence's info string cannot contain backticks.
  if (marker === '`' && info.includes('`')) return null;
  return { marker, length: run.length, indent };
}

function closes(text: string, opener: Opener): boolean {
  const trimmed = text.trim();
  if (trimmed.length < opener.length) return false;
  for (const ch of trimmed) if (ch !== opener.marker) return false;
  return true;
}

/**
 * Fence blocks in `texts[start .. end - 1]`. A fence closes on a line holding only a run
 * of the same character at least as long as the opener; an unclosed fence runs to `end - 1`.
 * Pass `start` past the frontmatter so `---` content is not scanned.
 */
export function findFences(texts: readonly string[], start = 0, end = texts.length): FenceBlock[] {
  const blocks: FenceBlock[] = [];
  let i = start;
  while (i < end) {
    const opener = parseOpener(texts[i]);
    if (opener === null) {
      i++;
      continue;
    }
    let close: number | null = null;
    for (let j = i + 1; j < end; j++) {
      if (closes(texts[j], opener)) {
        close = j;
        break;
      }
    }
    const last = close ?? end - 1;
    blocks.push({ open: i, close, last, ...opener });
    i = last + 1;
  }
  return blocks;
}

/**
 * Per-line flag over the whole `texts` array: true for lines in a fence block in
 * `texts[start .. end - 1]`, including the opening and closing fence lines.
 */
export function fenceMask(texts: readonly string[], start = 0, end = texts.length): boolean[] {
  const mask = new Array<boolean>(texts.length).fill(false);
  for (const block of findFences(texts, start, end)) {
    for (let i = block.open; i <= block.last; i++) mask[i] = true;
  }
  return mask;
}
