import test from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeEventObserver,
  RUNTIME_OBSERVER_LIMITS,
} from "../packages/client/dist/index.js";
import { bindRuntimeEvent } from "../packages/contracts/dist/index.js";
import { fixture } from "./fixtures/runtime-wire-v1.mjs";

const clone = (value) => structuredClone(value);
const uid = (n) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
function event(type, sequence = 1, payload) {
  const sample = fixture.event_variants.find((entry) => entry.type === type);
  assert.ok(sample);
  return {
    ...clone(sample),
    event_id: uid(Number(sequence)),
    sequence: String(sequence),
    ...(payload ? { payload: clone(payload) } : {}),
  };
}
const create = (budget) => new RuntimeEventObserver(fixture.start_a, budget);
function apply(observer, value) {
  const result = observer.accept(value);
  assert.equal(result.disposition, "applied", result.code);
  assert.equal(result.snapshot.authorization, false);
  assert.equal(result.snapshot.coverage, "accepted-prefix-only");
  return result.snapshot;
}
function running() {
  const observer = create();
  apply(observer, event("run.started"));
  return observer;
}
const bytes = (value) =>
  new TextEncoder().encode(JSON.stringify(bindRuntimeEvent(fixture.start_a, value))).length;
function unchangedPrefix(before, after) {
  for (const field of [
    "stream", "reported_state", "last_sequence", "next_sequence", "event_count",
    "retained_bytes", "pending_input", "observed_model", "latest_usage", "artifacts",
    "summary", "manifest_id", "stop_request_id", "stop_receipt", "failure",
  ])
    assert.deepEqual(after[field], before[field], field);
}

test("runtime observer: public entry constructs no execution and copies fixed input", () => {
  const input = clone(fixture.start_a);
  const observer = new RuntimeEventObserver(input);
  input.org_id = uid(999);
  assert.equal(observer.getSnapshot().stream.org_id, fixture.start_a.org_id);
  assert.equal(observer.getSnapshot().reported_state, "awaiting_start");
  assert.equal(observer.getSnapshot().last_sequence, "0");
  assert.equal(observer.getSnapshot().next_sequence, "1");
  assert.equal(observer.getSnapshot().event_count, 0);
  assert.ok(Object.isFrozen(RUNTIME_OBSERVER_LIMITS));
  assert.equal(observer.start, undefined);
  assert.equal(observer.stop, undefined);
  assert.equal(observer.retry, undefined);
});

test("runtime observer: complete synthetic history is deterministic and immutable", () => {
  const values = [
    event("run.started", 1), event("artifact.produced", 2),
    event("summary.available", 3), event("run.waiting_input", 4),
    event("run.input_accepted", 5), event("tool.requested", 6),
    event("usage.reported", 7), event("run.succeeded", 8),
  ];
  const first = create(), second = create();
  for (const value of values) {
    const a = apply(first, value), b = apply(second, clone(value));
    assert.deepEqual(a, b);
  }
  const final = first.getSnapshot();
  assert.equal(final.reported_state, "succeeded");
  assert.equal(final.manifest_id, fixture.manifest_a.manifest_id);
  assert.equal(final.artifacts.length, 1);
  assert.equal(final.summary.claim_kind, "agent_claim");
  assert.deepEqual(final.observed_model, { status: "unknown" });
  assert.deepEqual(final.latest_usage.usage, { status: "unknown" });
  assert.equal(final.retained_bytes, values.reduce((n, e) => n + bytes(e), 0));
  assert.ok(Object.isFrozen(final));
  assert.ok(Object.isFrozen(final.stream));
  assert.ok(Object.isFrozen(final.artifacts));
  assert.ok(Object.isFrozen(final.artifacts[0].producer));
  assert.throws(() => { final.artifacts[0].sha256 = "a".repeat(64); }, TypeError);
  assert.equal(final.authorization, false);
});

test("runtime observer: exact replay including terminal is idempotent", () => {
  const observer = running();
  const value = event("run.succeeded", 2);
  const before = apply(observer, value);
  for (const repeated of [event("run.started"), value, clone(value)]) {
    const result = observer.accept(repeated);
    assert.equal(result.disposition, "duplicate");
    assert.equal(result.snapshot, before);
  }
});

