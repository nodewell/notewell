// Attachment paste and drop for Markdown notes in a vault (links.md 4). The new file and the
// inserted embed are one edit: WorkspaceEdit.createFile never overwrites (the whole edit fails
// instead), and the text edit only inserts the link at the cursor or drop position.
import * as vscode from 'vscode';
import type { VaultRegistry } from '../../vault/registry.ts';
import { vaultRelativePath } from '../../vault/uri-paths.ts';
import {
  attachmentFolder,
  attachmentLink,
  attachmentPath,
  CONFIRM_BYTES,
  imageExtension,
  pastedImageName,
  safeFileName,
  uniqueName,
  uriListEntries,
} from './attachments.ts';

export interface AttachmentDependencies {
  readonly vaults: () => VaultRegistry | undefined;
}

/** Names tried (`name`, `name 1`, ...) before a paste gives up. */
const MAX_NAME_TRIES = 1000;
const KIND = vscode.DocumentDropOrPasteEditKind.Empty.append('notewell', 'attachment');
const SELECTOR: vscode.DocumentSelector = { language: 'markdown' };
const GLOB_SPECIAL = /[[\]{}*?!]/;

function settings(scope: vscode.Uri): { enabled: boolean; folder: string } {
  const config = vscode.workspace.getConfiguration('notewell.attachments', scope);
  return { enabled: config.get<boolean>('enabled', true), folder: config.get<string>('folder', '') };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

interface Incoming {
  /** A file already in the vault: only linked, never copied. */
  readonly vaultPath?: string;
  readonly name?: string;
  /** The source file, when there is one (its size is known before reading it). */
  readonly uri?: vscode.Uri;
  readonly data?: () => Thenable<Uint8Array>;
}

/** Size of a file on disk, or 0 when unknown. */
async function sizeOf(uri: vscode.Uri | undefined): Promise<number> {
  if (uri === undefined) return 0;
  try {
    return (await vscode.workspace.fs.stat(uri)).size;
  } catch {
    return 0;
  }
}

/**
 * Whether `folder` (vault-relative) or a folder above it inside the vault is a symbolic link:
 * a write there could land outside the vault (links.md 8). Missing folders are not links.
 */
async function throughSymlink(root: vscode.Uri, folder: string): Promise<boolean> {
  const segments = folder.split('/').filter((s) => s !== '');
  for (let i = 1; i <= segments.length; i++) {
    try {
      if (((await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, ...segments.slice(0, i)))).type & vscode.FileType.SymbolicLink) !== 0) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Files in the data transfer: named files keep their names; clipboard images get Obsidian's name. */
async function incoming(dataTransfer: vscode.DataTransfer, root: vscode.Uri, now: Date): Promise<Incoming[]> {
  const out: Incoming[] = [];
  let index = 0;
  dataTransfer.forEach((item, mime) => {
    const file = item.asFile();
    if (file === undefined) return;
    const vaultPath = file.uri ? vaultRelativePath(root, file.uri) : undefined;
    if (vaultPath !== undefined) {
      out.push({ vaultPath });
      return;
    }
    const extension = imageExtension(mime);
    // A clipboard image has no source file; several in one paste get distinct seconds.
    const name = file.uri === undefined && extension !== undefined ? pastedImageName(new Date(now.getTime() + 1000 * index++), extension) : file.name;
    out.push({ name, uri: file.uri, data: () => file.data() });
  });
  return out.length > 0 ? out : listedFiles(dataTransfer, root);
}

/**
 * Files dropped as a `text/uri-list` only (Windows Explorer can send no file items): vault files
 * are linked; other files are read only for `file:` URIs. Folders and unreadable entries are skipped.
 */
async function listedFiles(dataTransfer: vscode.DataTransfer, root: vscode.Uri): Promise<Incoming[]> {
  const list = await dataTransfer.get('text/uri-list')?.asString();
  if (list === undefined) return [];
  const out: Incoming[] = [];
  for (const entry of uriListEntries(list)) {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(entry, true);
    } catch {
      continue;
    }
    const vaultPath = vaultRelativePath(root, uri);
    if (vaultPath === undefined && uri.scheme !== 'file') continue;
    try {
      if (((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) === 0) continue;
    } catch {
      continue;
    }
    if (vaultPath !== undefined) out.push({ vaultPath });
    else out.push({ name: uri.path.slice(uri.path.lastIndexOf('/') + 1), uri, data: () => vscode.workspace.fs.readFile(uri) });
  }
  return out;
}

/** Same-name files in the vault, to decide whether the short link form is unique. */
async function sameNameFiles(root: vscode.Uri, name: string): Promise<string[] | undefined> {
  if (GLOB_SPECIAL.test(name)) return undefined;
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, `**/${name}`), null, 50);
  return found.map((uri) => vaultRelativePath(root, uri)).filter((p): p is string => p !== undefined);
}

interface Built {
  readonly text: string;
  readonly edit: vscode.WorkspaceEdit;
}

