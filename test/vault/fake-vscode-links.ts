// Fake `vscode` for src/vault/link-store.ts: the Backlog base fake (files, relative-pattern
// watchers, text documents) plus findFiles, stat, document opens and file rename events.
import * as base from '../features/backlog/fake-vscode.ts';

export * from '../features/backlog/fake-vscode.ts';

const { EventEmitter, Uri, files, textDocuments, documentEvents } = base;

export const renameEvents = new EventEmitter<{ files: { oldUri: base.Uri; newUri: base.Uri }[] }>();
export const openEvents = new EventEmitter<base.FakeDocument>();

/** Opens a document as VS Code reports it (an open event). */
export function openDocumentWithEvent(path: string, text: string, dirty = false): base.FakeDocument {
  const doc = base.openDocument(path, text);
  doc.isDirty = dirty;
  openEvents.fire(doc);
  return doc;
}

/**
 * Fires a rename as VS Code reports it: the files move on disk, open documents under the old
 * path are closed and reopened at the new one (unsaved text kept), then the rename event.
 */
export function rename(oldPath: string, newPath: string): void {
  const under = (path: string): boolean => path === oldPath || path.startsWith(`${oldPath}/`);
  const moved = (path: string): string => `${newPath}${path.slice(oldPath.length)}`;
  for (const [path, text] of [...files]) {
    if (under(path)) {
      files.delete(path);
      files.set(moved(path), text);
    }
  }
  for (const doc of [...textDocuments]) {
    if (!under(doc.uri.path)) continue;
    base.closeDocument(doc);
    openDocumentWithEvent(moved(doc.uri.path), doc.text, doc.isDirty === true);
  }
  renameEvents.fire({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
}

/** A range replacement in a file, by absolute path (as WorkspaceEdit.replace). */
export interface FakeEdit {
  readonly path: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

/**
 * How VS Code reports a workspace edit to a file that is not open: as the open of a document
 * that already holds the edit (no change event), or as an open followed by a change.
 */
export type EditDelivery = 'openedEdited' | 'openedThenChanged';

/** Applies a workspace edit: open documents change; closed files open in the background, unsaved. */
export function applyEdit(edits: readonly FakeEdit[], delivery: EditDelivery): void {
  const byPath = new Map<string, FakeEdit[]>();
  for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  for (const [path, list] of byPath) {
    const doc = textDocuments.find((d) => d.uri.path === path);
    const before = doc?.text ?? files.get(path) ?? '';
    const lines = before.split('\n');
    for (const e of [...list].sort((a, b) => b.line - a.line || b.start - a.start)) {
      const line = lines[e.line]!;
      lines[e.line] = line.slice(0, e.start) + e.newText + line.slice(e.end);
    }
    const after = lines.join('\n');
    if (doc !== undefined) base.editDocument(doc, after);
    else if (delivery === 'openedEdited') openDocumentWithEvent(path, after, true);
    else base.editDocument(openDocumentWithEvent(path, before), after);
  }
}

/** Saves an open document: the disk gets its text and the watcher reports a change. */
export function saveDocument(path: string): void {
  const doc = textDocuments.find((d) => d.uri.path === path)!;
  files.set(path, doc.text);
  doc.isDirty = false;
  documentEvents.changed.fire({ document: doc });
  base.fireWatcher('change', path);
}

/** Undo back to the saved text: a change that leaves the document clean. */
export function undoToSaved(path: string): void {
  const doc = textDocuments.find((d) => d.uri.path === path)!;
  doc.text = files.get(path) ?? '';
  doc.isDirty = false;
  documentEvents.changed.fire({ document: doc });
}

Object.assign(base.workspace, {
  async findFiles(include: base.RelativePattern) {
    const root = include.baseUri.path.replace(/\/$/, '');
    if (include.pattern !== '**/*') throw new Error(`fake vscode: unexpected glob ${include.pattern}`);
    return [...files.keys()].filter((p) => p.startsWith(`${root}/`)).map((p) => Uri.file(p));
  },
  onDidRenameFiles: renameEvents.event,
  onDidOpenTextDocument: openEvents.event,
});

Object.assign(base.workspace.fs, {
  async stat(uri: base.Uri) {
    if (files.has(uri.path)) return { type: base.FileType.File };
    if ([...files.keys()].some((p) => p.startsWith(`${uri.path}/`))) return { type: base.FileType.Directory };
    throw new base.FileSystemError(uri.path, 'FileNotFound');
  },
});
