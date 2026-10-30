// Style messages (kanban.md 3.1): only board tokens with safe values reach the page,
// switching styles clears earlier overrides, and nothing is redrawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyStyle } from '../../../src/features/kanban/browser/style.ts';
import { NOTEWELL_PALETTE } from '../../../src/features/kanban/notewell-theme.ts';
import { KANBAN_STYLE_TOKENS } from '../../../src/features/kanban/style-tokens.ts';

function page() {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
    },
  };
  const body = {
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
  return { props, attrs, root, body };
}

test('obsidian: applies token values and marks the body', () => {
  const { props, attrs, root, body } = page();
  const result = applyStyle(root, body, {
    style: 'obsidian',
    scheme: 'dark',
    tokens: { '--nw-board-bg': '#1e1e1e', '--nw-accent': 'hsl(258, 88%, 66%)', '--nw-font': '"Inter", sans-serif', '--nw-radius-card': '4px' },
  });
  assert.deepEqual(Object.fromEntries(props), {
    '--nw-board-bg': '#1e1e1e',
    '--nw-accent': 'hsl(258, 88%, 66%)',
    '--nw-font': '"Inter", sans-serif',
    '--nw-radius-card': '4px',
  });
  assert.deepEqual(Object.fromEntries(attrs), { 'data-style': 'obsidian', 'data-scheme': 'dark' });
  assert.equal(result.style, 'obsidian');
  assert.deepEqual(result.ignored, []);
});

test('notewell: the whole built-in palette applies for both schemes', () => {
  for (const scheme of ['dark', 'light'] as const) {
    const { props, attrs, root, body } = page();
    const result = applyStyle(root, body, { style: 'notewell', scheme, tokens: NOTEWELL_PALETTE[scheme] });
    assert.equal(props.size, KANBAN_STYLE_TOKENS.length, scheme);
    assert.deepEqual(result.ignored, [], scheme);
    assert.deepEqual(Object.fromEntries(attrs), { 'data-style': 'notewell', 'data-scheme': scheme });
  }
});

test('ignores unknown names and unsafe values', () => {
  const { props, root, body } = page();
  const result = applyStyle(root, body, {
    style: 'obsidian',
    scheme: 'light',
    tokens: {
      '--nw-fg': '#222',
      '--background-primary': '#fff',
      color: 'red',
      '--nw-card-bg': 'url(https://example.com/x.png)',
      '--nw-border': 'red; background: red',
      '--nw-link': 'expression(alert(1))',
      '--nw-lane-bg': 42,
      '--nw-hover-bg': '',
    },
  });
  assert.deepEqual(Object.fromEntries(props), { '--nw-fg': '#222' });
  assert.deepEqual(result.applied, ['--nw-fg']);
  assert.equal(result.ignored.length, 7);
});

test('vscode (or a malformed message) clears every override', () => {
  const { props, attrs, root, body } = page();
  applyStyle(root, body, { style: 'obsidian', scheme: 'dark', tokens: { '--nw-fg': '#eee', '--nw-accent': '#8a5cf5' } });
  assert.equal(props.size, 2);

  const result = applyStyle(root, body, { style: 'vscode', scheme: null, tokens: {} });
  assert.equal(result.style, 'vscode');
  assert.equal(props.size, 0);
  assert.deepEqual(Object.fromEntries(attrs), { 'data-style': 'vscode' });

  const malformed: { style?: unknown; scheme?: unknown; tokens?: unknown }[] = [
    { style: 'sepia', scheme: 'dark', tokens: { '--nw-fg': '#eee' } },
    { style: 'notewell', scheme: 'dim', tokens: { '--nw-fg': '#eee' } },
    { style: 'notewell', scheme: null, tokens: { '--nw-fg': '#eee' } },
    { style: 'obsidian', scheme: 'dark', tokens: [['--nw-fg', '#eee']] },
    { scheme: 'dark', tokens: { '--nw-fg': '#eee' } },
    { style: 'vscode', scheme: 'dark', tokens: { '--nw-fg': '#eee' } },
  ];
  for (const message of malformed) {
    applyStyle(root, body, { style: 'obsidian', scheme: 'dark', tokens: { '--nw-fg': '#111' } });
    assert.equal(applyStyle(root, body, message).style, 'vscode', JSON.stringify(message));
    assert.equal(props.size, 0, JSON.stringify(message));
    assert.equal(attrs.get('data-style'), 'vscode');
    assert.equal(attrs.has('data-scheme'), false);
  }
});

test('switching styles leaves no value from the previous one', () => {
  const { props, root, body } = page();
  applyStyle(root, body, { style: 'notewell', scheme: 'dark', tokens: NOTEWELL_PALETTE.dark });
  applyStyle(root, body, { style: 'obsidian', scheme: 'light', tokens: { '--nw-fg': '#222' } });
  assert.deepEqual(Object.fromEntries(props), { '--nw-fg': '#222' });
  // Every token is reset each time, including ones not set before.
  let removed = 0;
  applyStyle({ style: { setProperty: () => undefined, removeProperty: () => void removed++ } }, page().body, { style: 'vscode', scheme: null, tokens: {} });
  assert.equal(removed, KANBAN_STYLE_TOKENS.length);
});

test('a style message never redraws the board (open editors and drafts stay)', () => {
  const main = readFileSync(new URL('../../../src/features/kanban/browser/main.ts', import.meta.url), 'utf8');
  const branch = /if \(message\?\.type === 'style'\) \{([\s\S]*?)\n  \}/.exec(main)?.[1];
  assert.ok(branch, 'style branch present');
  assert.match(branch, /applyStyle\(/);
  assert.match(branch, /return;/);
  assert.doesNotMatch(branch, /draw\(|renderBoard\(|replaceChildren\(|closeEditor\(/);
});
