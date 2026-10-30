// Thin VS Code adapter for webview pages. Logic lives in the VS Code-free modules.
import * as vscode from 'vscode';
import { renderWebviewPage } from './html.ts';

/** Built webview assets (see scripts/build.mjs). */
const ASSET_DIR = ['dist', 'webview'] as const;
const BASE_STYLESHEET = 'base.css';

/** `extraRoots`: further folders the page may load resources (local images) from. */
export function webviewOptions(extensionUri: vscode.Uri, extraRoots: readonly vscode.Uri[] = []): vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableForms: false,
    enableCommandUris: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, ...ASSET_DIR), ...extraRoots],
  };
}

export interface WebviewHtmlOptions {
  readonly title: string;
  /** Script file names inside dist/webview, e.g. `kanban.js`. */
  readonly scripts: readonly string[];
  /** Extra stylesheet file names inside dist/webview, loaded after base.css. */
  readonly styles?: readonly string[];
  /** Allow local images from the webview's resource roots (CSP img-src). */
  readonly images?: boolean;
  /** `data-*` attributes of the page's `<body>`, read by its script. */
  readonly data?: Readonly<Record<string, string>>;
}

export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  options: WebviewHtmlOptions,
): string {
  const assetUri = (file: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...ASSET_DIR, file)).toString();
  return renderWebviewPage({
    cspSource: webview.cspSource,
    title: options.title,
    lang: vscode.env.language,
    styleUris: [BASE_STYLESHEET, ...(options.styles ?? [])].map(assetUri),
    scriptUris: options.scripts.map(assetUri),
    images: options.images === true,
    ...(options.data === undefined ? {} : { data: options.data }),
  });
}
