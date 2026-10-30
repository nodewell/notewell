// Messages between the board webview and the extension (kanban.md 4.3, 6).
// Webview -> extension messages are flat (identity fields spread out) so the shared
// validator can check every value; `toBoardRequest` rebuilds the operation request.
import { defineMessages, type MessageOf } from '../../webview/messages.ts';
import type { BoardRequest } from './operations.ts';
import type { BoardStyle, ColorScheme, KanbanStyleToken } from './style-tokens.ts';
import type { BoardView } from './view.ts';

/** Limits: titles and names are typed by the user; lines echo source lines (may be long). */
export const LIMITS = {
  index: 100_000,
  version: Number.MAX_SAFE_INTEGER,
  title: 2_000,
  /** Whole card edit text (kanban.md 4.4): characters and lines. */
  cardText: 20_000,
  cardLines: 500,
  sourceLine: 20_000,
  linkTarget: 1_000,
  /** Width slider (kanban.md 4.10): the px values it can write, in steps that include 272. */
  laneWidthMin: 200,
  laneWidthMax: 600,
  laneWidthStep: 8,
} as const;

const version = { kind: 'int', min: 0, max: LIMITS.version } as const;
const index = { kind: 'int', min: 0, max: LIMITS.index } as const;
const sourceLine = { kind: 'string', maxLength: LIMITS.sourceLine } as const;
const userText = { kind: 'string', maxLength: LIMITS.title, minLength: 1 } as const;
// LF only: CR, NEL, LS and PS are rejected by the shared validator.
const cardText = { kind: 'string', maxLength: LIMITS.cardText, minLength: 1, allowNewline: true, maxLines: LIMITS.cardLines } as const;
const card = { laneIndex: index, cardIndex: index, firstLine: sourceLine } as const;
const lane = { laneIndex: index, heading: sourceLine } as const;
// A token echoes part of a source line: `@{` + at least one character + `}`.
const dateToken = { kind: 'string', minLength: 4, maxLength: LIMITS.sourceLine } as const;

export const WEBVIEW_MESSAGES = {
  ready: {},
  openLink: { target: { kind: 'string', maxLength: LIMITS.linkTarget, minLength: 1 } },
  toggleCard: { version, ...card },
  // Card menu (kanban.md 4.6). The extension asks for confirmation before deleting.
  deleteCard: { version, ...card },
  duplicateCard: { version, ...card },
  // Opens the card's lines in a text editor beside the board (kanban.md 4.7); changes nothing.
  openCardInText: { version, ...card },
  editCardText: { version, ...card, text: cardText },
  moveCard: { version, ...card, toLaneIndex: index, toHeading: sourceLine, toIndex: index },
  addCard: { version, ...lane, index: { ...index, optional: true }, title: userText },
  moveLane: { version, ...lane, toIndex: index },
  renameLane: { version, ...lane, name: userText },
  // Date picker (kanban.md 4.8): `date` is YYYY-MM-DD; `token` is the card's first date token
  // as the board showed it (absent: the card has none and the date is added).
  setCardDate: { version, ...card, date: { kind: 'string', minLength: 10, maxLength: 10 }, token: { ...dateToken, optional: true } },
  removeCardDate: { version, ...card, token: dateToken },
  // Check box switch (kanban.md 4.9): the board's `show-checkboxes` value to write.
  setShowCheckboxes: { version, value: { kind: 'boolean' } },
  // Width slider (kanban.md 4.10): the board's `lane-width` in px; absent removes it (default width).
  setLaneWidth: { version, value: { kind: 'int', min: LIMITS.laneWidthMin, max: LIMITS.laneWidthMax, optional: true } },
} as const;

export type WebviewMessage = MessageOf<typeof WEBVIEW_MESSAGES>;

/** Validates a message from the webview; invalid input is rejected, never thrown. */
export const validateWebviewMessage = defineMessages(WEBVIEW_MESSAGES);

