// The YAML subset Backlog.md writes (backlog.md 3.2): top-level scalars, `[]`, block lists
// of scalars and (read only) one-line flow lists. Anything else is reported as unknown and
// keeps its source lines; YAML is never parsed in general.

export type FieldValue =
  | { readonly kind: 'scalar'; readonly value: string; readonly style: ScalarStyle }
  | {
      readonly kind: 'list';
      readonly items: readonly ListItem[];
      /** A one-line `[a, b]` list (read only). `[]` is not flow: it is how an empty list is written. */
      readonly flow: boolean;
    }
  | { readonly kind: 'unknown' };

/** How a scalar is written; 'block' is a folded or literal block (`>-`, `|`), rewritten as one line. */
export type ScalarStyle = 'plain' | 'single' | 'double' | 'block';

export interface ListItem {
  readonly value: string;
  /** Line index of the `- item` line (the field's first line for flow lists). */
  readonly line: number;
}

export interface Field {
  /** The YAML key. */
  readonly name: string;
  /** Line index of the `name:` line. */
  readonly line: number;
  /** One past the last line belonging to the field (block list items included). */
  readonly end: number;
  readonly value: FieldValue;
}

const NAME_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/;
const LIST_ITEM = /^( +)- (.*)$/;

/**
 * Fields in `texts[start .. end - 1]`. Lines that are not `name:` lines at column 0 and do
 * not belong to a field (comments, blank lines) are skipped. A name seen twice is unknown.
 */
export function parseFields(texts: readonly string[], start = 0, end = texts.length): Field[] {
  const fields: Field[] = [];
  let i = start;
  while (i < end) {
    const match = NAME_LINE.exec(texts[i]);
    if (match === null) {
      i++;
      continue;
    }
    let next = i + 1;
    while (next < end && /^[ \t]/.test(texts[next])) next++;
    fields.push({ name: match[1], line: i, end: next, value: parseValue(match[2], texts.slice(i + 1, next), i + 1) });
    i = next;
  }
  const seen = new Map<string, number>();
  for (const field of fields) seen.set(field.name, (seen.get(field.name) ?? 0) + 1);
  return fields.map((field) => ((seen.get(field.name) ?? 0) > 1 ? { ...field, value: { kind: 'unknown' } } : field));
}

function parseValue(rest: string, children: readonly string[], firstChild: number): FieldValue {
  if (rest !== '' && !/^[ \t]/.test(rest)) return { kind: 'unknown' };
  const inline = rest.trim();
  if (inline === '') {
    if (children.length === 0) return { kind: 'scalar', value: '', style: 'plain' };
    const items: ListItem[] = [];
    let indent: string | undefined;
    for (let j = 0; j < children.length; j++) {
      const item = LIST_ITEM.exec(children[j]);
      if (item === null || (indent !== undefined && item[1] !== indent)) return { kind: 'unknown' };
      indent = item[1];
      const value = parseScalar(item[2]);
      if (value === undefined) return { kind: 'unknown' };
      items.push({ value: value.value, line: firstChild + j });
    }
    return { kind: 'list', items, flow: false };
  }
  // A block scalar (`>-`, `|`, ...): how the CLI writes values longer than its line width.
  const block = /^([|>])([+-]?)$/.exec(inline);
  if (block !== null && children.length > 0) {
    const scalar = blockScalar(block[1] as '|' | '>', block[2], children);
    return scalar === undefined ? { kind: 'unknown' } : { kind: 'scalar', value: scalar, style: 'block' };
  }
  if (children.length > 0) return { kind: 'unknown' };
  if (inline === '[]') return { kind: 'list', items: [], flow: false };
  if (inline.startsWith('[')) {
    const values = parseFlowList(inline);
    return values === undefined
      ? { kind: 'unknown' }
      : { kind: 'list', items: values.map((value) => ({ value, line: firstChild - 1 })), flow: true };
  }
  const scalar = parseScalar(inline);
  return scalar === undefined ? { kind: 'unknown' } : { kind: 'scalar', ...scalar };
}

