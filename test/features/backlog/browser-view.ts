// Shared helpers for the Backlog webview tests: a view built from the fixture project and a
// fake document like the kanban render tests.
import { readdirSync, readFileSync } from 'node:fs';
import { parseConfig } from '../../../src/features/backlog/config.ts';
import { buildIndex, type SourceFile } from '../../../src/features/backlog/task-index.ts';
import { buildBacklogView } from '../../../src/features/backlog/view-build.ts';
import { DEFAULT_STRINGS, type BacklogView } from '../../../src/features/backlog/view.ts';

const PROJECT = new URL('../../fixtures/backlog/project/', import.meta.url);
const VARIANTS = new URL('../../fixtures/backlog/variants/', import.meta.url);

function folder(dir: URL, prefix: string, only?: readonly string[]): SourceFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && (only === undefined || only.includes(n)))
    .map((n) => ({ path: `${prefix}/${n}`, text: readFileSync(new URL(n, dir), 'utf8') }));
}

/** The fixture project, plus the named variant files. */
export function fixtureView(variants: readonly string[] = []): BacklogView {
  const config = parseConfig(readFileSync(new URL('config.yml', PROJECT), 'utf8')).config;
  const index = buildIndex(
    [...folder(new URL('tasks/', PROJECT), 'backlog/tasks'), ...folder(VARIANTS, 'backlog/tasks', variants)],
    folder(new URL('milestones/', PROJECT), 'backlog/milestones'),
    config,
  );
  return buildBacklogView(index, config, 'demo', DEFAULT_STRINGS);
}

export class FakeElement {
  readonly tagName: string;
  #text: string | null = null;
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly children: (FakeElement | string)[] = [];
  readonly classList = { add: (...tokens: string[]) => void tokens.forEach((t) => this.classes.add(t)) };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string | null {
    return this.#text ?? this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  set textContent(value: string | null) {
    this.#text = value;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }

  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) if (typeof child !== 'string') yield* child.walk();
  }

  find(predicate: (e: FakeElement) => boolean): FakeElement[] {
    return [...this.walk()].filter(predicate);
  }

  byClass(name: string): FakeElement[] {
    return this.find((e) => e.classes.has(name));
  }
}

export const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };
