/** Internal finite codec vocabulary, not an interpreter for caller-supplied schemas. */
export interface WireCodec<T> {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly read: (value: unknown) => T;
}
export type WireValue<C> = C extends WireCodec<infer T> ? T : never;
export function invalidWire(): never {
  throw new TypeError("Invalid runtime protocol message");
}
export function freezeWire<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeWire(child);
    Object.freeze(value);
  }
  return value;
}
export function wireEnum<const T extends readonly (string | boolean | null)[]>(
  ...values: T
): WireCodec<T[number]> {
  return {
    schema: { enum: values },
    read(value) {
      if (!values.includes(value as T[number])) invalidWire();
      return value as T[number];
    },
  };
}
export function wireString(
  pattern: string,
  maximum: number,
  minimum = 1,
): WireCodec<string> {
  const fullPattern = `${pattern}(?![\\s\\S])`;
  const expression = new RegExp(fullPattern, "u");
  return {
    schema: {
      type: "string",
      minLength: minimum,
      maxLength: maximum,
      pattern: fullPattern,
    },
    read(value) {
      if (
        typeof value !== "string" ||
        [...value].length < minimum ||
        [...value].length > maximum ||
        !expression.test(value)
      )
        invalidWire();
      return value;
    },
  };
}
export function wireInteger(
  minimum: number,
  maximum: number,
): WireCodec<number> {
  return {
    schema: { type: "integer", minimum, maximum },
    read(value) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
      )
        invalidWire();
      return value;
    },
  };
}
export function wireArray<C extends WireCodec<unknown>>(
  item: C,
  maximum: number,
  minimum = 0,
): WireCodec<readonly WireValue<C>[]> {
  return {
    schema: {
      type: "array",
      minItems: minimum,
      maxItems: maximum,
      items: item.schema,
    },
    read(value) {
      if (
        !Array.isArray(value) ||
        value.length < minimum ||
        value.length > maximum
      )
        invalidWire();
      return Object.freeze(
        value.map((entry) => item.read(entry)),
      ) as readonly WireValue<C>[];
    },
  };
}
export function wireObject<const P extends Record<string, WireCodec<unknown>>>(
  properties: P,
): WireCodec<{ readonly [K in keyof P]: WireValue<P[K]> }> {
  const keys = Object.keys(properties);
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      required: keys,
      properties: Object.fromEntries(
        keys.map((key) => [key, properties[key]!.schema]),
      ),
    },
    read(value) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        Object.keys(value).some((key) => !keys.includes(key))
      )
        invalidWire();
      const record = value as Record<string, unknown>;
      return Object.freeze(
        Object.fromEntries(
          keys.map((key) => [key, properties[key]!.read(record[key])]),
        ),
      ) as {
        readonly [K in keyof P]: WireValue<P[K]>;
      };
    },
  };
}
export function wireUnion<const C extends readonly WireCodec<unknown>[]>(
  ...choices: C
): WireCodec<WireValue<C[number]>> {
  return {
    schema: { oneOf: choices.map((choice) => choice.schema) },
    read(value) {
      for (const choice of choices) {
        try {
          return choice.read(value) as WireValue<C[number]>;
        } catch {
          /* Every public failure uses the same fixed message. */
        }
      }
      return invalidWire();
    },
  };
}
export function wireRefine<T>(
  codec: WireCodec<T>,
  accepts: (value: T) => boolean,
): WireCodec<T> {
  return {
    schema: codec.schema,
    read(value) {
      const parsed = codec.read(value);
      if (!accepts(parsed)) invalidWire();
      return parsed;
    },
  };
}

/** Limits apply to normalized JSON bytes, including property names and punctuation. */
export const RUNTIME_WIRE_LIMITS = Object.freeze({
  bytes: 262144,
  nodes: 8192,
  depth: 16,
});
function snapshotWire(value: unknown): unknown {
  let bytes = 0;
  let nodes = 0;
  const encoder = new TextEncoder();
  const active = new Set<object>();
  const charge = (size: number) => {
    bytes += size;
    if (bytes > RUNTIME_WIRE_LIMITS.bytes) invalidWire();
  };
  const text = (s: string) => {
    if (s.length > RUNTIME_WIRE_LIMITS.bytes) invalidWire();
    // Reject unpaired UTF-16 surrogates, rather than replacing them during encoding.
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalidWire();
      } else if (c >= 0xdc00 && c <= 0xdfff) invalidWire();
    }
    if (s.length > RUNTIME_WIRE_LIMITS.bytes) invalidWire();
    charge(encoder.encode(JSON.stringify(s)).length);
  };
  const copy = (v: unknown, depth: number): unknown => {
    if (
      ++nodes > RUNTIME_WIRE_LIMITS.nodes ||
      depth > RUNTIME_WIRE_LIMITS.depth
    )
      invalidWire();
    if (typeof v === "string") {
      text(v);
      return v;
    }
    if (v === null || typeof v === "boolean") {
      charge(v === null ? 4 : v ? 4 : 5);
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v) || Object.is(v, -0)) invalidWire();
      charge(JSON.stringify(v).length);
      return v;
    }
    if (!v || typeof v !== "object" || active.has(v)) invalidWire();
    const array = Array.isArray(v);
    if (
      Object.getPrototypeOf(v) !==
        (array ? Array.prototype : Object.prototype) &&
      !(Object.getPrototypeOf(v) === null && !array)
    )
      invalidWire();
    const keys = Reflect.ownKeys(v);
    if (
      keys.length > RUNTIME_WIRE_LIMITS.nodes ||
      keys.some((key) => typeof key !== "string")
    )
      invalidWire();
    active.add(v);
    charge(2);
    const readOwn = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        invalidWire();
      return copy(descriptor.value, depth + 1);
    };
    let result: unknown;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(v, "length")
        ?.value as unknown;
      if (
        typeof length !== "number" ||
        length > RUNTIME_WIRE_LIMITS.nodes ||
        keys.length !== length + 1
      )
        invalidWire();
      const entries: unknown[] = [];
      for (let i = 0; i < length; i++) {
        if (i) charge(1);
        entries.push(readOwn(String(i)));
      }
      result = Object.freeze(entries);
    } else {
      const entries: [string, unknown][] = [];
      for (const [i, key] of (keys as string[]).entries()) {
        if (i) charge(1);
        text(key);
        charge(1);
        entries.push([key, readOwn(key)]);
      }
      result = Object.freeze(Object.fromEntries(entries));
    }
    active.delete(v);
    return result;
  };
  return copy(value, 0);
}
/** Snapshot first; ordinary getters/toJSON never execute. Not a sandbox for hostile Proxies. */
export function parseWire<T>(codec: WireCodec<T>, value: unknown): T {
  try {
    return codec.read(snapshotWire(value));
  } catch {
    return invalidWire();
  }
}
