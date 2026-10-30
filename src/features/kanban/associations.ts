// Remembers boards in the user setting `workbench.editorAssociations` (kanban.md 5), so VS Code
// itself opens those files as boards: the explorer then reveals an open board instead of opening
// a second, text tab. Only entries this extension added (kept in global state) are ever changed.
import * as vscode from 'vscode';

const SECTION = 'workbench';
const SETTING = 'editorAssociations';
const STATE_ID = 'notewell.kanban.associations';

/** An entry this extension added: the pattern and the file it stands for. */
interface Remembered {
  readonly pattern: string;
  readonly uri: string;
}

/**
 * The association pattern of exactly one file. VS Code matches a pattern containing `/` against
 * `<scheme>:<path>` (ignoring case); glob characters in the path become `?` (any one character).
 */
export function associationPattern(uri: { readonly scheme: string; readonly path: string }): string {
  return `${uri.scheme}:${uri.path.replace(/[*?[\]{}]/g, '?')}`;
}

type Associations = Record<string, string>;

/** `uri` is `target` itself or lies inside the folder `target`. */
function isWithin(uri: vscode.Uri, target: vscode.Uri): boolean {
  if (uri.scheme !== target.scheme || uri.authority !== target.authority) return false;
  const a = uri.path.toLowerCase();
  const b = target.path.toLowerCase().replace(/\/$/, '');
  return a === b || a.startsWith(`${b}/`);
}

export class BoardAssociations {
  readonly #state: vscode.Memento;
  readonly #viewType: string;
  /** Setting writes run one at a time, each on the value the previous one left. */
  #queue: Promise<void> = Promise.resolve();

  constructor(state: vscode.Memento, viewType: string) {
    this.#state = state;
    this.#viewType = viewType;
  }

  /** Adds the board's file, unless the user already associates that pattern with something. */
  remember(uri: vscode.Uri): Promise<void> {
    const pattern = associationPattern(uri);
    return this.#change((associations, remembered) => {
      const ours = remembered.some((r) => r.pattern === pattern);
      // An entry the user wrote (for this editor or another) stays theirs.
      if (pattern in associations && !(ours && associations[pattern] === this.#viewType)) return false;
      if (!ours) remembered.push({ pattern, uri: uri.toString() });
      associations[pattern] = this.#viewType;
      return true;
    });
  }

  /** Removes the file's entry if this extension added it. */
  forget(uri: vscode.Uri): Promise<void> {
    const pattern = associationPattern(uri);
    return this.#prune((r) => r.pattern === pattern);
  }

  /** Moves the entries of a renamed or moved file, or of the files in a renamed folder. */
  async rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const moved = this.#remembered()
      .map((r) => vscode.Uri.parse(r.uri))
      .filter((uri) => isWithin(uri, from));
    if (moved.length === 0) return;
    await this.forgetWhere((uri) => isWithin(uri, from));
    for (const uri of moved) await this.remember(uri.with({ scheme: to.scheme, authority: to.authority, path: to.path + uri.path.slice(from.path.length) }));
  }

  /** Removes the entries of a deleted file or of the files in a deleted folder. */
  forgetWithin(target: vscode.Uri): Promise<void> {
    return this.forgetWhere((uri) => isWithin(uri, target));
  }

  /** Removes the entries whose file `drop` selects (all of them without a predicate). */
  forgetWhere(drop: (uri: vscode.Uri) => boolean = () => true): Promise<void> {
    return this.#prune((r) => drop(vscode.Uri.parse(r.uri)));
  }

  #prune(drop: (r: Remembered) => boolean): Promise<void> {
    return this.#change((associations, remembered) => {
      const gone = remembered.filter(drop);
      if (gone.length === 0) return false;
      for (const r of gone) {
        remembered.splice(remembered.indexOf(r), 1);
        // An entry the user changed since is theirs now.
        if (associations[r.pattern] === this.#viewType) delete associations[r.pattern];
      }
      return true;
    });
  }

  #remembered(): Remembered[] {
    const value = this.#state.get<unknown>(STATE_ID, []);
    return Array.isArray(value)
      ? value.filter((r): r is Remembered => typeof r?.pattern === 'string' && typeof r?.uri === 'string').map((r) => ({ ...r }))
      : [];
  }

  /** Runs `edit` on copies of the user-level associations and the remembered list; true saves both. */
  #change(edit: (associations: Associations, remembered: Remembered[]) => boolean): Promise<void> {
    const run = async (): Promise<void> => {
      const config = vscode.workspace.getConfiguration(SECTION);
      const current = config.inspect<unknown>(SETTING)?.globalValue;
      // The old array form or anything unexpected is left alone.
      if (current !== undefined && (current === null || typeof current !== 'object' || Array.isArray(current))) return;
      const associations: Associations = { ...(current as Associations | undefined) };
      const remembered = this.#remembered();
      const before = JSON.stringify(associations);
      if (!edit(associations, remembered)) return;
      // The setting first: when it cannot be written, the list still says what it holds.
      if (JSON.stringify(associations) !== before) {
        const next = Object.keys(associations).length === 0 ? undefined : associations;
        await config.update(SETTING, next, vscode.ConfigurationTarget.Global);
      }
      await this.#state.update(STATE_ID, remembered);
    };
    // A failed write (e.g. unreadable settings file) leaves the setting as it was.
    this.#queue = this.#queue.then(run).catch(() => undefined);
    return this.#queue;
  }
}
