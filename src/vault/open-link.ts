// VS Code adapter: opens the file a wikilink names, for the board and canvas views.
import * as vscode from 'vscode';
import { resolveLink } from './links.ts';
import type { VaultRegistry } from './registry.ts';

/**
 * Opens the file a wikilink names, resolved like Obsidian within the vault of `from` (or its
 * workspace folder outside a vault) by the shared resolver (links.md 2.2). Never creates
 * files; when several files fit, the user picks one instead of a guess.
 */
export async function openWikilink(target: string, from: vscode.Uri, vaults: VaultRegistry | undefined): Promise<void> {
  const root = vaults?.vaultFor(from)?.root ?? vscode.workspace.getWorkspaceFolder(from)?.uri;
  if (root === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No note named "{0}" was found in the workspace.', target));
    return;
  }
  const base = root.path.replace(/\/$/, '');
  const relative = (uri: vscode.Uri): string => uri.path.slice(base.length + 1);
  const uris = (await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'))).filter((uri) => uri.path.startsWith(`${base}/`));
  const byPath = new Map(uris.map((uri) => [relative(uri), uri]));
  const result = resolveLink({ form: 'wikilink', path: target }, [...byPath.keys()], relative(from));
  let path: string | undefined;
  if (result.kind === 'found') path = result.path;
  else if (result.kind === 'ambiguous') {
    path = await vscode.window.showQuickPick(result.paths, { placeHolder: vscode.l10n.t('Several files match "{0}". Choose one to open', target) });
  } else {
    void vscode.window.showInformationMessage(vscode.l10n.t('No note named "{0}" was found in the workspace.', target));
    return;
  }
  const uri = path === undefined ? undefined : byPath.get(path);
  if (uri !== undefined) await vscode.commands.executeCommand('vscode.open', uri);
}
