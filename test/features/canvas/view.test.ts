// The canvas view model (view.ts), messages (messages.ts) and the localized strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCanvas } from '../../../src/features/canvas/model.ts';
import { isWebUrl, validateWebviewMessage } from '../../../src/features/canvas/messages.ts';
import {
  buildCanvasView,
  DEFAULT_MESSAGES,
  DEFAULT_STRINGS,
  fileName,
  findSubpathLine,
  isImagePath,
  MAX_NOTE_LINES,
  noteExcerpt,
  resolveInside,
  resourcePaths,
  textTitle,
  type CanvasView,
} from '../../../src/features/canvas/view.ts';
import { variants } from './support.ts';

type Shown = Extract<CanvasView, { state: 'canvas' }>;

function canvasView(source: string, options = {}): Shown {
  const view = buildCanvasView(readCanvas(source), options);
  assert.equal(view.state, 'canvas');
  return view as Shown;
}

test('every fixture variant builds a canvas view that survives JSON (postMessage)', () => {
  for (const { name, source } of variants()) {
    const view = canvasView(source);
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view, name);
    for (const node of view.nodes) assert.ok(node.title !== undefined, name);
  }
});

test('nodes keep file order, geometry, kind, and colors as presets or #rrggbb', () => {
  const view = canvasView(
    JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', text: '## Title\nbody', x: 1, y: 2, width: 3, height: 4, color: '3' },
        { id: 'b', type: 'link', url: 'https://x.test', x: 0, y: 0, width: 10, height: 10, color: '#ABC' },
        { id: 'c', type: 'embed', x: 0, y: 0, width: 10, height: 10, color: 'red' },
        { id: 'd', type: 'group', x: 0, y: 0, width: 10, height: 10 },
      ],
    }),
  );
  assert.deepEqual(
    view.nodes.map((n) => [n.index, n.id, n.kind, n.type, n.color, n.title]),
    [
      [0, 'a', 'text', 'text', '3', 'Title'],
      [1, 'b', 'link', 'link', '#aabbcc', 'https://x.test'],
      [2, 'c', 'unknown', 'embed', undefined, 'embed'],
      [3, 'd', 'group', 'group', undefined, 'Untitled group'],
    ],
  );
  assert.deepEqual([view.nodes[0]!.x, view.nodes[0]!.y, view.nodes[0]!.width, view.nodes[0]!.height], [1, 2, 3, 4]);
  // An ignored color is a warning: the notice names the count and the first line.
  assert.deepEqual(view.notices, [{ kind: 'warning', text: 'Some values in this canvas were ignored or adjusted for display (1); the first is on line 1.' }]);
});

test('edges point at node positions (first node of a duplicated id); dangling edges are gone', () => {
  const view = canvasView(
    JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b', type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b', type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [
        { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'top', toEnd: 'none', fromEnd: 'arrow', label: 'x', color: '6' },
        { id: 'e2', fromNode: 'a', toNode: 'zz' },
      ],
    }),
  );
  assert.deepEqual(view.edges, [{ id: 'e1', from: 0, to: 1, fromSide: 'top', fromEnd: 'arrow', toEnd: 'none', color: '6', label: 'x' }]);
  assert.equal(view.notices.length, 1);
});

test('resources: images and backgrounds only as resolved; missing and outside marked', () => {
  const source = JSON.stringify({
    nodes: [
      { id: 'i', type: 'file', file: 'a.png', x: 0, y: 0, width: 10, height: 10 },
      { id: 'm', type: 'file', file: 'm.md', subpath: '#H', x: 0, y: 0, width: 10, height: 10 },
      { id: 'o', type: 'file', file: '../o.md', x: 0, y: 0, width: 10, height: 10 },
      { id: 'u', type: 'file', file: 'unknown.md', x: 0, y: 0, width: 10, height: 10 },
      { id: 'g', type: 'group', background: 'a.png', backgroundStyle: 'repeat', x: 0, y: 0, width: 10, height: 10 },
      { id: 'h', type: 'group', background: 'none.png', x: 0, y: 0, width: 10, height: 10 },
    ],
  });
  assert.deepEqual(resourcePaths(readCanvas(source)), { files: ['a.png', 'm.md', '../o.md', 'unknown.md'], backgrounds: ['a.png', 'none.png'] });
  const resources = new Map([
    ['a.png', { exists: true, inside: true, image: 'https://r/a.png' }],
    ['m.md', { exists: false, inside: true }],
    ['../o.md', { exists: false, inside: false }],
  ]);
  const [i, m, o, u, g, h] = canvasView(source, { resources }).nodes;
  assert.equal(i!.image, 'https://r/a.png');
  assert.deepEqual([m!.missing, m!.subpath, m!.title], [true, '#H', 'm.md']);
  assert.equal(o!.outside, true);
  assert.deepEqual([u!.missing, u!.outside, u!.image], [undefined, undefined, undefined]);
  assert.deepEqual([g!.background, g!.backgroundStyle], ['https://r/a.png', 'repeat']);
  assert.deepEqual([h!.background, h!.backgroundStyle], [undefined, undefined]);
});

