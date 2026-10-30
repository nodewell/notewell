// Line model: a document as lines with per-line line endings and a separate BOM,
// so that parse -> join reproduces the source exactly (core.md 3.3, kanban.md 2.10).

/** Line ending of one line. `''` only on the last line when the file has no trailing newline. */
export type Eol = '\n' | '\r\n' | '';

export interface Line {
  /** Line content without its line ending. A lone `\r` is kept as content. */
  readonly text: string;
  readonly eol: Eol;
}

export interface LineDocument {
  /** True when the source started with U+FEFF. The BOM is not part of any line. */
  readonly bom: boolean;
  /**
   * Lines in order. An empty source has no lines. A source ending with a line break
   * has no extra empty line at the end: `"a\n"` is one line `{ text: 'a', eol: '\n' }`.
   */
  readonly lines: readonly Line[];
}

export const BOM = '\uFEFF';

export function parseLines(source: string): LineDocument {
  const bom = source.startsWith(BOM);
  const body = bom ? source.slice(BOM.length) : source;
  const lines: Line[] = [];
  let start = 0;
  while (start < body.length) {
    const lf = body.indexOf('\n', start);
    if (lf === -1) {
      lines.push({ text: body.slice(start), eol: '' });
      break;
    }
    if (lf > start && body.charCodeAt(lf - 1) === 13) {
      lines.push({ text: body.slice(start, lf - 1), eol: '\r\n' });
    } else {
      lines.push({ text: body.slice(start, lf), eol: '\n' });
    }
    start = lf + 1;
  }
  return { bom, lines };
}

export function joinLines(doc: LineDocument): string {
  let out = doc.bom ? BOM : '';
  for (const line of doc.lines) out += line.text + line.eol;
  return out;
}

/** Line texts only, for the line-based checks in this module. */
export function lineTexts(doc: LineDocument): string[] {
  return doc.lines.map((line) => line.text);
}

export function hasTrailingNewline(doc: LineDocument): boolean {
  const last = doc.lines[doc.lines.length - 1];
  return last !== undefined && last.eol !== '';
}

/**
 * The line ending to use for newly inserted lines: the more frequent of LF and CRLF.
 * On a tie the one that appears first wins; a document without line breaks uses LF.
 */
export function dominantEol(doc: LineDocument): '\n' | '\r\n' {
  let lf = 0;
  let crlf = 0;
  let first: '\n' | '\r\n' | undefined;
  for (const { eol } of doc.lines) {
    if (eol === '') continue;
    if (eol === '\n') lf++;
    else crlf++;
    first ??= eol;
  }
  if (lf !== crlf) return lf > crlf ? '\n' : '\r\n';
  return first ?? '\n';
}
