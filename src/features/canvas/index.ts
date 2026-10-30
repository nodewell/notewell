// Registers the canvas feature: the custom editor for `.canvas` files (canvas.md 2).
import * as vscode from 'vscode';
import { CANVAS_VIEW_TYPE, CanvasEditorProvider, type CanvasDependencies } from './editor.ts';

export function registerCanvas(context: vscode.ExtensionContext, deps: CanvasDependencies): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(CANVAS_VIEW_TYPE, new CanvasEditorProvider(context.extensionUri, deps), {
      supportsMultipleEditorsPerDocument: true,
    }),
  );
}
