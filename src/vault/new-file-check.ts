// Whether a new note may be made at a path (daily-notes.md 4.3, 8). This module only reads (`stat`);
// the feature that asked writes the file, so src/vault stays read-only.
import * as vscode from 'vscode';

export type NewFileCheck =
  /** A file is already there: open it, never overwrite it. */
  | { readonly kind: 'exists' }
  /** The file may be created after the missing folders (outermost first, vault-relative). */
  | { readonly kind: 'ready'; readonly missingFolders: readonly string[] }
  /** A folder on the way is a symbolic link (could lead out of the vault) or is a file. */
  | { readonly kind: 'refused' };

type Stat = (uri: vscode.Uri) => Thenable<vscode.FileStat>;

/**
 * Checks the place of a new file `path` (from vaultPath) in the vault at `root`: what exists
 * already, which folders are missing, and that no folder on the way is a link (daily-notes.md 8).
 * Call it again right before writing; the file system may have changed since.
 */
export async function checkNewFile(root: vscode.Uri, path: string, stat: Stat = (uri) => vscode.workspace.fs.stat(uri)): Promise<NewFileCheck> {
  const segments = path.split('/');
  const missingFolders: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    const sub = segments.slice(0, i).join('/');
    const isFile = i === segments.length;
    if (missingFolders.length > 0) {
      if (!isFile) missingFolders.push(sub);
      continue;
    }
    let info: vscode.FileStat;
    try {
      info = await stat(vscode.Uri.joinPath(root, ...segments.slice(0, i)));
    } catch {
      if (!isFile) missingFolders.push(sub);
      continue;
    }
    if ((info.type & vscode.FileType.SymbolicLink) !== 0) return { kind: 'refused' };
    if (isFile) return { kind: 'exists' };
    if ((info.type & vscode.FileType.Directory) === 0) return { kind: 'refused' };
  }
  return { kind: 'ready', missingFolders };
}
