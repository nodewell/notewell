// VS Code adapter for core patch edits: one WorkspaceEdit touching only the board's document.
import * as vscode from 'vscode';
import type { TextEdit } from '../../core/patch.ts';

export function toWorkspaceEdit(uri: vscode.Uri, edits: readonly TextEdit[]): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const { range, newText } of edits) {
    edit.replace(
      uri,
      new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
      newText,
    );
  }
  return edit;
}
