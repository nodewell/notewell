// VS Code custom text editor for kanban boards (kanban.md 5). The document stays the
// source of truth: every board change is a minimal WorkspaceEdit on it, so undo/redo,
// dirty state and saving behave as in the text editor.
import * as vscode from 'vscode';
import { composeThemeVariables } from '../../vault/appearance.ts';
import type { AppearanceStore } from '../../vault/appearance-store.ts';
import { obsidianDefaultTheme } from '../../vault/obsidian-defaults.ts';
import type { VaultRegistry } from '../../vault/registry.ts';
import { webviewHtml, webviewOptions } from '../../webview/host.ts';
import { toWorkspaceEdit } from './edits.ts';
import { openWikilink } from '../../vault/open-link.ts';
import type { KanbanDependencies } from './index.ts';
import { BoardSession, type BoardSettings, type CardTextRange } from './session.ts';
import { NOTEWELL_PALETTE } from './notewell-theme.ts';
import { chooseBoardStyle, obsidianStyleTokens, safeTokens, type BoardStyleMessage, type StyleSetting } from './style-map.ts';
import { errorStrings, messages, viewStrings } from './strings.ts';
import type { ExtensionMessage } from './messages.ts';

export const KANBAN_VIEW_TYPE = 'notewell.kanban';

const RENDER_DELAY_MS = 50;

/** Whether VS Code decoded a document as UTF-8 (undefined: a host without the encoding API). */
export function isUtf8(encoding: string | undefined): boolean {
  return encoding === undefined || encoding === 'utf8' || encoding === 'utf8bom';
}

/** VS Code settings of the feature; `useTab` comes from the vault (see resolveCustomTextEditor). */
export function kanbanSettings(
  uri: vscode.Uri,
): Omit<BoardSettings, 'useTab'> & { enabled: boolean; openBoardsByDefault: boolean; style: StyleSetting } {
  const config = vscode.workspace.getConfiguration('notewell.kanban', uri);
  const doneLanes = config.get<unknown>('doneLanes', []);
  return {
    enabled: config.get<boolean>('enabled', true) !== false,
    style: parseStyleSetting(config.get<unknown>('style', 'vscode')),
    saveOnEdit: config.get<boolean>('saveOnEdit', true) !== false,
    openBoardsByDefault: config.get<boolean>('openBoardsByDefault', true) !== false,
    doneLanes: Array.isArray(doneLanes) ? doneLanes.filter((name): name is string => typeof name === 'string') : [],
    cardBodies: config.get<unknown>('cardBodies', 'expanded') === 'collapsed' ? 'collapsed' : 'expanded',
    cardPreview: config.get<unknown>('cardPreview', true) !== false,
  };
}

function parseStyleSetting(value: unknown): StyleSetting {
  return value === 'obsidian' || value === 'notewell' ? value : 'vscode';
}

