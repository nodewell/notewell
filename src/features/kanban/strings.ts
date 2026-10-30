// Localized UI strings for the board (English source text, translations in l10n/).
// The view strings mirror DEFAULT_STRINGS in view.ts; test/features/kanban/editor-l10n.test.ts
// checks both stay in sync and that every string has a Korean translation.
import * as vscode from 'vscode';
import type { ErrorStrings } from './session.ts';
import type { ViewStrings } from './view.ts';

export function viewStrings(): ViewStrings {
  return {
    addCard: vscode.l10n.t('Add card'),
    addCardPlaceholder: vscode.l10n.t('Card title'),
    done: vscode.l10n.t('Done'),
    collapse: vscode.l10n.t('Collapse lane'),
    expand: vscode.l10n.t('Expand lane'),
    toggleCard: vscode.l10n.t('Toggle card'),
    editCard: vscode.l10n.t('Edit card'),
    renameLane: vscode.l10n.t('Rename lane'),
    noLanes: vscode.l10n.t('This board has no lanes (headings).'),
    notABoard: vscode.l10n.t('This file has no kanban-plugin frontmatter key.'),
    keyboardHelp: vscode.l10n.t(
      'Alt+Up/Down moves a card, Alt+Left/Right moves it to another lane, Space toggles, F2 or Enter edits, Ctrl+Enter opens it in the text editor, N adds a card, Shift+F10 opens the card menu, Delete deletes, Ctrl+Shift+[ / ] folds or unfolds the card body, Ctrl+K Ctrl+I shows the card preview.',
    ),
    invalidRequest: vscode.l10n.t('The change was not applied: the text is empty or not allowed.'),
    unsafeRequest: vscode.l10n.t('This change cannot be made safely on the board. Please edit the file as text.'),
    keyboardHelpLabel: vscode.l10n.t('Keyboard shortcuts'),
    editorTargetChanged: vscode.l10n.t(
      'This card or lane changed while you were editing. Your text is kept below so you can copy it.',
    ),
    cardMenu: vscode.l10n.t('Card actions'),
    openInText: vscode.l10n.t('Open in text editor'),
    duplicateCard: vscode.l10n.t('Duplicate card'),
    insertCardBefore: vscode.l10n.t('Insert card before'),
    insertCardAfter: vscode.l10n.t('Insert card after'),
    moveToTop: vscode.l10n.t('Move to top'),
    moveToBottom: vscode.l10n.t('Move to bottom'),
    moveToLane: vscode.l10n.t('Move to lane'),
    deleteCard: vscode.l10n.t('Delete card'),
    collapseBody: vscode.l10n.t('Collapse card body'),
    expandBody: vscode.l10n.t('Expand card body'),
    collapseLaneBodies: vscode.l10n.t('Collapse all card bodies in this lane'),
    expandLaneBodies: vscode.l10n.t('Expand all card bodies in this lane'),
    bodyLines: vscode.l10n.t('{0} lines'),
    bodyLine: vscode.l10n.t('1 line'),
    cardPreview: vscode.l10n.t('Card preview'),
    addDate: vscode.l10n.t('Add date'),
    changeDate: vscode.l10n.t('Change date'),
    removeDate: vscode.l10n.t('Remove date'),
    dateConfirm: vscode.l10n.t('OK'),
    dateCancel: vscode.l10n.t('Cancel'),
    showCheckboxes: vscode.l10n.t('Show card checkboxes'),
    laneWidth: vscode.l10n.t('Lane width'),
    laneWidthValue: vscode.l10n.t('{0} px'),
    laneWidthTitle: vscode.l10n.t('Lane width: {0} px. Double-click for the default width.'),
  };
}

export function errorStrings(): ErrorStrings {
  return {
    stale: vscode.l10n.t('The file changed before this change was applied. The board now shows the latest content.'),
    invalid: vscode.l10n.t('The change was not applied: the text is empty or not allowed.'),
    unsafe: vscode.l10n.t('This change cannot be made safely on the board. Please edit the file as text.'),
    failed: vscode.l10n.t('The editor did not apply this change.'),
    disabled: vscode.l10n.t('The Notewell Kanban board is turned off (notewell.kanban.enabled).'),
    gone: vscode.l10n.t('This file was moved, renamed or deleted, so the board no longer changes it. Open the file again.'),
    encoding: vscode.l10n.t('VS Code opened this file with an encoding other than UTF-8 (files.encoding or files.autoGuessEncoding), so the board does not change it. Reopen it with UTF-8 encoding.'),
    unreadable: vscode.l10n.t('This file has characters that could not be read as text, so the board does not change it. Check the file encoding.'),
  };
}

export const messages = {
  disabled: () => vscode.l10n.t('The Notewell Kanban board is turned off (notewell.kanban.enabled).'),
  noFile: () => vscode.l10n.t('Open a Markdown file first.'),
  deleteCardQuestion: () => vscode.l10n.t('Delete this card?'),
  deleteCardButton: () => vscode.l10n.t('Delete'),
  newBoardTitle: () => vscode.l10n.t('New Kanban Board'),
  newBoardPrompt: () => vscode.l10n.t('File name for the new board'),
  newBoardInvalidName: () => vscode.l10n.t('Enter a file name without folder separators or reserved characters.'),
  newBoardExists: (name: string) => vscode.l10n.t('"{0}" already exists. Choose another name.', name),
  newBoardFailed: (name: string) => vscode.l10n.t('"{0}" could not be created.', name),
  newBoardNoFolder: () => vscode.l10n.t('Open a folder or workspace first to create a board.'),
};
