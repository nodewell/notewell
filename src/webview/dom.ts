// Element creation for webview scripts. Text always goes through textContent or
// text nodes; there is no way to pass markup. The structural types below accept
// the real DOM `document` without requiring the DOM lib here.

/** `N` is the element type itself; with the real DOM, `HTMLElement`. */
export interface DomElement<N> {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  append(...nodes: (N | string)[]): void;
  readonly classList: { add(...tokens: string[]): void };
}

export interface DomDocument<E extends DomElement<E>> {
  createElement(tagName: string): E;
}

export interface ElementProps {
  readonly className?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'iframe', 'frame', 'object', 'embed', 'template',
]);
const FORBIDDEN_ATTRS = new Set(['style', 'srcdoc']);

export function createElementFactory<E extends DomElement<E>>(doc: DomDocument<E>) {
  return function el(tagName: string, props: ElementProps = {}, ...children: (E | string)[]): E {
    if (!NAME_PATTERN.test(tagName) || FORBIDDEN_TAGS.has(tagName)) {
      throw new Error(`Element not allowed: ${tagName}`);
    }
    const element = doc.createElement(tagName);
    if (props.className !== undefined) {
      const classes = props.className.split(/\s+/).filter((c) => c.length > 0);
      if (classes.length > 0) element.classList.add(...classes);
    }
    for (const [name, value] of Object.entries(props.attrs ?? {})) {
      const lower = name.toLowerCase();
      if (!NAME_PATTERN.test(lower) || lower.startsWith('on') || FORBIDDEN_ATTRS.has(lower)) {
        throw new Error(`Attribute not allowed: ${name}`);
      }
      element.setAttribute(lower, value);
    }
    if (props.text !== undefined) element.textContent = props.text;
    if (children.length > 0) element.append(...children);
    return element;
  };
}
