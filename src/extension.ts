import * as vscode from 'vscode';
import { registerAttachments } from './features/attachments/index.ts';
import { registerBacklinks } from './features/backlinks/index.ts';
import { registerCanvas } from './features/canvas/index.ts';
import { registerDailyNotes } from './features/daily-notes/index.ts';
import { registerLinkPreview } from './features/link-preview/index.ts';
import { registerBacklog } from './features/backlog/index.ts';
import { registerKanban } from './features/kanban/index.ts';
import { registerLinks } from './features/links/index.ts';
import { AppearanceStore } from './vault/appearance-store.ts';
import { LinkStore } from './vault/link-store.ts';
import { VaultRegistry } from './vault/registry.ts';

// Feature modules register themselves here; each checks notewell.<feature>.enabled itself.
export function activate(context: vscode.ExtensionContext): void {
  let vaults: VaultRegistry | undefined;
  // Fires when the registry becomes available and whenever vaults or their settings change,
  // so boards opened before the first scan finished still pick up their vault.
  const vaultsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(vaultsChanged);
  let links: LinkStore | undefined;
  // Fires when the link index appears or changes.
  const linksChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(linksChanged);
  void VaultRegistry.create({
    onBrokenSettings: (root, error) =>
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Could not read Obsidian settings in {0} ({1}). Default settings are used.', root.fsPath, error),
      ),
  }).then(
    (registry) => {
      vaults = registry;
      context.subscriptions.push(registry, registry.onDidChange(() => vaultsChanged.fire()));
      // The vault link index (links.md 2.3), shared by the link features.
      links = new LinkStore({ roots: () => registry.vaults.map((v) => v.root), onDidChangeRoots: registry.onDidChange });
      context.subscriptions.push(links, links.onDidChange(() => linksChanged.fire()));
      linksChanged.fire();
      vaultsChanged.fire();
    },
    () => undefined,
  );
  // Obsidian theme, snippets and appearance.json per vault (core.md 3.6); read-only.
  const appearances = new AppearanceStore({
    onBrokenAppearance: (root, error) =>
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Could not read Obsidian appearance settings in {0} ({1}). The default theme is used.', root.fsPath, error),
      ),
  });
  context.subscriptions.push(appearances);
  registerKanban(context, { vaults: () => vaults, vaultsChanged: vaultsChanged.event, appearances: () => appearances });
  registerBacklog(context);
  registerCanvas(context, { vaults: () => vaults, vaultsChanged: vaultsChanged.event });
  registerAttachments(context, { vaults: () => vaults });
  registerBacklinks(context, { links: () => links, vaults: () => vaults, linksChanged: linksChanged.event });
  registerLinks(context, { links: () => links, vaults: () => vaults });
  registerLinkPreview(context, { links: () => links });
  registerDailyNotes(context, { vaults: () => vaults, vaultsChanged: vaultsChanged.event, links: () => links });
}

export function deactivate(): void {}
