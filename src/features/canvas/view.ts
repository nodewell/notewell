// The canvas view model sent to the webview (canvas.md 4). Pure: the canvas model in, plain
// serializable data out. The extension resolves file paths and image URIs (resources) before
// building the view, so the webview never sees anything but display values.
import type { CanvasIssue, CanvasIssueCode, CanvasNode, CanvasReadResult, EdgeEnd, NodeSide, BackgroundStyle } from './model.ts';

/** UI strings of the webview (English defaults; strings.ts localizes them). */
export const DEFAULT_STRINGS = {
  canvasLabel: 'Canvas',
  toolbarLabel: 'Canvas view',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomReset: 'Reset zoom to 100%',
  fit: 'Fit to view',
  showList: 'List view',
  showCanvas: 'Canvas view',
  textCard: 'Text card',
  fileCard: 'File card',
  linkCard: 'Link card',
  groupCard: 'Group',
  unsupportedCard: 'Unsupported card',
  untitledGroup: 'Untitled group',
  emptyText: 'Empty card',
  fileMissing: 'File not found',
  fileOutside: 'Outside the vault',
  openFile: 'Open file',
  openLink: 'Open link in browser',
  emptyCanvas: 'This canvas is empty.',
  openAsText: 'Open as Text',
  linksTo: 'Links to',
  linkedFrom: 'Linked from',
  focusCard: 'Show this card',
  zoomGroup: 'Zoom',
  viewGroup: 'View',
  keyboardHelpLabel: 'Keyboard shortcuts',
  // Keyboard help (key, action) rows; key names that are words are localized too.
  helpTabAction: 'Move between cards',
  helpArrowsKey: 'Arrow keys',
  helpArrowsAction: 'Pan the canvas when no card is selected (with Shift: faster)',
  helpZoomAction: 'Zoom in or out',
  helpZoomResetAction: 'Zoom to 100%',
  helpFitAction: 'Fit the whole canvas in view',
  helpEnterAction: 'Open the selected file or link card; edit a text card',
  helpEscapeAction: 'Clear the selection',
  helpDragGesture: 'Drag the background',
  helpSpaceDragGesture: 'drag',
  helpDragAction: 'Pan the canvas',
  helpWheelGesture: 'wheel',
  helpWheelAction: 'Zoom at the pointer',
  helpEditHeading: 'Edit',
  helpMoveAction: 'Move the selected card by 10 px (with Shift: 50 px)',
  helpResizeAction: 'Resize the selected card',
  helpColorAction: 'Choose the color of the selected card',
  helpSaveAction: 'Save the text (in the text box)',
  helpCancelAction: 'Cancel the text edit',
  helpDragCardGesture: 'Drag a card or its corner',
  helpDragCardAction: 'Move or resize it',
  emptyGroup: '(no cards)',
  editText: 'Edit text',
  textEditorLabel: 'Card text',
  textEditorHint: 'Ctrl+Enter saves, Escape cancels.',
  save: 'Save',
  cancel: 'Cancel',
  color: 'Color',
  colorNone: 'No color',
  color1: 'Red',
  color2: 'Orange',
  color3: 'Yellow',
  color4: 'Green',
  color5: 'Cyan',
  color6: 'Purple',
  colorCustom: 'Custom color (kept until you choose another)',
  resizeHandle: 'Resize',
  dismiss: 'Dismiss',
} as const;

export type ViewStrings = { readonly [K in keyof typeof DEFAULT_STRINGS]: string };

/** Messages the extension composes before sending the view (English defaults). */
export const DEFAULT_MESSAGES = {
  unreadable: (line: number): string => `This canvas cannot be read (line ${line}).`,
  readOnlySize: 'This canvas file is larger than 5 MB, so it is shown read-only.',
  readOnlyNodes: 'This canvas has more than 5,000 cards, so it is shown read-only.',
  warnings: (count: number, line: number): string => `Some values in this canvas were ignored or adjusted for display (${count}); the first is on line ${line}.`,
  reasonSyntax: 'The file is not valid JSON.',
  reasonRoot: 'The file must contain one JSON object.',
  reasonNotArray: '"nodes" and "edges" must be lists.',
  reasonNotObject: 'Every node and edge must be a JSON object.',
  reasonRequired: 'A node or edge is missing a required value, or the value has the wrong type.',
} as const;

export type ViewMessages = { readonly [K in keyof typeof DEFAULT_MESSAGES]: (typeof DEFAULT_MESSAGES)[K] extends string ? string : (typeof DEFAULT_MESSAGES)[K] };

