// Edit messages from the webview checked against the current canvas (canvas.md 3.3). Pure. An
// edit names the node by index and id and carries the values the webview showed; when the node
// or those values differ now, the view was outdated and the edit is refused as stale.
import type { WebviewMessage } from './messages.ts';
import type { Canvas, CanvasColor } from './model.ts';
import type { CanvasEdit } from './operations.ts';

export type EditMessage = Extract<WebviewMessage, { type: 'move' | 'resize' | 'editText' | 'setColor' }>;

export function isEditMessage(message: WebviewMessage): message is EditMessage {
  return message.type === 'move' || message.type === 'resize' || message.type === 'editText' || message.type === 'setColor';
}

/** The color as the view shows it: '' (none), a preset digit or `#rrggbb`. */
export function shownColor(color: CanvasColor | undefined): string {
  if (color === undefined) return '';
  return color.kind === 'preset' ? String(color.preset) : color.hex;
}

export type EditCheck = { readonly ok: true; readonly edit: CanvasEdit } | { readonly ok: false };

/** The operation for an edit message, or not ok when the message was made on another state. */
export function checkEdit(canvas: Canvas, message: EditMessage): EditCheck {
  const node = canvas.nodes.find((n) => n.index === message.index);
  if (node === undefined || node.id !== message.id) return { ok: false };
  switch (message.type) {
    case 'move':
      if (node.x !== message.fromX || node.y !== message.fromY) return { ok: false };
      return { ok: true, edit: { kind: 'move', id: node.id, x: message.x, y: message.y } };
    case 'resize':
      if (node.width !== message.fromWidth || node.height !== message.fromHeight) return { ok: false };
      return { ok: true, edit: { kind: 'resize', id: node.id, width: message.width, height: message.height } };
    case 'editText':
      return { ok: true, edit: { kind: 'text', id: node.id, text: message.text } };
    case 'setColor':
      if (shownColor(node.color) !== message.from) return { ok: false };
      return { ok: true, edit: { kind: 'color', id: node.id, color: message.color === 'none' ? null : message.color } };
  }
}
