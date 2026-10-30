// Reference "normalizing script" for kanban.md 7.4. It imitates a simple external tool that
// reads a board the way Obsidian Kanban 2.x does (top-level headings are lanes, the items of
// the first list after a heading are cards, kanban.md 2.4~2.8) and rewrites it as "lane title
// + blank line + cards (+ body)". It is deliberately independent of the real board parser
// (src/features/kanban) so the two can be compared, and simpler: not fence-aware, HTML blocks
// only as comments, drops preamble and interstitial lines, and keeps the archive / settings
// tail verbatim.

export interface NormalCard {
  /** First line as written, e.g. `- [ ] title`. */
  readonly line: string;
  /** Body lines as written (indented and lazy continuation lines); blank lines only between body lines. */
  readonly body: readonly string[];
}

export interface NormalLane {
  /** Heading text, trimmed, without closing `#`s (setext lines joined by a space). */
  readonly title: string;
  /** Lane has a one-line `**Complete**` paragraph before its first list. */
  readonly complete: boolean;
  readonly cards: readonly NormalCard[];
}

export interface NormalBoard {
  /** Frontmatter lines including both `---` lines, or null. */
  readonly frontmatter: readonly string[] | null;
  readonly lanes: readonly NormalLane[];
  /** From the archive break (a thematic break before an `Archive` heading) or the first `%% kanban:settings` line to the end, verbatim. */
  readonly tail: readonly string[];
}

const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])(?=[ \t]|$)/;
const BREAK = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const OTHER_BLOCK = /^ {0,3}(>|```|~~~|<!--|<\/?(div|p|table|details|section|pre)[ \t>])/i;

const blank = (line: string): boolean => line.trim() === '';

/** Width of the leading whitespace, tabs to the next multiple of four. */
function columns(line: string, from = 0, start = 0): number {
  let col = start;
  for (let i = from; i < line.length && (line[i] === ' ' || line[i] === '\t'); i++) col = line[i] === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}

function heading(line: string): string | null {
  const match = /^ {0,3}#{1,6}(?=[ \t]|$)(.*)$/.exec(line);
  if (match === null) return null;
  return match[1].replace(/[ \t]+$/, '').replace(/(^|[ \t])#+$/, '$1').replace(/^[ \t]+|[ \t]+$/g, '');
}

interface Item {
  readonly kind: string;
  readonly contentColumn: number;
  readonly empty: boolean;
  readonly number: number | undefined;
  readonly content: string;
}

function item(line: string): Item | null {
  if (BREAK.test(line)) return null;
  const match = ITEM.exec(line);
  if (match === null) return null;
  const end = match[0].length;
  const markerEnd = columns(line) + match[2].length;
  const empty = blank(line.slice(end));
  const after = columns(line, end, markerEnd) - markerEnd;
  return {
    kind: match[2].slice(-1),
    contentColumn: empty || after > 4 ? markerEnd + 1 : markerEnd + after,
    empty,
    number: match[3] === undefined ? undefined : Number(match[3]),
    content: line.slice(end),
  };
}

const startsBlock = (line: string): boolean => heading(line) !== null || BREAK.test(line) || OTHER_BLOCK.test(line) || ITEM.test(line);

/** Text a lazy continuation line may follow: not a heading, break, fence or comment (list and quote markers looked through). */
function paragraphText(line: string): boolean {
  let text = line.trimStart();
  for (let next = item(text); next !== null && !next.empty; next = item(text)) text = next.content.trimStart();
  while (text.startsWith('>')) text = text.slice(1).trimStart();
  return text !== '' && heading(text) === null && !BREAK.test(text) && !/^(```|~~~|<!--)/.test(text) && item(text)?.empty !== true;
}