test("runtime observer: property order does not turn an exact replay into a conflict", () => {
  const observer = running();
  const original = event("run.started");
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(observer.accept(reordered).disposition, "duplicate");
});

for (const [name, change] of [
  ["payload", (v) => { v.payload.observed_model = { status: "reported", provider: fixture.start_a.model_binding.provider, model_id: "observed", source: "runtime_report" }; }],
  ["sequence", (v) => { v.sequence = "2"; }],
  ["timestamp", (v) => { v.occurred_at = "2026-09-27T00:00:01.000Z"; }],
]) {
  test(`runtime observer: same event ID with changed ${name} quarantines`, () => {
    const observer = running();
    const before = observer.getSnapshot();
    const value = event("run.started");
    change(value);
    const result = observer.accept(value);
    assert.equal(result.code, "event_conflict");
    assert.equal(result.recovery, "inspect");
    unchangedPrefix(before, result.snapshot);
    assert.equal(observer.accept(event("run.succeeded", 2)).code, "inspect_required");
    assert.equal(observer.accept(event("run.started")).disposition, "duplicate");
    assert.equal(observer.getSnapshot().fault, "event_conflict");
  });
}

test("runtime observer: same sequence with a different ID is not stale success", () => {
  const observer = running();
  const before = observer.getSnapshot();
  const value = event("run.started");
  value.event_id = uid(77);
  assert.equal(observer.accept(value).code, "sequence_conflict");
  unchangedPrefix(before, observer.getSnapshot());
});

test("runtime observer: missing events require explicit contiguous replay without buffering", () => {
  const observer = running();
  const future = event("run.succeeded", 4);
  assert.equal(observer.accept(future).code, "sequence_gap");
  assert.equal(observer.getSnapshot().reported_state, "running");
  assert.equal(observer.getSnapshot().gap_through, "4");
  assert.equal(observer.getSnapshot().event_count, 1);
  const second = apply(observer, event("summary.available", 2));
  assert.equal(second.synchronization, "replay_required");
  apply(observer, event("artifact.produced", 3));
  assert.equal(observer.getSnapshot().reported_state, "running");
  apply(observer, future);
  assert.equal(observer.getSnapshot().synchronization, "contiguous");
  assert.equal(observer.getSnapshot().gap_through, null);
  assert.equal(observer.getSnapshot().reported_state, "succeeded");
});

test("runtime observer: bigint gap high water is exact and never regresses", () => {
  const observer = running();
  for (const sequence of ["9007199254740993", "9223372036854775807", "9007199254740992"]) {
    const value = event("run.succeeded", 2);
    value.sequence = sequence;
    assert.equal(observer.accept(value).code, "sequence_gap");
  }
  assert.equal(observer.getSnapshot().gap_through, "9223372036854775807");
  assert.equal(observer.getSnapshot().next_sequence, "2");
  assert.equal(observer.getSnapshot().event_count, 1);
});

test("runtime observer: reported timestamps do not reorder the contiguous sequence", () => {
  const observer = running();
  const value = event("run.succeeded", 2);
  value.occurred_at = "2000-01-01T00:00:00.000Z";
  assert.equal(apply(observer, value).reported_state, "succeeded");
});

for (const field of ["org_id", "run_id", "attempt_id", "evidence_kind"]) {
  test(`runtime observer: rejects cross-stream ${field} before projection`, () => {
    const observer = running();
    const before = observer.getSnapshot();
    const value = event("run.succeeded", 2);
    value[field] = field === "evidence_kind" ? "adapter_report" : uid(999);
    assert.equal(observer.accept(value).code, "invalid_event");
    unchangedPrefix(before, observer.getSnapshot());
  });
}

