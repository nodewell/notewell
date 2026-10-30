// Content Security Policy for every Notewell webview (core.md section 6).
// Images, fonts and connections stay blocked because default-src is 'none'. A feature that
// shows local images (canvas.md 4, 7) may allow `img-src` from the webview's own resource
// source only, so images can come from its localResourceRoots and nowhere else.

const NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
// One scheme/host source such as `https://*.vscode-cdn.net`, `vscode-webview://x` or `https:`:
// no separators, quotes or control characters that could end the directive.
const HOST_SOURCE_PATTERN = /^[^\s;,'"\u0000-\u001f\u007f]+$/;
// Quoted keywords allowed in `webview.cspSource`; others ('unsafe-inline', nonces, hashes) are refused.
const ALLOWED_KEYWORDS = new Set(["'self'"]);

/**
 * Normalized style sources from `webview.cspSource`, which VS Code gives as a
 * space-separated source list (for example `'self' https://*.vscode-cdn.net`).
 */
function styleSources(cspSource: string): string {
  const tokens = cspSource.split(/[ \t]+/).filter((t) => t !== '');
  if (/[\r\n]/.test(cspSource) || tokens.length === 0) throw new Error('Invalid webview CSP source');
  for (const token of tokens) {
    if (!ALLOWED_KEYWORDS.has(token) && !HOST_SOURCE_PATTERN.test(token)) {
      throw new Error('Invalid webview CSP source');
    }
  }
  return tokens.join(' ');
}

export interface CspOptions {
  /** Allow images from `cspSource` (local resources only). Default false. */
  readonly images?: boolean;
}

export function buildCsp(cspSource: string, nonce: string, options: CspOptions = {}): string {
  const styles = styleSources(cspSource);
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('Invalid CSP nonce');
  }
  const images = options.images === true ? ` img-src ${styles};` : '';
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${styles};${images}`;
}
