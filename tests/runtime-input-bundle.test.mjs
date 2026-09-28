import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  RuntimeInputBundle,
  RUNTIME_INPUT_BUNDLE_LIMITS,
} from "../packages/client/dist/index.js";
import { handoffFixture, handoffId } from "./fixtures/runtime-handoff-data.mjs";

const encode = (s) => new TextEncoder().encode(s);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const stream = (bytes) =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
const wire = (events) =>
  stream(encode(events.map((event) => JSON.stringify(event) + "\n").join("")));
function fixture(counts = [2, 1]) {
  const base = handoffFixture();
  const consumer = structuredClone(base.consumer);
  const payloads = new Map();
  const plans = counts.map((count, p) => {
    const request = structuredClone(base.producer);
    request.run_id = handoffId(100 + p);
    request.attempt_id = handoffId(200 + p);
    const manifest = structuredClone(base.manifest);
    Object.assign(manifest, {
      run_id: request.run_id,
      attempt_id: request.attempt_id,
      manifest_id: handoffId(300 + p),
    });
    manifest.artifacts = Array.from({ length: count }, (_, i) => {
      const entry = structuredClone(base.manifest.artifacts[0]);
      const bytes = encode(`input-${p}-${i}: 众弦 🎻\n`);
      entry.ref.artifact_id = handoffId(1000 + p * 100 + i);
      entry.ref.producer = {
        org_id: request.org_id,
        run_id: request.run_id,
        attempt_id: request.attempt_id,
      };
      entry.ref.sha256 = hash(bytes);
      entry.size_bytes = bytes.length;
      payloads.set(entry.ref.artifact_id, bytes);
      return entry;
    });
    return { request, manifest };
  });
  consumer.input_artifacts = plans
    .flatMap((plan) =>
      plan.manifest.artifacts.map((entry) => structuredClone(entry.ref)),
    )
    .reverse();
  const events = (p) => {
    const plan = plans[p];
    const event = (type, sequence, payload) => ({
      ...base.event(type, sequence, payload),
      run_id: plan.request.run_id,
      attempt_id: plan.request.attempt_id,
      event_id: handoffId(10000 + p * 100 + sequence),
    });
    return [
      event("run.started", 1),
      ...plan.manifest.artifacts.map((entry, i) =>
        event("artifact.produced", i + 2, {
          artifact: structuredClone(entry.ref),
        }),
      ),
      event("run.succeeded", plan.manifest.artifacts.length + 2, {
        manifest_id: plan.manifest.manifest_id,
      }),
    ];
  };
  return { consumer, plans, payloads, events };
}
const make = (data = fixture(), budget) =>
  new RuntimeInputBundle(data.consumer, data.plans, budget);
async function observed(data = fixture(), signal) {
  const bundle = make(data);
  bundle.begin(signal);
  await Promise.all(
    data.plans.map((plan, p) =>
      bundle.observeProducer(plan.manifest.manifest_id, wire(data.events(p))),
    ),
  );
  assert.equal(bundle.getSnapshot().status, "awaiting_artifacts");
  return { bundle, data };
}
async function ready(data = fixture(), signal) {
  const { bundle } = await observed(data, signal);
  await Promise.all(
    [...data.payloads].map(([id, bytes]) =>
      bundle.readArtifact(id, stream(bytes)),
    ),
  );
  assert.equal(bundle.getSnapshot().status, "ready");
  return { bundle, data };
}
function held(cancelMode = "never") {
  let controller;
  let cancellations = 0;
  const source = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      cancellations++;
      if (cancelMode === "reject")
        return Promise.reject(new Error("private-source-error"));
      if (cancelMode === "never") return new Promise(() => {});
    },
  });
  return { source, controller, cancellations: () => cancellations };
}
function rejected(bundle, code) {
  const result = bundle.getSnapshot();
  assert.equal(result.status, "rejected");
  assert.equal(result.fault.code, code);
  assert.equal(result.authorization, false);
  assert.ok(
    result.artifacts.every(
      (s) =>
        s.status === "closed" && s.binding === null && s.received_bytes === 0,
    ),
  );
  assert.ok(result.producers.every((p) => p.status === "closed"));
  assert.throws(() => bundle.takeAll(), /not available/);
  return result;
}
function closed(bundle) {
  const result = bundle.getSnapshot();
  assert.equal(result.status, "closed");
  assert.equal(result.consumer, null);
  assert.equal(result.declared_bytes, 0);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.producers, []);
  assert.throws(() => bundle.takeAll(), /not available/);
}

