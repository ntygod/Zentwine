import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Clock, IdSource, MonotonicClock } from "@zentwine/domain";
export type { Clock, IdSource, MonotonicClock } from "@zentwine/domain";
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
export class SystemMonotonicClock implements MonotonicClock {
  milliseconds(): number {
    return performance.now();
  }
}
export class RandomIds implements IdSource {
  next(): string {
    return randomUUID();
  }
}
export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");
