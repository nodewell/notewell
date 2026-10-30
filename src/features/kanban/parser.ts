// Board parser (kanban.md section 2). Pure: line texts in, line-index model out.
import { findFences, type FenceBlock } from '../../core/fences.ts';
import { findFrontmatter, frontmatterHasKey } from '../../core/frontmatter.ts';
import {
  atxHeadingText,
  canInterruptParagraph,
  closesHtmlBlock,
  htmlBlockStart,
  indentColumns,
  isAtxHeading,
  isBlank,
  isBlockQuote,
  isParagraphText,
  isSetextUnderline,
  isThematicBreak,
  listMarker,
  startsBlockInList,
  type HtmlBlockStart,
  type ListMarker,
  type MarkerKind,
} from './blocks.ts';
import { laneWidthValue } from '../../vault/settings.ts';
import { DEFAULT_DATE_TRIGGER, DEFAULT_TIME_TRIGGER } from './dates.ts';
import type { KanbanBoard, KanbanCard, KanbanLane, KanbanSettings, KanbanSettingsBlock, LineRange } from './model.ts';

export interface ParseOptions {
  /** Lane names treated as done lanes (`notewell.kanban.doneLanes`). Exact match. */
  readonly doneLanes?: readonly string[];
  /**
   * Settings for boards that do not set them (kanban.md 2.9): the Kanban plugin's settings in the
   * vault, and for the date format Obsidian's fallback (Daily notes, ...). Board values win.
   */
  readonly defaults?: SettingDefaults;
}

export interface SettingDefaults {
  readonly dateFormat?: string;
  readonly dateTrigger?: string;
  readonly timeTrigger?: string;
  readonly linkDateToDailyNote?: boolean;
}

export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

