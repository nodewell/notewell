// Messages between the canvas webview and the extension (canvas.md 3.3, 4, 5, 7). Edits name the
// node by index and id and carry the document version they were made on plus the values the
// webview showed (from*), so the extension can refuse edits made on an outdated view.
import { defineMessages, type MessageOf } from '../../webview/messages.ts';
import type { CanvasView } from './view.ts';

export const LIMITS = {
  /** A URL from a link card or a Markdown link. */
  url: 8_000,
  /** A wikilink target in a text card or a note shown in a file card. */
  linkTarget: 1_000,
  nodeIndex: 1_000_000,
  nodeId: 1_000,
  version: Number.MAX_SAFE_INTEGER,
  /** Coordinates and sizes as the model bounds them (model.ts). */
  coordinate: 10_000_000,
  size: 1_000_000,
  /** Text card content: the whole file is at most 5 MB when editable. */
  text: 5_000_000,
  textLines: 500_000,
} as const;

const version = { kind: 'int', min: 0, max: LIMITS.version } as const;
const node = {
  index: { kind: 'int', min: 0, max: LIMITS.nodeIndex },
  id: { kind: 'string', maxLength: LIMITS.nodeId },
} as const;
const coordinate = { kind: 'int', min: -LIMITS.coordinate, max: LIMITS.coordinate } as const;
const size = { kind: 'int', min: 1, max: LIMITS.size } as const;

export const WEBVIEW_MESSAGES = {
  ready: {},
  /** A link card or a Markdown link; the extension checks the scheme and asks first. */
  openUrl: { url: { kind: 'string', maxLength: LIMITS.url, minLength: 1 } },
  /** A file card, named by its index and id; the extension looks the path up itself. */
  openFile: {
    index: { kind: 'int', min: 0, max: LIMITS.nodeIndex },
    id: { kind: 'string', maxLength: LIMITS.nodeId },
  },
  /** A `[[wikilink]]` in a card; the extension resolves it in the vault and opens it. */
  openLink: { target: { kind: 'string', maxLength: LIMITS.linkTarget, minLength: 1 } },
  /** "Open as Text" on a canvas that cannot be read. */
  openAsText: {},
  /** A card moved (a group carries the cards inside it; operations.ts). */
  move: { version, ...node, x: coordinate, y: coordinate, fromX: coordinate, fromY: coordinate },
  resize: { version, ...node, width: size, height: size, fromWidth: size, fromHeight: size },
  /** New Markdown of a text card (LF line breaks only, as a textarea gives them). */
  editText: { version, ...node, text: { kind: 'string', maxLength: LIMITS.text, allowNewline: true, maxLines: LIMITS.textLines } },
  /** A preset or 'none'; `from` is the color shown ('' for none, a preset or #rrggbb). */
  setColor: { version, ...node, color: { kind: 'enum', values: ['1', '2', '3', '4', '5', '6', 'none'] }, from: { kind: 'string', maxLength: 7 } },
} as const;

export type WebviewMessage = MessageOf<typeof WEBVIEW_MESSAGES>;

/** Validates a message from the webview; invalid input is rejected, never thrown. */
export const validateWebviewMessage = defineMessages(WEBVIEW_MESSAGES);

/** Extension -> webview (trusted direction). */
export type ExtensionMessage =
  | { readonly type: 'render'; readonly version: number; readonly view: CanvasView }
  /** An edit was not applied; a fresh 'render' follows when the view was outdated. */
  | { readonly type: 'refused'; readonly message: string };

/** Whether a URL may be opened outside VS Code: http and https only. */
export function isWebUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
