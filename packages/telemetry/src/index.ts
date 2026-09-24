import { randomUUID } from "node:crypto";
import type { ApiErrorPayload } from "@zentwine/contracts";
export const newTraceId = (): string => randomUUID();
export function apiError(
  code: string,
  message: string,
  traceId: string,
  retryable = false,
): ApiErrorPayload {
  return { code, message, details: {}, trace_id: traceId, retryable };
}
const sensitive =
  /^(authorization|cookie|set-cookie|password|secret|token|api[_-]?key|credentials|database[_-]?url)$/i;
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive.test(key) ? "[REDACTED]" : redact(item, depth + 1),
      ]),
    );
  }
  return value;
}