/** Today's local date as `YYYY-MM-DD`. */
export function localToday(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const VSCODE_STYLE: BoardStyleMessage = { type: 'style', style: 'vscode', scheme: null, tokens: {} };

/**
 * The style message for a board document (kanban.md 3.1): no tokens for `vscode`; the
 * vault's Obsidian theme (built-in defaults < theme < snippets) mapped to board tokens for
 * `obsidian`; the built-in palette for `notewell`. High contrast, and `obsidian` outside a
 * vault or before vaults are known, fall back to `vscode`. Tokens are filtered once more
 * here (token name and value) before they leave the host.
 */
export async function boardStyleMessage(
  uri: vscode.Uri,
  vaults: VaultRegistry | undefined,
  appearances: AppearanceStore | undefined,
): Promise<BoardStyleMessage> {
  const kind = vscode.window.activeColorTheme.kind;
  const highContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
  const vscodeLight = kind === vscode.ColorThemeKind.Light;
  const setting = kanbanSettings(uri).style;
  const vault = setting === 'obsidian' ? vaults?.vaultFor(uri) : undefined;
  const source = vault !== undefined && appearances !== undefined ? await appearances.appearanceFor(vault.root) : undefined;
  const { style, scheme } = chooseBoardStyle({
    setting,
    inVault: source !== undefined,
    highContrast,
    mode: source?.appearance.mode ?? 'system',
    vscodeLight,
  });
  if (style === 'vscode' || scheme === null) return VSCODE_STYLE;
  if (style === 'notewell') return { type: 'style', style, scheme, tokens: safeTokens(NOTEWELL_PALETTE[scheme]) };
  const { appearance, themeCss, snippetCss } = source!;
  const vars = composeThemeVariables(obsidianDefaultTheme(appearance.accentColor), {
    ...(themeCss === undefined ? {} : { themeCss }),
    snippetCss,
  });
  return { type: 'style', style, scheme, tokens: safeTokens(obsidianStyleTokens(vars[scheme], appearance)) };
}

/** Shows a card's lines of a board document in a text editor (kanban.md 4.7). */
export type OpenCardInText = (document: vscode.TextDocument, range: CardTextRange) => Promise<void>;

/**
 * Shows `range` of `document` in a text editor: the one already visible for the document, else a
 * new one in the group beside the active one. The range is selected, centered and focused.
 * `window.showTextDocument` opens a text editor even when `workbench.editorAssociations` names the
 * board for the file: VS Code resolves it with `EditorResolution.EXCLUSIVE_ONLY`, which only lets
 * `exclusive` custom editors take over, and the board is registered with priority `option`.
 */
export async function showCardInText(document: vscode.TextDocument, range: CardTextRange): Promise<vscode.TextEditor> {
  const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
  const selection = new vscode.Range(range.startLine, 0, range.endLine, range.endCharacter);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
    selection,
    preserveFocus: false,
  });
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  return editor;
}

export class KanbanEditorProvider implements vscode.CustomTextEditorProvider {
  readonly #extensionUri: vscode.Uri;
  readonly #openInText: OpenCardInText;
  readonly #vaults: () => VaultRegistry | undefined;
  readonly #appearances: () => AppearanceStore | undefined;
  readonly #vaultsChanged: vscode.Event<void> | undefined;
  /** Open boards, for commands that act on the active one. */
  readonly #panels = new Set<vscode.WebviewPanel>();

  /** `openInText`: index.ts passes one that keeps the text tab from being switched to a board. */
  constructor(extensionUri: vscode.Uri, deps: KanbanDependencies, openInText?: OpenCardInText) {
    this.#extensionUri = extensionUri;
    this.#openInText = openInText ?? (async (document, range) => void (await showCardInText(document, range)));
    this.#vaults = deps.vaults;
    this.#appearances = deps.appearances ?? (() => undefined);
    this.#vaultsChanged = deps.vaultsChanged;
  }

