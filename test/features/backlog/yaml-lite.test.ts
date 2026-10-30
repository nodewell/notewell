// The frontmatter YAML subset (backlog.md 3.2): known shapes are values, everything else
// is unknown with its lines kept; formatScalar writes what the CLI writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldOf,
  formatScalar,
  listOf,
  parseFields,
  parseScalar,
  scalarOf,
  type ScalarStyle,
} from '../../../src/features/backlog/yaml-lite.ts';

test('parseScalar: plain, single and double quoted', () => {
  assert.deepEqual(parseScalar('In Progress'), { value: 'In Progress', style: 'plain' });
  assert.deepEqual(parseScalar('  m-0  '), { value: 'm-0', style: 'plain' });
  assert.deepEqual(parseScalar("'@alice'"), { value: '@alice', style: 'single' });
  assert.deepEqual(parseScalar("'it''s'"), { value: "it's", style: 'single' });
  assert.deepEqual(parseScalar("''"), { value: '', style: 'single' });
  assert.deepEqual(parseScalar('"To Do"'), { value: 'To Do', style: 'double' });
  assert.deepEqual(parseScalar('"a \\"b\\" \\\\ c"'), { value: 'a "b" \\ c', style: 'double' });
  assert.deepEqual(parseScalar('a:b'), { value: 'a:b', style: 'plain' });
  // YAML escapes as the CLI's serializer writes them (tabs, characters outside the BMP).
  assert.deepEqual(parseScalar('"tab\\tvalue \\U0001F600 \\x41 \\u00e9"'), { value: `tab\tvalue ${String.fromCodePoint(0x1f600)} A ${String.fromCodePoint(0xe9)}`, style: 'double' });
  assert.deepEqual(parseScalar('한국어 작업'), { value: '한국어 작업', style: 'plain' });
});

test('parseScalar: shapes it does not read are undefined', () => {
  for (const text of [
    '"tab\\qvalue"', // escapes YAML does not define
    '"lone \\uD800"', // a surrogate code point
    '"short \\x4"', // too few hex digits
    '"unclosed',
    "'unclosed",
    "'a' trailing",
    '"a" trailing',
    '|',
    '>-',
    '@alice',
    '`x`',
    '&anchor',
    '*alias',
    '!tag x',
    '{a: 1}',
    '[a]',
    '- item',
    'a: b',
    'value # comment',
    'key:',
    '#comment',
  ]) {
    assert.equal(parseScalar(text), undefined, text);
  }
});

const fieldsOf = (source: string) => parseFields(source.split('\n'));

test('parseFields: scalars, [] and block lists with line ranges', () => {
  const texts = [
    'id: TASK-1',
    "title: 'Title: with colon'",
    'assignee:',
    "  - '@alice'",
    '  - bob',
    'labels: []',
    'status: "To Do"',
    'ordinal: 1000',
    'empty:',
  ];
  const fields = parseFields(texts);
  assert.deepEqual(
    fields.map((f) => [f.name, f.line, f.end]),
    [
      ['id', 0, 1],
      ['title', 1, 2],
      ['assignee', 2, 5],
      ['labels', 5, 6],
      ['status', 6, 7],
      ['ordinal', 7, 8],
      ['empty', 8, 9],
    ],
  );
  assert.deepEqual(fieldOf(fields, 'title')?.value, { kind: 'scalar', value: 'Title: with colon', style: 'single' });
  assert.deepEqual(fieldOf(fields, 'assignee')?.value, {
    kind: 'list',
    items: [
      { value: '@alice', line: 3 },
      { value: 'bob', line: 4 },
    ],
    flow: false,
  });
  assert.deepEqual(fieldOf(fields, 'labels')?.value, { kind: 'list', items: [], flow: false });
  assert.deepEqual(fieldOf(fields, 'status')?.value, { kind: 'scalar', value: 'To Do', style: 'double' });
  assert.deepEqual(fieldOf(fields, 'empty')?.value, { kind: 'scalar', value: '', style: 'plain' });
});