test('read errors become the error view with a one-based line and a reason', () => {
  const cases: [string, number, string][] = [
    ['{\n  "nodes": [\n    {"id": 1}\n  ]\n}', 3, DEFAULT_MESSAGES.reasonRequired],
    ['{\n,', 2, DEFAULT_MESSAGES.reasonSyntax],
    ['[]', 1, DEFAULT_MESSAGES.reasonRoot],
    ['{"nodes": {}}', 1, DEFAULT_MESSAGES.reasonNotArray],
    ['{"edges": [1]}', 1, DEFAULT_MESSAGES.reasonNotObject],
  ];
  for (const [source, line, reason] of cases) {
    const view = buildCanvasView(readCanvas(source));
    assert.equal(view.state, 'error', source);
    if (view.state !== 'error') continue;
    assert.deepEqual([view.line, view.message, view.reason], [line, `This canvas cannot be read (line ${line}).`, reason], source);
  }
});

test('size limits: read-only with a notice naming the limit', () => {
  const nodes = Array.from({ length: 5001 }, (_, i) => ({ id: `n${i}`, type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 }));
  const many = canvasView(JSON.stringify({ nodes }));
  assert.equal(many.readOnly, true);
  assert.deepEqual(many.notices, [{ kind: 'info', text: DEFAULT_MESSAGES.readOnlyNodes }]);
  const large = canvasView(JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: 'x'.repeat(5 * 1024 * 1024), x: 0, y: 0, width: 10, height: 10 }] }));
  assert.equal(large.readOnly, true);
  assert.deepEqual(large.notices, [{ kind: 'info', text: DEFAULT_MESSAGES.readOnlySize }]);
});

test('cards know their innermost group', () => {
  const view = canvasView(
    JSON.stringify({
      nodes: [
        { id: 'outer', type: 'group', x: 0, y: 0, width: 1000, height: 1000 },
        { id: 'inner', type: 'group', x: 100, y: 100, width: 300, height: 300 },
        { id: 'twin', type: 'group', x: 100, y: 100, width: 300, height: 300 },
        { id: 'a', type: 'text', text: '', x: 150, y: 150, width: 10, height: 10 },
        { id: 'b', type: 'text', text: '', x: 500, y: 500, width: 10, height: 10 },
        { id: 'c', type: 'text', text: '', x: 990, y: 990, width: 20, height: 20 },
      ],
    }),
  );
  assert.deepEqual(view.nodes.map((n) => n.group), [undefined, 0, 1, 1, 0, undefined]);
});

test('text titles: first line without Markdown markers, shortened', () => {
  assert.equal(textTitle('\n\n# Heading *one*\nmore'), 'Heading one');
  assert.equal(textTitle('- [x] done item'), 'done item');
  assert.equal(textTitle('> quoted `code`'), 'quoted code');
  assert.equal(textTitle('   '), '');
  assert.equal(textTitle('x'.repeat(200)).length, 80);
  assert.equal(fileName('a/b/c.md'), 'c.md');
  assert.equal(fileName('c.md'), 'c.md');
});

test('image paths by extension', () => {
  for (const path of ['a.png', 'b/c.JPG', 'x.jpeg', 'y.gif', 'z.webp', 'v.svg', 'w.avif', 'q.bmp']) assert.ok(isImagePath(path), path);
  for (const path of ['a.md', 'png', '.png', 'a.png.md', 'a.pdf']) assert.ok(!isImagePath(path), path);
});

test('canvas paths stay inside the root', () => {
  assert.equal(resolveInside('', 'a/b.md'), 'a/b.md');
  assert.equal(resolveInside('sub', './a/../b.md'), 'sub/b.md');
  assert.equal(resolveInside('sub', '../b.md'), 'b.md');
  for (const path of ['../b.md', '/etc/passwd', 'C:/x.md', 'c:x', 'a\\..\\..\\b', '', '.', 'a/..', 'a\u0000b']) {
    assert.equal(resolveInside('', path), undefined, JSON.stringify(path));
  }
});

test('subpaths find headings and blocks', () => {
  const text = '# Top\n\n## Open questions ##\ntext ^abc\n\n### Deep\n- item ^x-1\n';
  assert.equal(findSubpathLine(text, '#Open questions'), 2);
  assert.equal(findSubpathLine(text, '#top'), 0);
  assert.equal(findSubpathLine(text, '#Top#Deep'), 5);
  assert.equal(findSubpathLine(text, '#^abc'), 3);
  assert.equal(findSubpathLine(text, '#^x-1'), 6);
  assert.equal(findSubpathLine(text, '#Nope'), undefined);
  assert.equal(findSubpathLine(text, '#^'), undefined);
  assert.equal(findSubpathLine(text, '#'), undefined);
});

