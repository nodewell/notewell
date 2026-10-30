import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsp } from '../../src/webview/csp.ts';
import { createNonce } from '../../src/webview/nonce.ts';
import { escapeHtml, renderWebviewPage } from '../../src/webview/html.ts';

// Real `webview.cspSource` shape on desktop VS Code: a space-separated source list.
const CSP_SOURCE = "'self' https://*.vscode-cdn.net";

function page(overrides: Partial<Parameters<typeof renderWebviewPage>[0]> = {}): string {
  return renderWebviewPage({
    cspSource: CSP_SOURCE,
    title: 'Board',
    lang: 'en',
    styleUris: ['https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/base.css'],
    scriptUris: ['https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/kanban.js'],
    ...overrides,
  });
}

function cspOf(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(match, 'CSP meta tag present');
  return match[1]!.replaceAll('&#39;', "'");
}

test('CSP matches core.md section 6 exactly', () => {
  assert.equal(
    buildCsp(CSP_SOURCE, 'abc123+/'),
    `default-src 'none'; script-src 'nonce-abc123+/'; style-src ${CSP_SOURCE};`,
  );
});

test('local images (canvas.md 7) add img-src from the webview source only', () => {
  assert.equal(
    buildCsp(CSP_SOURCE, 'abc', { images: true }),
    `default-src 'none'; script-src 'nonce-abc'; style-src ${CSP_SOURCE}; img-src ${CSP_SOURCE};`,
  );
  assert.equal(buildCsp(CSP_SOURCE, 'abc', { images: false }), buildCsp(CSP_SOURCE, 'abc'));
  assert.throws(() => buildCsp("'self' 'unsafe-inline'", 'abc', { images: true }), /Invalid webview CSP source/);
  const csp = cspOf(page({ images: true }));
  assert.match(csp, /; img-src 'self' https:\/\/\*\.vscode-cdn\.net;$/);
  assert.doesNotMatch(cspOf(page()), /img-src/);
});

test('CSP accepts real cspSource lists and normalizes whitespace', () => {
  assert.equal(
    buildCsp("'self' https://*.vscode-cdn.net", 'n0nce'),
    "default-src 'none'; script-src 'nonce-n0nce'; style-src 'self' https://*.vscode-cdn.net;",
  );
  assert.equal(
    buildCsp("  'self'\t\thttps://*.vscode-cdn.net  vscode-webview://abc ", 'n'),
    "default-src 'none'; script-src 'nonce-n'; style-src 'self' https://*.vscode-cdn.net vscode-webview://abc;",
  );
  assert.equal(buildCsp('https:', 'n'), "default-src 'none'; script-src 'nonce-n'; style-src https:;");
});

test('CSP rejects sources and nonces that could inject directives', () => {
  const rejected = [
    'x; script-src *',
    `${CSP_SOURCE}; script-src *`,
    "'unsafe-inline'",
    "'self' 'unsafe-inline'",
    "'unsafe-eval'",
    "'nonce-abc'",
    "'sha256-abc'",
    "'none'",
    'a,b',
    'https://x"',
    "'self'\nscript-src *",
    "'self'\r\n",
    `https://x${String.fromCharCode(0)}`,
    '',
    '   ',
  ];
  for (const source of rejected) {
    assert.throws(() => buildCsp(source, 'abc'), /Invalid webview CSP source/, JSON.stringify(source));
  }
  assert.throws(() => buildCsp(CSP_SOURCE, "abc' 'unsafe-eval"));
  assert.throws(() => buildCsp(CSP_SOURCE, ''));
});

test('nonce is 24 base64 characters and unique per call', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const nonce = createNonce();
    assert.match(nonce, /^[A-Za-z0-9+/]{24}$/);
    seen.add(nonce);
  }
  assert.equal(seen.size, 1000);
});

test('page CSP is exact and the nonce changes on every render', () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const html = page();
    const csp = cspOf(html);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.equal(csp, `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${CSP_SOURCE};`);
    nonces.add(nonce);
  }
  assert.equal(nonces.size, 20);
});

test('every script tag carries the page nonce; no inline script or style', () => {
  const html = page({ scriptUris: ['a.js', 'b.js'] });
  const nonce = /script-src 'nonce-([^']+)'/.exec(cspOf(html))?.[1];
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 2);
  for (const tag of scripts) {
    assert.ok(tag.includes(`nonce="${nonce}"`), tag);
    assert.match(tag, /\ssrc="/);
  }
  assert.doesNotMatch(html, /<script\b[^>]*>[^<]+<\/script>/);
  assert.doesNotMatch(html, /<style\b|\sstyle="/);
});

test('title, lang and URIs are escaped', () => {
  const html = page({
    title: '</title><script>x()</script>',
    lang: 'en" onload="x()',
    styleUris: ['a.css"><script>x()</script>'],
  });
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;x()&lt;/script&gt;'));
  assert.ok(html.includes('lang="en&quot; onload=&quot;x()"'));
});

test('body data attributes are escaped; names that are not plain data names are dropped', () => {
  const page = renderWebviewPage({ cspSource: 'vscode-resource:', title: 't', lang: 'en', styleUris: [], scriptUris: [], data: { project: 'file:/a "b" <c>', 'x-y': '1', 'on load': 'bad', Upper: 'bad' } });
  assert.match(page, /<body data-project="file:\/a &quot;b&quot; &lt;c&gt;" data-x-y="1">/);
  assert.doesNotMatch(page, /bad/);
  assert.match(renderWebviewPage({ cspSource: 'vscode-resource:', title: 't', lang: 'en', styleUris: [], scriptUris: [] }), /<body>/);
});

test('escapeHtml covers the five HTML special characters', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
