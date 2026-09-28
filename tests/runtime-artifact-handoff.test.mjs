import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { RuntimeArtifactHandoff } from "../packages/client/dist/index.js";
import { handoffFixture, handoffId } from "./fixtures/runtime-handoff-data.mjs";

const encode = (text) => new TextEncoder().encode(text);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function stream(chunks, hooks = {}) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    ...hooks,
  }, { highWaterMark: 0 });
}
const wire = (events, tail = "") =>
  stream([encode(events.map((event) => JSON.stringify(event) + "\n").join("") + tail)]);
const make = (data = handoffFixture()) =>
  new RuntimeArtifactHandoff(data.producer, data.consumer, data.manifest, data.id);
function denied(handoff, result, fault) {
  assert.equal(result.status, "rejected");
  assert.equal(result.fault, fault);
  assert.equal(result.authorization, false);
  assert.throws(() => handoff.takeBytes(), /not available/);
}
async function observed(data = handoffFixture(), signal) {
  const handoff = make(data);
  const source = wire(data.events);
  const result = await handoff.observe(source, signal);
  assert.equal(source.locked, false);
  return { handoff, result, data };
}
async function ready(data = handoffFixture(), signal) {
  const { handoff } = await observed(data, signal);
  const source = stream([data.bytes]);
  assert.equal((await handoff.readArtifact(source)).status, "ready");
  assert.equal(source.locked, false);
  return { handoff, data };
}