test('parseFields: a range of lines, as inside frontmatter', () => {
  const texts = ['---', 'id: TASK-1', '---', 'body: not a field'];
  assert.deepEqual(
    parseFields(texts, 1, 2).map((f) => f.name),
    ['id'],
  );
});

test('parseFields: one-line flow lists are read only lists', () => {
  const value = fieldOf(fieldsOf('labels: [alpha, "beta", \'it\'\'s\']'), 'labels')?.value;
  assert.deepEqual(value, {
    kind: 'list',
    items: [
      { value: 'alpha', line: 0 },
      { value: 'beta', line: 0 },
      { value: "it's", line: 0 },
    ],
    flow: true,
  });
  assert.equal(fieldOf(fieldsOf('labels: ["a, b", c]'), 'labels')?.value.kind, 'list');
  assert.deepEqual(listOf(fieldsOf('labels: ["a, b", c]'), 'labels'), ['a, b', 'c']);
});

test('parseFields: other shapes are unknown', () => {
  const cases: Record<string, string> = {
    'nested map': 'custom:\n  nested: value',
    'folded block with a more-indented line': 'notes: >\n  folded\n    more',
    'block with tab indentation': 'notes: |\n\tline',
    'block with an indentation indicator': 'notes: |2\n  line',
    'escape in double quotes': 'priority: "high\\qvalue"',
    'continued list item': 'assignee:\n  - plain\n    continued',
    'mixed list indent': 'labels:\n  - a\n    - b',
    'tab-indented list': 'labels:\n\t- a',
    'comment in list': 'labels:\n  # note\n  - a',
    'value and children': 'labels: a\n  - b',
    'nested flow list': 'labels: [a, [b]]',
    'flow map': 'labels: {a: 1}',
    'empty flow item': 'labels: [a, , b]',
    'unclosed flow list': 'labels: [a, b',
    'trailing comment': 'status: To Do # later',
    'no space after colon': 'status:To Do',
    'list of maps': 'refs:\n  - url: x',
  };
  for (const [label, source] of Object.entries(cases)) {
    const fields = fieldsOf(source);
    assert.equal(fields.length, 1, label);
    assert.equal(fields[0].value.kind, 'unknown', label);
    assert.equal(fields[0].end, source.split('\n').length, `${label}: the field keeps all its lines`);
  }
});

test('parseFields: comments and blank lines are skipped; a repeated name is unknown', () => {
  const fields = fieldsOf('# comment\nid: A\n\nstatus: To Do\nid: B');
  assert.deepEqual(
    fields.map((f) => [f.name, f.value.kind]),
    [
      ['id', 'unknown'],
      ['status', 'scalar'],
      ['id', 'unknown'],
    ],
  );
});

test('scalarOf and listOf', () => {
  const fields = fieldsOf("status: To Do\nassignee: '@me'\nlabels:\n  - a\n  - b\ncustom:\n  x: 1\nempty:");
  assert.equal(scalarOf(fields, 'status'), 'To Do');
  assert.equal(scalarOf(fields, 'labels'), undefined);
  assert.equal(scalarOf(fields, 'custom'), undefined);
  assert.equal(scalarOf(fields, 'missing'), undefined);
  assert.deepEqual(listOf(fields, 'labels'), ['a', 'b']);
  assert.deepEqual(listOf(fields, 'assignee'), ['@me'], 'a scalar is a one-item list');
  assert.deepEqual(listOf(fields, 'custom'), []);
  assert.deepEqual(listOf(fields, 'empty'), []);
  assert.deepEqual(listOf(fields, 'missing'), []);
});

test('formatScalar: plain values the CLI writes plain', () => {
  for (const value of ['In Progress', 'm-0', 'TASK-1.1', 'docs/build.md', '한국어 작업', 'high', "it's", 'say "hi"', 'v1.2.3']) {
    assert.equal(formatScalar(value, 'plain'), value, value);
  }
});