for (const name of ["missing", "extra", "version", "getter", "cycle", "symbol", "oversize"]) {
  test(`runtime observer: malformed ${name} input is rejected without echo or getter execution`, () => {
    const observer = running();
    const before = observer.getSnapshot();
    const value = event("run.succeeded", 2);
    let calls = 0;
    if (name === "missing") delete value.payload;
    if (name === "extra") value.private_text = "do-not-echo";
    if (name === "version") value.schema_version = "99.0.0";
    if (name === "getter") Object.defineProperty(value, "payload", { enumerable: true, get() { calls++; return {}; } });
    if (name === "cycle") value.payload = value;
    if (name === "symbol") value[Symbol("do-not-echo")] = true;
    if (name === "oversize") value.private_text = "x".repeat(262145);
    const result = observer.accept(value);
    assert.equal(result.code, "invalid_event");
    assert.equal(calls, 0);
    assert.ok(!JSON.stringify(result).includes("do-not-echo"));
    unchangedPrefix(before, observer.getSnapshot());
  });
}

test("runtime observer: provider reports stay non-authorizing and cannot mix with synthetic", () => {
  const input = clone(fixture.start_a);
  input.execution_kind = "provider";
  const observer = new RuntimeEventObserver(input);
  const value = event("run.started");
  value.evidence_kind = "adapter_report";
  const state = apply(observer, value);
  assert.equal(state.stream.evidence_kind, "adapter_report");
  assert.equal(state.authorization, false);
  assert.equal(observer.accept(event("run.succeeded", 2)).code, "invalid_event");
});

test("runtime observer: waiting input requires the exact pending request", () => {
  const observer = running();
  const waiting = event("run.waiting_input", 2);
  const pending = apply(observer, waiting);
  waiting.payload.request_id = uid(999);
  assert.notEqual(pending.pending_input.request_id, waiting.payload.request_id);
  const value = event("run.input_accepted", 3);
  value.payload.request_id = uid(999);
  assert.equal(observer.accept(value).code, "invalid_transition");
  unchangedPrefix(pending, observer.getSnapshot());
});

test("runtime observer: resolved input request IDs cannot be reused", () => {
  const observer = running();
  apply(observer, event("run.waiting_input", 2));
  apply(observer, event("run.input_accepted", 3));
  assert.equal(observer.accept(event("run.waiting_input", 4)).code, "invalid_transition");
});

for (const type of ["run.input_accepted", "run.succeeded", "run.started", "tool.requested"]) {
  test(`runtime observer: stop request cannot be reversed by ${type}`, () => {
    const observer = running();
    const before = apply(observer, event("run.stop_requested", 2));
    assert.equal(before.reported_state, "stop_requested");
    assert.equal(before.stop_receipt, null);
    assert.equal(observer.accept(event(type, 3)).code, "invalid_transition");
    unchangedPrefix(before, observer.getSnapshot());
  });
}

test("runtime observer: stopping while waiting clears actionable input before a receipt", () => {
  const observer = running();
  apply(observer, event("run.waiting_input", 2));
  const stopped = apply(observer, event("run.stop_requested", 3));
  assert.equal(stopped.pending_input, null);
  assert.equal(stopped.stop_receipt, null);
  const receipt = apply(observer, event("run.cancelled", 4));
  assert.equal(receipt.reported_state, "cancelled");
  assert.equal(receipt.stop_receipt.scope, "attempt_and_children");
  assert.equal(receipt.authorization, false);
});

test("runtime observer: cancellation requires a preceding stop request", () => {
  const observer = running();
  assert.equal(observer.accept(event("run.cancelled", 2)).code, "invalid_transition");
});

test("runtime observer: cancellation before start remains a reported receipt", () => {
  const observer = create();
  apply(observer, event("run.stop_requested", 1));
  apply(observer, event("run.cancelled", 2));
  assert.equal(observer.getSnapshot().observed_model, null);
});

