// Link hover and go-to for Markdown notes in a vault (links.md 6): a HoverProvider showing the
// target's beginning (or its heading/block section), and a DefinitionProvider so Ctrl+click opens
// the target at that line. Never creates files (links.md 10 #11). Read-only.
import * as vscode from 'vscode';
import { lineTexts, parseLines } from '../../core/lines.ts';
import type { LinkStore } from '../../vault/link-store.ts';
import { extractLinks, type LinkRef } from '../../vault/link-index.ts';
import { formatSize, linkAt, previewRange, safePreviewMarkdown, subpathLine } from './model.ts';

export interface LinkPreviewDependencies {
  readonly links: () => LinkStore | undefined;
}

const SELECTOR: vscode.DocumentSelector = { language: 'markdown' };
const isMarkdown = (path: string): boolean => /\.md$/i.test(path);
const uriOf = (root: vscode.Uri, path: string): vscode.Uri => vscode.Uri.joinPath(root, ...path.split('/'));

/** Notes larger than this are not read for a preview or a heading jump (only named with their size). */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * A note's text for previewing: the open editor's text, else the file when it is small enough
 * and not binary (NUL); otherwise its size (or nothing when it cannot be read).
 */
async function readText(uri: vscode.Uri): Promise<{ text: string } | { size: number } | undefined> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (open !== undefined) return { text: open.getText() };
  try {
    const { size } = await vscode.workspace.fs.stat(uri);
    if (size > MAX_PREVIEW_BYTES) return { size };
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return text.includes('\0') ? { size } : { text };
  } catch {
    return undefined;
  }
}

interface Target {
  readonly root: vscode.Uri;
  readonly link: LinkRef;
  readonly range: vscode.Range;
  /** Resolved vault-relative paths: one, several (ambiguous) or none (missing). */
  readonly paths: readonly string[];
}

// Links of the last documents hovered, per version: hovering again in a large unchanged document
// does not parse it again.
const MAX_CACHED_DOCUMENTS = 8;
const linkCache = new Map<string, { version: number; links: readonly LinkRef[] }>();

function linksOf(document: vscode.TextDocument): readonly LinkRef[] {
  const key = document.uri.toString();
  const cached = linkCache.get(key);
  if (cached !== undefined && cached.version === document.version) return cached.links;
  const links = extractLinks(document.getText());
  if (typeof document.version === 'number') {
    linkCache.delete(key);
    linkCache.set(key, { version: document.version, links });
    while (linkCache.size > MAX_CACHED_DOCUMENTS) linkCache.delete(linkCache.keys().next().value!);
  }
  return links;
}

/** The link under the position and what it resolves to, from the current (maybe unsaved) text. */
function targetAt(deps: LinkPreviewDependencies, document: vscode.TextDocument, position: vscode.Position): Target | undefined {
  if (!vscode.workspace.getConfiguration('notewell.linkPreview', document.uri).get<boolean>('enabled', true)) return undefined;
  const store = deps.links();
  const found = store?.indexFor(document.uri);
  const from = store?.relativePath(document.uri);
  if (found === undefined || from === undefined) return undefined;
  const link = linkAt(linksOf(document), position.line, position.character);
  if (link === undefined || link.path === '') return undefined;
  const resolution = found.index.resolver.resolve({ form: link.form, path: link.path }, from);
  const paths = resolution.kind === 'found' ? [resolution.path] : resolution.kind === 'ambiguous' ? resolution.paths : [];
  return { root: found.root, link, range: new vscode.Range(link.line, link.start, link.line, link.end), paths };
}

const escapeMd = (text: string): string => text.replace(/[\\`*_[\]#<>|]/g, '\\$&');

async function previewOf(root: vscode.Uri, path: string, subpath: string | null): Promise<string> {
  const uri = uriOf(root, path);
  const title = `**${escapeMd(path)}**`;
  if (!isMarkdown(path)) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return `${title} — ${formatSize(stat.size)}`;
    } catch {
      return title;
    }
  }
  const read = await readText(uri);
  if (read === undefined) return title;
  if ('size' in read) return `${title} — ${formatSize(read.size)}`;
  const { lines, found } = previewRange(lineTexts(parseLines(read.text)), subpath);
  const missing = found ? '' : `\n\n_${escapeMd(vscode.l10n.t('"{0}" was not found in this note.', subpath ?? ''))}_`;
  return `${title}${missing}\n\n---\n\n${safePreviewMarkdown(lines)}`;
}

function markdown(value: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(value, false);
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

export function registerLinkPreview(context: vscode.ExtensionContext, deps: LinkPreviewDependencies): void {
  const hover: vscode.HoverProvider = {
    async provideHover(document, position) {
      const target = targetAt(deps, document, position);
      if (target === undefined) return undefined;
      if (target.paths.length === 0) {
        return new vscode.Hover(markdown(escapeMd(vscode.l10n.t('"{0}" does not exist in this vault.', target.link.path))), target.range);
      }
      if (target.paths.length > 1) {
        const list = target.paths.map((p) => `- ${escapeMd(p)}`).join('\n');
        return new vscode.Hover(markdown(`${escapeMd(vscode.l10n.t('Several files match this link:'))}\n\n${list}`), target.range);
      }
      return new vscode.Hover(markdown(await previewOf(target.root, target.paths[0]!, target.link.subpath)), target.range);
    },
  };

  const definition: vscode.DefinitionProvider = {
    async provideDefinition(document, position) {
      const target = targetAt(deps, document, position);
      if (target === undefined || target.paths.length === 0) return undefined;
      const locations: vscode.LocationLink[] = [];
      for (const path of target.paths) {
        const uri = uriOf(target.root, path);
        let line = 0;
        if (isMarkdown(path) && target.link.subpath !== null) {
          const read = await readText(uri);
          line = (read === undefined || !('text' in read) ? undefined : subpathLine(lineTexts(parseLines(read.text)), target.link.subpath)) ?? 0;
        }
        const at = new vscode.Range(line, 0, line, 0);
        locations.push({ originSelectionRange: target.range, targetUri: uri, targetRange: at, targetSelectionRange: at });
      }
      return locations;
    },
  };

  context.subscriptions.push(vscode.languages.registerHoverProvider(SELECTOR, hover), vscode.languages.registerDefinitionProvider(SELECTOR, definition));
}
