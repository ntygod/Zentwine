import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  RuntimeInputArtifactReader,
  RUNTIME_INPUT_ARTIFACT_LIMITS,
} from "../packages/client/dist/index.js";
import { fixture } from "./fixtures/runtime-wire-v1.mjs";

const encode = (text) => new TextEncoder().encode(text);
const abc = encode("abc");
const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uid = "10000000-0000-4000-8000-000000000001";
function inputs(bytes = abc, digest = hash(bytes)) {
  const consumer = structuredClone(fixture.start_b);
  const manifest = structuredClone(fixture.manifest_a);
  manifest.artifacts[0].size_bytes = bytes.length;
  manifest.artifacts[0].ref.sha256 = digest;
  consumer.input_artifacts[0].sha256 = digest;
  return { consumer, manifest, id: manifest.artifacts[0].ref.artifact_id };
}
function make(input = inputs(), limits) {
  return new RuntimeInputArtifactReader(
    input.consumer,
    input.manifest,
    input.id,
    limits,
  );
}
function stream(chunks, hooks = {}) {
  let index = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      ...hooks,
    },
    { highWaterMark: 0 },
  );
}
async function read(bytes = abc, chunks = [bytes], input = inputs(bytes), limits) {
  const reader = make(input, limits);
  const source = stream(chunks);
  const result = await reader.read(source);
  assert.equal(source.locked, false);
  assert.equal(result.authorization, false);
  return { reader, result };
}
function denied(reader, result, fault) {
  assert.equal(result.status, "rejected");
  assert.equal(result.fault, fault);
  assert.equal(result.integrity, "not_checked");
  assert.throws(() => reader.takeBytes(), /not available/);
  assert.equal(Object.hasOwn(result, "bytes"), false);
}
const budget = (patch) => ({ ...RUNTIME_INPUT_ARTIFACT_LIMITS, ...patch });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("input artifact: public entry is inert and snapshots contain no bytes", () => {
  const reader = make();
  const snapshot = reader.getSnapshot();
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.authorization, false);
  assert.equal(snapshot.integrity, "not_checked");
  assert.equal(snapshot.binding.artifact.verification, "unverified");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.binding.artifact.ref.producer));
  assert.ok(Object.isFrozen(RUNTIME_INPUT_ARTIFACT_LIMITS));
  for (const key of ["start", "fetch", "stop", "retry"])
    assert.equal(reader[key], undefined);
  assert.throws(() => reader.takeBytes(), /not available/);
});
test("input artifact: independent abc SHA-256 golden value and one-time byte delivery", async () => {
  const { reader, result } = await read(abc, [abc], inputs(abc, abcHash));
  assert.equal(result.status, "matched");
  assert.equal(result.integrity, "sha256_and_length_match");
  const delivery = reader.takeBytes();
  assert.deepEqual(delivery.bytes, abc);
  assert.equal(delivery.binding.artifact.ref.sha256, abcHash);
  assert.equal(delivery.binding.artifact.verification, "unverified");
  assert.equal(delivery.authorization, false);
  assert.ok(Object.isFrozen(delivery));
  assert.equal(reader.getSnapshot().status, "taken");
  assert.throws(() => reader.takeBytes(), /not available/);
  reader.close();
  assert.deepEqual(delivery.bytes, abc);
  delivery.bytes[0] = 0;
  assert.equal(delivery.bytes[0], 0);
});
test("input artifact: empty byte artifact has the independent SHA-256 empty digest", async () => {
  const bytes = new Uint8Array(0);
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const { reader, result } = await read(bytes, [], inputs(bytes, emptyHash));
  assert.equal(result.status, "matched");
  assert.equal(reader.takeBytes().bytes.length, 0);
});
for (const [name, bytes] of [
  ["Unicode", encode("中文🙂 café\r\n")],
  ["binary", Uint8Array.from({ length: 256 }, (_, i) => i)],
]) {
  test(`input artifact: all two-block ${name} splits preserve exact bytes`, async () => {
    for (let i = 0; i <= bytes.length; i++) {
      const { reader, result } = await read(bytes, [bytes.slice(0, i), bytes.slice(i)]);
      assert.equal(result.status, "matched", `split ${i}`);
      assert.equal(result.received_bytes, bytes.length);
      assert.deepEqual(reader.takeBytes().bytes, bytes);
    }
    const { reader } = await read(bytes, Array.from(bytes, (b) => Uint8Array.of(b)));
    assert.deepEqual(reader.takeBytes().bytes, bytes);
  });
}
test("input artifact: chunk offsets use only the exact typed-array view", async () => {
  const backing = encode("xabcx");
  const { reader } = await read(abc, [backing.subarray(1, 4)]);
  assert.deepEqual(reader.takeBytes().bytes, abc);
});
test("input artifact: changing the source buffer after consumption cannot change delivery", async () => {
  const bytes = abc.slice();
  let pulls = 0;
  const source = stream([], {
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(bytes);
      else {
        bytes.fill(0);
        controller.close();
      }
    },
  });
  const reader = make();
  assert.equal((await reader.read(source)).status, "matched");
  assert.deepEqual(reader.takeBytes().bytes, abc);
});
test("input artifact: consumer and manifest are snapshotted before caller mutation", async () => {
  const input = inputs();
  const reader = make(input);
  input.consumer.input_artifacts[0].sha256 = "0".repeat(64);
  input.manifest.artifacts[0].size_bytes = 1;
  assert.equal((await reader.read(stream([abc]))).status, "matched");
  assert.equal(reader.takeBytes().binding.artifact.ref.sha256, abcHash);
});
for (const [name, change] of [
  ["artifact selection", (x) => { x.id = uid; }],
  ["missing consumer input", (x) => { x.consumer.input_artifacts = []; }],
  ["missing manifest entry", (x) => { x.manifest.artifacts = []; }],
  ["revision", (x) => { x.consumer.input_artifacts[0].revision++; }],
  ["hash", (x) => { x.consumer.input_artifacts[0].sha256 = "0".repeat(64); }],
  ["producer run", (x) => { x.consumer.input_artifacts[0].producer.run_id = uid; }],
  ["producer attempt", (x) => { x.consumer.input_artifacts[0].producer.attempt_id = uid; }],
  ["organization", (x) => { x.consumer.org_id = uid; x.consumer.input_artifacts[0].producer.org_id = uid; }],
  ["synthetic as provider", (x) => { x.consumer.execution_kind = "provider"; }],
  ["provider as synthetic", (x) => { x.manifest.evidence_kind = "adapter_report"; }],
  ["self-produced input", (x) => { x.consumer.input_artifacts[0].producer.run_id = x.consumer.run_id; }],
  ["manifest envelope mismatch", (x) => { x.manifest.attempt_id = uid; }],
  ["already verified manifest", (x) => { x.manifest.artifacts[0].verification = "verified"; }],
  ["extra manifest field", (x) => { x.manifest.secret = "not-returned"; }],
  ["duplicate manifest artifact", (x) => { x.manifest.artifacts.push(structuredClone(x.manifest.artifacts[0])); }],
  ["boxed artifact identifier", (x) => { x.id = new String(x.id); }],
]) {
  test(`input artifact: reject mismatched ${name} before reading any source`, () => {
    const input = inputs();
    change(input);
    assert.throws(() => make(input), TypeError);
  });
}
test("input artifact: provider declarations still do not become trusted evidence", async () => {
  const input = inputs();
  input.consumer.execution_kind = "provider";
  input.manifest.evidence_kind = "adapter_report";
  const { reader, result } = await read(abc, [abc], input);
  assert.equal(result.status, "matched");
  assert.equal(reader.takeBytes().binding.artifact.verification, "unverified");
});
for (const field of ["consumer", "manifest"]) {
  test(`input artifact: ${field} accessors are rejected without invocation`, () => {
    const input = inputs();
    let calls = 0;
    Object.defineProperty(input[field], "schema_version", { enumerable: true, get() { calls++; return "1.0.0"; } });
    assert.throws(() => make(input), TypeError);
    assert.equal(calls, 0);
  });
}
for (const invalid of [null, 0, {}, { max_bytes: 1 }, budget({ max_bytes: 0 }), budget({ max_chunks: 0 }), budget({ max_bytes: Infinity }), budget({ max_chunks: 1.5 }), budget({ max_bytes: 4194305 }), budget({ max_chunks: 65537 }), { ...budget({}), extra: 1 }]) {
  test(`input artifact: reject invalid bounded configuration ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => make(inputs(), invalid), TypeError);
  });
}
test("input artifact: limit getters are not evaluated", () => {
  let calls = 0;
  const limits = budget({});
  Object.defineProperty(limits, "max_bytes", { enumerable: true, get() { calls++; return 3; } });
  assert.throws(() => make(inputs(), limits), TypeError);
  assert.equal(calls, 0);
});
test("input artifact: declared size above local budget rejects before allocation", () => {
  assert.throws(() => make(inputs(), budget({ max_bytes: 2 })), TypeError);
});
test("input artifact: exact reduced byte and chunk budget succeeds", async () => {
  const { reader, result } = await read(abc, [abc], inputs(), budget({ max_bytes: 3, max_chunks: 1 }));
  assert.equal(result.status, "matched");
  assert.deepEqual(reader.takeBytes().bytes, abc);
});
test("input artifact: exact default maximum payload succeeds", async () => {
  const bytes = new Uint8Array(RUNTIME_INPUT_ARTIFACT_LIMITS.max_bytes);
  bytes[bytes.length - 1] = 255;
  const { reader, result } = await read(bytes);
  assert.equal(result.status, "matched");
  assert.deepEqual(reader.takeBytes().bytes, bytes);
});
test("input artifact: empty chunks are charged and exact count can finish", async () => {
  const { reader, result } = await read(abc, [new Uint8Array(), abc], inputs(), budget({ max_chunks: 2 }));
  assert.equal(result.status, "matched");
  assert.equal(result.received_chunks, 2);
  reader.close();
});
test("input artifact: one extra empty chunk fails rather than enabling unbounded polling", async () => {
  const { reader, result } = await read(abc, [abc, new Uint8Array()], inputs(), budget({ max_chunks: 1 }));
  denied(reader, result, "chunk_limit");
});
for (const [name, chunks, fault] of [
  ["truncated bytes", [abc.slice(0, 2)], "size_mismatch"],
  ["extra byte in same block", [encode("abcd")], "size_mismatch"],
  ["extra byte in following block", [abc, encode("d")], "size_mismatch"],
  ["same-size corrupted bytes", [encode("abd")], "digest_mismatch"],
  ["string chunk", ["abc"], "invalid_chunk"],
  ["wrong typed array", [new Uint16Array([97, 98, 99])], "invalid_chunk"],
  ["shared byte buffer", [new Uint8Array(new SharedArrayBuffer(3))], "invalid_chunk"],
  ["plain byte-shaped object", [{ 0: 97, length: 1 }], "invalid_chunk"],
]) {
  test(`input artifact: ${name} never exposes partial content`, async () => {
    const { reader, result } = await read(abc, chunks, inputs());
    denied(reader, result, fault);
  });
}
test("input artifact: byte-chunk property getters are not called", async () => {
  const bytes = abc.slice();
  let calls = 0;
  for (const name of ["buffer", "byteLength", "byteOffset", "length"])
    Object.defineProperty(bytes, name, { get() { calls++; throw new Error("no"); } });
  const { reader, result } = await read(abc, [bytes]);
  assert.equal(result.status, "matched");
  assert.equal(calls, 0);
  assert.deepEqual(reader.takeBytes().bytes, abc);
});
test("input artifact: detached buffer is rejected", async () => {
  const bytes = abc.slice();
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  const { reader, result } = await read(abc, [bytes]);
  denied(reader, result, "invalid_chunk");
});
test("input artifact: source errors have fixed local fault and no raw message", async () => {
  const reader = make();
  const source = stream([], { pull(c) { c.error(new Error("private-source-message")); } });
  const result = await reader.read(source);
  denied(reader, result, "transport_lost");
  assert.ok(!JSON.stringify(result).includes("private-source-message"));
  assert.equal(source.locked, false);
});
test("input artifact: byte count alone cannot finish without EOF", async () => {
  let controller;
  const source = stream([], { start(c) { controller = c; }, pull() {} });
  const reader = make();
  const pending = reader.read(source);
  controller.enqueue(abc);
  await tick();
  assert.equal(reader.getSnapshot().status, "reading");
  assert.throws(() => reader.takeBytes(), /not available/);
  reader.close();
  assert.equal((await pending).status, "closed");
  assert.equal(source.locked, false);
});
test("input artifact: second read cannot steal an active source", async () => {
  const reader = make();
  const source = stream([], { pull() {} });
  const pending = reader.read(source);
  const other = stream([abc]);
  await assert.rejects(reader.read(other), /already consumed/);
  assert.equal(other.locked, false);
  assert.equal(source.locked, true);
  reader.close();
  await pending;
});
test("input artifact: rejected and successful instances cannot be reused", async () => {
  for (const bytes of [abc, encode("bad")]) {
    const { reader } = await read(abc, [bytes], inputs());
    const other = stream([abc]);
    await assert.rejects(reader.read(other), /already consumed/);
    assert.equal(other.locked, false);
    reader.close();
  }
});
test("input artifact: invalid and already locked native sources fail closed", async () => {
  const source = stream([abc]);
  const owner = source.getReader();
  for (const value of [null, {}, source]) {
    const reader = make();
    denied(reader, await reader.read(value), "invalid_source");
  }
  assert.equal(source.locked, true);
  owner.releaseLock();
});
test("input artifact: pre-abort does not touch the source or expose abort reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private-abort-reason"));
  const source = stream([abc]);
  const reader = make();
  const result = await reader.read(source, controller.signal);
  assert.equal(result.status, "closed");
  assert.equal(result.binding, null);
  assert.ok(!JSON.stringify(result).includes("private-abort-reason"));
  assert.equal(source.locked, false);
});
for (const mode of ["close", "abort", "rejecting_cancel"]) {
  test(`input artifact: ${mode} interrupts a pending read and releases its lock`, async () => {
    let cancellations = 0;
    const source = stream([], { pull() {}, cancel() { cancellations++; return mode === "rejecting_cancel" ? Promise.reject(new Error("hidden")) : new Promise(() => {}); } });
    const reader = make();
    const controller = new AbortController();
    const pending = reader.read(source, controller.signal);
    await tick();
    if (mode === "abort") controller.abort();
    else reader.close();
    const result = await pending;
    assert.equal(result.status, "closed");
    assert.equal(result.binding, null);
    assert.equal(result.received_bytes, 0);
    assert.equal(source.locked, false);
    assert.equal(cancellations, 1);
    assert.throws(() => reader.takeBytes(), /not available/);
  });
}
test("input artifact: cancellation stays active after digest match until bytes are taken", async () => {
  const reader = make();
  const controller = new AbortController();
  assert.equal((await reader.read(stream([abc]), controller.signal)).status, "matched");
  controller.abort();
  assert.equal(reader.getSnapshot().status, "closed");
  assert.throws(() => reader.takeBytes(), /not available/);
});
test("input artifact: transferring bytes detaches the AbortSignal listener", async (t) => {
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  const reader = make();
  await reader.read(stream([abc]), controller.signal);
  assert.equal(remove.mock.callCount(), 0);
  const delivery = reader.takeBytes();
  assert.equal(remove.mock.callCount(), 1);
  controller.abort();
  assert.equal(reader.getSnapshot().status, "taken");
  assert.deepEqual(delivery.bytes, abc);
});
for (const outcome of ["resolve", "reject"]) {
  test(`input artifact: late digest ${outcome} cannot revive cancelled contents`, async (t) => {
    let settle;
    let captured;
    t.mock.method(crypto.subtle, "digest", (_algorithm, bytes) => {
      captured = new Uint8Array(bytes);
      return new Promise((resolve, reject) => { settle = outcome === "resolve" ? resolve : reject; });
    });
    const reader = make();
    const source = stream([abc]);
    const pending = reader.read(source);
    await tick();
    assert.equal(reader.getSnapshot().status, "checking");
    assert.throws(() => reader.takeBytes(), /not available/);
    reader.close();
    assert.equal((await pending).status, "closed");
    assert.equal(source.locked, false);
    assert.deepEqual(captured, new Uint8Array(3));
    settle(outcome === "resolve" ? Uint8Array.from(Buffer.from(abcHash, "hex")).buffer : new Error("private-digest-error"));
    await tick();
    assert.equal(reader.getSnapshot().binding, null);
    assert.throws(() => reader.takeBytes(), /not available/);
  });
}
test("input artifact: missing crypto produces no bytes and a fixed diagnostic", async (t) => {
  t.mock.method(crypto.subtle, "digest", () => { throw new Error("private-crypto-error"); });
  const { reader, result } = await read();
  denied(reader, result, "digest_unavailable");
  assert.ok(!JSON.stringify(result).includes("private-crypto-error"));
});
test("input artifact: crypto rejection wipes private payload", async (t) => {
  let captured;
  t.mock.method(crypto.subtle, "digest", (_algorithm, bytes) => {
    captured = new Uint8Array(bytes);
    return Promise.reject(new Error("private-crypto-error"));
  });
  const { reader, result } = await read();
  denied(reader, result, "digest_unavailable");
  assert.deepEqual(captured, new Uint8Array(3));
});
test("input artifact: closed instances never inspect a late source", async () => {
  const reader = make();
  reader.close();
  const source = { get getReader() { assert.fail("late source accessed"); } };
  assert.equal((await reader.read(source)).status, "closed");
});
test("input artifact: no implicit fetch, storage or execution occurs", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { assert.fail("implicit fetch"); });
  const { reader } = await read();
  reader.takeBytes();
  reader.close();
  assert.equal(fetch.mock.callCount(), 0);
});

async function serverFor(t, handle) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}/artifact`;
}
test("input artifact HTTP: actual response bytes verify and pass once to the consumer", async (t) => {
  const bytes = encode("真实字节交接🙂\n");
  const url = await serverFor(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    for (const byte of bytes) response.write(Uint8Array.of(byte));
    response.end();
  });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const reader = make(inputs(bytes));
  assert.equal((await reader.read(response.body)).status, "matched");
  assert.deepEqual(reader.takeBytes().bytes, bytes);
});
test("input artifact HTTP: same-size corrupted response is refused", async (t) => {
  const url = await serverFor(t, (_request, response) => response.end("abd"));
  const response = await fetch(url);
  const reader = make();
  denied(reader, await reader.read(response.body), "digest_mismatch");
});
test("input artifact HTTP: prematurely ended response is not accepted", async (t) => {
  const url = await serverFor(t, (_request, response) => response.end("ab"));
  const response = await fetch(url);
  const reader = make();
  denied(reader, await reader.read(response.body), "size_mismatch");
});
test("input artifact HTTP: real socket failure yields no partial delivery", async (t) => {
  let destroy;
  const url = await serverFor(t, (_request, response) => {
    response.writeHead(200);
    response.write("a");
    destroy = () => response.destroy();
  });
  const response = await fetch(url);
  const reader = make();
  const pending = reader.read(response.body);
  await tick();
  destroy();
  denied(reader, await pending, "transport_lost");
  assert.equal(response.body.locked, false);
});
test("input artifact HTTP: local Abort interrupts an active real response", async (t) => {
  const url = await serverFor(t, (_request, response) => { response.writeHead(200); response.write("a"); });
  const response = await fetch(url);
  const reader = make();
  const controller = new AbortController();
  const pending = reader.read(response.body, controller.signal);
  await tick();
  controller.abort();
  assert.equal((await pending).status, "closed");
  assert.equal(response.body.locked, false);
  assert.throws(() => reader.takeBytes(), /not available/);
});
