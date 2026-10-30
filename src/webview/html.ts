import { buildCsp } from './csp.ts';
import { createNonce } from './nonce.ts';

export interface WebviewPageOptions {
  /** `webview.cspSource` of the target webview. */
  readonly cspSource: string;
  readonly title: string;
  readonly lang: string;
  /** Stylesheet URIs already converted with `webview.asWebviewUri`. */
  readonly styleUris: readonly string[];
  /** Script URIs already converted with `webview.asWebviewUri`. */
  readonly scriptUris: readonly string[];
  /** Allow local images (`img-src` from cspSource); see csp.ts. */
  readonly images?: boolean;
  /** `data-*` attributes of `<body>` for the page's script (escaped; other names are dropped). */
  readonly data?: Readonly<Record<string, string>>;
}

const DATA_NAME = /^[a-z][a-z0-9-]*$/;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Builds the host page for a webview. A fresh nonce is generated on every call.
 * The page has no inline styles or scripts; content is rendered by the scripts
 * into `#app` using textContent only.
 */
export function renderWebviewPage(options: WebviewPageOptions): string {
  const nonce = createNonce();
  const csp = buildCsp(options.cspSource, nonce, { images: options.images === true });
  const styles = options.styleUris
    .map((uri) => `<link rel="stylesheet" href="${escapeHtml(uri)}">`)
    .join('\n    ');
  const scripts = options.scriptUris
    .map((uri) => `<script nonce="${nonce}" src="${escapeHtml(uri)}"></script>`)
    .join('\n    ');
  const data = Object.entries(options.data ?? {})
    .filter(([name]) => DATA_NAME.test(name))
    .map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`)
    .join('');
  return `<!DOCTYPE html>
<html lang="${escapeHtml(options.lang)}">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(options.title)}</title>
    ${styles}
  </head>
  <body${data}>
    <div id="app"></div>
    ${scripts}
  </body>
</html>
`;
}