const SETTINGS_OPEN = /^%% kanban:settings[ \t]*$/;
const FENCE_MARKER_LINE = /^[ \t]*(`{3,}|~{3,})/;
// A check box: one character other than `]`, then whitespace and more text (as Obsidian reads
// it), or nothing at all (an empty card).
const CHECK_BOX = /^\[([^\]])\](?:[ \t]+(?=[^ \t])|$)/;

function rangeMask(length: number, blocks: readonly FenceBlock[]): boolean[] {
  const mask = new Array<boolean>(length).fill(false);
  for (const block of blocks) for (let i = block.open; i <= block.last; i++) mask[i] = true;
  return mask;
}

/**
 * The settings block: the last column-0 `%% kanban:settings` line that is not inside a
 * closed code fence and has a later `%%` line. Unclosed fences do not hide it (2.11).
 */
function findSettingsBlock(texts: readonly string[], bodyStart: number): LineRange | null {
  const closed = findFences(texts, bodyStart).filter((block) => block.close !== null);
  const hidden = rangeMask(texts.length, closed);
  for (let open = texts.length - 1; open >= bodyStart; open--) {
    if (hidden[open] || !SETTINGS_OPEN.test(texts[open]!)) continue;
    for (let close = open + 1; close < texts.length; close++) {
      if (texts[close]!.trim() === '%%') return { start: open, end: close + 1 };
    }
  }
  return null;
}

function readSettingsJson(texts: readonly string[], block: LineRange): Record<string, unknown> | null {
  const inner = texts.slice(block.start + 1, block.end - 1).filter((t) => !FENCE_MARKER_LINE.test(t));
  try {
    const data: unknown = JSON.parse(inner.join('\n'));
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Scalar `<key>:` value from the frontmatter lines, without YAML parsing. */
function frontmatterScalar(texts: readonly string[], frontmatter: LineRange | null, key: string): string | undefined {
  if (frontmatter === null) return undefined;
  const pattern = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`);
  for (let i = frontmatter.start + 1; i < frontmatter.end - 1; i++) {
    const match = pattern.exec(texts[i]!);
    if (match === null) continue;
    const value = match[1]!.replace(/^(['"])(.*)\1$/, '$2');
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** Frontmatter values of the settings the board reads; the settings block wins (2.9). */
interface FrontmatterSettings {
  readonly dateFormat?: string | undefined;
  readonly dateTrigger?: string | undefined;
  readonly timeTrigger?: string | undefined;
  readonly linkDateToDailyNote?: string | undefined;
  readonly showCheckboxes?: string | undefined;
  readonly laneWidth?: string | undefined;
}

function frontmatterSettings(texts: readonly string[], frontmatter: LineRange | null): FrontmatterSettings {
  return {
    dateFormat: frontmatterScalar(texts, frontmatter, 'date-format'),
    dateTrigger: frontmatterScalar(texts, frontmatter, 'date-trigger'),
    timeTrigger: frontmatterScalar(texts, frontmatter, 'time-trigger'),
    linkDateToDailyNote: frontmatterScalar(texts, frontmatter, 'link-date-to-daily-note'),
    showCheckboxes: frontmatterScalar(texts, frontmatter, 'show-checkboxes'),
    laneWidth: frontmatterScalar(texts, frontmatter, 'lane-width'),
  };
}

function resolveSettings(json: Record<string, unknown> | null, fm: FrontmatterSettings, defaults: SettingDefaults): KanbanSettings {
  const collapse = json?.['list-collapse'];
  const dateFormat = json?.['date-format'];
  const dateTrigger = json?.['date-trigger'];
  const timeTrigger = json?.['time-trigger'];
  const linkDate = json?.['link-date-to-daily-note'];
  const showCheckboxes = json?.['show-checkboxes'];
  const fmShow = fm.showCheckboxes === 'true' ? true : fm.showCheckboxes === 'false' ? false : undefined;
  const fmLinkDate = fm.linkDateToDailyNote === 'true' ? true : fm.linkDateToDailyNote === 'false' ? false : undefined;
  const nonEmpty = (value: string | undefined): string | undefined => (value === '' ? undefined : value);
  const widthInBlock = json !== null && json['lane-width'] !== undefined;
  return {
    laneWidth: widthInBlock ? laneWidthValue(json['lane-width']) : fm.laneWidth === undefined ? undefined : laneWidthValue(fm.laneWidth),
    laneWidthIn: { block: widthInBlock, frontmatter: fm.laneWidth !== undefined },
    listCollapse: Array.isArray(collapse) ? collapse.map((v) => v === true) : [],
    dateFormat:
      typeof dateFormat === 'string' && dateFormat !== ''
        ? dateFormat
        : (fm.dateFormat ?? nonEmpty(defaults.dateFormat) ?? DEFAULT_DATE_FORMAT),
    dateTrigger: typeof dateTrigger === 'string' ? dateTrigger : (fm.dateTrigger ?? defaults.dateTrigger ?? DEFAULT_DATE_TRIGGER),
    timeTrigger:
      typeof timeTrigger === 'string' && timeTrigger !== ''
        ? timeTrigger
        : (fm.timeTrigger ?? nonEmpty(defaults.timeTrigger) ?? DEFAULT_TIME_TRIGGER),
    linkDateToDailyNote: typeof linkDate === 'boolean' ? linkDate : (fmLinkDate ?? defaults.linkDateToDailyNote ?? false),
    showCheckboxes: typeof showCheckboxes === 'boolean' ? showCheckboxes : fmShow,
  };
}

interface ScannedItem {
  readonly start: number;
  last: number;
  readonly marker: ListMarker;
  /** The item's last line is paragraph text, so a lazy continuation line may follow. */
  lazy: boolean;
}

interface ScannedLane {
  readonly heading: LineRange;
  readonly headingKind: 'atx' | 'setext';
  readonly name: string;
  readonly cards: ScannedItem[];
  readonly completeMarkerLines: number[];
  /** A list has started in the lane: its first list holds the cards, later ones do not. */
  listSeen: boolean;
}

interface OpenList {
  readonly kind: MarkerKind;
  /** The lane's first list: its items are cards. */
  readonly first: boolean;
  item: ScannedItem;
  /** Blank lines since the item's last line. */
  blank: boolean;
}

/**
 * Reads the structure region as CommonMark blocks at the top level (kanban.md 2.4~2.8): lanes
 * are top-level headings, cards are the items of the first list after a heading, and thematic
 * breaks are collected for the archive. Lines inside list items, fences, HTML blocks and
 * quotes are never headings.
 */
function scanStructure(
  texts: readonly string[],
  start: number,
  end: number,
  fenceAt: ReadonlyMap<number, FenceBlock>,
): { lanes: ScannedLane[]; breaks: number[] } {
  const lanes: ScannedLane[] = [];
  const breaks: number[] = [];
  let list: OpenList | null = null;
  let para: { start: number; count: number } | null = null;
  let quote = false;
  let html: HtmlBlockStart | null = null;

  const current = (): ScannedLane | undefined => lanes[lanes.length - 1];
  const newItem = (line: number, marker: ListMarker): ScannedItem => ({
    start: line,
    last: line,
    marker,
    lazy: !marker.empty && isParagraphText(texts[line]!.slice(marker.contentOffset)),
  });
  const endList = (open: OpenList): void => {
    if (open.first) current()!.cards.push(open.item);
    list = null;
  };
  // A one-line `**Complete**` paragraph before the lane's first list marks a done lane (2.7).
  const closePara = (): void => {
    const lane = current();
    if (para !== null && para.count === 1 && lane !== undefined && !lane.listSeen && texts[para.start]!.trim() === '**Complete**') {
      lane.completeMarkerLines.push(para.start);
    }
    para = null;
  };
  const newLane = (first: number, next: number, headingKind: 'atx' | 'setext', name: string): void => {
    lanes.push({ heading: { start: first, end: next }, headingKind, name, cards: [], completeMarkerLines: [], listSeen: false });
  };

  let i = start;
  while (i < end) {
    const text = texts[i]!;
    if (html !== null) {
      if (html.close === null ? isBlank(text) : closesHtmlBlock(text, html.close)) html = null;
      i++;
      continue;
    }
    const block = fenceAt.get(i);
    if (list !== null) {
      const open: OpenList = list;
      const item = open.item;
      if (isBlank(text)) {
        open.blank = true;
        item.lazy = false;
        i++;
        continue;
      }
      // Indented to the item's content column: part of the item (2.5).
      if (indentColumns(text) >= item.marker.contentColumn) {
        item.last = block === undefined ? i : Math.min(block.last, end - 1);
        item.lazy = block === undefined && isParagraphText(text);
        open.blank = false;
        i = item.last + 1;
        continue;
      }
      if (block === undefined && !isThematicBreak(text)) {
        const marker = listMarker(text);
        if (marker !== undefined && marker.kind === open.kind) {
          if (open.first) current()!.cards.push(item);
          open.item = newItem(i, marker);
          open.blank = false;
          i++;
          continue;
        }
        // A lazy continuation line of the item's paragraph.
        if (marker === undefined && !open.blank && item.lazy && !startsBlockInList(text)) {
          item.last = i;
          i++;
          continue;
        }
      }
      endList(open);
    }

    if (block !== undefined) {
      closePara();
      quote = false;
      i = Math.min(block.last, end - 1) + 1;
      continue;
    }
    if (isBlank(text)) {
      closePara();
      quote = false;
      i++;
      continue;
    }
    const interruptible = para === null && !quote;
    // Indented code (it cannot interrupt a paragraph).
    if (interruptible && indentColumns(text) >= 4) {
      i++;
      continue;
    }
    if (isAtxHeading(text)) {
      closePara();
      quote = false;
      newLane(i, i + 1, 'atx', atxHeadingText(text));
      i++;
      continue;
    }
    if (para !== null && isSetextUnderline(text)) {
      const lines = texts.slice(para.start, i).map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ''));
      newLane(para.start, i + 1, 'setext', lines.join(' '));
      para = null;
      i++;
      continue;
    }
    if (isThematicBreak(text)) {
      closePara();
      quote = false;
      breaks.push(i);
      i++;
      continue;
    }
    if (isBlockQuote(text)) {
      closePara();
      quote = true;
      i++;
      continue;
    }
    const htmlStart = htmlBlockStart(text);
    if (htmlStart !== undefined && (interruptible || htmlStart.interrupts)) {
      closePara();
      quote = false;
      const from = text.indexOf('<') + 2;
      if (htmlStart.close === null || !closesHtmlBlock(text.slice(from), htmlStart.close)) html = htmlStart;
      i++;
      continue;
    }
    const marker = listMarker(text);
    if (marker !== undefined && (interruptible || canInterruptParagraph(marker))) {
      closePara();
      quote = false;
      const lane = current();
      list = { kind: marker.kind, first: lane !== undefined && !lane.listSeen, item: newItem(i, marker), blank: false };
      if (lane !== undefined) lane.listSeen = true;
      i++;
      continue;
    }
    // Paragraph text (or a lazy line of a block quote).
    if (!quote) {
      if (para === null) para = { start: i, count: 1 };
      else para.count++;
    }
    i++;
  }
  if (list !== null) endList(list);
  closePara();
  return { lanes, breaks };
}

function toCard(texts: readonly string[], laneIndex: number, index: number, item: ScannedItem): KanbanCard {
  const text = texts[item.start]!;
  const { marker } = item;
  const box = marker.empty ? null : CHECK_BOX.exec(text.slice(marker.contentOffset));
  const check = box === null ? null : box[1]!;
  return {
    laneIndex,
    index,
    range: { start: item.start, end: item.last + 1 },
    body: { start: item.start + 1, end: item.last + 1 },
    check,
    checked: check !== null && check !== ' ',
    checkOffset: box === null ? null : marker.contentOffset + 1,
    titleOffset: marker.contentOffset + (box === null ? 0 : box[0].length),
    marker: { kind: marker.kind, start: marker.start, end: marker.end, number: marker.number, contentColumn: marker.contentColumn },
  };
}

export function parseBoard(texts: readonly string[], options: ParseOptions = {}): KanbanBoard {
  const lineCount = texts.length;
  const fm = findFrontmatter(texts);
  const frontmatter: LineRange | null = fm === null ? null : { start: fm.openLine, end: fm.closeLine + 1 };
  const bodyStart = frontmatter?.end ?? 0;

  const settingsRange = findSettingsBlock(texts, bodyStart);
  const structEnd = settingsRange?.start ?? lineCount;

  // Fences in the structure region; unclosed ones stop before the settings block.
  const blocks = findFences(texts, bodyStart, structEnd);
  const fenceAt = new Map(blocks.map((block) => [block.open, block]));

  const scanned = scanStructure(texts, bodyStart, structEnd, fenceAt);

  // Archive (2.8): a thematic break, blank lines, then a heading named `Archive`.
  const headingAt = new Map(scanned.lanes.map((lane) => [lane.heading.start, lane]));
  let archiveStart: number | undefined;
  for (const line of scanned.breaks) {
    let next = line + 1;
    while (next < structEnd && isBlank(texts[next]!)) next++;
    if (headingAt.get(next)?.name === 'Archive') {
      archiveStart = line;
      break;
    }
  }
  const lanesEnd = archiveStart ?? structEnd;

  const doneLanes = options.doneLanes ?? [];
  const kept = scanned.lanes.filter((lane) => lane.heading.start < lanesEnd);
  const lanes: KanbanLane[] = kept.map((lane, index) => {
    const doneByName = doneLanes.includes(lane.name);
    return {
      index,
      headingLine: lane.heading.start,
      heading: lane.heading,
      headingKind: lane.headingKind,
      name: lane.name,
      range: { start: lane.heading.start, end: kept[index + 1]?.heading.start ?? lanesEnd },
      completeMarkerLines: lane.completeMarkerLines,
      doneByName,
      done: doneByName || lane.completeMarkerLines.length > 0,
      cards: lane.cards.map((item, cardIndex) => toCard(texts, index, cardIndex, item)),
    };
  });

  let settingsBlock: KanbanSettingsBlock | null = null;
  let json: Record<string, unknown> | null = null;
  if (settingsRange !== null) {
    json = readSettingsJson(texts, settingsRange);
    settingsBlock = { range: settingsRange, valid: json !== null };
  }

  return {
    isBoard: fm !== null && frontmatterHasKey(texts, fm, 'kanban-plugin'),
    lineCount,
    frontmatter,
    preamble: { start: bodyStart, end: lanes[0]?.headingLine ?? lanesEnd },
    lanes,
    archive: archiveStart === undefined ? null : { start: archiveStart, end: structEnd },
    settingsBlock,
    tail: { start: settingsRange?.end ?? lineCount, end: lineCount },
    settings: resolveSettings(json, frontmatterSettings(texts, frontmatter), options.defaults ?? {}),
  };
}
