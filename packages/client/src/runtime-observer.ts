/** ZT12-01-A2: bounded, instance-local observations; never execution authority. */
import {
  bindRuntimeEvent,
  parseStartRun,
  type RuntimeEvent,
  type StartRun,
} from "@zentwine/contracts";

type Payload<N extends RuntimeEvent["type"]> = Extract<
  RuntimeEvent,
  { type: N }
>["payload"];
type Artifact = Payload<"artifact.produced">["artifact"];
export type RuntimeReportedState =
  | "awaiting_start"
  | "running"
  | "waiting_input"
  | "stop_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type RuntimeObservationFault =
  | "invalid_event"
  | "event_conflict"
  | "sequence_conflict"
  | "invalid_transition"
  | "capacity_exceeded"
  | "transport_lost"
  | "outcome_unknown";
export interface RuntimeObserverLimits {
  readonly max_events: number;
  readonly max_bytes: number;
}
export const RUNTIME_OBSERVER_LIMITS: RuntimeObserverLimits = Object.freeze({
  max_events: 1024,
  max_bytes: 1048576,
});
export interface RuntimeObservation {
  readonly observer_version: "1.0.0";
  readonly authorization: false;
  readonly coverage: "accepted-prefix-only";
  readonly synchronization:
    | "contiguous"
    | "replay_required"
    | "inspect_required"
    | "closed";
  readonly stream: Readonly<{
    org_id: string;
    run_id: string;
    attempt_id: string;
    evidence_kind: "synthetic" | "adapter_report";
  }> | null;
  readonly reported_state: RuntimeReportedState | null;
  readonly last_sequence: string | null;
  readonly next_sequence: string | null;
  readonly gap_through: string | null;
  readonly event_count: number;
  readonly retained_bytes: number;
  readonly fault: RuntimeObservationFault | null;
  readonly observed_model: Payload<"run.started">["observed_model"] | null;
  readonly pending_input: Payload<"run.waiting_input"> | null;
  readonly stop_request_id: string | null;
  readonly stop_receipt: Payload<"run.cancelled"> | null;
  readonly manifest_id: string | null;
  readonly unknown_outcome: Payload<"run.unknown"> | null;
  readonly failure: Payload<"run.failed">["error"] | null;
  readonly latest_usage: Payload<"usage.reported"> | null;
  readonly artifacts: readonly Artifact[];
  readonly summary: Payload<"summary.available"> | null;
}
export interface RuntimeObservationResult {
  readonly disposition: "applied" | "duplicate" | "rejected";
  readonly code:
    | "accepted"
    | "duplicate"
    | "sequence_gap"
    | "inspect_required"
    | "closed"
    | RuntimeObservationFault;
  readonly recovery: "none" | "replay" | "inspect";
  readonly snapshot: RuntimeObservation;
}
function empty(): RuntimeObservation {
  return Object.freeze({
    observer_version: "1.0.0",
    authorization: false,
    coverage: "accepted-prefix-only",
    synchronization: "closed",
    stream: null,
    reported_state: null,
    last_sequence: null,
    next_sequence: null,
    gap_through: null,
    event_count: 0,
    retained_bytes: 0,
    fault: null,
    observed_model: null,
    pending_input: null,
    stop_request_id: null,
    stop_receipt: null,
    manifest_id: null,
    unknown_outcome: null,
    failure: null,
    latest_usage: null,
    artifacts: Object.freeze([]),
    summary: null,
  });
}
function limits(value: RuntimeObserverLimits): RuntimeObserverLimits {
  const fail = () => {
    throw new TypeError("Invalid runtime observer limits");
  };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("max_events") ||
    !keys.includes("max_bytes")
  )
    fail();
  const copy = { max_events: 0, max_bytes: 0 };
  for (const key of ["max_events", "max_bytes"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail();
    const n: unknown = descriptor?.value;
    if (
      typeof n !== "number" ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      n > RUNTIME_OBSERVER_LIMITS[key]
    )
      fail();
    copy[key] = n as number;
  }
  return Object.freeze(copy);
}
const terminal = (state: RuntimeReportedState | null) =>
  state === "succeeded" || state === "failed" || state === "cancelled";

