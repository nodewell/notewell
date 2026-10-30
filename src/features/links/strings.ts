// UI strings of the links feature (English source, Korean in l10n/).
import * as vscode from 'vscode';

export const messages = {
  confirmUpdate: (links: number, files: number) =>
    vscode.l10n.t('Update {0} links in {1} files to point to the renamed files?', links, files),
  updateButton: () => vscode.l10n.t('Update links'),
  skipButton: () => vscode.l10n.t("Don't update"),
  untrusted: () => vscode.l10n.t('This workspace is not trusted, so links to the renamed files were not updated.'),
  leftVault: (links: number) => vscode.l10n.t('{0} links point to files moved out of their vault. They were not changed and will break.', links),
  notReady: () => vscode.l10n.t('The link index is still being built, so links were not updated.'),
  unchanged: (links: number) => vscode.l10n.t('{0} links were left unchanged because they could point to more than one file or could not be rewritten safely.', links),
  tooLarge: (files: number) => vscode.l10n.t('{0} notes are too large (over 16 MB) to be checked for links, so links in them to the renamed files were not updated.', files),
  stale: (files: number) => vscode.l10n.t('{0} files changed since they were indexed or could not be read as UTF-8 text, so their links were not updated.', files),
};