/** Display state of a file card's or group background's path. */
export interface ResolvedResource {
  /** The file exists inside the vault (or next to the canvas outside a vault). */
  readonly exists: boolean;
  /** False when the path leaves the vault (or the folder the canvas may reach). */
  readonly inside: boolean;
  /** Webview URI for an image preview; only for local images inside a vault. */
  readonly image?: string;
  /** Text of a Markdown note inside the vault (capped), shown in its file cards (canvas.md 4). */
  readonly note?: string;
}

/** A node as the webview draws it. `color` is `"1"`-`"6"` or `#rrggbb`. */
export interface NodeView {
  readonly index: number;
  readonly id: string;
  readonly kind: CanvasNode['kind'];
  /** The `type` as written (shown for unsupported cards). */
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color?: string;
  /** Short text for screen readers and the list view. */
  readonly title: string;
  /** Index of the innermost group the card lies fully inside (list view nesting). */
  readonly group?: number;
  readonly text?: string;
  readonly file?: string;
  readonly subpath?: string;
  readonly missing?: boolean;
  readonly outside?: boolean;
  readonly image?: string;
  /** Markdown shown in a note's file card: the note without front matter, or its `subpath` part. */
  readonly note?: string;
  /** Name above a file or link card, as Obsidian shows it (canvas.md 4). */
  readonly caption?: string;
  readonly url?: string;
  readonly label?: string;
  readonly background?: string;
  readonly backgroundStyle?: BackgroundStyle;
  /** The id is used by several nodes: shown, never edited (canvas.md 5.1). */
  readonly locked?: boolean;
}

export interface EdgeView {
  readonly id: string;
  /** Indexes into `nodes` (the first node with the id the file names). */
  readonly from: number;
  readonly to: number;
  readonly fromSide?: NodeSide;
  readonly toSide?: NodeSide;
  readonly fromEnd: EdgeEnd;
  readonly toEnd: EdgeEnd;
  readonly color?: string;
  readonly label?: string;
}

export interface Notice {
  readonly kind: 'info' | 'warning';
  readonly text: string;
}

export type CanvasView =
  | {
      readonly state: 'canvas';
      readonly nodes: readonly NodeView[];
      readonly edges: readonly EdgeView[];
      readonly readOnly: boolean;
      /** Whether the view may send edits: not read-only and editing allowed by the settings. */
      readonly editable: boolean;
      /** Moved cards land on a 20 px grid (notewell.canvas.snapToGrid). */
      readonly snapToGrid: boolean;
      /** Localized notices shown above the canvas: read-only (info) and ignored values (warning). */
      readonly notices: readonly Notice[];
      readonly strings: ViewStrings;
    }
  | {
      readonly state: 'error';
      /** One-based line of the first error. */
      readonly line: number;
      readonly message: string;
      readonly reason: string;
      readonly strings: ViewStrings;
    };

export interface BuildViewOptions {
  readonly strings?: ViewStrings;
  readonly messages?: ViewMessages;
  /** Resolved file card paths and group backgrounds, by the path as written. */
  readonly resources?: ReadonlyMap<string, ResolvedResource>;
  /** notewell.canvas.editable (default true). */
  readonly editable?: boolean;
  /** notewell.canvas.snapToGrid (default false). */
  readonly snapToGrid?: boolean;
}

const MAX_TITLE = 80;

function reasonOf(code: CanvasIssueCode, messages: ViewMessages): string {
  switch (code) {
    case 'syntax':
      return messages.reasonSyntax;
    case 'root':
      return messages.reasonRoot;
    case 'not-array':
      return messages.reasonNotArray;
    case 'not-object':
      return messages.reasonNotObject;
    default:
      return messages.reasonRequired;
  }
}

/** The color as the webview applies it: a preset digit or a lowercase `#rrggbb`. */
function colorOf(node: { readonly color?: CanvasNode['color'] }): string | undefined {
  const color = node.color;
  if (color === undefined) return undefined;
  return color.kind === 'preset' ? String(color.preset) : color.hex;
}

