// One open board: turns webview messages into document edits and sends views back
// (kanban.md 4.2, 4.3). VS Code-free; editor.ts supplies the ports.
import { lineTexts, parseLines } from '../../core/lines.ts';
import { computePatch, type TextEdit } from '../../core/patch.ts';
import { toBoardRequest, validateWebviewMessage, type ErrorReason, type ExtensionMessage } from './messages.ts';
import type { BoardStyleMessage } from './style-map.ts';
import { cardTitle, findCardByIdentity, type KanbanCard } from './model.ts';
import { planBoardRequest } from './operations.ts';
import { parseBoard, type SettingDefaults } from './parser.ts';
import { buildBoardView, type CardBodies, type ViewStrings } from './view.ts';

export interface BoardDocument {
  readonly text: () => string;
  readonly version: () => number;
  /**
   * Applies edits to this document only, computed for `version`; resolves false (and applies
   * nothing) when the document is at another version or the editor refused them.
   */
  readonly applyEdits: (edits: readonly TextEdit[], version: number) => Promise<boolean>;
  /**
   * Whether the board may write this document now: 'gone' when it was closed, moved or deleted
   * (an edit would recreate the old file), 'encoding' when VS Code did not read it as UTF-8 (a
   * save would write another encoding), 'disabled' when the feature was turned off meanwhile.
   * Absent: always writable.
   */
  readonly state?: () => Promise<'ok' | 'gone' | 'encoding' | 'disabled'>;
  readonly save: () => Promise<void>;
}

/** A card's lines in the document: first line start to the end of its last line (kanban.md 4.7). */
export interface CardTextRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface BoardHost {
  readonly post: (message: ExtensionMessage) => void;
  readonly openLink: (target: string) => Promise<void>;
  /** Shows the card's lines in a text editor beside the board (kanban.md 4.7). Absent: ignored. */
  readonly openInText?: (range: CardTextRange) => Promise<void>;
}

/** The text range of `card`: first line start through the end of its last body line. */
export function cardTextRange(texts: readonly string[], card: KanbanCard): CardTextRange {
  const endLine = card.range.end - 1;
  return { startLine: card.range.start, endLine, endCharacter: (texts[endLine] ?? '').length };
}

export interface BoardSettings {
  readonly doneLanes: readonly string[];
  /** Vault `useTab` for new card body lines (kanban.md 4.4); true outside a vault. */
  readonly useTab: boolean;
  readonly saveOnEdit: boolean;
  /** Default fold state of card bodies (kanban.md 3.2); expanded when absent. */
  readonly cardBodies?: CardBodies;
  /** Hover preview of cards (kanban.md 3.3); on when absent. */
  readonly cardPreview?: boolean;
  /** The vault's Kanban plugin default for `show-checkboxes` (kanban.md 2.9); none outside a vault. */
  readonly showCheckboxesDefault?: boolean;
  /** The vault's Kanban plugin default for `lane-width` (kanban.md 2.9); none outside a vault. */
  readonly laneWidthDefault?: number | null;
  /** The vault's defaults for the other board settings (kanban.md 2.9); none outside a vault. */
  readonly defaults?: SettingDefaults;
}

/** Messages shown in the board when a request is not applied. */
export type ErrorStrings = Readonly<Record<ErrorReason, string>>;

export interface BoardSessionOptions {
  readonly document: BoardDocument;
  readonly host: BoardHost;
  readonly settings: () => BoardSettings;
  readonly strings: ViewStrings;
  readonly errors: ErrorStrings;
  /** Today's local date as `YYYY-MM-DD`. */
  readonly today: () => string;
  /**
   * Asks the user to confirm deleting a card (kanban.md 4.6), given its title. Without this
   * port deletions are refused, so a board never deletes without asking.
   */
  readonly confirmDelete?: (title: string) => Promise<boolean>;
  /** The board style for this document (kanban.md 3.1); sent on ready and by `sendStyle`. */
  readonly style?: () => Promise<BoardStyleMessage>;
}

const UNREADABLE = /[\uFFFD\u0000]/;