for (const phase of ["prestart", "running", "waiting", "stopping"]) {
  test(`runtime observer: unknown ${phase} outcome cannot auto-resume or retry`, () => {
    const observer = create();
    let sequence = 1;
    if (phase !== "prestart") apply(observer, event("run.started", sequence++));
    if (phase === "waiting") apply(observer, event("run.waiting_input", sequence++));
    if (phase === "stopping") apply(observer, event("run.stop_requested", sequence++));
    const value = event("run.unknown", sequence++);
    const state = apply(observer, value);
    assert.equal(state.reported_state, "unknown");
    assert.equal(state.pending_input, null);
    assert.equal(state.fault, "outcome_unknown");
    assert.equal(observer.accept(value).disposition, "duplicate");
    const result = observer.accept(event("run.succeeded", sequence));
    assert.equal(result.code, "inspect_required");
    assert.equal(result.recovery, "inspect");
    assert.equal(observer.getSnapshot(), state);
  });
}

test("runtime observer: disconnect preserves last report but blocks automatic recovery", () => {
  const observer = running();
  const before = observer.getSnapshot();
  const after = observer.disconnect();
  unchangedPrefix(before, after);
  assert.equal(after.fault, "transport_lost");
  assert.equal(after.synchronization, "inspect_required");
  assert.equal(observer.accept(event("run.succeeded", 2)).code, "inspect_required");
});

for (const end of ["succeeded", "failed", "cancelled"]) {
  test(`runtime observer: ${end} cannot be overwritten, even by a well-formed event`, () => {
    const observer = running();
    let sequence = 2;
    if (end === "cancelled") apply(observer, event("run.stop_requested", sequence++));
    const before = apply(observer, event(`run.${end}`, sequence++));
    assert.equal(observer.accept(event("run.started", sequence)).code, "invalid_transition");
    unchangedPrefix(before, observer.getSnapshot());
  });
}

test("runtime observer: failure before start must declare not_started", () => {
  const observer = create();
  const value = event("run.failed", 1);
  assert.equal(observer.accept(value).code, "invalid_transition");
  value.payload.error.outcome = "not_started";
  const valid = create();
  assert.equal(apply(valid, value).reported_state, "failed");
});

test("runtime observer: failure after start cannot claim not_started", () => {
  const observer = running();
  const value = event("run.failed", 2);
  value.payload.error.outcome = "not_started";
  assert.equal(observer.accept(value).code, "invalid_transition");
});

test("runtime observer: prestart stop followed by not_started failure is coherent", () => {
  const observer = create();
  apply(observer, event("run.stop_requested", 1));
  const value = event("run.failed", 2);
  value.payload.error.outcome = "not_started";
  assert.equal(apply(observer, value).reported_state, "failed");
});

test("runtime observer: summary and tool requests do not mark success or approval", () => {
  const observer = running();
  apply(observer, event("summary.available", 2));
  const value = event("tool.requested", 3);
  value.payload.approval_request_id = uid(99);
  const snapshot = apply(observer, value);
  assert.equal(snapshot.reported_state, "running");
  assert.equal(snapshot.manifest_id, null);
  assert.equal(snapshot.authorization, false);
  assert.equal(snapshot.summary.claim_kind, "agent_claim");
  const repeated = event("tool.requested", 4, value.payload);
  assert.equal(observer.accept(repeated).code, "invalid_transition");
});

test("runtime observer: request identity cannot collide across tool and input channels", () => {
  const observer = running();
  const tool = event("tool.requested", 2);
  apply(observer, tool);
  const waiting = event("run.waiting_input", 3);
  waiting.payload.request_id = tool.payload.request_id;
  assert.equal(observer.accept(waiting).code, "invalid_transition");
});

test("runtime observer: artifact references stay exact and duplicate notification is harmless", () => {
  const observer = running();
  const artifact = event("artifact.produced", 2);
  apply(observer, artifact);
  apply(observer, event("artifact.produced", 3));
  assert.equal(observer.getSnapshot().artifacts.length, 1);
  const changed = event("artifact.produced", 4);
  changed.payload.artifact.revision = 2;
  const before = observer.getSnapshot();
  assert.equal(observer.accept(changed).code, "invalid_transition");
  unchangedPrefix(before, observer.getSnapshot());
});