/** A whole scalar: quoted, or plain without YAML indicators that would change its meaning. */
export function parseScalar(text: string): { value: string; style: ScalarStyle } | undefined {
  const s = text.trim();
  if (s.startsWith("'")) {
    let value = '';
    for (let i = 1; i < s.length; i++) {
      if (s[i] !== "'") {
        value += s[i];
        continue;
      }
      if (s[i + 1] === "'") {
        value += "'";
        i++;
        continue;
      }
      return i === s.length - 1 ? { value, style: 'single' } : undefined;
    }
    return undefined;
  }
  if (s.startsWith('"')) {
    let value = '';
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') {
        const escaped = escapeAt(s, i + 1);
        if (escaped === undefined) return undefined;
        value += escaped.text;
        i = escaped.end - 1;
        continue;
      }
      if (ch === '"') return i === s.length - 1 ? { value, style: 'double' } : undefined;
      value += ch;
    }
    return undefined;
  }
  if (/^[|>&*!%@`{}[\],?#]/.test(s) || /^- /.test(s) || s.includes(': ') || s.includes(' #') || s.endsWith(':')) {
    return undefined;
  }
  return { value: s, style: 'plain' };
}

/** YAML's one-character escapes in double quotes, by the character after the backslash (as char codes). */
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  '0': 0x00, a: 0x07, b: 0x08, t: 0x09, '\t': 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, e: 0x1b, ' ': 0x20, '"': 0x22, '/': 0x2f,
  '\\': 0x5c, N: 0x85, _: 0xa0, L: 0x2028, P: 0x2029,
};
const HEX_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/**
 * The escape after a backslash at `at` in a double-quoted scalar (YAML 1.2), as the CLI's
 * serializer writes it: `\t`, `\\`, `\"`, `\xXX`, `\uXXXX`, `\UXXXXXXXX` and the other named
 * ones. Undefined for anything else, or a code point that is not a character (a surrogate).
 */
function escapeAt(s: string, at: number): { text: string; end: number } | undefined {
  const c = s[at];
  if (c === undefined) return undefined;
  const simple = SIMPLE_ESCAPES[c];
  if (simple !== undefined) return { text: String.fromCharCode(simple), end: at + 1 };
  const digits = HEX_DIGITS[c];
  if (digits === undefined) return undefined;
  const hex = s.slice(at + 1, at + 1 + digits);
  if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) return undefined;
  const code = Number.parseInt(hex, 16);
  if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return undefined;
  return { text: String.fromCodePoint(code), end: at + 1 + digits };
}

/**
 * A block scalar's value from its indented lines: `>` folds lines with spaces, `|` keeps them;
 * chomping `-` drops the final line break, none keeps one, `+` keeps it too (trailing blank lines
 * end the field here). Undefined for shapes this reader does not fold safely: lines indented less
 * than the first, tabs in the indentation, or more-indented lines in a folded scalar.
 */
function blockScalar(kind: '|' | '>', chomp: string, children: readonly string[]): string | undefined {
  const indent = /^ */.exec(children[0])![0].length;
  if (indent === 0) return undefined;
  const lines: string[] = [];
  for (const child of children) {
    const own = /^ */.exec(child)![0].length;
    if (own < indent || child[own] === '\t') return undefined;
    if (kind === '>' && own > indent) return undefined;
    lines.push(child.slice(indent));
  }
  const body = lines.join(kind === '>' ? ' ' : '\n');
  return chomp === '-' ? body : `${body}\n`;
}

/** `["a", 'b', c]` with scalar items only; nested brackets or braces are not read. */
function parseFlowList(text: string): string[] | undefined {
  if (!text.endsWith(']')) return undefined;
  const inner = text.slice(1, -1);
  if (/[[\]{}]/.test(inner)) return undefined;
  const values: string[] = [];
  let current = '';
  let quote: string | undefined;
  const flush = (): boolean => {
    const scalar = parseScalar(current);
    if (scalar === undefined || scalar.value === '') return false;
    values.push(scalar.value);
    current = '';
    return true;
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) {
        if (quote === "'" && inner[i + 1] === "'") {
          current += "'";
          i++;
        } else if (!(quote === '"' && inner[i - 1] === '\\')) {
          quote = undefined;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === ',') {
      if (!flush()) return undefined;
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) return undefined;
  if (current.trim() !== '' && !flush()) return undefined;
  return values;
}

// Values YAML would read as another type (yes/no/on/off too, for YAML 1.1 readers).
const RESERVED_PLAIN =
  /^(true|false|yes|no|on|off|y|n|null|~|[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?|[-+]?\.(inf|nan)|0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d{4}-\d{2}-\d{2}.*)$/i;

// Plain-scalar rules of the serializer Backlog.md 1.54.0 uses (js-yaml 3): no indicator
// first and none of `:#,[]{}` anywhere, which is why URLs and `a: b` titles come out quoted.
const UNSAFE_FIRST = /^[-?:,[\]{}#&*!|>'"%@`\s]/;
const UNSAFE_ANY = /[:#,[\]{}\t\r\n]/;

/**
 * A scalar as Backlog.md would write it in `style`. Plain values that the CLI would quote,
 * or that YAML would read differently, fall back to single quotes.
 */
export function formatScalar(value: string, style: ScalarStyle): string {
  if (style === 'double') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const single = `'${value.replace(/'/g, "''")}'`;
  if (style === 'single') return single;
  const plainOk =
    value !== '' &&
    value === value.trim() &&
    !UNSAFE_FIRST.test(value) &&
    !UNSAFE_ANY.test(value) &&
    !RESERVED_PLAIN.test(value) &&
    parseScalar(value)?.value === value;
  return plainOk ? value : single;
}

export function fieldOf(fields: readonly Field[], name: string): Field | undefined {
  return fields.find((field) => field.name === name);
}

/** Scalar value of `name`, or undefined when missing or not a scalar. */
export function scalarOf(fields: readonly Field[], name: string): string | undefined {
  const value = fieldOf(fields, name)?.value;
  return value?.kind === 'scalar' ? value.value : undefined;
}

/** List values of `name`; a scalar counts as a one-item list; missing or unknown is empty. */
export function listOf(fields: readonly Field[], name: string): string[] {
  const value = fieldOf(fields, name)?.value;
  if (value?.kind === 'list') return value.items.map((item) => item.value);
  if (value?.kind === 'scalar' && value.value !== '') return [value.value];
  return [];
}
