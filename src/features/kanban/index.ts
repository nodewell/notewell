// Registers the kanban feature: custom editor, commands and "open boards by default".
import * as vscode from 'vscode';
import type { AppearanceStore } from '../../vault/appearance-store.ts';
import type { VaultRegistry } from '../../vault/registry.ts';
import { BoardAssociations } from './associations.ts';
import { hasKanbanFrontmatter } from './detect.ts';
import { KANBAN_VIEW_TYPE, KanbanEditorProvider, kanbanSettings, showCardInText, type OpenCardInText } from './editor.ts';
import { newBoard } from './new-board.ts';
import { messages } from './strings.ts';

export const COMMANDS = {
  openAsBoard: 'notewell.kanban.openAsBoard',
  openAsText: 'notewell.kanban.openAsText',
  newBoard: 'notewell.kanban.newBoard',
  collapseAllCardBodies: 'notewell.kanban.collapseAllCardBodies',
  expandAllCardBodies: 'notewell.kanban.expandAllCardBodies',
} as const;

// Schemes of real files; other schemes (git diffs, output, ...) are never switched to a board.
const AUTO_OPEN_SCHEMES = new Set(['file', 'vscode-remote']);

function isMarkdown(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.md');
}

function tabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  const input = tab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

function findTab(uri: vscode.Uri, matches: (input: unknown) => boolean): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (matches(tab.input) && tabUri(tab)?.toString() === uri.toString()) return tab;
    }
  }
  return undefined;
}

const isTextInput = (input: unknown): boolean => input instanceof vscode.TabInputText;
const isBoardInput = (input: unknown): boolean =>
  input instanceof vscode.TabInputCustom && input.viewType === KANBAN_VIEW_TYPE;

/** Opens `uri` with another editor in the same column and closes the tab it replaces. */
async function reopen(uri: vscode.Uri, viewType: string, replaced: vscode.Tab | undefined): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType, {
    viewColumn: replaced?.group.viewColumn,
    preview: replaced?.isPreview ?? false,
  });
  if (replaced !== undefined) {
    // The tab object may be outdated after the open; close the current one for that input.
    const current = findTab(uri, (input) => input === replaced.input) ?? replaced;
    if (current !== undefined && !current.isDirty) await vscode.window.tabGroups.close(current, true);
  }
}

export interface KanbanDependencies {
  readonly vaults: () => VaultRegistry | undefined;
  /** Fires when vaults become known or change. */
  readonly vaultsChanged?: vscode.Event<void>;
  readonly appearances?: () => AppearanceStore | undefined;
}