export class BoardSession {
  readonly #options: BoardSessionOptions;
  /** Messages are handled one at a time so each sees the result of the previous one. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: BoardSessionOptions) {
    this.#options = options;
  }

  /** Sends the current document as a board view. */
  render(): void {
    const { document, host, settings, strings, today } = this.#options;
    const texts = lineTexts(parseLines(document.text()));
    const { doneLanes, cardBodies, cardPreview, showCheckboxesDefault, laneWidthDefault, defaults } = settings();
    const board = parseBoard(texts, { doneLanes, ...(defaults === undefined ? {} : { defaults }) });
    const view = buildBoardView(texts, board, {
      today: today(),
      strings,
      ...(cardBodies === undefined ? {} : { cardBodies }),
      ...(cardPreview === undefined ? {} : { cardPreview }),
      ...(showCheckboxesDefault === undefined ? {} : { showCheckboxesDefault }),
      ...(laneWidthDefault === undefined ? {} : { laneWidthDefault }),
    });
    host.post({ type: 'render', version: document.version(), view });
  }

  /**
   * Sends the current style; the webview replaces all style tokens with the ones sent, so
   * this always sends the full set. Style changes never redraw the board (kanban.md 3.1).
   */
  async sendStyle(): Promise<void> {
    const style = this.#options.style;
    if (style !== undefined) this.#options.host.post(await style());
  }

  /** Handles one raw webview message. Never throws; the returned promise settles after it is handled. */
  handle(raw: unknown): Promise<void> {
    const next = this.#queue.then(() => this.#handle(raw));
    this.#queue = next.catch(() => undefined);
    return next.catch(() => this.#fail('failed'));
  }

  async #handle(raw: unknown): Promise<void> {
    const validated = validateWebviewMessage(raw);
    if (!validated.ok) {
      this.#fail('invalid');
      return;
    }
    const message = validated.message;
    if (message.type === 'ready') {
      this.render();
      await this.sendStyle();
      return;
    }
    if (message.type === 'openLink') {
      await this.#options.host.openLink(message.target);
      return;
    }
    if (message.type === 'openCardInText') {
      // Changes nothing, so only the card identity (2.5) has to match the current document; the
      // range is taken from the current text.
      const texts = lineTexts(parseLines(this.#options.document.text()));
      const card = findCardByIdentity(parseBoard(texts, { doneLanes: this.#options.settings().doneLanes }), texts, message);
      if (card === undefined) {
        this.#stale();
        return;
      }
      await this.#options.host.openInText?.(cardTextRange(texts, card));
      return;
    }
    const operation = toBoardRequest(message);
    if (operation === undefined) return;

    const { document, settings } = this.#options;
    const version = document.version();
    if (operation.version !== version) {
      this.#stale();
      return;
    }
    // Text VS Code could not decode (U+FFFD) or binary content (NUL) would be saved damaged.
    if (UNREADABLE.test(document.text())) {
      this.#fail('unreadable');
      return;
    }
    if (operation.request.kind === 'deleteCard') {
      // Confirm first (modal). Nothing is sent on cancel; if the document changed while the
      // dialog was open, the request is stale.
      const before = lineTexts(parseLines(document.text()));
      const card = findCardByIdentity(parseBoard(before), before, operation.request.card);
      if (card === undefined) {
        this.#stale();
        return;
      }
      const confirm = this.#options.confirmDelete;
      if (confirm === undefined || !(await confirm(cardTitle(before, card)))) return;
      if (document.version() !== version) {
        this.#stale();
        return;
      }
    }
    const problem = await document.state?.();
    if (problem !== undefined && problem !== 'ok') {
      this.#fail(problem);
      return;
    }
    if (document.version() !== version) {
      this.#stale();
      return;
    }
    const doc = parseLines(document.text());
    const texts = lineTexts(doc);
    const { doneLanes, useTab, defaults } = settings();
    const eols = doc.lines.map((line) => line.eol);
    const plan = planBoardRequest(texts, parseBoard(texts, { doneLanes, ...(defaults === undefined ? {} : { defaults }) }), operation.request, { useTab, eols });
    if (!plan.ok) {
      if (plan.reason === 'stale') this.#stale();
      else this.#fail(plan.reason);
      return;
    }
    if (plan.operations.length === 0) return;
    const patch = computePatch(doc, version, { ...plan, expectedVersion: operation.version });
    if (!patch.ok) {
      if (patch.reason === 'version' || patch.reason === 'content') this.#stale();
      else this.#fail('failed');
      return;
    }
    if (!(await document.applyEdits(patch.edits, version))) {
      this.render();
      this.#fail('failed');
      return;
    }
    if (settings().saveOnEdit) await document.save();
  }

  /** The board was built from an older document: redraw first, then explain (render clears notices). */
  #stale(): void {
    this.render();
    this.#fail('stale');
  }

  #fail(reason: ErrorReason): void {
    this.#options.host.post({ type: 'error', reason, message: this.#options.errors[reason] });
  }
}
