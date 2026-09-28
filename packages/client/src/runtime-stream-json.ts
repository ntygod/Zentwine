/** Internal bounded JSON reader. Duplicate decoded keys are never silently replaced. */
import { RUNTIME_WIRE_LIMITS } from "@zentwine/contracts";

function readBoundedJson(
  text: string,
  maximumNodes: number,
  maximumDepth: number,
): unknown {
  let position = 0;
  let nodes = 0;
  const fail = (): never => {
    throw new TypeError("Invalid runtime event frame");
  };
  const space = () => {
    while (position < text.length && /[\x20\t\r\n]/u.test(text[position]!))
      position++;
  };
  const string = (): string => {
    const start = position;
    if (text[position++] !== '"') return fail();
    while (position < text.length) {
      const c = text[position++];
      if (c === '"') return JSON.parse(text.slice(start, position)) as string;
      if (c === "\\") position++;
    }
    return fail();
  };
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const read = (depth: number): unknown => {
    if (++nodes > maximumNodes || depth > maximumDepth) fail();
    space();
    const c = text[position];
    if (c === '"') return string();
    if (c === "{") {
      position++;
      const object: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      space();
      if (text[position] === "}") {
        position++;
        return object;
      }
      for (;;) {
        space();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        space();
        if (text[position++] !== ":") fail();
        object[key] = read(depth + 1);
        space();
        const delimiter = text[position++];
        if (delimiter === "}") return object;
        if (delimiter !== ",") fail();
      }
    }
    if (c === "[") {
      position++;
      const array: unknown[] = [];
      space();
      if (text[position] === "]") {
        position++;
        return array;
      }
      for (;;) {
        array.push(read(depth + 1));
        space();
        const delimiter = text[position++];
        if (delimiter === "]") return array;
        if (delimiter !== ",") fail();
      }
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return value;
      }
    }
    number.lastIndex = position;
    const matched = number.exec(text);
    if (!matched) return fail();
    position = number.lastIndex;
    const value = Number(matched[0]);
    // Do not round a non-integer JSON token into an acceptable integer.
    if (
      !Number.isSafeInteger(value) ||
      Object.is(value, -0) ||
      !/^-?(0|[1-9][0-9]*)$/u.test(matched[0])
    )
      fail();
    return value;
  };
  const value = read(0);
  space();
  if (position !== text.length) fail();
  return value;
}

// Original event/plan callers retain exactly their existing limits.
export function readRuntimeStreamJson(text: string): unknown {
  return readBoundedJson(
    text,
    RUNTIME_WIRE_LIMITS.nodes,
    RUNTIME_WIRE_LIMITS.depth,
  );
}

// Separate bounded import profile, not a relaxation of runtime wire limits.
export function readRepositoryComparisonJson(text: string): unknown {
  return readBoundedJson(text, 100000, 16);
}
