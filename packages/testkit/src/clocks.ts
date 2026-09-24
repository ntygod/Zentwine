import type { Clock, IdSource } from "@zentwine/domain";
export class FixedClock implements Clock {
  private readonly milliseconds: number;
  constructor(iso = "2026-09-24T00:00:00.000Z") {
    this.milliseconds = Date.parse(iso);
    if (!Number.isFinite(this.milliseconds))
      throw new TypeError("Invalid fixture clock");
  }
  now(): Date {
    return new Date(this.milliseconds);
  }
}
export class SequenceIds implements IdSource {
  private count = 0;
  next(): string {
    this.count += 1;
    return `fixture_${this.count}`;
  }
}

/** Deterministic wall clock with explicit test-controlled movement. */
export class ManualClock implements Clock {
  private value: number;
  constructor(iso = "2026-09-24T00:00:00.000Z") {
    this.value = new FixedClock(iso).now().getTime();
  }
  now(): Date {
    return new Date(this.value);
  }
  advance(milliseconds: number): void {
    const next = this.value + milliseconds;
    if (
      !Number.isSafeInteger(milliseconds) ||
      !Number.isFinite(new Date(next).getTime())
    ) {
      throw new RangeError("Invalid clock movement");
    }
    this.value = next;
  }
}
export class ManualMonotonicClock {
  private value = 0;
  milliseconds(): number {
    return this.value;
  }
  advance(milliseconds: number): void {
    if (
      !Number.isFinite(milliseconds) ||
      milliseconds < 0 ||
      !Number.isFinite(this.value + milliseconds)
    ) {
      throw new RangeError("Invalid monotonic movement");
    }
    this.value += milliseconds;
  }
}
