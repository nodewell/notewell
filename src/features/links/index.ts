// Registers link updates on rename (links.md 3): VS Code renames or moves files in a vault ->
// the links to them are rewritten in the same operation (one undo), per the settings.
import * as vscode from 'vscode';
import type { LinkStore } from '../../vault/link-store.ts';
import type { VaultRegistry } from '../../vault/registry.ts';
import { sameUriPath } from '../../vault/uri-paths.ts';
import { closedFileText, documentText, planFileRenames, throughSymlink, type RenameNotice, type UpdateMode } from './rename.ts';
import { messages } from './strings.ts';

export interface LinkDependencies {
  readonly links: () => LinkStore | undefined;
  readonly vaults: () => VaultRegistry | undefined;
}

const MODES: readonly UpdateMode[] = ['obsidian', 'always', 'prompt', 'never'];

export function linkSettings(scope?: vscode.Uri): { enabled: boolean; updateOnRename: UpdateMode; saveUpdatedFiles: boolean } {
  const config = vscode.workspace.getConfiguration('notewell.links', scope);
  const mode = config.get<unknown>('updateOnRename', 'obsidian');
  return {
    enabled: config.get<boolean>('enabled', true) !== false,
    updateOnRename: MODES.includes(mode as UpdateMode) ? (mode as UpdateMode) : 'obsidian',
    saveUpdatedFiles: config.get<boolean>('saveUpdatedFiles', false) === true,
  };
}

function show(notice: RenameNotice): void {
  switch (notice.kind) {
    case 'untrusted':
      void vscode.window.showInformationMessage(messages.untrusted());
      break;
    case 'leftVault':
      void vscode.window.showWarningMessage(messages.leftVault(notice.links));
      break;
    case 'notReady':
      void vscode.window.showInformationMessage(messages.notReady());
      break;
    case 'unchanged':
      void vscode.window.showInformationMessage(messages.unchanged(notice.links));
      break;
    case 'tooLarge':
      void vscode.window.showWarningMessage(messages.tooLarge(notice.files));
      break;
    case 'stale':
      void vscode.window.showWarningMessage(messages.stale(notice.files));
      break;
  }
}

/**
 * The text an edit to `uri` would apply to: the open document if VS Code read it as UTF-8, else
 * the file if it is plain UTF-8 that VS Code will also read as UTF-8 (closedFileText). Nothing
 * for a file reached through a symbolic link: an edit could land outside the vault `root`.
 */
async function editableText(uri: vscode.Uri, root: string | undefined): Promise<string | undefined> {
  const isLink = async (path: string): Promise<boolean> =>
    ((await vscode.workspace.fs.stat(uri.with({ path }))).type & vscode.FileType.SymbolicLink) !== 0;
  if (root === undefined || (await throughSymlink(root, uri.path, isLink))) return undefined;
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === uri.scheme && sameUriPath(d.uri.path, uri.path));
  if (open !== undefined) return documentText(open.getText(), open.encoding);
  const files = vscode.workspace.getConfiguration('files', { uri, languageId: 'markdown' });
  const encoding = files.get<unknown>('encoding');
  try {
    return closedFileText(await vscode.workspace.fs.readFile(uri), {
      encoding: typeof encoding === 'string' ? encoding : undefined,
      autoGuess: files.get<boolean>('autoGuessEncoding', false) === true,
    });
  } catch {
    return undefined;
  }
}

export function registerLinks(context: vscode.ExtensionContext, deps: LinkDependencies): void {
  /** Files to save after the rename (new path -> uri), when saveUpdatedFiles is on. */
  let toSave: vscode.Uri[] = [];

  const willRename = async (event: vscode.FileWillRenameEvent): Promise<vscode.WorkspaceEdit> => {
    const edit = new vscode.WorkspaceEdit();
    const first = event.files[0];
    const store = deps.links();
    const registry = deps.vaults();
    if (first === undefined || store === undefined || registry === undefined) return edit;
    const settings = linkSettings(first.oldUri);
    if (!settings.enabled) return edit;
    const toUri = (path: string): vscode.Uri => first.oldUri.with({ path });
    const inside = (root: string): vscode.Uri => toUri(`${root.replace(/\/$/, '')}/_`);
    const outcome = await planFileRenames(
      event.files.map((f) => ({ oldPath: f.oldUri.path, newPath: f.newUri.path })),
      {
        vaultOf: (path) => registry.vaultFor(toUri(path))?.root.path,
        indexFor: (root) => store.indexFor(inside(root))?.index,
        // Read live: a change while the question is open counts (rename.ts checks again after it).
        mode: () => linkSettings(first.oldUri).updateOnRename,
        enabled: () => linkSettings(first.oldUri).enabled,
        trusted: () => vscode.workspace.isTrusted,
        confirm: async (links, files) => {
          const update = messages.updateButton();
          const answer = await vscode.window.showWarningMessage(messages.confirmUpdate(links, files), { modal: true }, update, messages.skipButton());
          return answer === update;
        },
        readText: (path) => editableText(toUri(path), registry.vaultFor(toUri(path))?.root.path),
        reindex: (paths) => {
          for (const path of paths) store.refresh(toUri(path));
        },
      },
    );
    for (const notice of outcome.notices) show(notice);
    for (const e of outcome.edits) {
      edit.replace(toUri(e.path), new vscode.Range(e.line, e.start, e.line, e.end), e.newText);
    }
    // Only files that were saved before the update are saved after it (10 #7); dirty ones never.
    if (settings.saveUpdatedFiles) {
      toSave = outcome.files
        .filter(({ path }) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === first.oldUri.scheme && sameUriPath(d.uri.path, path))?.isDirty !== true)
        .map(({ newPath }) => toUri(newPath));
    }
    return edit;
  };

  context.subscriptions.push(
    // One operation: the link edits are applied with the rename, so one undo reverts both.
    vscode.workspace.onWillRenameFiles((event) => event.waitUntil(willRename(event))),
    vscode.workspace.onDidRenameFiles(async () => {
      const uris = toSave;
      toSave = [];
      for (const uri of uris) {
        try {
          await (await vscode.workspace.openTextDocument(uri)).save();
        } catch {
          // The file vanished or cannot be saved: it stays as it is (unsaved edits shown).
        }
      }
    }),
  );
}