/** Last path segment, for file card titles. */
export function fileName(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

/** A one-line summary of Markdown text: the first non-empty line without leading markers. */
export function textTitle(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)*/, '')
      .replace(/[*_`~]/g, '')
      .trim();
    if (line !== '') return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
  }
  return '';
}

function titleOf(node: CanvasNode, strings: ViewStrings): string {
  switch (node.kind) {
    case 'text':
      return textTitle(node.text) || strings.emptyText;
    case 'file':
      return fileName(node.file);
    case 'link':
      return node.url;
    case 'group':
      return node.label !== undefined && node.label.trim() !== '' ? node.label : strings.untitledGroup;
    case 'unknown':
      return node.type;
  }
}

function nodeView(node: CanvasNode, strings: ViewStrings, resources: ReadonlyMap<string, ResolvedResource>): NodeView {
  const base = {
    index: node.index,
    id: node.id,
    kind: node.kind,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    title: titleOf(node, strings),
  };
  const color = colorOf(node);
  const view: { -readonly [K in keyof NodeView]: NodeView[K] } = color === undefined ? base : { ...base, color };
  switch (node.kind) {
    case 'text':
      view.text = node.text;
      break;
    case 'file': {
      view.file = node.file;
      if (node.subpath !== undefined) view.subpath = node.subpath;
      const resource = resources.get(node.file);
      if (resource !== undefined) {
        if (!resource.inside) view.outside = true;
        else if (!resource.exists) view.missing = true;
        else if (resource.image !== undefined) view.image = resource.image;
        else if (resource.note !== undefined) view.note = noteExcerpt(resource.note, node.subpath);
      }
      // Obsidian names a note without `.md`; other files keep their extension.
      view.caption = fileName(node.file).replace(/\.md$/i, '') + (node.subpath ?? '');
      break;
    }
    case 'link':
      view.url = node.url;
      view.caption = node.url.replace(/^https?:\/\//i, '');
      break;
    case 'group': {
      if (node.label !== undefined) view.label = node.label;
      const image = node.background === undefined ? undefined : resources.get(node.background)?.image;
      if (image !== undefined) {
        view.background = image;
        view.backgroundStyle = node.backgroundStyle ?? 'cover';
      }
      break;
    }
    case 'unknown':
      break;
  }
  return view;
}

/** Lines of a note shown in a file card at most; the card scrolls, a longer note is cut. */
export const MAX_NOTE_LINES = 300;

/**
 * The part of a note a file card shows (canvas.md 4): the note without its front matter, or for
 * `#heading` that heading's section (up to the next heading of the same or a higher level), or
 * for `#^block` the line holding that block id. A subpath not found shows the whole note.
 */
export function noteExcerpt(text: string, subpath?: string): string {
  let lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (close > 0) lines = lines.slice(close + 1);
  }
  if (subpath !== undefined) {
    const at = findSubpathLine(lines.join('\n'), subpath);
    if (at !== undefined) {
      if (subpath.startsWith('#^')) {
        lines = [lines[at]!.replace(/\s*\^[\w-]+\s*$/, '')];
      } else {
        const level = /^ {0,3}(#{1,6})/.exec(lines[at]!)?.[1]?.length ?? 6;
        const next = lines.findIndex((line, i) => i > at && (/^ {0,3}(#{1,6})[ \t]/.exec(line)?.[1]?.length ?? 7) <= level);
        lines = lines.slice(at, next < 0 ? undefined : next);
      }
    }
  }
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  return lines.slice(0, MAX_NOTE_LINES).join('\n');
}

/** Builds what the webview shows for a read result. */
export function buildCanvasView(result: CanvasReadResult, options: BuildViewOptions = {}): CanvasView {
  const strings = options.strings ?? DEFAULT_STRINGS;
  const messages = options.messages ?? DEFAULT_MESSAGES;
  if (!result.ok) {
    const first: CanvasIssue = result.issues[0]!;
    const line = first.position.line + 1;
    return { state: 'error', line, message: messages.unreadable(line), reason: reasonOf(first.code, messages), strings };
  }
  const { canvas } = result;
  const resources = options.resources ?? new Map<string, ResolvedResource>();
  const duplicates = new Set(canvas.duplicateNodeIds);
  const nodes = withGroups(
    canvas.nodes,
    canvas.nodes.map((node) => {
      const view = nodeView(node, strings, resources);
      return duplicates.has(node.id) ? { ...view, locked: true } : view;
    }),
  );
  const firstIndex = new Map<string, number>();
  nodes.forEach((node, i) => {
    if (!firstIndex.has(node.id)) firstIndex.set(node.id, i);
  });
  const edges: EdgeView[] = [];
  for (const edge of canvas.edges) {
    const from = firstIndex.get(edge.fromNode);
    const to = firstIndex.get(edge.toNode);
    if (from === undefined || to === undefined) continue;
    const view: { -readonly [K in keyof EdgeView]: EdgeView[K] } = { id: edge.id, from, to, fromEnd: edge.fromEnd, toEnd: edge.toEnd };
    if (edge.fromSide !== undefined) view.fromSide = edge.fromSide;
    if (edge.toSide !== undefined) view.toSide = edge.toSide;
    const color = colorOf(edge);
    if (color !== undefined) view.color = color;
    if (edge.label !== undefined) view.label = edge.label;
    edges.push(view);
  }
  const notices: Notice[] = [];
  if (canvas.issues.some((i) => i.code === 'too-large')) notices.push({ kind: 'info', text: messages.readOnlySize });
  if (canvas.issues.some((i) => i.code === 'too-many-nodes')) notices.push({ kind: 'info', text: messages.readOnlyNodes });
  const warnings = canvas.issues.filter((issue) => issue.code !== 'too-large' && issue.code !== 'too-many-nodes');
  if (warnings.length > 0) notices.push({ kind: 'warning', text: messages.warnings(warnings.length, warnings[0]!.position.line + 1) });
  const editable = !canvas.readOnly && options.editable !== false;
  return { state: 'canvas', nodes, edges, readOnly: canvas.readOnly, editable, snapToGrid: options.snapToGrid === true, notices, strings };
}

/** Adds each card's innermost enclosing group (smallest group whose rectangle holds it fully). */
function withGroups(model: readonly CanvasNode[], views: NodeView[]): NodeView[] {
  const groups = model.filter((n) => n.kind === 'group');
  if (groups.length === 0) return views;
  return views.map((view, i) => {
    const node = model[i]!;
    let best: CanvasNode | undefined;
    for (const g of groups) {
      if (g === node) continue;
      const inside = node.x >= g.x && node.y >= g.y && node.x + node.width <= g.x + g.width && node.y + node.height <= g.y + g.height;
      if (!inside) continue;
      // Two groups with the same rectangle: only the earlier one (drawn below) holds the later.
      const same = g.x === node.x && g.y === node.y && g.width === node.width && g.height === node.height;
      if (same && g.index > node.index) continue;
      if (best === undefined || g.width * g.height < best.width * best.height) best = g;
    }
    return best === undefined ? view : { ...view, group: best.index };
  });
}

/** Paths the extension needs to resolve: file cards and group backgrounds, without repeats. */
export function resourcePaths(result: CanvasReadResult): { files: string[]; backgrounds: string[] } {
  if (!result.ok) return { files: [], backgrounds: [] };
  const files = new Set<string>();
  const backgrounds = new Set<string>();
  for (const node of result.canvas.nodes) {
    if (node.kind === 'file') files.add(node.file);
    else if (node.kind === 'group' && node.background !== undefined) backgrounds.add(node.background);
  }
  return { files: [...files], backgrounds: [...backgrounds] };
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

/** Whether a path names an image the webview may preview (by extension). */
export function isImagePath(path: string): boolean {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Zero-based line a file card's `subpath` points to in a Markdown text: `#Heading` (the last
 * part of `#A#B`) matches a heading with that text, `#^id` a line ending in ` ^id`.
 * Undefined when nothing matches.
 */
export function findSubpathLine(text: string, subpath: string): number | undefined {
  const lines = text.split(/\r?\n/);
  if (subpath.startsWith('#^')) {
    const id = subpath.slice(2).trim();
    if (id === '') return undefined;
    const index = lines.findIndex((line) => line.trimEnd().endsWith(`^${id}`) && /(^|\s)\^[\w-]+$/.test(line.trimEnd()));
    return index < 0 ? undefined : index;
  }
  const parts = subpath.split('#').filter((p) => p.trim() !== '');
  const wanted = parts[parts.length - 1]?.trim().toLowerCase();
  if (wanted === undefined) return undefined;
  const index = lines.findIndex((line) => {
    const match = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/.exec(line);
    return match !== null && match[1]!.trim().toLowerCase() === wanted;
  });
  return index < 0 ? undefined : index;
}

/**
 * Joins a canvas path onto a base folder (both relative to a root, `/`-separated) and
 * normalizes it. Undefined when the result would leave the root, or the path is absolute,
 * has a drive, a backslash, a control character or an empty name.
 */
export function resolveInside(base: string, path: string): string | undefined {
  if (path === '' || path.startsWith('/') || /[\\\u0000-\u001f]/.test(path) || /^[A-Za-z]:/.test(path)) return undefined;
  const out: string[] = [];
  for (const part of [...base.split('/'), ...path.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.length === 0 ? undefined : out.join('/');
}