  /**
   * Sends a message to the active board (the commands' when-clause requires one); false when
   * no board is active.
   */
  postToActiveBoard(message: ExtensionMessage): boolean {
    for (const panel of this.#panels) {
      if (panel.active) {
        void Promise.resolve()
          .then(() => panel.webview.postMessage(message))
          .catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (!kanbanSettings(document.uri).enabled) {
      // The feature is off: show the file as text instead of an empty board.
      panel.dispose();
      void vscode.window.showInformationMessage(messages.disabled());
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }
    const webview = panel.webview;
    this.#panels.add(panel);
    webview.options = webviewOptions(this.#extensionUri);
    webview.html = webviewHtml(webview, this.#extensionUri, {
      title: document.uri.path.split('/').pop() ?? 'Kanban',
      scripts: ['kanban.js'],
      styles: ['kanban.css'],
    });

    // Once the board is closed its pending requests change nothing and nothing is posted to it.
    let disposed = false;
    const session = new BoardSession({
      document: {
        text: () => document.getText(),
        version: () => document.version,
        // Checked right before sending: an edit computed for an older version is never applied
        // (VS Code also refuses it if the document moves on before the edit arrives).
        applyEdits: async (edits, version) =>
          !disposed && !document.isClosed && document.version === version && vscode.workspace.applyEdit(toWorkspaceEdit(document.uri, edits)),
        state: async () => {
          // Turning the feature off stops an open board from writing at once.
          if (!kanbanSettings(document.uri).enabled) return 'disabled';
          if (document.isClosed) return 'gone';
          if (!isUtf8(document.encoding)) return 'encoding';
          if (document.uri.scheme === 'untitled') return 'ok';
          try {
            await vscode.workspace.fs.stat(document.uri);
            return 'ok';
          } catch {
            return 'gone';
          }
        },
        save: async () => {
          await document.save();
        },
      },
      host: {
        post: (message) => {
          if (disposed) return;
          // A webview disposed in the meantime rejects or throws; nothing is lost by dropping it.
          void Promise.resolve()
            .then(() => webview.postMessage(message))
            .catch(() => undefined);
        },
        openLink: (target) => openWikilink(target, document.uri, this.#vaults()),
        openInText: async (range) => {
          if (!disposed && !document.isClosed) await this.#openInText(document, range);
        },
      },
      // The vault's useTab decides indentation for new body lines; defaults outside a vault.
      settings: () => {
        const plugin = this.#vaults()?.kanbanPluginFor(document.uri);
        const showCheckboxesDefault = plugin?.showCheckboxes;
        const laneWidthDefault = plugin?.laneWidth;
        return {
          ...kanbanSettings(document.uri),
          useTab: this.#vaults()?.settingsFor(document.uri).useTab ?? true,
          ...(showCheckboxesDefault === undefined ? {} : { showCheckboxesDefault }),
          ...(laneWidthDefault === undefined ? {} : { laneWidthDefault }),
          ...(plugin === undefined ? {} : { defaults: plugin.defaults }),
        };
      },
      strings: viewStrings(),
      errors: errorStrings(),
      today: () => localToday(),
      style: () => boardStyleMessage(document.uri, this.#vaults(), this.#appearances()),
      confirmDelete: async (title) => {
        const button = messages.deleteCardButton();
        const answer = await vscode.window.showWarningMessage(messages.deleteCardQuestion(), { modal: true, detail: title }, button);
        return answer === button;
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRender = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        session.render();
      }, RENDER_DELAY_MS);
    };
    // Style changes only swap tokens (no redraw). A newer request supersedes an older one.
    let styleTimer: ReturnType<typeof setTimeout> | undefined;
    let styleRequest = 0;
    const scheduleStyle = (): void => {
      if (styleTimer !== undefined) clearTimeout(styleTimer);
      styleTimer = setTimeout(() => {
        styleTimer = undefined;
        const request = ++styleRequest;
        void boardStyleMessage(document.uri, this.#vaults(), this.#appearances()).then((message) => {
          if (request === styleRequest && !disposed) void webview.postMessage(message);
        });
      }, RENDER_DELAY_MS);
    };
    const vaultOfDocument = (): string | undefined => this.#vaults()?.vaultFor(document.uri)?.root.path;

    const subscriptions: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: unknown) => void session.handle(message)),
      // Editor typing, undo/redo, disk changes and our own edits all arrive here.
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === document && event.contentChanges.length > 0) scheduleRender();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('notewell.kanban', document.uri)) {
          scheduleRender();
          scheduleStyle();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => scheduleStyle()),
    ];
    // Theme, snippet or appearance.json changes in this board's vault; vaults found or lost.
    const appearances = this.#appearances();
    if (appearances !== undefined) {
      subscriptions.push(appearances.onDidChange((root) => {
        if (root === vaultOfDocument()) scheduleStyle();
      }));
    }
    // Vault settings also hold the Kanban plugin's check box default (kanban.md 2.9).
    if (this.#vaultsChanged !== undefined) {
      subscriptions.push(this.#vaultsChanged(() => {
        scheduleRender();
        scheduleStyle();
      }));
    }
    panel.onDidDispose(() => {
      disposed = true;
      this.#panels.delete(panel);
      if (styleTimer !== undefined) clearTimeout(styleTimer);
      if (timer !== undefined) clearTimeout(timer);
      for (const s of subscriptions) s.dispose();
    });
  }
}