test("bundle: public constructor is inert and complete snapshot has no bytes or authority", () => {
  const bundle = make();
  const s = bundle.getSnapshot();
  assert.equal(s.status, "idle");
  assert.equal(s.scope, "all_declared_input_artifacts");
  assert.equal(s.authorization, false);
  for (const item of [
    s,
    s.consumer,
    s.producers,
    s.producers[0],
    s.artifacts,
    s.artifacts[0].binding.artifact.ref,
  ])
    assert.ok(Object.isFrozen(item));
  for (const method of [
    "fetch",
    "start",
    "retry",
    "takeBytes",
    "acceptObservation",
  ])
    assert.equal(bundle[method], undefined);
  assert.equal(JSON.stringify(s).includes("input-0-0"), false);
  bundle.close();
});
test("bundle: all inputs transfer once in consumer order with original unverified receipts", async () => {
  const { bundle, data } = await ready();
  const result = bundle.takeAll();
  assert.equal(result.authorization, false);
  assert.equal(result.scope, "all_declared_input_artifacts");
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.artifacts));
  assert.deepEqual(
    result.artifacts.map((entry) => entry.binding.artifact.ref),
    data.consumer.input_artifacts,
  );
  for (const entry of result.artifacts) {
    assert.deepEqual(
      entry.bytes,
      data.payloads.get(entry.binding.artifact.ref.artifact_id),
    );
    assert.equal(hash(entry.bytes), entry.binding.artifact.ref.sha256);
    assert.equal(entry.binding.artifact.verification, "unverified");
    assert.equal(entry.producer_report.trust, "reported_not_authenticated");
    assert.equal(entry.integrity, "sha256_and_length_match");
  }
  assert.equal(bundle.getSnapshot().status, "taken");
  assert.throws(() => bundle.takeAll(), /not available/);
  bundle.close();
  assert.deepEqual(
    result.artifacts[0].bytes,
    data.payloads.get(data.consumer.input_artifacts[0].artifact_id),
  );
});
test("bundle: one producer with several artifacts requires just one event stream", async () => {
  const data = fixture([3]);
  const { bundle } = await ready(data);
  const result = bundle.takeAll();
  assert.equal(result.artifacts.length, 3);
  assert.ok(
    result.artifacts.every((entry) => entry.producer_report.event_count === 5),
  );
  assert.equal(bundle.getSnapshot().producers.length, 1);
});
test("bundle: empty input set yields only an empty bundle after explicit begin", () => {
  const data = fixture([]);
  const bundle = make(data);
  assert.throws(() => bundle.takeAll(), /not available/);
  assert.equal(bundle.begin().status, "ready");
  assert.deepEqual(bundle.takeAll(), {
    authorization: false,
    scope: "all_declared_input_artifacts",
    artifacts: [],
  });
  data.consumer.org_id = "invalid";
  assert.throws(() => make(data));
});
test("bundle: constructor snapshots inputs and wrapper arrays synchronously", async () => {
  const data = fixture();
  const saved = fixture();
  const bundle = make(data);
  data.consumer.input_artifacts.length = 0;
  data.plans[0].request.run_id = handoffId(999);
  data.plans[0].manifest.artifacts[0].ref.sha256 = "0".repeat(64);
  data.plans.length = 0;
  bundle.begin();
  for (let p = 0; p < saved.plans.length; p++)
    await bundle.observeProducer(
      saved.plans[p].manifest.manifest_id,
      wire(saved.events(p)),
    );
  for (const [id, bytes] of saved.payloads)
    await bundle.readArtifact(id, stream(bytes));
  assert.equal(bundle.takeAll().artifacts.length, 3);
});
for (const kind of [
  "missing",
  "unused",
  "duplicate_manifest",
  "duplicate_stream",
  "revision",
  "digest",
  "attempt",
  "org",
  "evidence",
  "duplicate_input",
]) {
  test(`bundle: rejects invalid exact coverage ${kind}`, () => {
    const data = fixture();
    if (kind === "missing") data.plans.pop();
    if (kind === "unused") data.consumer.input_artifacts.shift();
    if (kind === "duplicate_manifest")
      data.plans[1].manifest.manifest_id = data.plans[0].manifest.manifest_id;
    if (kind === "duplicate_stream") {
      const extra = structuredClone(data.plans[0]);
      extra.manifest.manifest_id = handoffId(500);
      data.plans.push(extra);
    }
    if (kind === "revision") data.consumer.input_artifacts[0].revision++;
    if (kind === "digest")
      data.consumer.input_artifacts[0].sha256 = "1".repeat(64);
    if (kind === "attempt")
      data.consumer.input_artifacts[0].producer.attempt_id = handoffId(777);
    if (kind === "org") data.consumer.org_id = handoffId(888);
    if (kind === "evidence") {
      data.plans[0].request.execution_kind = "provider";
      data.plans[0].manifest.evidence_kind = "adapter_report";
    }
    if (kind === "duplicate_input")
      data.consumer.input_artifacts.push(
        structuredClone(data.consumer.input_artifacts[0]),
      );
    assert.throws(() => make(data));
  });
}
for (const kind of [
  "array_getter",
  "array_hole",
  "array_extra",
  "array_symbol",
  "wrapper_getter",
  "wrapper_hidden",
  "wrapper_extra",
  "nested_getter",
]) {
  test(`bundle: rejects ${kind} without evaluating a getter`, () => {
    const data = fixture();
    let called = 0;
    const get = () => {
      called++;
      throw new Error("private-getter");
    };
    if (kind === "array_getter")
      Object.defineProperty(data.plans, "0", { get, enumerable: true });
    if (kind === "array_hole") delete data.plans[0];
    if (kind === "array_extra") data.plans.extra = true;
    if (kind === "array_symbol") data.plans[Symbol("extra")] = true;
    if (kind === "wrapper_getter")
      Object.defineProperty(data.plans[0], "request", {
        get,
        enumerable: true,
      });
    if (kind === "wrapper_hidden")
      Object.defineProperty(data.plans[0], "request", { enumerable: false });
    if (kind === "wrapper_extra") data.plans[0].approved = true;
    if (kind === "nested_getter")
      Object.defineProperty(data.plans[0].manifest, "manifest_id", {
        get,
        enumerable: true,
      });
    assert.throws(() => make(data));
    assert.equal(called, 0);
  });
}
for (const key of ["max_inputs", "max_producers", "max_total_bytes"]) {
  for (const value of [
    0,
    -1,
    1.5,
    Number.NaN,
    RUNTIME_INPUT_BUNDLE_LIMITS[key] + 1,
  ]) {
    test(`bundle: ${key} rejects limit ${value}`, () => {
      assert.throws(
        () => make(fixture(), { ...RUNTIME_INPUT_BUNDLE_LIMITS, [key]: value }),
        /Invalid runtime input bundle/,
      );
    });
  }
}
test("bundle: limit getter and unexpected limit properties are rejected", () => {
  let called = 0;
  const budget = { ...RUNTIME_INPUT_BUNDLE_LIMITS };
  Object.defineProperty(budget, "max_total_bytes", {
    enumerable: true,
    get() {
      called++;
      return 1;
    },
  });
  assert.throws(() => make(fixture(), budget));
  assert.equal(called, 0);
  assert.throws(() =>
    make(fixture(), { ...RUNTIME_INPUT_BUNDLE_LIMITS, extra: true }),
  );
});
test("bundle: default input and producer count boundaries are exact", () => {
  make(fixture([16])).close();
  assert.throws(() => make(fixture([17])));
  make(fixture(Array(8).fill(1))).close();
  assert.throws(() => make(fixture(Array(9).fill(1))));
});
test("bundle: declared total reaches 16MiB but one extra byte is refused", () => {
  const data = fixture([5]);
  const sizes = [4194304, 4194304, 4194304, 4194303, 1];
  data.plans[0].manifest.artifacts.forEach((entry, i) => {
    entry.size_bytes = sizes[i];
  });
  const bundle = make(data);
  assert.equal(bundle.getSnapshot().declared_bytes, 16777216);
  bundle.close();
  data.plans[0].manifest.artifacts[4].size_bytes++;
  assert.throws(() => make(data), /Invalid runtime input bundle/);
});
test("bundle: per-input original byte ceiling remains enforced", () => {
  const data = fixture([1]);
  data.plans[0].manifest.artifacts[0].size_bytes = 4194305;
  assert.throws(() => make(data), /Invalid runtime input artifact/);
});
test("bundle: lowered total byte budget is enforced on actual successful handoff", async () => {
  const data = fixture([1, 1]);
  const total = [...data.payloads.values()].reduce(
    (sum, bytes) => sum + bytes.length,
    0,
  );
  const limits = { max_inputs: 2, max_producers: 2, max_total_bytes: total };
  const bundle = make(data, limits);
  limits.max_total_bytes = 1;
  bundle.begin();
  for (let i = 0; i < 2; i++)
    await bundle.observeProducer(
      data.plans[i].manifest.manifest_id,
      wire(data.events(i)),
    );
  for (const [id, bytes] of data.payloads)
    await bundle.readArtifact(id, stream(bytes));
  assert.equal(
    bundle.takeAll().artifacts.reduce((n, a) => n + a.bytes.length, 0),
    total,
  );
  assert.throws(() =>
    make(data, { max_inputs: 2, max_producers: 2, max_total_bytes: total - 1 }),
  );
});
test("bundle: unrelated extra manifest artifacts must still appear in producer report", async () => {
  const data = fixture([2]);
  data.consumer.input_artifacts.pop();
  data.payloads.delete(data.plans[0].manifest.artifacts[0].ref.artifact_id);
  const { bundle } = await ready(data);
  assert.equal(bundle.takeAll().artifacts.length, 1);
  const broken = make(data);
  broken.begin();
  const events = data.events(0);
  events.splice(1, 1);
  events.forEach((e, i) => {
    e.sequence = String(i + 1);
  });
  await broken.observeProducer(
    data.plans[0].manifest.manifest_id,
    wire(events),
  );
  rejected(broken, "producer_rejected");
});
test("bundle: all reports must reach EOF before any artifact read is admitted", async () => {
  const data = fixture([1, 1]);
  const bundle = make(data);
  bundle.begin();
  await bundle.observeProducer(
    data.plans[0].manifest.manifest_id,
    wire(data.events(0)),
  );
  const pendingSource = held();
  pendingSource.controller.enqueue(
    encode(
      data
        .events(1)
        .map((e) => JSON.stringify(e) + "\n")
        .join(""),
    ),
  );
  const pending = bundle.observeProducer(
    data.plans[1].manifest.manifest_id,
    pendingSource.source,
  );
  await tick();
  const [id, bytes] = [...data.payloads][0];
  const unused = stream(bytes);
  await assert.rejects(bundle.readArtifact(id, unused), /not awaiting/);
  assert.equal(unused.locked, false);
  assert.throws(() => bundle.takeAll(), /not available/);
  pendingSource.controller.close();
  await pending;
  assert.equal(bundle.getSnapshot().status, "awaiting_artifacts");
  bundle.close();
});
for (const order of [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]) {
  test(`bundle: parallel artifact completion ${order.join("")} preserves consumer order`, async () => {
    const { bundle, data } = await observed();
    const values = [...data.payloads];
    const sources = values.map(() => held());
    const pending = values.map(([id], i) =>
      bundle.readArtifact(id, sources[i].source),
    );
    for (const index of order) {
      sources[index].controller.enqueue(values[index][1]);
      sources[index].controller.close();
      await pending[index];
      if (index !== order[2])
        assert.throws(() => bundle.takeAll(), /not available/);
    }
    assert.ok(sources.every((s) => !s.source.locked));
    assert.deepEqual(
      bundle
        .takeAll()
        .artifacts.map((entry) => entry.binding.artifact.ref.artifact_id),
      data.consumer.input_artifacts.map((ref) => ref.artifact_id),
    );
  });
}
test("bundle: wrong stage, unknown IDs and duplicate calls never acquire replacement streams", async () => {
  const data = fixture([1, 1]);
  const bundle = make(data);
  const unused = stream(encode("unused"));
  await assert.rejects(
    bundle.observeProducer(data.plans[0].manifest.manifest_id, unused),
    /not awaiting/,
  );
  await assert.rejects(
    bundle.readArtifact(data.consumer.input_artifacts[0].artifact_id, unused),
    /not awaiting/,
  );
  bundle.begin();
  assert.throws(() => bundle.begin(), /already begun/);
  await assert.rejects(
    bundle.observeProducer(handoffId(555), unused),
    /not awaiting/,
  );
  const blocked = held();
  const pending = bundle.observeProducer(
    data.plans[0].manifest.manifest_id,
    blocked.source,
  );
  await assert.rejects(
    bundle.observeProducer(data.plans[0].manifest.manifest_id, unused),
    /not awaiting/,
  );
  assert.equal(unused.locked, false);
  bundle.close();
  await pending;
  assert.equal(blocked.source.locked, false);
});
test("bundle: duplicate artifact reads while pending or matched never replace bytes", async () => {
  const { bundle, data } = await observed();
  const [id, bytes] = [...data.payloads][0];
  const unused = stream(encode("unused"));
  const source = held();
  const pending = bundle.readArtifact(id, source.source);
  await assert.rejects(bundle.readArtifact(id, unused), /not awaiting/);
  source.controller.enqueue(bytes);
  source.controller.close();
  await pending;
  await assert.rejects(bundle.readArtifact(id, unused), /not awaiting/);
  await assert.rejects(
    bundle.readArtifact(handoffId(999), unused),
    /not awaiting/,
  );
  assert.equal(unused.locked, false);
  bundle.close();
});
for (const mode of [
  "wrong_manifest",
  "missing_success",
  "gap",
  "cross_attempt",
  "bad_tail",
]) {
  test(`bundle: ${mode} aborts other producer observations and prevents byte acquisition`, async () => {
    const data = fixture([1, 1]);
    const bundle = make(data);
    bundle.begin();
    const blocked = held();
    const waiting = bundle.observeProducer(
      data.plans[1].manifest.manifest_id,
      blocked.source,
    );
    const events = data.events(0);
    if (mode === "wrong_manifest")
      events.at(-1).payload.manifest_id = handoffId(999);
    if (mode === "missing_success") events.pop();
    if (mode === "gap") events.splice(1, 1);
    if (mode === "cross_attempt") events[0].attempt_id = handoffId(999);
    const source =
      mode === "bad_tail"
        ? stream(
            encode(
              events.map((e) => JSON.stringify(e) + "\n").join("") + "bad",
            ),
          )
        : wire(events);
    await bundle.observeProducer(data.plans[0].manifest.manifest_id, source);
    await waiting;
    rejected(bundle, "producer_rejected");
    assert.equal(blocked.cancellations(), 1);
    assert.equal(blocked.source.locked, false);
    const unused = stream(encode("unused"));
    await bundle.readArtifact(
      data.consumer.input_artifacts[0].artifact_id,
      unused,
    );
    assert.equal(unused.locked, false);
  });
}
for (const mode of [
  "corrupt",
  "truncated",
  "oversize",
  "source_error",
  "digest_error",
]) {
  test(`bundle: ${mode} wipes a matched sibling and cancels pending sibling`, async (t) => {
    const { bundle, data } = await observed(fixture([3]));
    const values = [...data.payloads];
    const captured = [];
    const native = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    t.mock.method(globalThis.crypto.subtle, "digest", (algorithm, buffer) => {
      captured.push(new Uint8Array(buffer));
      return native(algorithm, buffer);
    });
    await bundle.readArtifact(values[0][0], stream(values[0][1]));
    assert.ok(captured[0].some((v) => v !== 0));
    const blocked = held("reject");
    blocked.controller.enqueue(values[2][1].subarray(0, 2));
    const pending = bundle.readArtifact(values[2][0], blocked.source);
    let bytes = values[1][1].slice();
    let source;
    if (mode === "corrupt") bytes[0] ^= 1;
    if (mode === "truncated") bytes = bytes.subarray(1);
    if (mode === "oversize") bytes = new Uint8Array(bytes.length + 1);
    if (mode === "source_error")
      source = new ReadableStream({
        start(c) {
          c.error(new Error("private-source-error"));
        },
      });
    if (mode === "digest_error")
      t.mock.method(globalThis.crypto.subtle, "digest", () =>
        Promise.reject(new Error("private-digest-error")),
      );
    await bundle.readArtifact(values[1][0], source ?? stream(bytes));
    await pending;
    const result = rejected(bundle, "artifact_rejected");
    assert.ok(captured[0].every((v) => v === 0));
    assert.equal(blocked.cancellations(), 1);
    assert.equal(blocked.source.locked, false);
    assert.equal(JSON.stringify(result).includes("private-"), false);
  });
}
for (const phase of [
  "idle",
  "awaiting_producers",
  "observing",
  "awaiting_artifacts",
  "reading_artifacts",
  "ready",
]) {
  test(`bundle: lifetime abort clears ${phase} without waiting for source cancellation`, async () => {
    const data = fixture();
    const bundle = make(data);
    const abort = new AbortController();
    let source;
    let pending;
    if (phase === "idle") {
      abort.abort("private-reason");
      bundle.begin(abort.signal);
    } else {
      bundle.begin(abort.signal);
      if (phase === "observing") {
        source = held();
        pending = bundle.observeProducer(
          data.plans[0].manifest.manifest_id,
          source.source,
        );
      }
      if (
        ["awaiting_artifacts", "reading_artifacts", "ready"].includes(phase)
      ) {
        for (let p = 0; p < data.plans.length; p++)
          await bundle.observeProducer(
            data.plans[p].manifest.manifest_id,
            wire(data.events(p)),
          );
        if (phase === "reading_artifacts") {
          source = held();
          pending = bundle.readArtifact(
            data.consumer.input_artifacts[0].artifact_id,
            source.source,
          );
        }
        if (phase === "ready")
          for (const [id, bytes] of data.payloads)
            await bundle.readArtifact(id, stream(bytes));
      }
      abort.abort("private-reason");
    }
    closed(bundle);
    if (pending) await pending;
    if (source) {
      assert.equal(source.source.locked, false);
      assert.equal(source.cancellations(), 1);
    }
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error("must not inspect source");
        },
      },
    );
    await bundle.observeProducer("ignored", forbidden);
    await bundle.readArtifact("ignored", forbidden);
    closed(bundle);
  });
}
for (const ending of ["abort", "sibling_failure"]) {
  test(`bundle: ${ending} during native digest blocks a late successful digest`, async (t) => {
    const abort = new AbortController();
    const { bundle, data } = await observed(fixture([2]), abort.signal);
    const values = [...data.payloads];
    const native = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let finish;
    let owned;
    let result;
    t.mock.method(globalThis.crypto.subtle, "digest", (algorithm, buffer) => {
      owned = new Uint8Array(buffer);
      result = native(algorithm, buffer);
      return new Promise((resolve) => {
        finish = () => resolve(result);
      });
    });
    const pending = bundle.readArtifact(values[0][0], stream(values[0][1]));
    while (!finish) await tick();
    if (ending === "abort") abort.abort();
    else await bundle.readArtifact(values[1][0], stream(new Uint8Array(0)));
    await pending;
    assert.ok(owned.every((value) => value === 0));
    finish();
    await result;
    await tick();
    if (ending === "abort") closed(bundle);
    else rejected(bundle, "artifact_rejected");
  });
}
test("bundle: Abort listener removed on rejection, close and successful take", async () => {
  for (const ending of ["reject", "close", "take"]) {
    const abort = new AbortController();
    const data = fixture([1]);
    const bundle = make(data);
    let balance = 0;
    const add = abort.signal.addEventListener.bind(abort.signal);
    const remove = abort.signal.removeEventListener.bind(abort.signal);
    abort.signal.addEventListener = (...args) => {
      balance++;
      return add(...args);
    };
    abort.signal.removeEventListener = (...args) => {
      balance--;
      return remove(...args);
    };
    bundle.begin(abort.signal);
    assert.equal(balance, 1);
    if (ending === "close") bundle.close();
    else if (ending === "reject")
      await bundle.observeProducer(
        data.plans[0].manifest.manifest_id,
        wire([]),
      );
    else {
      await bundle.observeProducer(
        data.plans[0].manifest.manifest_id,
        wire(data.events(0)),
      );
      const [id, bytes] = [...data.payloads][0];
      await bundle.readArtifact(id, stream(bytes));
      bundle.takeAll();
      abort.abort();
      assert.equal(bundle.getSnapshot().status, "taken");
    }
    assert.equal(balance, 0);
  }
});
test("bundle: no implicit fetch during construction or any preparation stage", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("implicit fetch forbidden");
  });
  const { bundle } = await ready();
  assert.equal(bundle.takeAll().artifacts.length, 3);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

