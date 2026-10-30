// Obsidian theme CSS -> custom property values (core.md 3.6). Vault CSS is untrusted
// input: only `--name: value` declarations in rules for body/html/:root/.theme-dark/
// .theme-light are read, and only values made of an allowlist of tokens survive.
// Pure: no VS Code API, no file access.
import { isSafeCssValue, MAX_CSS_VALUE_LENGTH } from '../webview/css-values.ts';

export type ThemeScheme = 'dark' | 'light';

/** Resolved variables per scheme: name (`--x`) -> value without `var()`. */
export interface ThemeVariables {
  readonly dark: ReadonlyMap<string, string>;
  readonly light: ReadonlyMap<string, string>;
}

export interface ThemeDeclaration {
  readonly name: string;
  readonly value: string;
  readonly important: boolean;
  /** Selector weight: 100 per class or :root, 1 per element. */
  readonly specificity: number;
  readonly schemes: readonly ThemeScheme[];
}

export const MAX_VALUE_LENGTH = MAX_CSS_VALUE_LENGTH;
const MAX_VAR_DEPTH = 32;
const BOTH: readonly ThemeScheme[] = ['dark', 'light'];

// --- tokenizer helpers ---

/** Index after a comment or string starting at `i`, or `i` when there is none. */
function skipOpaque(css: string, i: number): number {
  if (css.startsWith('/*', i)) {
    const end = css.indexOf('*/', i + 2);
    return end === -1 ? css.length : end + 2;
  }
  const quote = css[i];
  if (quote === '"' || quote === "'") {
    for (let j = i + 1; j < css.length; j++) {
      if (css[j] === '\\') j++;
      else if (css[j] === quote || css[j] === '\n') return j + 1;
    }
    return css.length;
  }
  return i;
}

/** Index of the `}` matching the `{` at `open` (or the end of the text). */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; ) {
    const skipped = skipOpaque(css, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
    i++;
  }
  return css.length;
}