test("runtime observer: artifact capacity is 64 without eviction", () => {
  const observer = running();
  for (let i = 0; i < 64; i++) {
    const value = event("artifact.produced", i + 2);
    value.payload.artifact.artifact_id = uid(2000 + i);
    apply(observer, value);
  }
  const before = observer.getSnapshot();
  const extra = event("artifact.produced", 66);
  extra.payload.artifact.artifact_id = uid(9999);
  assert.equal(observer.accept(extra).code, "invalid_transition");
  unchangedPrefix(before, observer.getSnapshot());
  assert.equal(before.artifacts.length, 64);
});

test("runtime observer: usage is latest declaration, not a sum or verified bill", () => {
  const observer = running();
  const value = event("usage.reported", 2);
  value.payload.usage = { status: "reported", input_tokens: 0, output_tokens: 1, cost_microusd: null };
  apply(observer, value);
  const next = event("usage.reported", 3);
  next.payload.measurement_id = uid(777);
  const result = apply(observer, next);
  assert.deepEqual(result.latest_usage.usage, { status: "unknown" });
  assert.equal(result.total_cost, undefined);
  const reused = event("usage.reported", 4, value.payload);
  assert.equal(observer.accept(reused).code, "invalid_transition");
});

test("runtime observer: exact event capacity accepts replay but not a new event", () => {
  const budget = { max_events: 2, max_bytes: 1048576 };
  const observer = create(budget);
  budget.max_events = 1024;
  apply(observer, event("run.started", 1));
  const before = apply(observer, event("summary.available", 2));
  assert.equal(observer.accept(event("run.started", 1)).disposition, "duplicate");
  assert.equal(observer.accept(event("run.succeeded", 3)).code, "capacity_exceeded");
  unchangedPrefix(before, observer.getSnapshot());
});

test("runtime observer: byte budget counts canonical serialized UTF-8 exactly", () => {
  const first = event("run.started", 1), second = event("summary.available", 2);
  const total = bytes(first) + bytes(second);
  const exact = create({ max_events: 10, max_bytes: total });
  apply(exact, first);
  assert.equal(apply(exact, second).retained_bytes, total);
  const short = create({ max_events: 10, max_bytes: total - 1 });
  apply(short, first);
  const before = short.getSnapshot();
  assert.equal(short.accept(second).code, "capacity_exceeded");
  unchangedPrefix(before, short.getSnapshot());
  assert.equal(short.getSnapshot().summary, null);
});

test("runtime observer: default event bound does not silently discard early duplicate identities", () => {
  const observer = running();
  for (let sequence = 2; sequence <= RUNTIME_OBSERVER_LIMITS.max_events; sequence++) {
    const value = event("usage.reported", sequence);
    value.payload.measurement_id = uid(10000 + sequence);
    apply(observer, value);
  }
  const before = observer.getSnapshot();
  assert.equal(before.event_count, 1024);
  assert.equal(observer.accept(event("run.started")).disposition, "duplicate");
  assert.equal(observer.accept(event("run.succeeded", 1025)).code, "capacity_exceeded");
  unchangedPrefix(before, observer.getSnapshot());
});

for (const budget of [
  null, {}, { max_events: 0, max_bytes: 1 }, { max_events: 1025, max_bytes: 1 },
  { max_events: 1, max_bytes: 1048577 }, { max_events: 1.5, max_bytes: 1 },
  { max_events: 1, max_bytes: NaN }, { max_events: 1, max_bytes: 1, extra: true },
]) {
  test(`runtime observer: invalid limits ${JSON.stringify(budget)} rejected`, () => {
    assert.throws(() => create(budget), { name: "TypeError", message: "Invalid runtime observer limits" });
  });
}

test("runtime observer: limit getters are rejected without invocation", () => {
  let calls = 0;
  const budget = { max_events: 1, get max_bytes() { calls++; return 1; } };
  assert.throws(() => create(budget), TypeError);
  assert.equal(calls, 0);
});