test('webview messages: accepted shapes only', () => {
  const ok = [{ type: 'ready' }, { type: 'openAsText' }, { type: 'openUrl', url: 'https://x' }, { type: 'openFile', index: 0, id: '' }, { type: 'openLink', target: '노트#제목' }];
  for (const message of ok) assert.ok(validateWebviewMessage(message).ok, JSON.stringify(message));
  const bad = [
    null,
    [],
    { type: 'openUrl' },
    { type: 'openUrl', url: '' },
    { type: 'openUrl', url: 'https://x\nY' },
    { type: 'openUrl', url: 'x'.repeat(8001) },
    { type: 'openFile', index: 1.5, id: 'a' },
    { type: 'openFile', index: 0, id: 'a', extra: true },
    { type: 'move', id: 'a' },
    { type: 'ready', x: 1 },
    { type: 'openLink', target: '' },
    { type: 'openLink', target: 'x'.repeat(1001) },
    { type: 'openLink' },
  ];
  for (const message of bad) assert.ok(!validateWebviewMessage(message).ok, JSON.stringify(message));
});

test('only http and https URLs count as web URLs', () => {
  for (const url of ['https://a.test/x?y#z', 'http://a.test']) assert.ok(isWebUrl(url), url);
  for (const url of ['javascript:alert(1)', 'file:///x', 'vscode://x', 'command:x', 'data:text/html,x', 'mailto:a@b.c', 'nope', '//a.test']) {
    assert.ok(!isWebUrl(url), url);
  }
});

test('strings.ts covers DEFAULT_STRINGS and DEFAULT_MESSAGES with the same English text', () => {
  const source = readFileSync(new URL('../../../src/features/canvas/strings.ts', import.meta.url), 'utf8');
  const section = (from: string, to: string): string => source.slice(source.indexOf(from), source.indexOf(to));
  const entries = (body: string) => Object.fromEntries([...body.matchAll(/(\w+): (?:\([^)]*\) => )?vscode\.l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(entries(section('export function viewStrings', 'export function viewMessages')), { ...DEFAULT_STRINGS });
  const messages = entries(section('export function viewMessages', 'export const messages'));
  const { unreadable, warnings, ...plain } = DEFAULT_MESSAGES;
  assert.deepEqual(messages, {
    ...plain,
    unreadable: unreadable(-1).replace('-1', '{0}'),
    warnings: warnings(-1, -2).replace('-1', '{0}').replace('-2', '{1}'),
  });
});

test('file and link cards: captions as Obsidian shows them, and the note of a Markdown file', () => {
  const source = JSON.stringify({
    nodes: [
      { id: 'n', type: 'file', file: 'Notes/프로젝트 A.md', x: 0, y: 0, width: 10, height: 10 },
      { id: 's', type: 'file', file: 'Notes/프로젝트 A.md', subpath: '#일정', x: 0, y: 0, width: 10, height: 10 },
      { id: 'i', type: 'file', file: 'Notes/그림.png', x: 0, y: 0, width: 10, height: 10 },
      { id: 'm', type: 'file', file: 'gone.md', x: 0, y: 0, width: 10, height: 10 },
      { id: 'l', type: 'link', url: 'https://example.com/a', x: 0, y: 0, width: 10, height: 10 },
    ],
  });
  const note = '---\ntags: [a]\n---\n\n# 프로젝트 A\n\n본문\n\n## 일정\n\n- 10월\n\n## 예산\n';
  const resources = new Map([
    ['Notes/프로젝트 A.md', { exists: true, inside: true, note }],
    ['Notes/그림.png', { exists: true, inside: true, image: 'https://r/p.png' }],
    ['gone.md', { exists: false, inside: true }],
  ]);
  const [n, s, i, m, l] = canvasView(source, { resources }).nodes;
  assert.deepEqual([n!.caption, n!.note], ['프로젝트 A', '# 프로젝트 A\n\n본문\n\n## 일정\n\n- 10월\n\n## 예산\n']);
  assert.deepEqual([s!.caption, s!.note], ['프로젝트 A#일정', '## 일정\n\n- 10월\n']);
  assert.deepEqual([i!.caption, i!.note, i!.image], ['그림.png', undefined, 'https://r/p.png']);
  assert.deepEqual([m!.caption, m!.note, m!.missing], ['gone', undefined, true]);
  assert.equal(l!.caption, 'example.com/a');
});

test('note excerpts: front matter dropped, heading sections, block lines, a cap', () => {
  assert.equal(noteExcerpt('---\na: 1\n---\nText'), 'Text');
  assert.equal(noteExcerpt('---\nunclosed\nText'), '---\nunclosed\nText', 'not front matter without a closing line');
  assert.equal(noteExcerpt('﻿# T\r\nbody'), '# T\nbody');
  const text = '# A\nintro\n## B\nb1\n### B1\nb2\n## C\nc ^blk\n';
  assert.equal(noteExcerpt(text, '#B'), '## B\nb1\n### B1\nb2');
  assert.equal(noteExcerpt(text, '#A#B#B1'), '### B1\nb2');
  assert.equal(noteExcerpt(text, '#^blk'), 'c');
  assert.equal(noteExcerpt(text, '#Nowhere'), text, 'a subpath not found shows the whole note');
  const long = Array.from({ length: MAX_NOTE_LINES + 50 }, (_, k) => `l${k}`).join('\n');
  assert.equal(noteExcerpt(long).split('\n').length, MAX_NOTE_LINES);
});
