// Validation for messages posted from a webview to the extension. Webview input
// is untrusted: a message is accepted only if its `type` is registered and every
// field matches its schema exactly. Unknown keys, missing fields and wrong values
// reject the whole message.

export interface IntField {
  readonly kind: 'int';
  readonly min: number;
  readonly max: number;
  readonly optional?: boolean;
}

export interface StringField {
  readonly kind: 'string';
  /** Maximum length in UTF-16 code units. */
  readonly maxLength: number;
  readonly minLength?: number;
  /**
   * Line breaks (CR, LF, NEL, LS, PS) are rejected unless this is true. When true,
   * only LF is allowed; CR, NEL, LS and PS are still rejected.
   */
  readonly allowNewline?: boolean;
  /** Maximum number of lines (LF count + 1). Only meaningful with allowNewline. */
  readonly maxLines?: number;
  readonly optional?: boolean;
}

export interface BooleanField {
  readonly kind: 'boolean';
  readonly optional?: boolean;
}

export interface EnumField<V extends string = string> {
  readonly kind: 'enum';
  readonly values: readonly V[];
  readonly optional?: boolean;
}

export type FieldSchema = IntField | StringField | BooleanField | EnumField;
export type MessageFields = Readonly<Record<string, FieldSchema>>;
export type MessageSchemas = Readonly<Record<string, MessageFields>>;

type FieldValue<F> = F extends IntField
  ? number
  : F extends StringField
    ? string
    : F extends BooleanField
      ? boolean
      : F extends EnumField<infer V>
        ? V
        : never;

type RequiredKeys<S> = { [K in keyof S]: S[K] extends { optional: true } ? never : K }[keyof S];
type OptionalKeys<S> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] };

type FieldsOf<S> = Simplify<
  { [K in RequiredKeys<S>]: FieldValue<S[K]> } & { [K in OptionalKeys<S>]?: FieldValue<S[K]> }
>;

/** The union of message objects described by a schema map. */
export type MessageOf<M extends MessageSchemas> = {
  [T in keyof M & string]: Simplify<{ type: T } & FieldsOf<M[T]>>;
}[keyof M & string];

export type ValidationResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly error: string };

const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
const OTHER_LINE_BREAK = /[\r\u0085\u2028\u2029]/;
const RESERVED_FIELDS = new Set(['type', '__proto__']);

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function checkSchemas(schemas: MessageSchemas): void {
  for (const [type, fields] of Object.entries(schemas)) {
    for (const [name, field] of Object.entries(fields)) {
      const where = `${type}.${name}`;
      if (RESERVED_FIELDS.has(name)) throw new Error(`Reserved field name: ${where}`);
      switch (field.kind) {
        case 'int':
          if (!isSafeInt(field.min) || !isSafeInt(field.max) || field.min > field.max) {
            throw new Error(`Invalid int range: ${where}`);
          }
          break;
        case 'string': {
          const min = field.minLength ?? 0;
          if (!isSafeInt(field.maxLength) || !isSafeInt(min) || min < 0 || min > field.maxLength) {
            throw new Error(`Invalid string length: ${where}`);
          }
          if (field.maxLines !== undefined && (!isSafeInt(field.maxLines) || field.maxLines < 1 || field.allowNewline !== true)) {
            throw new Error(`Invalid maxLines: ${where}`);
          }
          break;
        }
        case 'boolean':
          break;
        case 'enum':
          if (field.values.length === 0) throw new Error(`Empty enum: ${where}`);
          break;
        default:
          throw new Error(`Unknown field kind: ${where}`);
      }
    }
  }
}

function checkField(field: FieldSchema, value: unknown): string | undefined {
  switch (field.kind) {
    case 'int':
      if (!isSafeInt(value)) return 'expected an integer';
      if (value < field.min || value > field.max) return `out of range ${field.min}..${field.max}`;
      return undefined;
    case 'string':
      if (typeof value !== 'string') return 'expected a string';
      if (value.length > field.maxLength) return `longer than ${field.maxLength}`;
      if (value.length < (field.minLength ?? 0)) return `shorter than ${field.minLength}`;
      if (field.allowNewline !== true) {
        if (LINE_BREAK.test(value)) return 'contains a line break';
      } else {
        if (OTHER_LINE_BREAK.test(value)) return 'contains a line break other than LF';
        if (field.maxLines !== undefined && value.split('\n').length > field.maxLines) {
          return `more than ${field.maxLines} lines`;
        }
      }
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'expected a boolean';
    case 'enum':
      return typeof value === 'string' && field.values.includes(value) ? undefined : 'not an allowed value';
  }
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own enumerable data properties only; accessors and symbol keys are rejected. */
function readOwnData(value: object): Map<string, unknown> | undefined {
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined || !('value' in desc) || desc.enumerable !== true) return undefined;
    result.set(key, desc.value);
  }
  return result;
}

/**
 * Creates a validator for the given message types. The schema map is checked
 * up front; invalid schemas throw. The validator never throws on input.
 */
export function defineMessages<const M extends MessageSchemas>(
  schemas: M,
): (raw: unknown) => ValidationResult<MessageOf<M>> {
  checkSchemas(schemas);
  const fail = (error: string): ValidationResult<MessageOf<M>> => ({ ok: false, error });

  return (raw) => {
    if (!isPlainObject(raw)) return fail('message is not a plain object');
    const props = readOwnData(raw);
    if (props === undefined) return fail('message has non-data properties');

    const type = props.get('type');
    if (typeof type !== 'string' || !Object.hasOwn(schemas, type)) return fail('unknown message type');
    const fields: MessageFields = schemas[type]!;

    for (const key of props.keys()) {
      if (key !== 'type' && !Object.hasOwn(fields, key)) return fail(`${type}: unknown field ${key}`);
    }

    const message: Record<string, unknown> = { type };
    for (const [name, field] of Object.entries(fields)) {
      if (!props.has(name)) {
        if (field.optional === true) continue;
        return fail(`${type}.${name}: missing`);
      }
      const value = props.get(name);
      const error = checkField(field, value);
      if (error !== undefined) return fail(`${type}.${name}: ${error}`);
      message[name] = value;
    }
    return { ok: true, message: message as MessageOf<M> };
  };
}