for (const mode of ["success", "bad_producer", "corrupt_bytes"]) {
  test(
    `bundle HTTP: two real loopback producers ${mode}, no partial consumer handoff`,
    { timeout: 10000 },
    async (t) => {
      const data = fixture([2, 1]);
      const counts = { events: [0, 0], bytes: 0 };
      const servers = [];
      t.after(async () => {
        for (const server of servers) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      });
      for (let p = 0; p < 2; p++) {
        const server = createServer((request, response) => {
          if (request.url === "/events") {
            counts.events[p]++;
            const events = data.events(p);
            if (mode === "bad_producer" && p === 1) events.pop();
            response.writeHead(200, { "Content-Type": "application/x-ndjson" });
            for (const event of events)
              response.write(JSON.stringify(event) + "\n");
            response.end();
          } else {
            const id = request.url.slice(1);
            const bytes = data.payloads.get(id)?.slice();
            if (
              !bytes ||
              !data.plans[p].manifest.artifacts.some(
                (a) => a.ref.artifact_id === id,
              )
            ) {
              response.writeHead(404);
              response.end();
              return;
            }
            counts.bytes++;
            if (mode === "corrupt_bytes" && p === 1) bytes[0] ^= 1;
            response.writeHead(200, {
              "Content-Type": "application/octet-stream",
            });
            response.write(bytes.subarray(0, 2));
            response.end(bytes.subarray(2));
          }
        });
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
      }
      const origins = servers.map(
        (server) => `http://127.0.0.1:${server.address().port}`,
      );
      const bundle = make(data);
      bundle.begin();
      const bodies = [];
      await Promise.all(
        origins.map(async (origin, p) => {
          const response = await fetch(origin + "/events", {
            redirect: "error",
          });
          assert.equal(response.status, 200);
          bodies.push(response.body);
          await bundle.observeProducer(
            data.plans[p].manifest.manifest_id,
            response.body,
          );
        }),
      );
      let consumerCalls = 0;
      if (bundle.getSnapshot().status === "awaiting_artifacts") {
        // First producer's two inputs finish before the second producer's data is offered.
        for (let p = 0; p < 2; p++)
          for (const item of data.plans[p].manifest.artifacts) {
            const response = await fetch(
              origins[p] + "/" + item.ref.artifact_id,
              { redirect: "error" },
            );
            assert.equal(response.status, 200);
            bodies.push(response.body);
            await bundle.readArtifact(item.ref.artifact_id, response.body);
            if (p === 0) assert.throws(() => bundle.takeAll(), /not available/);
          }
      }
      if (bundle.getSnapshot().status === "ready") {
        const received = bundle.takeAll();
        consumerCalls++;
        assert.equal(received.artifacts.length, 3);
        assert.deepEqual(
          received.artifacts.map((item) => hash(item.bytes)),
          data.consumer.input_artifacts.map((ref) => ref.sha256),
        );
        assert.deepEqual(
          received.artifacts.map((item) => [...item.bytes]),
          data.consumer.input_artifacts.map((ref) => [
            ...data.payloads.get(ref.artifact_id),
          ]),
        );
      }
      assert.deepEqual(counts.events, [1, 1]);
      assert.ok(bodies.every((body) => !body.locked));
      assert.equal(consumerCalls, mode === "success" ? 1 : 0);
      assert.equal(counts.bytes, mode === "bad_producer" ? 0 : 3);
      if (mode !== "success")
        rejected(
          bundle,
          mode === "bad_producer" ? "producer_rejected" : "artifact_rejected",
        );
      bundle.close();
    },
  );
}
