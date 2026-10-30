// Vault-relative paths of VS Code URIs, compared the way the file system does (core.md 3.1):
// case-insensitively on Windows and macOS, and drive letters ('/d:/' vs '/D:/') always.
import type * as vscode from 'vscode';
import { relativePath, samePath } from './paths.ts';

/** Default file systems of Windows and macOS ignore case; Linux does not. */
export const CASE_INSENSITIVE_FS = process.platform !== 'linux';

const options = { caseInsensitive: CASE_INSENSITIVE_FS };

/** Path of `uri` relative to the vault `root` (forward slashes), or undefined outside it. */
export function vaultRelativePath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== root.scheme || uri.authority.toLowerCase() !== root.authority.toLowerCase()) return undefined;
  return relativePath(root.path, uri.path, options);
}

/** Whether two URI paths name the same file on this file system. */
export function sameUriPath(a: string, b: string): boolean {
  return samePath(a, b, options);
}