/** The board request and document version carried by an operation message. */
export function toBoardRequest(message: WebviewMessage): { version: number; request: BoardRequest } | undefined {
  switch (message.type) {
    case 'ready':
    case 'openLink':
    case 'openCardInText':
      return undefined;
    case 'toggleCard':
      return { version: message.version, request: { kind: 'toggleCard', card: cardOf(message) } };
    case 'deleteCard':
      return { version: message.version, request: { kind: 'deleteCard', card: cardOf(message) } };
    case 'duplicateCard':
      return { version: message.version, request: { kind: 'duplicateCard', card: cardOf(message) } };
    case 'editCardText':
      return { version: message.version, request: { kind: 'editCardText', card: cardOf(message), text: message.text } };
    case 'moveCard':
      return {
        version: message.version,
        request: {
          kind: 'moveCard',
          card: cardOf(message),
          toLane: { laneIndex: message.toLaneIndex, heading: message.toHeading },
          toIndex: message.toIndex,
        },
      };
    case 'addCard':
      return {
        version: message.version,
        request: {
          kind: 'addCard',
          lane: laneOf(message),
          title: message.title,
          ...(message.index === undefined ? {} : { index: message.index }),
        },
      };
    case 'moveLane':
      return { version: message.version, request: { kind: 'moveLane', lane: laneOf(message), toIndex: message.toIndex } };
    case 'renameLane':
      return { version: message.version, request: { kind: 'renameLane', lane: laneOf(message), name: message.name } };
    case 'setCardDate':
      return {
        version: message.version,
        request: {
          kind: 'setCardDate',
          card: cardOf(message),
          date: message.date,
          ...(message.token === undefined ? {} : { token: message.token }),
        },
      };
    case 'removeCardDate':
      return { version: message.version, request: { kind: 'removeCardDate', card: cardOf(message), token: message.token } };
    case 'setShowCheckboxes':
      return { version: message.version, request: { kind: 'setShowCheckboxes', value: message.value } };
    case 'setLaneWidth':
      return { version: message.version, request: { kind: 'setLaneWidth', ...(message.value === undefined ? {} : { value: message.value }) } };
  }
}

function cardOf(m: { laneIndex: number; cardIndex: number; firstLine: string }) {
  return { laneIndex: m.laneIndex, cardIndex: m.cardIndex, firstLine: m.firstLine };
}

function laneOf(m: { laneIndex: number; heading: string }) {
  return { laneIndex: m.laneIndex, heading: m.heading };
}

/**
 * Why the extension did not apply an operation (operations.ts failures plus 'failed' for edit
 * errors). 'unreadable': the file was not read as text (replacement characters or NUL), so it
 * is never written from the board. 'gone': the file was closed, moved or deleted. 'encoding': VS
 * Code read the file with an encoding other than UTF-8. 'disabled': notewell.kanban.enabled was
 * turned off while the board is open.
 */
export type ErrorReason = 'stale' | 'invalid' | 'unsafe' | 'failed' | 'unreadable' | 'gone' | 'encoding' | 'disabled';

/**
 * Extension -> webview. Trusted direction; not validated by the webview beyond shape.
 * After 'stale' the extension also sends a fresh 'render'.
 */
export type ExtensionMessage =
  | { readonly type: 'render'; readonly version: number; readonly view: BoardView }
  | { readonly type: 'error'; readonly reason: ErrorReason; readonly message: string }
  /**
   * "Collapse/Expand All Card Bodies" (kanban.md 3.2): the board forgets its per-card fold
   * states and uses this as its default (the setting is not changed).
   */
  | { readonly type: 'cardBodies'; readonly collapsed: boolean }
  | StyleMessage;

/**
 * Board style (kanban.md 3.1, core.md 3.6). 'vscode' clears every override (scheme null,
 * tokens {}); 'obsidian' and 'notewell' carry token values for a dark or light scheme.
 * The webview checks token names and values again before use.
 */
export interface StyleMessage {
  readonly type: 'style';
  readonly style: BoardStyle;
  readonly scheme: ColorScheme | null;
  readonly tokens: Readonly<Partial<Record<KanbanStyleToken, string>>>;
}
