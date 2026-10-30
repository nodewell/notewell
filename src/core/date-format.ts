// Moment.js-compatible date formatting for the token subset in daily-notes.md 3. Pure: the
// date is read in local time (as Moment does) and names come from Moment's `en` (default) or
// `ko` locale, the languages Obsidian shows them in for an English or Korean app.
// A format with a Moment token outside the subset is rejected as a whole, never half-applied.

export type DateFormatResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly token: string };

export type DateFormatPart = { readonly literal: string } | { readonly token: string };

export type CompiledDateFormat =
  | { readonly ok: true; readonly parts: readonly DateFormatPart[] }
  | { readonly ok: false; readonly token: string };

// Moment's own tokenizer (moment 2.30 `formattingTokens`): bracketed literal, then an optional
// backslash and the longest token at that point, else any one character. Using the same
// alternation keeps splitting identical (`MMMMM` is `MMMM` + `M`, `Hmm` is one token, ...).
// Moment expands locale formats (`LT`, `LL`, `l`, ...) before tokenizing, with this pattern
// (moment 2.30 `localFormattingTokens`); none of them is in the subset.
const LOCALE_FORMATS = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g;

const FORMATTING_TOKENS =
  /(\[[^\[]*\])|(\\)?([Hh]mm(ss)?|Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Qo?|N{1,5}|YYYYYY|YYYYY|YYYY|YY|y{2,4}|yo?|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|kk?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|.)/g;

/**
 * Letters Moment gives a meaning to (format tokens and locale formats `L`/`l`). Other letters,
 * and a lone `g`/`G`, print as themselves, so `YYYY-MM-DDTHH:mm` keeps its `T`.
 */
const MOMENT_LETTERS = new Set('MDdwWQNYyeEaAhHkmsSxXzZLl'.split(''));

/** Locales of the names (Moment `en` and `ko`); weeks are counted the same way in both. */
export type DateLocale = 'en' | 'ko';

interface LocaleNames {
  readonly months: readonly string[];
  readonly monthsShort: readonly string[];
  readonly weekdays: readonly string[];
  readonly weekdaysShort: readonly string[];
  readonly weekdaysMin: readonly string[];
  readonly ordinal: (day: number) => string;
  readonly meridiem: (hours: number, lower: boolean) => string;
}

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KO_MONTHS = EN_MONTHS.map((_, i) => `${i + 1}월`);
const KO_WEEKDAYS_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

const NAMES: Readonly<Record<DateLocale, LocaleNames>> = {
  en: {
    months: EN_MONTHS,
    monthsShort: EN_MONTHS.map((m) => m.slice(0, 3)),
    weekdays: EN_WEEKDAYS,
    weekdaysShort: EN_WEEKDAYS.map((d) => d.slice(0, 3)),
    weekdaysMin: EN_WEEKDAYS.map((d) => d.slice(0, 2)),
    ordinal,
    meridiem: (hours, lower) => (hours > 11 ? (lower ? 'pm' : 'PM') : lower ? 'am' : 'AM'),
  },
  ko: {
    months: KO_MONTHS,
    monthsShort: KO_MONTHS,
    weekdays: KO_WEEKDAYS_SHORT.map((d) => `${d}요일`),
    weekdaysShort: KO_WEEKDAYS_SHORT,
    weekdaysMin: KO_WEEKDAYS_SHORT,
    ordinal: (day) => `${day}일`,
    meridiem: (hours) => (hours < 12 ? '오전' : '오후'),
  },
};

const DAY_MS = 86_400_000;

type Formatter = (d: Date, n: LocaleNames) => string;

const FORMATTERS: Readonly<Record<string, Formatter>> = {
  YYYY: (d) => year4(d.getFullYear()),
  YY: (d) => pad(d.getFullYear() % 100, 2),
  M: (d) => String(d.getMonth() + 1),
  MM: (d) => pad(d.getMonth() + 1, 2),
  MMM: (d, n) => n.monthsShort[d.getMonth()]!,
  MMMM: (d, n) => n.months[d.getMonth()]!,
  D: (d) => String(d.getDate()),
  DD: (d) => pad(d.getDate(), 2),
  Do: (d, n) => n.ordinal(d.getDate()),
  d: (d) => String(d.getDay()),
  dd: (d, n) => n.weekdaysMin[d.getDay()]!,
  ddd: (d, n) => n.weekdaysShort[d.getDay()]!,
  dddd: (d, n) => n.weekdays[d.getDay()]!,
  E: (d) => String(d.getDay() || 7),
  w: (d) => String(localeWeek(d).week),
  ww: (d) => pad(localeWeek(d).week, 2),
  gggg: (d) => pad(localeWeek(d).year, 4),
  W: (d) => String(isoWeek(d).week),
  WW: (d) => pad(isoWeek(d).week, 2),
  GGGG: (d) => pad(isoWeek(d).year, 4),
  Q: (d) => String(Math.floor(d.getMonth() / 3) + 1),
  H: (d) => String(d.getHours()),
  HH: (d) => pad(d.getHours(), 2),
  h: (d) => String(d.getHours() % 12 || 12),
  hh: (d) => pad(d.getHours() % 12 || 12, 2),
  m: (d) => String(d.getMinutes()),
  mm: (d) => pad(d.getMinutes(), 2),
  s: (d) => String(d.getSeconds()),
  ss: (d) => pad(d.getSeconds(), 2),
  A: (d, n) => n.meridiem(d.getHours(), false),
  a: (d, n) => n.meridiem(d.getHours(), true),
  X: (d) => String(Math.floor(d.getTime() / 1000)),
  x: (d) => String(d.getTime()),
};

/** Splits a format once; reports a Moment token outside the subset (locale formats first). */
export function compileDateFormat(format: string): CompiledDateFormat {
  for (const match of format.matchAll(LOCALE_FORMATS)) {
    if (match[3] !== undefined && match[2] === undefined) return { ok: false, token: match[3] };
  }
  const parts: DateFormatPart[] = [];
  const pushLiteral = (text: string): void => {
    const last = parts[parts.length - 1];
    if (last !== undefined && 'literal' in last) parts[parts.length - 1] = { literal: last.literal + text };
    else if (text !== '') parts.push({ literal: text });
  };
  let index = 0;
  for (const match of format.matchAll(FORMATTING_TOKENS)) {
    // Moment's `.` skips line breaks; keep them as text rather than dropping them.
    if (match.index > index) pushLiteral(format.slice(index, match.index));
    index = match.index + match[0].length;
    const [whole, bracketed, backslash, token = ''] = match;
    if (bracketed !== undefined) pushLiteral(bracketed.slice(1, -1));
    else if (backslash !== undefined) pushLiteral(token.replace(/\\/g, ''));
    else if (Object.hasOwn(FORMATTERS, token)) parts.push({ token });
    else if (/^[Hh]mm(ss)?$/.test(token)) {
      parts.push({ token: token[0]! }, { token: 'mm' });
      if (token.length === 5) parts.push({ token: 'ss' });
    } else if (token === '\\') {
      // A dangling backslash at the end prints nothing in Moment.
    } else if (token.length > 1 || MOMENT_LETTERS.has(token)) return { ok: false, token: whole };
    else pushLiteral(token);
  }
  if (index < format.length) pushLiteral(format.slice(index));
  return { ok: true, parts };
}

/** Formats `date` (local time) like `moment(date).locale(locale).format(format)`. */
export function formatDate(date: Date, format: string, locale: DateLocale = 'en'): DateFormatResult {
  const compiled = compileDateFormat(format);
  if (!compiled.ok) return compiled;
  return { ok: true, text: applyDateFormat(date, compiled.parts, locale) };
}

export function applyDateFormat(date: Date, parts: readonly DateFormatPart[], locale: DateLocale = 'en'): string {
  const names = NAMES[locale];
  return parts.map((p) => ('literal' in p ? p.literal : FORMATTERS[p.token]!(date, names))).join('');
}

function pad(value: number, width: number): string {
  const digits = String(Math.abs(value)).padStart(width, '0');
  return value < 0 ? `-${digits}` : digits;
}

function year4(year: number): string {
  return year <= 9999 ? pad(year, 4) : `+${year}`;
}

function ordinal(day: number): string {
  const tens = Math.floor((day % 100) / 10);
  const ones = day % 10;
  const suffix = tens === 1 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

/** Moment `en` (and `ko`) locale weeks: start on Sunday, week 1 contains January 1. */
function localeWeek(date: Date): { week: number; year: number } {
  return weekOfYear(date, 0, 1);
}

/** ISO 8601 weeks: start on Monday, week 1 contains January 4. */
function isoWeek(date: Date): { week: number; year: number } {
  return weekOfYear(date, 1, 4);
}

function weekOfYear(date: Date, firstWeekday: number, anchorDay: number): { week: number; year: number } {
  // Calendar arithmetic on the local date's fields in UTC so DST never shifts a day.
  const day = utcDay(date.getFullYear(), date.getMonth(), date.getDate());
  const weekOneStart = (year: number): number => {
    const anchor = utcDay(year, 0, anchorDay);
    return anchor - ((new Date(anchor).getUTCDay() - firstWeekday + 7) % 7) * DAY_MS;
  };
  let year = date.getFullYear();
  if (day < weekOneStart(year)) year -= 1;
  else if (day >= weekOneStart(year + 1)) year += 1;
  return { week: Math.floor((day - weekOneStart(year)) / (7 * DAY_MS)) + 1, year };
}

function utcDay(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(2000, month, day));
  date.setUTCFullYear(year, month, day); // Date.UTC alone maps years 0..99 to 1900..1999
  return date.getTime();
}
