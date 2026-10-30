// Date handling for card tokens (kanban.md 3). Supports the moment-style tokens
// boards commonly use for `date-format`: YYYY, YY, MM, M, DD, D and [literal] text.
// Any other format letter makes the format unsupported; ISO dates still work then.

const ISO_FORMAT = 'YYYY-MM-DD';
const FORMAT_PART = /\[[^\]]*\]|YYYY|YY|MM|M|DD|D|./g;

type Part = { readonly token: 'YYYY' | 'YY' | 'MM' | 'M' | 'DD' | 'D' } | { readonly literal: string };

/** Longer formats, and dates longer than this, are not read (a date format is short). */
const MAX_FORMAT = 64;
const MAX_DATE_TEXT = 32;

/**
 * The format's parts, or undefined when unsupported. Year, month and day may each appear at
 * most once: repeated variable-width tokens (`MMMM…`) would make date matching backtrack
 * exponentially and stall the board.
 */
function compile(format: string): Part[] | undefined {
  if (format.length > MAX_FORMAT) return undefined;
  const parts: Part[] = [];
  const seen = new Set<string>();
  for (const [piece] of format.matchAll(FORMAT_PART)) {
    if (/^(YYYY|YY|MM|M|DD|D)$/.test(piece)) {
      const kind = piece[0]!;
      if (seen.has(kind)) return undefined;
      seen.add(kind);
      parts.push({ token: piece as 'YYYY' });
    } else if (piece.startsWith('[')) parts.push({ literal: piece.slice(1, -1) });
    else if (/[A-Za-z]/.test(piece)) return undefined;
    else parts.push({ literal: piece });
  }
  return parts;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return undefined;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function parseWith(text: string, parts: readonly Part[]): string | undefined {
  let pattern = '^';
  const order: string[] = [];
  for (const part of parts) {
    if ('literal' in part) {
      pattern += part.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      pattern += { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{2})', M: '(\\d{1,2})', DD: '(\\d{2})', D: '(\\d{1,2})' }[part.token];
      order.push(part.token);
    }
  }
  const match = new RegExp(`${pattern}$`).exec(text);
  if (match === null) return undefined;
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  order.forEach((token, i) => {
    const value = Number(match[i + 1]);
    if (token === 'YYYY') year = value;
    else if (token === 'YY') year = 2000 + value;
    else if (token === 'MM' || token === 'M') month = value;
    else day = value;
  });
  return year === undefined || month === undefined || day === undefined ? undefined : toIso(year, month, day);
}

/** ISO `YYYY-MM-DD` for `text` written in `format` (or ISO), or undefined. */
export function parseDate(text: string, format: string): string | undefined {
  if (text.length > MAX_DATE_TEXT) return undefined;
  const parts = compile(format);
  return (parts && parseWith(text, parts)) ?? parseWith(text, compile(ISO_FORMAT)!);
}

/** Formats an ISO date with `format`; unsupported formats fall back to ISO. */
export function formatDate(iso: string, format: string): string {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const parts = compile(format) ?? compile(ISO_FORMAT)!;
  return parts
    .map((part) => {
      if ('literal' in part) return part.literal;
      switch (part.token) {
        case 'YYYY': return pad(year, 4);
        case 'YY': return pad(year % 100, 2);
        case 'MM': return pad(month, 2);
        case 'M': return String(month);
        case 'DD': return pad(day, 2);
        case 'D': return String(day);
      }
    })
    .join('');
}

/** Obsidian Kanban's default `date-trigger`: dates are written `@{2026-10-20}` (kanban.md 3). */
export const DEFAULT_DATE_TRIGGER = '@';

/** Obsidian Kanban's default `time-trigger`: times are written `@@{09:30}` (kanban.md 3). */
export const DEFAULT_TIME_TRIGGER = '@@';

/** `HH:mm` (hour 0-23, one or two digits) normalized to two-digit hours, or undefined. */
export function parseTime(text: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? `${pad(hour, 2)}:${pad(minute, 2)}` : undefined;
}

export function isIsoDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return match !== null && toIso(Number(match[1]), Number(match[2]), Number(match[3])) === text;
}