test("handoff: public constructor is inert and snapshots are deeply frozen", () => {
  const handoff = make();
  const snapshot = handoff.getSnapshot();
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.authorization, false);
  assert.equal(snapshot.scope, "one_selected_artifact");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.binding.artifact.ref.producer));
  assert.equal(Object.hasOwn(snapshot, "bytes"), false);
  for (const name of ["fetch", "start", "stop", "retry", "acceptObservation"])
    assert.equal(handoff[name], undefined);
});
test("handoff: full stream and exact manifest precede real byte integrity and single take", async () => {
  const { handoff, data } = await ready();
  const delivery = handoff.takeBytes();
  assert.deepEqual(delivery.bytes, data.bytes);
  assert.equal(delivery.integrity, "sha256_and_length_match");
  assert.equal(delivery.authorization, false);
  assert.equal(delivery.binding.artifact.verification, "unverified");
  assert.equal(delivery.producer_report.trust, "reported_not_authenticated");
  assert.equal(delivery.producer_report.last_sequence, "3");
  assert.equal(delivery.producer_report.event_count, 3);
  assert.ok(Object.isFrozen(delivery.producer_report));
  assert.equal(handoff.getSnapshot().status, "taken");
  assert.equal(handoff.getSnapshot().artifact.status, "taken");
  assert.throws(() => handoff.takeBytes(), /not available/);
  handoff.close();
  assert.deepEqual(delivery.bytes, data.bytes);
});
test("handoff: reported success without response EOF does not open byte stage", async () => {
  const data = handoffFixture();
  const handoff = make(data);
  const source = stream([encode(data.events.map((e) => JSON.stringify(e) + "\n").join(""))], {
    pull(controller) {
      if (!this.sent) { this.sent = true; controller.enqueue(encode(data.events.map((e) => JSON.stringify(e) + "\n").join(""))); }
    },
  });
  const pending = handoff.observe(source);
  await tick();
  assert.equal(handoff.getSnapshot().producer.observation.reported_state, "succeeded");
  assert.equal(handoff.getSnapshot().status, "observing");
  const untouched = stream([data.bytes]);
  await assert.rejects(handoff.readArtifact(untouched), /not awaiting/);
  assert.equal(untouched.locked, false);
  handoff.close();
  assert.equal((await pending).status, "closed");
  assert.equal(source.locked, false);
});
for (const type of ["run.failed", "run.cancelled", "run.unknown"]) {
  test(`handoff: ${type} never releases artifact bytes`, async () => {
    const data = handoffFixture();
    data.events[2] = data.event(type, 3);
    if (type === "run.cancelled") {
      data.events[2] = data.event("run.stop_requested", 3);
      data.events.push(data.event("run.cancelled", 4));
    }
    const { handoff, result } = await observed(data);
    denied(handoff, result, type === "run.unknown" ? "producer_stream_rejected" : "producer_not_succeeded");
  });
}
for (const [name, change] of [
  ["early EOF", (d) => d.events.pop()],
  ["unsolicited cancellation", (d) => { d.events[2] = d.event("run.cancelled", 3); }],
  ["sequence gap", (d) => d.events.splice(1, 1)],
  ["same event ID with different content", (d) => { d.events[2].event_id = d.events[1].event_id; }],
  ["wrong stream attempt", (d) => { d.events[0].attempt_id = handoffId(333); }],
]) {
  test(`handoff: rejects producer ${name}`, async () => {
    const data = handoffFixture();
    change(data);
    const { handoff, result } = await observed(data);
    denied(handoff, result, "producer_stream_rejected");
  });
}
for (const tail of ['{"truncated":', "bad\n", "\n"]) {
  test(`handoff: bad tail ${JSON.stringify(tail)} overrides an earlier success report`, async () => {
    const data = handoffFixture();
    const handoff = make(data);
    denied(handoff, await handoff.observe(wire(data.events, tail)), "producer_stream_rejected");
  });
}
test("handoff: exact event replay is accepted without double observation", async () => {
  const data = handoffFixture();
  data.events.splice(1, 0, structuredClone(data.events[0]));
  const { handoff, result } = await observed(data);
  assert.equal(result.status, "awaiting_bytes");
  assert.equal(result.producer.duplicate_events, 1);
  assert.equal(result.producer.observation.event_count, 3);
  handoff.close();
});
test("handoff: success naming another manifest is rejected", async () => {
  const data = handoffFixture();
  data.events[2].payload.manifest_id = handoffId(456);
  const { handoff, result } = await observed(data);
  denied(handoff, result, "manifest_mismatch");
});
for (const [name, change] of [
  ["not observed", (d) => { d.events = [d.events[0], d.event("run.succeeded", 2)]; }],
  ["different hash", (d) => { d.events[1].payload.artifact.sha256 = "0".repeat(64); }],
  ["different revision", (d) => { d.events[1].payload.artifact.revision++; }],
  ["different ID", (d) => { d.events[1].payload.artifact.artifact_id = handoffId(789); }],
  ["unreported manifest entry", (d) => { const extra = structuredClone(d.manifest.artifacts[0]); extra.ref.artifact_id = handoffId(789); d.manifest.artifacts.push(extra); }],
  ["omitted observed entry", (d) => { const extra = structuredClone(d.events[1].payload.artifact); extra.artifact_id = handoffId(789); d.events[2] = d.event("artifact.produced", 3, { artifact: extra }); d.events.push(d.event("run.succeeded", 4)); }],
]) {
  test(`handoff: exact produced set rejects ${name}`, async () => {
    const data = handoffFixture();
    change(data);
    const { handoff, result } = await observed(data);
    denied(handoff, result, "artifact_set_mismatch");
  });
}
test("handoff: manifest order is irrelevant but only selected input bytes are checked", async () => {
  const data = handoffFixture();
  const extra = structuredClone(data.manifest.artifacts[0]);
  extra.ref.artifact_id = handoffId(789);
  data.manifest.artifacts.unshift(extra);
  data.consumer.input_artifacts.push(structuredClone(extra.ref));
  data.events[2] = data.event("artifact.produced", 3, { artifact: extra.ref });
  data.events.push(data.event("run.succeeded", 4));
  const { handoff } = await ready(data);
  assert.equal(handoff.getSnapshot().scope, "one_selected_artifact");
  assert.equal(handoff.takeBytes().binding.artifact.ref.artifact_id, data.id);
});
for (const key of ["org_id", "run_id", "attempt_id"]) {
  test(`handoff: producer manifest mismatch ${key} is rejected before acquiring sources`, () => {
    const data = handoffFixture();
    data.producer[key] = handoffId(345);
    assert.throws(() => make(data), TypeError);
  });
}
for (const [name, change] of [
  ["consumer organization", (d) => { d.consumer.org_id = handoffId(3); }],
  ["consumer source kind", (d) => { d.consumer.execution_kind = "provider"; }],
  ["producer source kind", (d) => { d.producer.execution_kind = "provider"; }],
  ["consumer revision", (d) => { d.consumer.input_artifacts[0].revision++; }],
  ["consumer hash", (d) => { d.consumer.input_artifacts[0].sha256 = "0".repeat(64); }],
  ["consumer producer attempt", (d) => { d.consumer.input_artifacts[0].producer.attempt_id = handoffId(6); }],
  ["missing selected input", (d) => { d.consumer.input_artifacts = []; }],
  ["unknown artifact ID", (d) => { d.id = handoffId(7); }],
  ["larger than inherited byte cap", (d) => { d.manifest.artifacts[0].size_bytes = 4194305; }],
]) {
  test(`handoff: construction rejects ${name}`, () => {
    const data = handoffFixture();
    change(data);
    assert.throws(() => make(data), TypeError);
  });
}
test("handoff: public protocol snapshots do not execute getter inputs", () => {
  const data = handoffFixture();
  let calls = 0;
  Object.defineProperty(data.manifest, "manifest_id", { enumerable: true, get() { calls++; return "secret"; } });
  assert.throws(() => make(data), TypeError);
  assert.equal(calls, 0);
});
test("handoff: constructor snapshots survive caller mutations", async () => {
  const data = handoffFixture();
  const handoff = make(data);
  data.producer.run_id = handoffId(3);
  data.consumer.input_artifacts[0].sha256 = "0".repeat(64);
  data.manifest.manifest_id = handoffId(4);
  assert.equal((await handoff.observe(wire(data.events))).status, "awaiting_bytes");
  assert.equal((await handoff.readArtifact(stream([data.bytes]))).status, "ready");
  assert.deepEqual(handoff.takeBytes().bytes, data.bytes);
});
test("handoff: provider-labelled declarations never become authentication or authorization", async () => {
  const data = handoffFixture();
  data.producer.execution_kind = "provider";
  data.consumer.execution_kind = "provider";
  data.manifest.evidence_kind = "adapter_report";
  for (const event of data.events) event.evidence_kind = "adapter_report";
  const { handoff } = await ready(data);
  const delivery = handoff.takeBytes();
  assert.equal(delivery.authorization, false);
  assert.equal(delivery.producer_report.trust, "reported_not_authenticated");
  assert.equal(delivery.binding.artifact.verification, "unverified");
});
for (const [name, chunks] of [
  ["truncated", (d) => [d.bytes.subarray(0, 1)]],
  ["extra", (d) => [d.bytes, new Uint8Array([1])]],
  ["same length damaged", (d) => [new Uint8Array(d.bytes.length)]],
]) {
  test(`handoff: artifact ${name} cannot be taken`, async () => {
    const { handoff, data } = await observed();
    denied(handoff, await handoff.readArtifact(stream(chunks(data))), "artifact_rejected");
    await assert.rejects(handoff.readArtifact(stream([data.bytes])), /not awaiting/);
  });
}
test("handoff: source error is redacted and leaves no deliverable partial bytes", async () => {
  const { handoff } = await observed();
  const result = await handoff.readArtifact(stream([], { pull(controller) { controller.error(new Error("private-data")); } }));
  denied(handoff, result, "artifact_rejected");
  assert.equal(result.artifact.fault, "transport_lost");
  assert.equal(JSON.stringify(result).includes("private-data"), false);
});
test("handoff: calls out of order or twice do not touch replacement sources", async () => {
  const handoff = make();
  const untouched = stream([]);
  await assert.rejects(handoff.readArtifact(untouched), /not awaiting/);
  assert.equal(untouched.locked, false);
  assert.throws(() => handoff.takeBytes(), /not available/);
  await handoff.observe(wire(handoffFixture().events));
  await assert.rejects(handoff.observe(untouched), /already consumed/);
  assert.equal(untouched.locked, false);
  const source = stream([], { pull() {} });
  const pending = handoff.readArtifact(source);
  await assert.rejects(handoff.readArtifact(untouched), /not awaiting/);
  assert.equal(untouched.locked, false);
  handoff.close();
  await pending;
  assert.equal(source.locked, false);
});
test("handoff: pre-abort and closed calls never acquire or inspect a source", async () => {
  const handoff = make();
  const abort = new AbortController();
  abort.abort("private-data");
  const source = new Proxy({}, { get() { throw new Error("source must not be read"); } });
  assert.equal((await handoff.observe(source, abort.signal)).status, "closed");
  assert.equal((await handoff.readArtifact(source)).status, "closed");
  assert.equal((await handoff.observe(source)).status, "closed");
  assert.equal(handoff.getSnapshot().binding, null);
});
for (const phase of ["observing", "awaiting_bytes", "reading_bytes", "ready"]) {
  test(`handoff: shared abort clears ${phase} and remains effective across stage gaps`, async () => {
    const data = handoffFixture();
    const handoff = make(data);
    const abort = new AbortController();
    let pending;
    let source;
    if (phase === "observing") {
      source = stream([], { pull() {}, cancel() { return new Promise(() => {}); } });
      pending = handoff.observe(source, abort.signal);
    } else {
      await handoff.observe(wire(data.events), abort.signal);
      if (phase === "reading_bytes") {
        source = stream([], { pull() {}, cancel() { return new Promise(() => {}); } });
        pending = handoff.readArtifact(source);
      } else if (phase === "ready") {
        await handoff.readArtifact(stream([data.bytes]));
      }
    }
    assert.equal(handoff.getSnapshot().status, phase);
    abort.abort("private-data");
    assert.equal(handoff.getSnapshot().status, "closed");
    if (pending) assert.equal((await pending).status, "closed");
    if (source) assert.equal(source.locked, false);
    const result = handoff.getSnapshot();
    assert.equal(result.binding, null);
    assert.equal(result.producer.observation.stream, null);
    assert.equal(result.artifact.binding, null);
    assert.throws(() => handoff.takeBytes(), /not available/);
  });
}
test("handoff: cancellation during digest cannot be undone by late crypto completion", async () => {
  const original = crypto.subtle.digest;
  let resolveDigest;
  crypto.subtle.digest = () => new Promise((resolve) => { resolveDigest = resolve; });
  try {
    const abort = new AbortController();
    const { handoff, data } = await observed(handoffFixture(), abort.signal);
    const pending = handoff.readArtifact(stream([data.bytes]));
    await tick();
    assert.equal(handoff.getSnapshot().artifact.status, "checking");
    abort.abort();
    assert.equal((await pending).status, "closed");
    resolveDigest(new Uint8Array(32).buffer);
    await tick();
    assert.equal(handoff.getSnapshot().status, "closed");
    assert.throws(() => handoff.takeBytes(), /not available/);
  } finally { crypto.subtle.digest = original; }
});
test("handoff: take detaches lifetime abort and close cannot erase transferred bytes", async () => {
  const abort = new AbortController();
  const { handoff, data } = await ready(handoffFixture(), abort.signal);
  const delivery = handoff.takeBytes();
  abort.abort();
  assert.equal(handoff.getSnapshot().status, "taken");
  handoff.close();
  assert.deepEqual(delivery.bytes, data.bytes);
});

