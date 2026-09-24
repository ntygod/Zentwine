import { AsyncLocalStorage } from "node:async_hooks";
import { newSpanId, newTraceId } from "./services.js";
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
}
function hex(value: string, size: number): boolean {
  return (
    value.length === size && /^[0-9a-f]+$/.test(value) && !/^0+$/.test(value)
  );
}
export function rootTrace(): TraceContext {
  return Object.freeze({
    traceId: newTraceId(),
    spanId: newSpanId(),
    sampled: false,
  });
}
/** Version 00 subset only; unsupported/malformed parents start a new trace. */
export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (typeof value !== "string" || value.length !== 55) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match) return undefined;
  const traceId = match[1] ?? "";
  const spanId = match[2] ?? "";
  if (!hex(traceId, 32) || !hex(spanId, 16)) return undefined;
  return Object.freeze({
    traceId,
    spanId,
    sampled: (parseInt(match[3] ?? "00", 16) & 1) === 1,
  });
}
function snapshot(context: TraceContext): TraceContext {
  if (
    !hex(context.traceId, 32) ||
    !hex(context.spanId, 16) ||
    typeof context.sampled !== "boolean" ||
    (context.parentSpanId !== undefined && !hex(context.parentSpanId, 16))
  )
    throw new TypeError("Invalid trace context");
  return Object.freeze({
    traceId: context.traceId,
    spanId: context.spanId,
    sampled: context.sampled,
    ...(context.parentSpanId === undefined
      ? {}
      : { parentSpanId: context.parentSpanId }),
  });
}
export function traceparent(context: TraceContext): string {
  const c = snapshot(context);
  return `00-${c.traceId}-${c.spanId}-${c.sampled ? "01" : "00"}`;
}
/** Diagnostics only. Never stores organization, actor, delegation or authorization. */
export class TraceStore {
  readonly #storage = new AsyncLocalStorage<TraceContext | undefined>();
  current(): TraceContext | undefined {
    return this.#storage.getStore();
  }
  run<T>(context: TraceContext, callback: () => T): T {
    return this.#storage.run(snapshot(context), callback);
  }
  child<T>(callback: () => T): T {
    const parent = this.current();
    return this.run(
      parent
        ? {
            traceId: parent.traceId,
            spanId: newSpanId(),
            parentSpanId: parent.spanId,
            sampled: parent.sampled,
          }
        : rootTrace(),
      callback,
    );
  }
  /** Caller must authenticate the peer first; public HTTP never calls this. */
  fromTrustedParent<T>(value: unknown, callback: () => T): T {
    const parent = parseTraceparent(value);
    return this.run(
      parent
        ? {
            traceId: parent.traceId,
            spanId: newSpanId(),
            parentSpanId: parent.spanId,
            sampled: parent.sampled,
          }
        : rootTrace(),
      callback,
    );
  }
  bind<A extends unknown[], T>(callback: (...args: A) => T): (...args: A) => T {
    const context = this.current();
    return (...args) =>
      context
        ? this.run(context, () => callback(...args))
        : this.#storage.run(undefined, () => callback(...args));
  }
}