/** Text with comments removed (strings kept). */
function stripComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('/*', i)) {
      i = skipOpaque(text, i);
      out += ' ';
      continue;
    }
    const skipped = skipOpaque(text, i);
    if (skipped !== i) {
      out += text.slice(i, skipped);
      i = skipped;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

// --- selectors ---

const ALLOWED_SELECTOR_PARTS = /\.theme-dark\b(?!-)|\.theme-light\b(?!-)|:root\b|\bhtml\b(?!-)|\bbody\b(?!-)/g;

interface SelectorInfo {
  readonly specificity: number;
  readonly schemes: readonly ThemeScheme[];
}

/** A selector made only of body/html/:root/.theme-dark/.theme-light parts, or undefined. */
function classifySelector(selector: string): SelectorInfo | undefined {
  const text = selector.trim();
  if (text === '' || text.replace(ALLOWED_SELECTOR_PARTS, ' ').trim() !== '') return undefined;
  const dark = text.includes('.theme-dark');
  const light = text.includes('.theme-light');
  if (dark && light) return undefined;
  let specificity = 0;
  for (const [part] of text.matchAll(ALLOWED_SELECTOR_PARTS)) specificity += part === 'html' || part === 'body' ? 1 : 100;
  return { specificity, schemes: dark ? ['dark'] : light ? ['light'] : BOTH };
}

// --- declarations ---

/** Top-level `name: value` pairs of a rule body; nested blocks are skipped. */
function declarationsOf(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let start = 0;
  const flush = (end: number): void => {
    const text = body.slice(start, end);
    const colon = text.indexOf(':');
    if (colon > 0) out.push({ name: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() });
  };
  for (let i = 0; i < body.length; ) {
    const skipped = skipOpaque(body, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (body[i] === '{') {
      // Nested rule (CSS nesting): not read; also drops the text before it.
      i = matchingBrace(body, i) + 1;
      start = i;
      continue;
    }
    if (body[i] === ';') {
      flush(i);
      start = i + 1;
    }
    i++;
  }
  flush(body.length);
  return out;
}

const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/;
const IMPORTANT = /\s*!\s*important\s*$/i;

function mediaScheme(prelude: string): readonly ThemeScheme[] | undefined {
  const text = prelude.toLowerCase().replace(/\s+/g, ' ');
  if (!text.startsWith('@media')) return undefined;
  const dark = /prefers-color-scheme\s*:\s*dark/.test(text);
  const light = /prefers-color-scheme\s*:\s*light/.test(text);
  if (dark === light) return undefined;
  return dark ? ['dark'] : ['light'];
}

/**
 * Custom property declarations of one stylesheet, in source order. Rules in
 * `@media (prefers-color-scheme: dark|light)` count for that scheme only; every other
 * at-rule (`@import`, `@font-face`, other `@media`, ...) is skipped. Values are not
 * validated here (see `isSafeThemeValue`).
 */
export function extractDeclarations(css: string, within: readonly ThemeScheme[] = BOTH): ThemeDeclaration[] {
  const out: ThemeDeclaration[] = [];
  let preludeStart = 0;
  for (let i = 0; i < css.length; ) {
    const skipped = skipOpaque(css, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = css[i];
    if (ch === ';') {
      // A statement at-rule such as @import: ignored.
      preludeStart = i + 1;
    } else if (ch === '}') {
      // Stray closing brace: resynchronize after it.
      preludeStart = i + 1;
    } else if (ch === '{') {
      const close = matchingBrace(css, i);
      const prelude = stripComments(css.slice(preludeStart, i)).trim();
      const body = css.slice(i + 1, close);
      if (prelude.startsWith('@')) {
        const schemes = mediaScheme(prelude);
        if (schemes !== undefined) {
          const inner = schemes.filter((s) => within.includes(s));
          if (inner.length > 0) out.push(...extractDeclarations(body, inner));
        }
      } else {
        out.push(...ruleDeclarations(prelude, body, within));
      }
      i = close + 1;
      preludeStart = i;
      continue;
    }
    i++;
  }
  return out;
}

function ruleDeclarations(prelude: string, body: string, within: readonly ThemeScheme[]): ThemeDeclaration[] {
  const selectors = prelude.split(',').map(classifySelector);
  const out: ThemeDeclaration[] = [];
  const decls = declarationsOf(stripComments(body));
  for (const selector of selectors) {
    if (selector === undefined) continue;
    const schemes = selector.schemes.filter((s) => within.includes(s));
    if (schemes.length === 0) continue;
    for (const { name, value } of decls) {
      if (!CUSTOM_PROPERTY.test(name)) continue;
      const important = IMPORTANT.test(value);
      out.push({ name, value: value.replace(IMPORTANT, '').trim(), important, specificity: selector.specificity, schemes });
    }
  }
  return out;
}

// --- values ---

/** core.md 3.6 value allowlist, shared with the webview side (src/webview/css-values.ts). */
export const isSafeThemeValue = isSafeCssValue;

// --- cascade and var() resolution ---

interface Winner {
  readonly value: string;
  readonly important: boolean;
  readonly specificity: number;
  readonly order: number;
}

/**
 * Cascades declarations from several stylesheets (earlier first, later wins at equal
 * weight) over `base` values (lowest priority), drops unsafe values, then resolves `var()`
 * within each scheme. A winning value whose references cannot be resolved (unknown or
 * cyclic) is discarded and the next value in cascade order is used instead, so a broken
 * theme declaration falls back to the layer below; with none left the variable is dropped.
 */
export function cascadeThemeVariables(
  stylesheets: readonly string[],
  base: ThemeVariables = { dark: new Map(), light: new Map() },
): ThemeVariables {
  const result = { dark: new Map<string, string>(), light: new Map<string, string>() };
  for (const scheme of BOTH) {
    const candidates = new Map<string, Winner[]>();
    let order = 0;
    const add = (name: string, winner: Winner): void => {
      const list = candidates.get(name);
      if (list === undefined) candidates.set(name, [winner]);
      else list.push(winner);
    };
    for (const [name, value] of base[scheme]) {
      if (isSafeThemeValue(value)) add(name, { value, important: false, specificity: -1, order: order++ });
    }
    for (const css of stylesheets) {
      for (const decl of extractDeclarations(css)) {
        if (!decl.schemes.includes(scheme) || !isSafeThemeValue(decl.value)) continue;
        add(decl.name, { value: decl.value, important: decl.important, specificity: decl.specificity, order: order++ });
      }
    }
    // Best first: the cascade winner, then the values it overrode.
    const ranked = new Map([...candidates].map(([name, list]) => [name, list.sort((a, b) => (outranks(a, b) ? -1 : 1)).map((w) => w.value)]));
    for (const [name, value] of resolveRanked(ranked)) result[scheme].set(name, value);
  }
  return result;
}

function outranks(a: Winner, b: Winner): boolean {
  if (a.important !== b.important) return a.important;
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  return a.order > b.order;
}

/** Replaces `var(--x)` / `var(--x, fallback)` from the same map; unresolvable or cyclic entries are left out. */
export function resolveVariables(raw: ReadonlyMap<string, string>): Map<string, string> {
  return resolveRanked(new Map([...raw].map(([name, value]) => [name, [value]])));
}

/**
 * Like `resolveVariables`, with several candidate values per name (best first): the first
 * candidate that resolves to a safe value wins.
 */
function resolveRanked(ranked: ReadonlyMap<string, readonly string[]>): Map<string, string> {
  const done = new Map<string, string | null>();
  const resolve = (name: string, stack: Set<string>): string | null => {
    const known = done.get(name);
    if (known !== undefined) return known;
    const values = ranked.get(name);
    if (values === undefined || stack.has(name) || stack.size > MAX_VAR_DEPTH) return null;
    stack.add(name);
    let final: string | null = null;
    for (const value of values) {
      const out = substitute(value, (ref) => resolve(ref, stack));
      if (out !== null && out.length <= MAX_VALUE_LENGTH && isSafeThemeValue(out)) {
        final = out;
        break;
      }
    }
    stack.delete(name);
    // Results found while another name was mid-resolution may depend on that cycle; only cache top-level ones.
    if (stack.size === 0 || final !== null) done.set(name, final);
    return final;
  };
  const result = new Map<string, string>();
  for (const name of ranked.keys()) {
    const value = resolve(name, new Set());
    if (value !== null) result.set(name, value);
  }
  return result;
}

/** Text with every var() replaced, or null when a reference has no value and no fallback. */
function substitute(value: string, lookup: (name: string) => string | null): string | null {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.toLowerCase().indexOf('var(', i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    // Find the matching parenthesis of this var( ... ).
    let depth = 0;
    let end = at + 3;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')' && --depth === 0) break;
    }
    if (end >= value.length) return null;
    const inner = value.slice(at + 4, end);
    const comma = inner.indexOf(',');
    const ref = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    let replacement = CUSTOM_PROPERTY.test(ref) ? lookup(ref) : null;
    if (replacement === null && fallback !== undefined && fallback !== '') replacement = substitute(fallback, lookup);
    if (replacement === null) return null;
    out += replacement;
    i = end + 1;
  }
  return out;
}