async function peer(t, mode, scenario = "normal") {
  const child = fork(new URL("./fixtures/runtime-handoff-peer.mjs", import.meta.url), [mode, scenario], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  });
  return child;
}
for (const scenario of ["normal", "corrupt", "no_success", "wrong_manifest"]) {
  test(`handoff: real process/HTTP composition ${scenario}`, { timeout: 15000 }, async (t) => {
    const producer = await peer(t, "producer", scenario);
    const [endpoint] = await once(producer, "message");
    assert.ok(Number.isInteger(endpoint.port) && endpoint.port > 0);
    const base = `http://127.0.0.1:${endpoint.port}`;
    const data = handoffFixture();
    const manifestResponse = await fetch(`${base}/manifest`, { redirect: "error" });
    assert.equal(manifestResponse.status, 200);
    data.manifest = await manifestResponse.json();
    const handoff = make(data);
    t.after(() => handoff.close());
    const response = await fetch(`${base}/events`, { redirect: "error" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    await handoff.observe(response.body);
    let consumerCreated = false;
    if (handoff.getSnapshot().status === "awaiting_bytes") {
      const artifact = await fetch(`${base}/artifact`, { redirect: "error" });
      assert.equal(artifact.status, 200);
      assert.equal(artifact.headers.get("content-type"), "application/octet-stream");
      await handoff.readArtifact(artifact.body);
    }
    if (handoff.getSnapshot().status === "ready") {
      const delivery = handoff.takeBytes();
      const consumer = await peer(t, "consumer");
      consumerCreated = true;
      const reply = once(consumer, "message");
      const exit = once(consumer, "exit");
      consumer.send({ bytes: [...delivery.bytes], expected_sha256: delivery.binding.artifact.ref.sha256 });
      const [result] = await reply;
      assert.equal(result.consumed_sha256, data.manifest.artifacts[0].ref.sha256);
      assert.equal(result.total, 16);
      assert.equal(result.count, 3);
      assert.notEqual(result.pid, endpoint.pid);
      assert.notEqual(result.pid, process.pid);
      assert.deepEqual(await exit, [0, null]);
    }
    const statsReply = once(producer, "message");
    producer.send("stats");
    const [stats] = await statsReply;
    assert.equal(stats.byteRequests, ["normal", "corrupt"].includes(scenario) ? 1 : 0);
    assert.equal(consumerCreated, scenario === "normal");
    assert.equal(handoff.getSnapshot().status, scenario === "normal" ? "taken" : "rejected");
    if (scenario !== "normal") assert.throws(() => handoff.takeBytes(), /not available/);
  });
}