async function build(vaults: VaultRegistry | undefined, document: vscode.TextDocument, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<Built | undefined> {
  if (vaults === undefined || document.uri.scheme === 'untitled') return undefined;
  const vault = vaults.vaultFor(document.uri);
  const notePath = vault && vaultRelativePath(vault.root, document.uri);
  if (vault === undefined || notePath === undefined) return undefined;
  const own = settings(document.uri);
  if (!own.enabled) return undefined;

  const items = await incoming(dataTransfer, vault.root, new Date());
  if (items.length === 0) return undefined;

  const folder = attachmentFolder(vault.settings.attachmentFolderPath, notePath, own.folder);
  if (folder === undefined || (await throughSymlink(vault.root, folder))) {
    void vscode.window.showWarningMessage(vscode.l10n.t('The attachment folder setting points outside the vault or into a hidden folder. Nothing was added.'));
    return undefined;
  }

  // Files on disk are measured before they are read: a large one is asked about first.
  let asked = false;
  const confirmSize = async (total: number): Promise<boolean> => {
    if (asked || total <= CONFIRM_BYTES) return true;
    asked = true;
    const add = vscode.l10n.t('Add');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('The attachment is {0} MB. Add it to the vault?', Math.round(total / 1024 / 1024)),
      { modal: true },
      add,
    );
    return answer === add;
  };
  let known = 0;
  for (const item of items) if (item.vaultPath === undefined) known += await sizeOf(item.uri);
  if (!(await confirmSize(known))) return undefined;

  const edit = new vscode.WorkspaceEdit();
  const links: string[] = [];
  const chosen = new Set<string>();
  const copies: { path: string; data: Uint8Array }[] = [];
  for (const item of items) {
    if (token.isCancellationRequested) return undefined;
    if (item.vaultPath !== undefined) {
      links.push(attachmentLink(vault.settings, notePath, item.vaultPath, (await sameNameFiles(vault.root, item.vaultPath.split('/').pop()!)) ?? [item.vaultPath, '']));
      continue;
    }
    const safe = item.name === undefined ? undefined : safeFileName(item.name);
    if (safe === undefined || item.data === undefined) continue;
    const data = await item.data();
    if (token.isCancellationRequested) return undefined;
    const folderUri = vscode.Uri.joinPath(vault.root, ...folder.split('/').filter((s) => s !== ''));
    // Taken: on disk or chosen earlier in this paste (case-insensitively, like Windows and macOS).
    const names: string[] = [];
    for (const n of chosen) names.push(n.toLowerCase());
    // Bounded: a file system that reports every name as taken must not hang the paste.
    let name: string | undefined;
    for (let tries = 0; tries < MAX_NAME_TRIES && name === undefined; tries++) {
      const candidate = uniqueName(safe, (c) => names.includes(attachmentPath(folder, c).toLowerCase()));
      if (!(await exists(vscode.Uri.joinPath(folderUri, candidate)))) name = candidate;
      else names.push(attachmentPath(folder, candidate).toLowerCase());
      if (token.isCancellationRequested) return undefined;
    }
    if (name === undefined) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No free file name was found for "{0}". Nothing was added.', safe));
      return undefined;
    }
    const path = attachmentPath(folder, name);
    chosen.add(path);
    copies.push({ path, data });
    links.push(attachmentLink(vault.settings, notePath, path, (await sameNameFiles(vault.root, name)) ?? [path, '']));
  }
  if (links.length === 0 || token.isCancellationRequested) return undefined;

  if (!(await confirmSize(copies.reduce((sum, c) => sum + c.data.byteLength, 0)))) return undefined;
  for (const copy of copies) {
    edit.createFile(vscode.Uri.joinPath(vault.root, ...copy.path.split('/')), { overwrite: false, ignoreIfExists: false, contents: copy.data });
  }
  return { text: links.join('\n'), edit };
}

export function registerAttachments(context: vscode.ExtensionContext, deps: AttachmentDependencies): void {
  const title = vscode.l10n.t('Insert as Obsidian attachment');
  const provider: vscode.DocumentPasteEditProvider & vscode.DocumentDropEditProvider = {
    async provideDocumentPasteEdits(document, _ranges, dataTransfer, _context, token) {
      const built = await build(deps.vaults(), document, dataTransfer, token);
      if (built === undefined) return undefined;
      const edit = new vscode.DocumentPasteEdit(built.text, title, KIND);
      edit.additionalEdit = built.edit;
      return [edit];
    },
    async provideDocumentDropEdits(document, _position, dataTransfer, token) {
      const built = await build(deps.vaults(), document, dataTransfer, token);
      if (built === undefined) return undefined;
      const edit = new vscode.DocumentDropEdit(built.text, title, KIND);
      edit.additionalEdit = built.edit;
      return edit;
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider(SELECTOR, provider, { providedPasteEditKinds: [KIND], pasteMimeTypes: ['files', 'image/*'] }),
    vscode.languages.registerDocumentDropEditProvider(SELECTOR, provider, { providedDropEditKinds: [KIND], dropMimeTypes: ['files', 'image/*', 'text/uri-list'] }),
  );
}
