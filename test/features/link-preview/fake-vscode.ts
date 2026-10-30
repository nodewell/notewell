// Minimal stand-in for the `vscode` module, covering src/features/link-preview/index.ts.

export class Uri {
  readonly authority = '';
  readonly scheme = 'file';
  readonly path: string;
  private constructor(path: string) {
    this.path = path;
  }
  static file(path: string): Uri {
    return new Uri(path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.path.replace(/\/$/, ''), ...segments].join('/'));
  }
  toString(): string {
    return `file://${this.path}`;
  }
}

export class Range {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.startLine = startLine;
    this.startCharacter = startCharacter;
    this.endLine = endLine;
    this.endCharacter = endCharacter;
  }
}

export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportHtml?: boolean;
  constructor(value: string) {
    this.value = value;
  }
}

export class Hover {
  readonly contents: MarkdownString;
  readonly range: Range;
  constructor(contents: MarkdownString, range: Range) {
    this.contents = contents;
    this.range = range;
  }
}

export const files = new Map<string, string>();
/** Sizes stat reports instead of the text's length, and paths read through readFile. */
export const sizes = new Map<string, number>();
export const reads: string[] = [];
export const settings = new Map<string, unknown>();
export const providers: { hover?: unknown; definition?: unknown } = {};
const format = (text: string, args: unknown[]): string => text.replace(/\{(\d+)\}/g, (_, n: string) => String(args[Number(n)]));
export const l10n = { t: (text: string, ...args: unknown[]) => format(text, args) };

export const workspace = {
  textDocuments: [] as { uri: Uri; getText(): string }[],
  fs: {
    async readFile(uri: Uri) {
      const text = files.get(uri.path);
      if (text === undefined) throw new Error('FileNotFound');
      reads.push(uri.path);
      return new TextEncoder().encode(text);
    },
    async stat(uri: Uri) {
      const text = files.get(uri.path);
      if (text === undefined) throw new Error('FileNotFound');
      return { size: sizes.get(uri.path) ?? new TextEncoder().encode(text).byteLength };
    },
  },
  getConfiguration(section: string) {
    return { get: <T>(name: string, fallback: T): T => (settings.has(`${section}.${name}`) ? (settings.get(`${section}.${name}`) as T) : fallback) };
  },
};

export const languages = {
  registerHoverProvider(_s: unknown, provider: unknown) {
    providers.hover = provider;
    return { dispose: () => undefined };
  },
  registerDefinitionProvider(_s: unknown, provider: unknown) {
    providers.definition = provider;
    return { dispose: () => undefined };
  },
};
