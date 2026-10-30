import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileDateFormat, formatDate } from '../../src/core/date-format.ts';

// Reference values come from Moment.js itself (version recorded in the fixture's `note`), run
// outside this repository by a throwaway generator; Moment is not a dependency.
interface MomentTable {
  readonly moment: string;
  readonly formats: readonly string[];
  readonly literalLetters: readonly string[];
  readonly zones: readonly {
    readonly timeZone: string;
    readonly cases: readonly { readonly local: readonly number[]; readonly why: string; readonly expected: readonly string[] }[];
  }[];
}

const read = (name: string): MomentTable => JSON.parse(readFileSync(new URL(`../fixtures/daily-notes/${name}`, import.meta.url), 'utf8')) as MomentTable;
const table = read('date-format.moment.json');
// Same formats and dates in Moment's `ko` locale (names, `Do`, meridiem; weeks as in `en`).
const tableKo = read('date-format.moment-ko.json');

/** Formats in the table that use a Moment token outside the subset, with the token reported. */
const REJECTED: Readonly<Record<string, string>> = { 'Today is dddd': 'y' };

function localDate(local: readonly number[]): Date {
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0, ms = 0] = local;
  return new Date(y, mo - 1, d, h, mi, s, ms);
}

for (const [reference, locale] of [[table, 'en'], [tableKo, 'ko']] as const) {
  for (const zone of reference.zones) {
    test(`matches moment ${reference.moment} (${locale}) in ${zone.timeZone}`, () => {
      // Each test file runs in its own process, so switching the zone here is contained.
      const saved = process.env.TZ;
      process.env.TZ = zone.timeZone;
      try {
        for (const c of zone.cases) {
          const date = localDate(c.local);
          reference.formats.forEach((format, i) => {
            const result = formatDate(date, format, locale);
            const label = `${format} @ ${c.local.join(',')} (${c.why})`;
            const rejected = REJECTED[format];
            if (rejected !== undefined) assert.deepEqual(result, { ok: false, token: rejected }, label);
            else assert.deepEqual(result, { ok: true, text: c.expected[i] }, label);
          });
        }
      } finally {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
      }
    });
  }
}

test('the table covers every supported token on its own', () => {
  const tokens = ['YYYY', 'YY', 'M', 'MM', 'MMM', 'MMMM', 'D', 'DD', 'Do', 'd', 'dd', 'ddd', 'dddd', 'E',
    'w', 'ww', 'W', 'WW', 'gggg', 'GGGG', 'Q', 'H', 'HH', 'h', 'hh', 'm', 'mm', 's', 'ss', 'A', 'a', 'X', 'x'];
  for (const token of tokens) assert.ok(table.formats.includes(token), token);
});

test('letters Moment prints as themselves stay literal; every other letter is a token', () => {
  const date = new Date(2009, 5, 15, 13, 5, 9);
  for (let code = 0; code < 128; code++) {
    const ch = String.fromCharCode(code);
    if (!/[A-Za-z]/.test(ch)) continue;
    const result = formatDate(date, ch);
    if (table.literalLetters.includes(ch)) assert.deepEqual(result, { ok: true, text: ch }, ch);
    else assert.ok(!result.ok || result.text !== ch, ch);
  }
});

test('Moment tokens outside the subset are reported, not passed through', () => {
  const unsupported = [
    'L', 'LL', 'LLL', 'LLLL', 'LT', 'LTS', 'l', 'll', 'DDD', 'DDDD', 'DDDo', 'Mo', 'Qo', 'wo', 'Wo', 'do',
    'e', 'k', 'kk', 'S', 'SSS', 'Z', 'ZZ', 'z', 'zz', 'N', 'NNNN', 'y', 'yy', 'yo', 'Y', 'YYYYY', 'YYYYYY',
    'gg', 'ggggg', 'GG', 'GGGGG', 'w|',
  ];
  for (const token of unsupported) {
    assert.deepEqual(formatDate(new Date(2024, 0, 1), token), { ok: false, token }, token);
  }
});

test('an unsupported token rejects the whole format', () => {
  assert.deepEqual(compileDateFormat('YYYY-MM-DD [at] LT'), { ok: false, token: 'LT' });
  assert.deepEqual(compileDateFormat('YYYY DDD'), { ok: false, token: 'DDD' });
  // Escaped like Moment: `\L` is a plain `L`, and `T` is not a token.
  assert.deepEqual(formatDate(new Date(2024, 0, 1), String.raw`\LT YYYY`), { ok: true, text: 'LT 2024' });
  assert.deepEqual(compileDateFormat('[L] YYYY'), {
    ok: true,
    parts: [{ literal: 'L ' }, { token: 'YYYY' }],
  });
});

test('compiled parts merge adjacent literals', () => {
  assert.deepEqual(compileDateFormat('[Week] W / gggg'), {
    ok: true,
    parts: [{ literal: 'Week ' }, { token: 'W' }, { literal: ' / ' }, { token: 'gggg' }],
  });
  assert.deepEqual(compileDateFormat(''), { ok: true, parts: [] });
});

test('line breaks are kept as text', () => {
  assert.deepEqual(formatDate(new Date(2024, 0, 2), 'YYYY\nMM\r\nDD'), { ok: true, text: '2024\n01\r\n02' });
});
