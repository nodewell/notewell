// "New Kanban Board" (kanban.md 4.5): asks for a file name and creates one new board file,
// never overwriting an existing one. Allowed in untrusted workspaces (one new file the user
// explicitly asked for, core.md 6).
import * as vscode from 'vscode';
import { isSafeName } from '../../vault/appearance.ts';
import { KANBAN_VIEW_TYPE } from './editor.ts';
import { messages } from './strings.ts';
import { eolFor, newBoardText } from './template.ts';

export const DEFAULT_BOARD_NAME = 'Kanban.md';

// Windows device names, also with an extension (`CON.md` opens the console, not a file).
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\.|$)/i;

/**
 * The file name a user typed, with `.md` added; undefined when it is not one safe name:
 * reserved device names, hidden names (a leading dot: Obsidian does not show them) and names
 * ending in a dot (Windows drops it) are refused too.
 */
export function boardFileName(input: string): string | undefined {
  const name = input.trim();
  const file = name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
  if (name === '' || name.startsWith('.') || name.endsWith('.') || RESERVED.test(file)) return undefined;
  return isSafeName(file) ? file : undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Folder for the new board: the explorer folder, else the active file's folder, else the first workspace folder. */
function targetFolder(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const active =
    vscode.window.activeTextEditor?.document.uri ??
    (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined);
  if (active !== undefined && active.scheme !== 'untitled') return vscode.Uri.joinPath(active, '..');
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export async function newBoard(arg?: unknown): Promise<void> {
  const folder = targetFolder(arg);
  if (folder === undefined) {
    void vscode.window.showInformationMessage(messages.newBoardNoFolder());
    return;
  }
  for (;;) {
    const input = await vscode.window.showInputBox({
      title: messages.newBoardTitle(),
      prompt: messages.newBoardPrompt(),
      value: DEFAULT_BOARD_NAME,
      valueSelection: [0, DEFAULT_BOARD_NAME.length - 3],
      validateInput: async (value) => {
        const name = boardFileName(value);
        if (name === undefined) return messages.newBoardInvalidName();
        return (await exists(vscode.Uri.joinPath(folder, name))) ? messages.newBoardExists(name) : undefined;
      },
    });
    if (input === undefined) return;
    const name = boardFileName(input);
    if (name === undefined) continue;
    const uri = vscode.Uri.joinPath(folder, name);
    // Checked again right before writing: never overwrite a file that appeared meanwhile.
    if (await exists(uri)) {
      void vscode.window.showWarningMessage(messages.newBoardExists(name));
      continue;
    }
    const eol = eolFor(vscode.workspace.getConfiguration('files', folder).get<unknown>('eol', 'auto'), process.platform);
    // Created only if still absent (another program may have made it after the check above):
    // a create without overwrite fails instead of replacing that file. UTF-8 bytes, and the
    // document is loaded as UTF-8 before the board opens it, whatever files.encoding says.
    const create = new vscode.WorkspaceEdit();
    create.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: new TextEncoder().encode(newBoardText(vscode.env.language, eol)) });
    if (!(await vscode.workspace.applyEdit(create))) {
      if (await exists(uri)) {
        void vscode.window.showWarningMessage(messages.newBoardExists(name));
        continue;
      }
      void vscode.window.showWarningMessage(messages.newBoardFailed(name));
      return;
    }
    await vscode.workspace.openTextDocument(uri, { encoding: 'utf8' });
    await vscode.commands.executeCommand('vscode.openWith', uri, KANBAN_VIEW_TYPE);
    return;
  }
}
