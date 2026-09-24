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