test('formatScalar: plain falls back to single quotes when the CLI quotes or YAML would misread', () => {
  const cases: Record<string, string> = {
    '@me': "'@me'",
    'a: b': "'a: b'",
    'Title: with colon & "quotes"': '\'Title: with colon & "quotes"\'',
    'https://example.com/build': "'https://example.com/build'",
    '2026-10-14': "'2026-10-14'",
    '2026-10-14 09:49': "'2026-10-14 09:49'",
    true: "'true'",
    False: "'False'",
    null: "'null'",
    '~': "'~'",
    '123': "'123'",
    '-1.5': "'-1.5'",
    '1e3': "'1e3'",
    '0x1F': "'0x1F'",
    '.inf': "'.inf'",
    yes: "'yes'",
    '': "''",
    ' padded': "' padded'",
    'padded ': "'padded '",
    "'quoted'": "'''quoted'''",
    '"quoted"': '\'"quoted"\'',
    '- item': "'- item'",
    '#tag': "'#tag'",
    'a #b': "'a #b'",
    'a,b': "'a,b'",
    '[x]': "'[x]'",
    '{x}': "'{x}'",
    '|': "'|'",
    '>': "'>'",
    '*star': "'*star'",
    '&amp': "'&amp'",
    '!bang': "'!bang'",
    '%pct': "'%pct'",
    '`tick`': "'`tick`'",
    '?q': "'?q'",
    'tab\there': "'tab\there'",
  };
  for (const [value, expected] of Object.entries(cases)) {
    assert.equal(formatScalar(value, 'plain'), expected, JSON.stringify(value));
  }
});

test('formatScalar: single and double styles are kept', () => {
  assert.equal(formatScalar('To Do', 'single'), "'To Do'");
  assert.equal(formatScalar("it's", 'single'), "'it''s'");
  assert.equal(formatScalar('To Do', 'double'), '"To Do"');
  assert.equal(formatScalar('a "b" \\ c', 'double'), '"a \\"b\\" \\\\ c"');
});

test('formatScalar round trip: parseScalar reads back the same value', () => {
  const values = [
    'In Progress',
    '@me',
    'a: b',
    '2026-10-14',
    'true',
    '123',
    "it's",
    'say "hi"',
    'a \\ b',
    '',
    ' padded ',
    'https://example.com/x?y=1#z',
    '한국어 🚀',
    "'",
    '"',
    '- x',
  ];
  const styles: ScalarStyle[] = ['plain', 'single', 'double'];
  for (const value of values) {
    for (const style of styles) {
      const written = formatScalar(value, style);
      const read = parseScalar(written);
      assert.equal(read?.value, value, `${style} ${JSON.stringify(value)} -> ${written}`);
      if (style !== 'plain') assert.equal(read?.style, style);
    }
  }
});

test('formatScalar round trip through parseFields as a field line', () => {
  for (const value of ['@me', 'a: b', '2026-10-14 09:49', 'To Do']) {
    const fields = parseFields([`status: ${formatScalar(value, 'plain')}`]);
    assert.equal(scalarOf(fields, 'status'), value);
  }
});

test('parseFields: block scalars as the CLI writes long values (folded, literal, chomping)', () => {
  const value = (source: string) => {
    const field = fieldsOf(source)[0];
    return field.value.kind === 'scalar' ? [field.value.value, field.value.style] : field.value.kind;
  };
  assert.deepEqual(value('title: >-\n  A long title that the CLI\n  folded over two lines'), ['A long title that the CLI folded over two lines', 'block']);
  assert.deepEqual(value('notes: >\n  folded'), ['folded\n', 'block']);
  assert.deepEqual(value('notes: |\n  multi\n    indented\n  line'), ['multi\n  indented\nline\n', 'block']);
  assert.deepEqual(value('notes: |-\n  kept'), ['kept', 'block']);
  assert.deepEqual(value('notes: |+\n  kept'), ['kept\n', 'block']);
});
