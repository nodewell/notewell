// Backlinks sidebar (links.md 5): linked and (optionally) unlinked mentions of the active note,
// from the vault link index. Read-only: it reads files and opens editors, never writes.
import * as vscode from 'vscode';
import { lineTexts, parseLines } from '../../core/lines.ts';
import type { LinkStore } from '../../vault/link-store.ts';
import type { VaultRegistry } from '../../vault/registry.ts';
import { isExcluded, linkedMentions, noteName, unlinkedMentions, type Mention, type MentionGroup } from './model.ts';

export interface BacklinkDependencies {
  readonly links: () => LinkStore | undefined;
  readonly vaults: () => VaultRegistry | undefined;
  readonly linksChanged: vscode.Event<void>;
}

export const BACKLINKS_VIEW = 'notewell.backlinks';
export const BACKLINKS_CONTEXT = 'notewell.backlinks.active';
/** Internal command behind each mention (not in the palette): opens it if the file still exists. */
export const BACKLINKS_OPEN = 'notewell.backlinks.open';
const REFRESH_DELAY_MS = 150;

type Node =
  | { readonly kind: 'section'; readonly label: string; readonly groups: readonly MentionGroup[]; readonly unlinked: boolean }
  | { readonly kind: 'file'; readonly root: vscode.Uri; readonly group: MentionGroup }
  | { readonly kind: 'mention'; readonly root: vscode.Uri; readonly source: string; readonly mention: Mention }
  | { readonly kind: 'message'; readonly label: string };

const isMarkdown = (path: string): boolean => /\.md$/i.test(path);
const uriOf = (root: vscode.Uri, path: string): vscode.Uri => vscode.Uri.joinPath(root, ...path.split('/'));

/** The file the active editor shows: text editors and custom editors (Kanban boards) alike. */
export function activeFile(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input as { uri?: vscode.Uri } | undefined;
  return input?.uri ?? vscode.window.activeTextEditor?.document.uri;
}

/** An open editor's text, or the file on disk; undefined when unreadable. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (open !== undefined) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

export class BacklinksProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #deps: BacklinkDependencies;
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #roots: Node[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  constructor(deps: BacklinkDependencies) {
    this.#deps = deps;
  }

  /** Rebuilds the tree for the active note (debounced). */
  schedule(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    const roots = await this.#build();
    if (generation !== this.#generation) return;
    this.#roots = roots;
    this.#changed.fire(undefined);
  }

  async #build(): Promise<Node[]> {
    const uri = activeFile();
    const store = this.#deps.links();
    const found = uri && store?.indexFor(uri);
    const path = uri && store?.relativePath(uri);
    void vscode.commands.executeCommand('setContext', BACKLINKS_CONTEXT, found !== undefined && path !== undefined);
    if (uri === undefined || store === undefined || path === undefined) return [];
    if (found === undefined) return [{ kind: 'message', label: vscode.l10n.t('Indexing the vault…') }];
    const { root, index } = found;

    const cache = new Map<string, readonly string[] | undefined>();
    const textOf = async (source: string): Promise<string | undefined> => readText(uriOf(root, source));
    const sources = [...new Set(index.incoming(path).map((l) => l.source))];
    for (const source of sources) {
      const text = await textOf(source);
      cache.set(source, text === undefined ? undefined : lineTexts(parseLines(text)));
    }
    const linked = linkedMentions(index.incoming(path), (source) => cache.get(source));
    const nodes: Node[] = [{ kind: 'section', label: vscode.l10n.t('Linked mentions'), groups: linked, unlinked: false }];

    const config = vscode.workspace.getConfiguration('notewell.backlinks', uri);
    if (config.get<boolean>('unlinked', false)) {
      const name = noteName(path);
      const filters = this.#deps.vaults()?.vaultFor(uri)?.settings.userIgnoreFilters ?? [];
      const groups: MentionGroup[] = [];
      for (const source of index.files()) {
        if (source === path || !isMarkdown(source) || isExcluded(source, filters)) continue;
        const text = await textOf(source);
        if (text === undefined) continue;
        const mentions = unlinkedMentions(text, name, index.outgoing(source).map((o) => o.link));
        if (mentions.length > 0) groups.push({ source, mentions });
      }
      groups.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
      nodes.push({ kind: 'section', label: vscode.l10n.t('Unlinked mentions'), groups, unlinked: true });
    }
    return nodes;
  }

  /**
   * Opens a mention. The view may be a moment behind a rename or delete: a file that is gone is
   * not opened (an editor on the old path could recreate it on save); the view is refreshed.
   */
  async open(uri: vscode.Uri, options: vscode.TextDocumentShowOptions): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      this.schedule();
      void vscode.window.showInformationMessage(vscode.l10n.t('This file was moved or deleted. The backlinks are being updated.'));
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri, options);
  }

  getChildren(node?: Node): Node[] {
    if (node === undefined) return this.#roots;
    if (node.kind === 'section') {
      const root = this.#rootFor();
      if (root === undefined) return [];
      if (node.groups.length === 0) return [{ kind: 'message', label: node.unlinked ? vscode.l10n.t('No unlinked mentions') : vscode.l10n.t('No backlinks') }];
      return node.groups.map((group) => ({ kind: 'file', root, group }));
    }
    if (node.kind === 'file') return node.group.mentions.map((mention) => ({ kind: 'mention', root: node.root, source: node.group.source, mention }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const count = node.groups.reduce((sum, g) => sum + g.mentions.length, 0);
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(count);
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(noteName(node.group.source), vscode.TreeItemCollapsibleState.Expanded);
        item.resourceUri = uriOf(node.root, node.group.source);
        item.description = node.group.source.includes('/') ? node.group.source.slice(0, node.group.source.lastIndexOf('/')) : '';
        item.tooltip = node.group.source;
        return item;
      }
      case 'mention': {
        const item = new vscode.TreeItem(node.mention.preview || `${node.mention.line + 1}`, vscode.TreeItemCollapsibleState.None);
        item.tooltip = `${node.source}:${node.mention.line + 1}`;
        const range = new vscode.Range(node.mention.line, node.mention.start, node.mention.line, node.mention.end);
        item.command = { command: BACKLINKS_OPEN, title: vscode.l10n.t('Open'), arguments: [uriOf(node.root, node.source), { selection: range }] };
        return item;
      }
      case 'message':
        return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    }
  }

  #rootFor(): vscode.Uri | undefined {
    const uri = activeFile();
    return uri && this.#deps.links()?.indexFor(uri)?.root;
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#changed.dispose();
  }
}

export function registerBacklinks(context: vscode.ExtensionContext, deps: BacklinkDependencies): BacklinksProvider {
  const provider = new BacklinksProvider(deps);
  const schedule = (): void => provider.schedule();
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(BACKLINKS_VIEW, provider),
    vscode.commands.registerCommand(BACKLINKS_OPEN, (uri: vscode.Uri, options: vscode.TextDocumentShowOptions) => provider.open(uri, options)),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.window.tabGroups.onDidChangeTabs(schedule),
    deps.linksChanged(schedule),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('notewell.backlinks')) schedule();
    }),
  );
  schedule();
  return provider;
}
