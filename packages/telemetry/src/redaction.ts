const HIDDEN = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const sensitive =
  /(?:authorization|cookie|password|passwd|secret|token|apikey|privatekey|credentials|databaseurl|connectionstring)$|^(?:headers|body|payload|prompt|messages|content|query|env|stack|cause|stdout|stderr)$/;
function sensitiveKey(key: string): boolean {
  return sensitive.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase());
}
/** Defense in depth, not a promise to identify arbitrary secrets in free text. */
export function createRedactor(
  secrets: readonly string[] = [],
): (value: unknown) => unknown {
  if (
    secrets.length > 64 ||
    secrets.some((s) => s.length < 4 || s.length > 4096)
  ) {
    throw new TypeError("Invalid redaction configuration");
  }
  const known = [...secrets].sort((a, b) => b.length - a.length);
  const text = (input: string): string => {
    if (input.length > 2048) return TRUNCATED;
    let result = input;
    for (const secret of known) result = result.split(secret).join(HIDDEN);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(result)) return HIDDEN;
    return result
      .replace(
        /\b(?:https?|postgres(?:ql)?|rediss?|amqps?|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
        HIDDEN,
      )
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, HIDDEN)
      .replace(/\b(?:sk[-_]|gh[pousr]_|github_pat_)[a-z0-9_-]{8,}/gi, HIDDEN)
      .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, HIDDEN)
      .replace(
        /(?:["']?)(?:password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
        HIDDEN,
      )
      .replace(/[\u0000-\u001f\u007f]/g, " ");
  };
  return (input: unknown): unknown => {
    const active = new WeakSet<object>();
    let remaining = 1000;
    function visit(value: unknown, depth: number): unknown {
      remaining -= 1;
      if (remaining < 0 || depth > 8) return TRUNCATED;
      if (typeof value === "string") return text(value);
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number")
        return Number.isFinite(value) ? value : "[NON_FINITE]";
      if (typeof value !== "object") return "[UNSUPPORTED]";
      if (active.has(value)) return TRUNCATED;
      try {
        const array = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (!array && prototype !== Object.prototype && prototype !== null)
          return HIDDEN;
        active.add(value);
        const output: Record<string, unknown> = Object.create(null);
        const keys = array
          ? Array.from(
              { length: Math.min((value as unknown[]).length, 50) },
              (_, i) => String(i),
            )
          : Object.keys(value).slice(0, 50);
        for (const key of keys) {
          const safeKey = text(key);
          if (
            safeKey.length > 128 ||
            ["__proto__", "constructor", "prototype", "toJSON"].includes(
              safeKey,
            )
          )
            continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          output[safeKey] = sensitiveKey(key)
            ? HIDDEN
            : !descriptor || !("value" in descriptor)
              ? "[ACCESSOR]"
              : visit(descriptor.value, depth + 1);
        }
        if (array) {
          const result = keys.map((key) => output[key]);
          if ((value as unknown[]).length > 50) result.push(TRUNCATED);
          return result;
        }
        if (Object.keys(value).length > 50) output["__truncated__"] = true;
        return { ...output };
      } catch {
        return "[UNREADABLE]";
      } finally {
        active.delete(value);
      }
    }
    return visit(input, 0);
  };
}
export const redact = createRedactor();