test("runtime observer: close clears owned projection and rejects late input without reading it", () => {
  const observer = running();
  apply(observer, event("artifact.produced", 2));
  const old = observer.getSnapshot();
  observer.close();
  let calls = 0;
  const late = { get schema_version() { calls++; throw new Error("do-not-echo"); } };
  assert.equal(observer.accept(late).code, "closed");
  assert.equal(calls, 0);
  const state = observer.disconnect();
  assert.equal(state.synchronization, "closed");
  assert.equal(state.stream, null);
  assert.equal(state.reported_state, null);
  assert.equal(state.event_count, 0);
  assert.equal(state.retained_bytes, 0);
  assert.deepEqual(state.artifacts, []);
  assert.equal(state.observed_model, null);
  assert.equal(old.artifacts.length, 1, "caller-held history is not remotely erased");
  assert.deepEqual(observer.close(), state);
});

test("runtime observer: instances never share deduplication or quarantine state", () => {
  const first = running(), second = running();
  first.disconnect();
  apply(second, event("run.succeeded", 2));
  assert.equal(first.getSnapshot().reported_state, "running");
  assert.equal(second.getSnapshot().reported_state, "succeeded");
});

test("runtime observer: all transitions run without network, storage, timers or dispatch", () => {
  const names = ["fetch", "WebSocket", "localStorage", "sessionStorage", "setTimeout", "setInterval"];
  const previous = new Map(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let calls = 0;
  try {
    for (const key of names) Object.defineProperty(globalThis, key, { configurable: true, get() { calls++; throw new Error("Unexpected effect"); } });
    const observer = running();
    apply(observer, event("tool.requested", 2));
    apply(observer, event("run.stop_requested", 3));
    observer.disconnect();
    observer.close();
    assert.equal(calls, 0);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

const phaseRecipes = {
  awaiting_start: [],
  running: ["run.started"],
  waiting_input: ["run.started", "run.waiting_input"],
  stop_requested: ["run.started", "run.stop_requested"],
  succeeded: ["run.started", "run.succeeded"],
  failed: ["run.started", "run.failed"],
  cancelled: ["run.started", "run.stop_requested", "run.cancelled"],
  unknown: ["run.started", "run.unknown"],
};
const allowed = {
  awaiting_start: ["run.started", "run.stop_requested", "run.failed", "run.unknown"],
  running: ["run.waiting_input", "run.stop_requested", "run.succeeded", "run.failed", "run.unknown", "tool.requested", "summary.available", "artifact.produced", "usage.reported"],
  waiting_input: ["run.input_accepted", "run.stop_requested", "run.failed", "run.unknown", "summary.available", "artifact.produced", "usage.reported"],
  stop_requested: ["run.cancelled", "run.failed", "run.unknown", "usage.reported"],
  succeeded: [], failed: [], cancelled: [], unknown: [],
};
for (const [phase, recipe] of Object.entries(phaseRecipes)) {
  test(`runtime observer: explicit ${phase} transition matrix covers all twelve wire variants`, () => {
    for (const sample of fixture.event_variants) {
      const observer = create();
      let sequence = 1;
      for (const type of recipe) apply(observer, event(type, sequence++));
      const before = observer.getSnapshot();
      assert.equal(before.reported_state, phase);
      const value = event(sample.type, sequence);
      if (phase === "awaiting_start" && sample.type === "run.failed")
        value.payload.error.outcome = "not_started";
      const result = observer.accept(value);
      assert.equal(result.disposition === "applied", allowed[phase].includes(sample.type), `${phase}: ${sample.type}`);
      if (result.disposition === "applied") {
        assert.equal(result.snapshot.event_count, before.event_count + 1);
        assert.equal(result.snapshot.last_sequence, String(sequence));
      } else unchangedPrefix(before, result.snapshot);
      assert.equal(result.snapshot.authorization, false);
    }
  });
}

test("runtime observer: every three-event delivery permutation can be explicitly replayed", () => {
  const values = [event("run.started", 1), event("artifact.produced", 2), event("run.succeeded", 3)];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const canonical = create();
  for (const value of values) apply(canonical, value);
  for (const order of orders) {
    const observer = create();
    for (const i of order) observer.accept(values[i]);
    for (const value of values) {
      const result = observer.accept(value);
      assert.ok(result.disposition === "applied" || result.disposition === "duplicate");
    }
    assert.deepEqual(observer.getSnapshot(), canonical.getSnapshot());
  }
});