/** No network, storage, timers, authorization or tool dispatch. One instance = one Attempt. */
export class RuntimeEventObserver {
  #start: StartRun | null;
  readonly #limits: RuntimeObserverLimits;
  #snapshot: RuntimeObservation;
  #last = 0n;
  #gap = 0n;
  readonly #events = new Map<string, string>();
  readonly #requests = new Set<string>();
  readonly #measurements = new Set<string>();
  readonly #artifacts = new Map<string, Artifact>();
  constructor(
    request: unknown,
    budget: RuntimeObserverLimits = RUNTIME_OBSERVER_LIMITS,
  ) {
    this.#start = parseStartRun(request);
    this.#limits = limits(budget);
    this.#snapshot = Object.freeze({
      ...empty(),
      synchronization: "contiguous",
      reported_state: "awaiting_start",
      last_sequence: "0",
      next_sequence: "1",
      stream: Object.freeze({
        org_id: this.#start.org_id,
        run_id: this.#start.run_id,
        attempt_id: this.#start.attempt_id,
        evidence_kind:
          this.#start.execution_kind === "synthetic"
            ? "synthetic"
            : "adapter_report",
      }),
    });
  }
  getSnapshot = (): RuntimeObservation => this.#snapshot;
  private result(
    disposition: RuntimeObservationResult["disposition"],
    code: RuntimeObservationResult["code"],
  ): RuntimeObservationResult {
    const sync = this.#snapshot.synchronization;
    return Object.freeze({
      disposition,
      code,
      recovery:
        sync === "inspect_required"
          ? "inspect"
          : sync === "replay_required"
            ? "replay"
            : "none",
      snapshot: this.#snapshot,
    });
  }
  private quarantine(fault: RuntimeObservationFault) {
    if (
      this.#start !== null &&
      this.#snapshot.synchronization !== "inspect_required"
    )
      this.#snapshot = Object.freeze({
        ...this.#snapshot,
        synchronization: "inspect_required",
        fault,
      });
    return this.result("rejected", fault);
  }
  /** Transport loss is not a stop receipt. Only external, authorized inspection can reconcile it. */
  disconnect = (): RuntimeObservation => {
    this.quarantine("transport_lost");
    return this.#snapshot;
  };
  /** Use on logout/context invalidation. Existing caller-held copies cannot be remotely erased. */
  close = (): RuntimeObservation => {
    this.#start = null;
    this.#events.clear();
    this.#requests.clear();
    this.#measurements.clear();
    this.#artifacts.clear();
    this.#last = 0n;
    this.#gap = 0n;
    this.#snapshot = empty();
    return this.#snapshot;
  };
  accept = (value: unknown): RuntimeObservationResult => {
    const start = this.#start;
    if (start === null) return this.result("rejected", "closed");
    let event: RuntimeEvent;
    try {
      event = bindRuntimeEvent(start, value);
    } catch {
      return this.#start === null
        ? this.result("rejected", "closed")
        : this.quarantine("invalid_event");
    }
    if (this.#start !== start) return this.result("rejected", "closed");
    const encoded = JSON.stringify(event);
    const previous = this.#events.get(event.event_id);
    if (previous !== undefined) {
      return previous === encoded
        ? this.result("duplicate", "duplicate")
        : this.quarantine("event_conflict");
    }
    if (this.#snapshot.synchronization === "inspect_required")
      return this.result("rejected", "inspect_required");
    const sequence = BigInt(event.sequence);
    if (sequence <= this.#last) return this.quarantine("sequence_conflict");
    if (sequence !== this.#last + 1n) {
      // Out-of-order payloads are not retained, trusted, or automatically retried.
      this.#gap = sequence > this.#gap ? sequence : this.#gap;
      this.#snapshot = Object.freeze({
        ...this.#snapshot,
        synchronization: "replay_required",
        gap_through: String(this.#gap),
      });
      return this.result("rejected", "sequence_gap");
    }
    const patch = this.transition(event);
    if (patch === null) return this.quarantine("invalid_transition");
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (
      this.#events.size >= this.#limits.max_events ||
      this.#snapshot.retained_bytes + bytes > this.#limits.max_bytes
    )
      return this.quarantine("capacity_exceeded");
    // Validation finishes before any journal, identity set or projection is changed.
    this.#events.set(event.event_id, encoded);
    if (
      event.type === "run.waiting_input" ||
      event.type === "run.stop_requested" ||
      event.type === "tool.requested"
    )
      this.#requests.add(event.payload.request_id);
    if (event.type === "usage.reported")
      this.#measurements.add(event.payload.measurement_id);
    if (event.type === "artifact.produced")
      this.#artifacts.set(
        event.payload.artifact.artifact_id,
        event.payload.artifact,
      );
    this.#last = sequence;
    if (this.#last >= this.#gap) this.#gap = 0n;
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...patch,
      synchronization:
        event.type === "run.unknown"
          ? "inspect_required"
          : this.#gap > 0n
            ? "replay_required"
            : "contiguous",
      fault: event.type === "run.unknown" ? "outcome_unknown" : null,
      last_sequence: event.sequence,
      next_sequence:
        sequence < 9223372036854775807n ? String(sequence + 1n) : null,
      gap_through: this.#gap > 0n ? String(this.#gap) : null,
      event_count: this.#events.size,
      retained_bytes: this.#snapshot.retained_bytes + bytes,
      artifacts: Object.freeze([...this.#artifacts.values()]),
    });
    return this.result("applied", "accepted");
  };
  private transition(event: RuntimeEvent): Partial<RuntimeObservation> | null {
    const state = this.#snapshot.reported_state;
    if (terminal(state) || state === "unknown" || state === null) return null;
    if (
      (event.type === "run.waiting_input" ||
        event.type === "run.stop_requested" ||
        event.type === "tool.requested") &&
      this.#requests.has(event.payload.request_id)
    )
      return null;
    switch (event.type) {
      case "run.started":
        return state === "awaiting_start"
          ? {
              reported_state: "running",
              observed_model: event.payload.observed_model,
            }
          : null;
      case "run.waiting_input":
        return state === "running"
          ? { reported_state: "waiting_input", pending_input: event.payload }
          : null;
      case "run.input_accepted":
        return state === "waiting_input" &&
          this.#snapshot.pending_input?.request_id === event.payload.request_id
          ? { reported_state: "running", pending_input: null }
          : null;
      case "run.stop_requested":
        return state !== "stop_requested"
          ? {
              reported_state: "stop_requested",
              stop_request_id: event.payload.request_id,
              pending_input: null,
            }
          : null;
      case "run.cancelled":
        return state === "stop_requested"
          ? { reported_state: "cancelled", stop_receipt: event.payload }
          : null;
      case "run.succeeded":
        return state === "running"
          ? {
              reported_state: "succeeded",
              manifest_id: event.payload.manifest_id,
            }
          : null;
      case "run.failed":
        return (this.#snapshot.observed_model === null) ===
          (event.payload.error.outcome === "not_started")
          ? {
              reported_state: "failed",
              failure: event.payload.error,
              pending_input: null,
            }
          : null;
      case "run.unknown":
        return {
          reported_state: "unknown",
          unknown_outcome: event.payload,
          pending_input: null,
        };
      case "tool.requested":
        return state === "running" ? {} : null;
      case "usage.reported":
        return state !== "awaiting_start" &&
          !this.#measurements.has(event.payload.measurement_id)
          ? { latest_usage: event.payload }
          : null;
      case "artifact.produced": {
        if (state !== "running" && state !== "waiting_input") return null;
        const ref = event.payload.artifact;
        const previous = this.#artifacts.get(ref.artifact_id);
        if (previous)
          return JSON.stringify(previous) === JSON.stringify(ref) ? {} : null;
        return this.#artifacts.size < 64 ? {} : null;
      }
      case "summary.available":
        return state === "running" || state === "waiting_input"
          ? { summary: event.payload }
          : null;
    }
  }
}