export function readNormalized(source: string): NormalBoard {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  let i = 0;
  let frontmatter: string[] | null = null;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, n) => n > 0 && line.trim() === '---');
    if (close !== -1) {
      frontmatter = lines.slice(0, close + 1);
      i = close + 1;
    }
  }

  type Lane = { title: string; complete: boolean; cards: { line: string; body: string[] }[]; listed: boolean };
  const lanes: Lane[] = [];
  let tail: string[] = [];
  // The open list: its kind, the current item's content column and card (null outside the first list).
  let list: { kind: string; column: number; card: { line: string; body: string[] } | null; lazy: boolean; blanks: string[] } | null = null;
  let para: string[] | null = null;
  let quote = false;
  let comment = false;

  const lane = (): Lane | undefined => lanes[lanes.length - 1];
  const endPara = (): void => {
    const current = lane();
    if (para !== null && para.length === 1 && para[0].trim() === '**Complete**' && current !== undefined && !current.listed) current.complete = true;
    para = null;
  };
  // A thematic break, blank lines, then a heading named Archive (ATX or setext).
  const archiveAt = (at: number): boolean => {
    let next = at + 1;
    while (next < lines.length && blank(lines[next])) next++;
    if (next >= lines.length) return false;
    if (heading(lines[next]) === 'Archive') return true;
    return lines[next].trim() === 'Archive' && next + 1 < lines.length && UNDERLINE.test(lines[next + 1]);
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('%% kanban:settings')) {
      tail = lines.slice(i);
      break;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    if (list !== null) {
      if (blank(line)) {
        list.blanks.push(line);
        list.lazy = false;
        continue;
      }
      if (columns(line) >= list.column) {
        list.card?.body.push(...list.blanks, line);
        list.blanks = [];
        list.lazy = paragraphText(line);
        continue;
      }
      const next = item(line);
      if (next !== null && next.kind === list.kind) {
        const card: { line: string; body: string[] } | null = list.card === null ? null : { line, body: [] };
        if (card !== null) lane()!.cards.push(card);
        list = { kind: next.kind, column: next.contentColumn, card, lazy: !next.empty && paragraphText(next.content), blanks: [] };
        continue;
      }
      if (next === null && list.blanks.length === 0 && list.lazy && !startsBlock(line)) {
        list.card?.body.push(line);
        continue;
      }
      list = null;
    }

    if (blank(line)) {
      endPara();
      quote = false;
      continue;
    }
    if (para === null && !quote && columns(line) >= 4) continue;
    const title = heading(line);
    if (title !== null) {
      endPara();
      quote = false;
      lanes.push({ title, complete: false, cards: [], listed: false });
      continue;
    }
    if (para !== null && UNDERLINE.test(line)) {
      lanes.push({ title: para.map((l) => l.replace(/^[ \t]+|[ \t]+$/g, '')).join(' '), complete: false, cards: [], listed: false });
      para = null;
      continue;
    }
    if (BREAK.test(line)) {
      endPara();
      quote = false;
      if (archiveAt(i)) {
        tail = lines.slice(i);
        break;
      }
      continue;
    }
    if (OTHER_BLOCK.test(line)) {
      endPara();
      quote = /^ {0,3}>/.test(line);
      comment = line.trimStart().startsWith('<!--') && !line.slice(line.indexOf('<!--') + 4).includes('-->');
      continue;
    }
    const next = item(line);
    if (next !== null && (para === null && !quote || (!next.empty && (next.number === undefined || next.number === 1)))) {
      endPara();
      quote = false;
      const current = lane();
      const card = current !== undefined && !current.listed ? { line, body: [] } : null;
      if (current !== undefined) current.listed = true;
      if (card !== null) current!.cards.push(card);
      list = { kind: next.kind, column: next.contentColumn, card, lazy: !next.empty && paragraphText(next.content), blanks: [] };
      continue;
    }
    if (!quote) (para ??= []).push(line);
  }
  endPara();
  return { frontmatter, lanes: lanes.map(({ title, complete, cards }) => ({ title, complete, cards })), tail };
}

export function writeNormalized(board: NormalBoard, eol: '\n' | '\r\n' = '\n'): string {
  const out: string[] = [];
  if (board.frontmatter !== null) out.push(...board.frontmatter, '');
  for (const lane of board.lanes) {
    out.push(`## ${lane.title}`, '');
    if (lane.complete) out.push('**Complete**');
    for (const card of lane.cards) out.push(card.line, ...card.body);
    out.push('');
  }
  out.push(...board.tail);
  return out.map((line) => line + eol).join('');
}
