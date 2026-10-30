import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeCssValue, MAX_CSS_VALUE_LENGTH } from '../../src/webview/css-values.ts';

test('accepts colors, lengths, numbers, font lists and allowed functions', () => {
  for (const value of [
    '#fff',
    '#1e1e1e',
    '#8a5cf5cc',
    'rgb(255, 0, 0)',
    'rgba(0 0 0 / 0.4)',
    'hsl(258, 88%, 66%)',
    'hsla(258 88% 66% / 50%)',
    'transparent',
    'red',
    'var(--nw-accent)',
    'var(--color-accent, #8a5cf5)',
    'calc(var(--radius-s) * 2)',
    'calc(4px + 0.5em)',
    'color-mix(in srgb, var(--interactive-accent) 20%, transparent)',
    'hsl(calc(var(--accent-h) - 3), var(--accent-s), calc(var(--accent-l) + 4%))',
    '6px',
    '0.25rem',
    '1.5em',
    '100%',
    '600',
    '"Inter", -apple-system, sans-serif',
    "'Source Code Pro', monospace",
    '"맑은 고딕", 나눔고딕, sans-serif',
  ]) {
    assert.ok(isSafeCssValue(value), value);
  }
});

test('refuses anything that could load, run or escape the declaration', () => {
  for (const value of [
    '',
    '   ',
    'url(https://example.com/x.png)',
    'URL(x)',
    'image-set("a.png" 1x)',
    'expression(alert(1))',
    'red; background: red',
    'red}body{color:red',
    '{',
    '<b>',
    'red !important',
    '@import "x.css"',
    'a\\61',
    'red /* comment */',
    'red\nblue',
    `red${String.fromCharCode(0)}`,
    `red${String.fromCharCode(0x7f)}`,
    'attr(data-x)',
    'env(safe-area-inset-top)',
    'linear-gradient(red, blue)',
    'element(#x)',
    '--x(1)',
    'rgb(1, 2, 3',
    'rgb(1, 2, 3))',
    '"unclosed',
    '"bad"quote"',
    '"a;b"',
    'a:b',
    'a=b',
    'a&b',
    '`x`',
    'x'.repeat(MAX_CSS_VALUE_LENGTH + 1),
  ]) {
    assert.equal(isSafeCssValue(value), false, JSON.stringify(value.slice(0, 40)));
  }
  assert.ok(isSafeCssValue('a'.repeat(MAX_CSS_VALUE_LENGTH)));
});