export function registerKanban(context: vscode.ExtensionContext, deps: KanbanDependencies): void {
  const { vaults } = deps;
  /**
   * Files the user switched to text with "Open as Text": never switched back to a board
   * automatically during this session (prevents ping-pong between the two editors).
   */
  const preferText = new Set<string>();
  const switching = new Set<string>();
  /** Boards opened per file, to tell whether one opened while a text tab was being checked. */
  const boardOpens = new Map<string, number>();
  /*
   * A text tab of a file that has (or just had) a board in the same group is VS Code's
   * "Reopen Editor With... > Text Editor", which bypasses "Open as Text"; it counts the same.
   * VS Code may report the swap as one event, as an input change, or as separate events in either
   * order, so both the boards before the event and boards closed just before are checked.
   */
  const boardSlot = (uri: vscode.Uri, viewColumn: number): string => `${viewColumn}\n${uri.toString()}`;
  const currentBoards = (): Set<string> => {
    const slots = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) if (isBoardInput(tab.input)) slots.add(boardSlot(tabUri(tab)!, group.viewColumn));
    }
    return slots;
  };
  let boardsBefore = currentBoards();
  const closedBoards = new Map<string, number>();
  const REOPEN_WINDOW_MS = 1000;
  /** The group's active tab is another file (reported before the board it replaced closed). */
  const showsOtherFile = (group: vscode.TabGroup, uri: vscode.Uri): boolean => {
    const active = tabUri(group.activeTab);
    return active !== undefined && active.toString() !== uri.toString();
  };

  /** How long a board still open next to a new text tab may take to be reported closed. */
  const SWAP_SETTLE_MS = 150;

  /**
   * 'replaced': the text tab took the place of a board of the file in its group.
   * 'beside': a board of the file stays open in that group (the file was opened again, e.g. from
   * the explorer), so the board is shown again. 'none': no board involved.
   */
  const boardRelation = async (uri: vscode.Uri, viewColumn: number): Promise<'replaced' | 'beside' | 'none'> => {
    const slot = boardSlot(uri, viewColumn);
    const closedAt = closedBoards.get(slot);
    if (closedAt !== undefined && Date.now() - closedAt <= REOPEN_WINDOW_MS) return 'replaced';
    const before = boardsBefore.has(slot);
    if (!currentBoards().has(slot)) return before ? 'replaced' : 'none';
    // The text tab may be reported before the board it replaces is closed.
    await new Promise((resolve) => setTimeout(resolve, SWAP_SETTLE_MS));
    return currentBoards().has(slot) ? 'beside' : 'replaced';
  };

  /*
   * Text editors opened beside a board with "Open in Text" (kanban.md 4.7), as board slots
   * (group and file). The user did not leave the board, so these tabs are never switched to a
   * board, never closed for a board in their group and never taken as "Open as Text" (the file's
   * editor association stays). `openingInText` covers the tab events that arrive before the open
   * resolves and tells which group the editor went to. A slot ends when its text tab closes.
   */
  const textBeside = new Set<string>();
  const openingInText = new Map<string, number>();
  const openInText: OpenCardInText = async (document, range) => {
    const key = document.uri.toString();
    openingInText.set(key, (openingInText.get(key) ?? 0) + 1);
    try {
      const editor = await showCardInText(document, range);
      if (editor.viewColumn !== undefined) textBeside.add(boardSlot(document.uri, editor.viewColumn));
    } finally {
      const left = (openingInText.get(key) ?? 1) - 1;
      if (left > 0) openingInText.set(key, left);
      else openingInText.delete(key);
    }
  };
  const isTextBeside = (uri: vscode.Uri, viewColumn: number): boolean =>
    openingInText.has(uri.toString()) || textBeside.has(boardSlot(uri, viewColumn));

  const provider = new KanbanEditorProvider(context.extensionUri, deps, openInText);

  // Boards remembered in the user's editor associations (kanban.md 5).
  const associations = new BoardAssociations(context.globalState, KANBAN_VIEW_TYPE);
  const rememberBoards = (): boolean => vscode.workspace.getConfiguration('notewell.kanban').get<boolean>('rememberBoards', true) !== false;
  const remember = (uri: vscode.Uri): void => {
    if (AUTO_OPEN_SCHEMES.has(uri.scheme) && isMarkdown(uri) && rememberBoards() && kanbanSettings(uri).enabled) void associations.remember(uri);
  };
  /** The user chose text for the file: VS Code must stop opening it as a board. */
  const chooseText = (uri: vscode.Uri): void => {
    preferText.add(uri.toString());
    void associations.forget(uri);
  };

  const openAsBoard = async (arg?: unknown): Promise<void> => {
    const uri = arg instanceof vscode.Uri ? arg : (vscode.window.activeTextEditor?.document.uri ?? tabUri(vscode.window.tabGroups.activeTabGroup.activeTab));
    if (uri === undefined || !isMarkdown(uri)) {
      void vscode.window.showInformationMessage(messages.noFile());
      return;
    }
    if (!kanbanSettings(uri).enabled) {
      void vscode.window.showInformationMessage(messages.disabled());
      return;
    }
    preferText.delete(uri.toString());
    await reopen(uri, KANBAN_VIEW_TYPE, findTab(uri, isTextInput));
  };

  const openAsText = async (arg?: unknown): Promise<void> => {
    const uri = arg instanceof vscode.Uri ? arg : tabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (uri === undefined) {
      void vscode.window.showInformationMessage(messages.noFile());
      return;
    }
    chooseText(uri);
    await reopen(uri, 'default', findTab(uri, isBoardInput));
  };

  const maybeOpenAsBoard = async (tab: vscode.Tab): Promise<void> => {
    if (!(tab.input instanceof vscode.TabInputText) || tab.isDirty) return;
    const uri = tab.input.uri;
    const key = uri.toString();
    if (!isMarkdown(uri) || !AUTO_OPEN_SCHEMES.has(uri.scheme) || preferText.has(key) || switching.has(key)) return;
    if (isTextBeside(uri, tab.group.viewColumn)) return;
    const settings = kanbanSettings(uri);
    if (!settings.enabled) return;
    switching.add(key);
    const opensBefore = boardOpens.get(key) ?? 0;
    try {
      const relation = await boardRelation(uri, tab.group.viewColumn);
      if (relation === 'replaced') {
        // A board opened meanwhile (e.g. switched straight back) wins over this switch to text.
        if ((boardOpens.get(key) ?? 0) === opensBefore) chooseText(uri);
        return;
      }
      if (relation === 'beside') {
        // Shown as a board in this group already, with or without frontmatter: keep the board.
        if (!tab.isDirty && findTab(uri, (input) => input === tab.input) !== undefined) await reopen(uri, KANBAN_VIEW_TYPE, tab);
        return;
      }
      if (!settings.openBoardsByDefault) return;
      const document = await vscode.workspace.openTextDocument(uri);
      if (preferText.has(key)) return;
      if (hasKanbanFrontmatter(document.getText())) await reopen(uri, KANBAN_VIEW_TYPE, tab);
    } catch {
      // The file vanished or cannot be read: leave the tab as it is.
    } finally {
      switching.delete(key);
    }
  };

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(KANBAN_VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand(COMMANDS.openAsBoard, openAsBoard),
    vscode.commands.registerCommand(COMMANDS.openAsText, openAsText),
    vscode.commands.registerCommand(COMMANDS.newBoard, newBoard),
    // Card bodies of the active board (kanban.md 3.2): view state only, the setting stays.
    vscode.commands.registerCommand(COMMANDS.collapseAllCardBodies, () => provider.postToActiveBoard({ type: 'cardBodies', collapsed: true })),
    vscode.commands.registerCommand(COMMANDS.expandAllCardBodies, () => provider.postToActiveBoard({ type: 'cardBodies', collapsed: false })),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.closed) {
        if (isBoardInput(tab.input) && !showsOtherFile(tab.group, tabUri(tab)!)) closedBoards.set(boardSlot(tabUri(tab)!, tab.group.viewColumn), Date.now());
        if (isTextInput(tab.input)) textBeside.delete(boardSlot(tabUri(tab)!, tab.group.viewColumn));
      }
      // A board replaced by another file (a preview board left through a link, say) was not
      // switched to text: its text tab coming back soon after (e.g. with "Go Back") is no swap.
      for (const tab of event.opened) {
        const uri = tabUri(tab);
        if (uri === undefined) continue;
        for (const slot of closedBoards.keys()) {
          if (slot.startsWith(`${tab.group.viewColumn}\n`) && slot !== boardSlot(uri, tab.group.viewColumn)) closedBoards.delete(slot);
        }
      }
      // A board opened by any route ("Reopen Editor With..." included) ends the text preference.
      for (const tab of event.opened) {
        if (!isBoardInput(tab.input)) continue;
        const key = tabUri(tab)!.toString();
        preferText.delete(key);
        boardOpens.set(key, (boardOpens.get(key) ?? 0) + 1);
        remember(tabUri(tab)!);
      }
      // `changed` covers a preview tab whose file was replaced.
      for (const tab of [...event.opened, ...event.changed]) void maybeOpenAsBoard(tab);
      boardsBefore = currentBoards();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) void associations.rename(oldUri, newUri);
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) void associations.forgetWithin(uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Turned off, globally or for some files: those entries go.
      if (!event.affectsConfiguration('notewell.kanban')) return;
      void associations.forgetWhere((uri) => !rememberBoards() || !kanbanSettings(uri).enabled);
    }),
  );
  // Editors already open when the extension activates.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (isBoardInput(tab.input)) remember(tabUri(tab)!);
      else void maybeOpenAsBoard(tab);
    }
  }
  // Settings may have changed while the extension was not running.
  void associations.forgetWhere((uri) => !rememberBoards() || !kanbanSettings(uri).enabled);
}
