import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeCssValue } from '../../../src/webview/css-values.ts';
import { NOTEWELL_PALETTE } from '../../../src/features/kanban/notewell-theme.ts';
import { KANBAN_STYLE_TOKENS } from '../../../src/features/kanban/style-tokens.ts';

test('the notewell palette has a safe value for every token in both schemes', () => {
  for (const scheme of ['dark', 'light'] as const) {
    const palette = NOTEWELL_PALETTE[scheme];
    assert.deepEqual(Object.keys(palette).sort(), [...KANBAN_STYLE_TOKENS].sort(), scheme);
    for (const [name, value] of Object.entries(palette)) {
      assert.ok(isSafeCssValue(value), `${scheme} ${name}: ${value}`);
    }
  }
});

test('colors are fixed values, not VS Code theme variables (fonts may follow VS Code)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    for (const [name, value] of Object.entries(NOTEWELL_PALETTE[scheme])) {
      if (name.startsWith('--nw-font')) continue;
      assert.doesNotMatch(value, /var\(/, `${scheme} ${name}`);
    }
  }
});
