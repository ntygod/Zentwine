import { SystemClock, type Clock } from "./services.js";
import { createRedactor } from "./redaction.js";
import { TraceStore } from "./trace.js";
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogEvent =
  | "api.started"
  | "api.stopped"
  | "api.start_failed"
  | "http.completed"
  | "http.failed"
  | "diagnostic";
export type LogSink = (line: string) => void;
const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
} as const;
const events = new Set<string>([
  "api.started",
  "api.stopped",
  "api.start_failed",
  "http.completed",
  "http.failed",
  "diagnostic",
]);
export interface LoggerOptions {
  level?: LogLevel;
  clock?: Clock;
  traces?: TraceStore;
  sink?: LogSink;
  secrets?: readonly string[];
}
/** Bounded diagnostic JSON lines; not a durable security audit ledger. */
export function createLogger(options: LoggerOptions = {}) {
  const level = options.level ?? "info";
  if (!Object.hasOwn(levels, level)) throw new TypeError("Invalid log level");
  const clock = options.clock ?? new SystemClock();
  const sanitize = createRedactor(options.secrets);
  const sink = options.sink ?? (() => {});
  let dropped = 0;
  return {
    get droppedRecords(): number {
      return dropped;
    },
    log(
      severity: Exclude<LogLevel, "silent">,
      event: LogEvent,
      fields: unknown = {},
    ): void {
      if (
        !(["debug", "info", "warn", "error"] as string[]).includes(severity) ||
        levels[severity] < levels[level]
      )
        return;
      try {
        const trace = options.traces?.current();
        const record = {
          timestamp: clock.now().toISOString(),
          level: severity,
          event: events.has(event) ? event : "log.invalid_event",
          ...(trace ? { trace_id: trace.traceId, span_id: trace.spanId } : {}),
          fields: sanitize(fields),
        };
        let line = JSON.stringify(record);
        if (Buffer.byteLength(line, "utf8") + 1 > 16384) {
          line = JSON.stringify({ ...record, fields: "[TRUNCATED]" });
        }
        sink(line + "\n");
      } catch {
        // Never log the sink error recursively, leak its content, or fail the request.
        dropped += 1;
      }
    },
  };
}
export type StructuredLogger = ReturnType<typeof createLogger>;
