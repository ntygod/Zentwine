import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  RuntimeEventStreamReader,
  RUNTIME_STREAM_LIMITS,
} from "../packages/client/dist/index.js";
import { readRuntimeStreamJson } from "../packages/client/dist/runtime-stream-json.js";
import { fixture } from "./fixtures/runtime-wire-v1.mjs";

const encoder = new TextEncoder();
const uid = (n) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
function event(type, sequence = 1) {
  const sample = fixture.event_variants.find((entry) => entry.type === type);
  assert.ok(sample);
  return {
    ...structuredClone(sample),
    event_id: uid(sequence),
    sequence: String(sequence),
  };
}
const started = () => event("run.started");
const success = () => event("run.succeeded", 2);
const wire = (value) => JSON.stringify(value) + "\n";
const full = () => wire(started()) + wire(success());
function source(chunks, options = {}) {
  let index = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      ...options,
    },
    { highWaterMark: 0 },
  );
}
async function read(text, budget, chunks) {
  const reader = new RuntimeEventStreamReader(fixture.start_a, budget);
  const stream = source(chunks ?? [encoder.encode(text)]);
  const result = await reader.read(stream);
  assert.equal(stream.locked, false);
  assert.equal(result.authorization, false);
  return { reader, result };
}
function fault(result, expected) {
  assert.equal(result.status, "inspect_required");
  assert.equal(result.fault, expected);
  assert.equal(result.observation.synchronization, "inspect_required");
  assert.equal(result.authorization, false);
}
const limits = (patch) => ({ ...RUNTIME_STREAM_LIMITS, ...patch });

// Control tests use an actual Web ReadableStream; HTTP tests below use real loopback sockets.
test("runtime stream: public entry and idle snapshot have no implicit execution", () => {
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  assert.equal(reader.getSnapshot().status, "idle");
  assert.equal(reader.getSnapshot().observation.event_count, 0);
  for (const key of ["start", "stop", "retry", "fetch"])
    assert.equal(reader[key], undefined);
  assert.ok(Object.isFrozen(RUNTIME_STREAM_LIMITS));
  assert.ok(Object.isFrozen(reader.getSnapshot()));
});
test("runtime stream: complete LF history is frozen and releases its reader", async () => {
  const { result } = await read(full());
  assert.equal(result.status, "ended");
  assert.equal(result.observation.reported_state, "succeeded");
  assert.equal(result.consumed_bytes, encoder.encode(full()).length);
  assert.equal(result.framed_events, 2);
  assert.equal(result.duplicate_events, 0);
  assert.ok(Object.isFrozen(result.observation.stream));
});
test("runtime stream: every two-chunk split preserves a valid escaped-key history", async () => {
  const bytes = encoder.encode(
    full().replaceAll('"sequence"', '"sequen\\u0063e"'),
  );
  const baseline = (await read("", undefined, [bytes])).result;
  assert.equal(baseline.status, "ended");
  for (let i = 0; i <= bytes.length; i++) {
    const { result } = await read("", undefined, [
      bytes.slice(0, i),
      bytes.slice(i),
    ]);
    assert.deepEqual(result, baseline, `split ${i}`);
  }
});
test("runtime stream: every UTF-8 split decodes Unicode before the unchanged protocol rejects text", async () => {
  const summary = event("summary.available", 2);
  summary.payload.text = "中文🙂 café";
  const bytes = encoder.encode(wire(started()) + wire(summary));
  const baseline = (await read("", undefined, [bytes])).result;
  fault(baseline, "observation_rejected");
  assert.equal(baseline.event_code, "invalid_event");
  assert.equal(baseline.observation.event_count, 1);
  for (let i = 0; i <= bytes.length; i++) {
    const { result } = await read("", undefined, [
      bytes.slice(0, i),
      bytes.slice(i),
    ]);
    assert.deepEqual(result, baseline, `split ${i}`);
  }
});
test("runtime stream: one-byte chunks, empty chunks and CRLF are supported", async () => {
  const text = full().replaceAll("\n", "\r\n");
  const chunks = [
    new Uint8Array(0),
    ...[...encoder.encode(text)].map((n) => new Uint8Array([n])),
    new Uint8Array(0),
  ];
  const { result } = await read("", undefined, chunks);
  assert.equal(result.status, "ended");
  assert.equal(result.consumed_bytes, encoder.encode(text).length);
});
test("runtime stream JSON: Unicode and escaped braces are values, not duplicate property names", () => {
  const text = { message: '中文🙂 {"x":1,"x":2} newline\n tab\t slash\\' };
  const parsed = readRuntimeStreamJson(JSON.stringify(text));
  assert.equal(parsed.message, text.message);
});
for (const [name, text] of [
  ["empty line", "\n"],
  ["whitespace line", " \t\r\n"],
  ["BOM", "\ufeff" + full()],
  ["BOM second frame", wire(started()) + "\ufeff" + wire(success())],
  ["raw CR inside JSON", wire(started()).replace(":", ":\r")],
  ["two trailing CR", full().replace("\n", "\r\r\n")],
  ["duplicate key", wire(started()).replace("{", '{"sequence":"1",')],
  [
    "escaped duplicate key",
    wire(started()).replace("{", '{"sequen\\u0063e":"1",'),
  ],
  [
    "nested duplicate key",
    wire(started()).replace(
      '"status":"unknown"',
      '"status":"unknown","status":"unknown"',
    ),
  ],
  ["trailing comma", wire(started()).replace(/\}\n$/u, ",}\n")],
  ["multiple values", JSON.stringify(started()) + " {}\n"],
  ["comment", "// ignored?\n"],
  ["raw control", '{"x":"\u0000"}\n'],
  ["truncated string", '{"x":"oops}\n'],
  ["wrong escape", '{"x":"\\q"}\n'],
  ["leading zero", '{"x":01}\n'],
  ["fractional integer rounding", '{"x":1.00000000000000001}\n'],
  ["exponent", '{"x":1e0}\n'],
  ["negative zero", '{"x":-0}\n'],
  ["unsafe integer", '{"x":9007199254740993}\n'],
  ["unterminated object", "{\n"],
  ["array trailing comma", "[1,]\n"],
  ["missing colon", '{"x" 1}\n'],
  ["deep JSON", "[".repeat(18) + "0" + "]".repeat(18) + "\n"],
  ["node budget", "[" + Array(8192).fill("null").join(",") + "]\n"],
]) {
  test(`runtime stream: rejects ${name} without replacing the accepted prefix`, async () => {
    const { result } = await read(text);
    fault(result, "invalid_frame");
    assert.ok(result.observation.event_count <= 1);
  });
}
for (const [name, bytes] of [
  ["overlong", [0xc0, 0xaf, 10]],
  ["surrogate", [0xed, 0xa0, 0x80, 10]],
  ["out-of-range", [0xf4, 0x90, 0x80, 0x80, 10]],
  ["partial", [0xe4, 10]],
  ["invalid continuation", [0xe4, 0x20, 0x80, 10]],
]) {
  test(`runtime stream: fatal UTF-8 ${name}`, async () => {
    fault(
      (await read("", undefined, [new Uint8Array(bytes)])).result,
      "invalid_frame",
    );
  });
}
test("runtime stream: malformed later frame retains only the verified local prefix", async () => {
  const { result } = await read(
    wire(started()) + '{"bad":"SECRET_DIAGNOSTIC"\n' + wire(success()),
  );
  fault(result, "invalid_frame");
  assert.equal(result.observation.event_count, 1);
  assert.equal(result.observation.reported_state, "running");
  assert.equal(JSON.stringify(result).includes("SECRET_DIAGNOSTIC"), false);
});
test("runtime stream: EOF before terminal is not success even on frame boundary", async () => {
  for (const text of ["", wire(started())])
    fault((await read(text)).result, "unexpected_eof");
});
test("runtime stream: final newline is mandatory even for a complete JSON terminal", async () => {
  const { result } = await read(full().slice(0, -1));
  fault(result, "truncated_frame");
  assert.equal(result.observation.event_count, 1);
});
test("runtime stream: a partial multibyte final frame is never repaired", async () => {
  const { result } = await read("", undefined, [
    encoder.encode(wire(started())),
    new Uint8Array([0xe4]),
  ]);
  fault(result, "truncated_frame");
});
test("runtime stream: malformed tail after reported success still requires inspection", async () => {
  const { result } = await read(full() + "oops");
  fault(result, "truncated_frame");
  assert.equal(result.observation.reported_state, "succeeded");
});
test("runtime stream: exact replay is charged without repeating observer effects", async () => {
  const text = full() + wire(started()) + wire(success());
  const { result } = await read(text);
  assert.equal(result.status, "ended");
  assert.equal(result.framed_events, 4);
  assert.equal(result.duplicate_events, 2);
  assert.equal(result.observation.event_count, 2);
});
for (const [name, value] of [
  ["cross organization", { ...started(), org_id: uid(90) }],
  ["cross attempt", { ...started(), attempt_id: uid(91) }],
  ["provider evidence", { ...started(), evidence_kind: "adapter_report" }],
  ["invalid version", { ...started(), schema_version: "9.0.0" }],
  ["sequence gap", event("run.started", 2)],
]) {
  test(`runtime stream: observer refuses ${name}`, async () => {
    const { result } = await read(wire(value));
    fault(result, "observation_rejected");
    assert.equal(result.observation.event_count, 0);
  });
}
test("runtime stream: conflicting replay stops without accepting later frames", async () => {
  const conflict = started();
  conflict.occurred_at = "2026-09-27T00:00:01.000Z";
  const { result } = await read(
    wire(started()) + wire(conflict) + wire(success()),
  );
  fault(result, "observation_rejected");
  assert.equal(result.observation.event_count, 1);
});
test("runtime stream: unknown remains unknown and stops byte consumption", async () => {
  const text = wire(started()) + wire(event("run.unknown", 2));
  const { result } = await read(text + wire(event("run.succeeded", 3)));
  fault(result, "observation_rejected");
  assert.equal(result.observation.reported_state, "unknown");
  assert.equal(result.observation.fault, "outcome_unknown");
  assert.equal(result.consumed_bytes, encoder.encode(text).length);
});
test("runtime stream: valid stop receipt and failure histories finish distinctly", async () => {
  const cancelled =
    wire(started()) +
    wire(event("run.stop_requested", 2)) +
    wire(event("run.cancelled", 3));
  const { result } = await read(cancelled);
  assert.equal(result.status, "ended");
  assert.equal(result.observation.reported_state, "cancelled");
  const fail = event("run.failed", 2);
  fail.payload.error.outcome = "failed";
  const failed = (await read(wire(started()) + wire(fail))).result;
  assert.equal(failed.status, "ended");
  assert.equal(failed.observation.reported_state, "failed");
});
test("runtime stream: exact raw frame bytes accept while one less rejects", async () => {
  const max = Math.max(
    ...full()
      .trimEnd()
      .split("\n")
      .map((line) => encoder.encode(line).length),
  );
  assert.equal(
    (await read(full(), limits({ max_frame_bytes: max }))).result.status,
    "ended",
  );
  fault(
    (await read(full(), limits({ max_frame_bytes: max - 1 }))).result,
    "frame_limit",
  );
});
test("runtime stream: exact total raw bytes and whitespace are counted", async () => {
  const text = " \t" + full();
  const length = encoder.encode(text).length;
  assert.equal(
    (await read(text, limits({ max_stream_bytes: length }))).result.status,
    "ended",
  );
  const { result } = await read(text, limits({ max_stream_bytes: length - 1 }));
  fault(result, "stream_limit");
  assert.equal(result.consumed_bytes, length - 1);
});
test("runtime stream: frame counts include duplicate histories at exact boundary", async () => {
  const text = full() + wire(started());
  assert.equal(
    (await read(text, limits({ max_frames: 3 }))).result.status,
    "ended",
  );
  const { result } = await read(text, limits({ max_frames: 2 }));
  fault(result, "frame_count_limit");
  assert.equal(result.framed_events, 2);
  assert.equal(result.duplicate_events, 0);
});
test("runtime stream: total limit produces the same prefix for every chunk split", async () => {
  const bytes = encoder.encode(full());
  const budget = limits({ max_stream_bytes: bytes.length - 3 });
  const reference = (await read("", budget, [bytes])).result;
  for (let i = 0; i <= bytes.length; i++) {
    const { result } = await read("", budget, [
      bytes.slice(0, i),
      bytes.slice(i),
    ]);
    assert.deepEqual(result, reference, `split ${i}`);
  }
});
test("runtime stream: limits are snapshotted and cannot be raised or supplied by getters", () => {
  for (const patch of [
    { max_frames: 0 },
    { max_frames: 2049 },
    { max_frame_bytes: 262145 },
    { max_stream_bytes: 4194305 },
    { max_frames: 1.5 },
    { extra: 1 },
  ]) {
    assert.throws(
      () => new RuntimeEventStreamReader(fixture.start_a, limits(patch)),
      TypeError,
    );
  }
  let called = 0;
  const budget = limits({});
  Object.defineProperty(budget, "max_frames", {
    get() {
      called++;
      return 1;
    },
    enumerable: true,
  });
  assert.throws(
    () => new RuntimeEventStreamReader(fixture.start_a, budget),
    TypeError,
  );
  assert.equal(called, 0);
});
test("runtime stream: rejects string, shared, detached and non-byte chunks", async () => {
  const detached = new Uint8Array(2);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const value of [
    full(),
    new Uint16Array(2),
    {},
    null,
    new Uint8Array(new SharedArrayBuffer(2)),
    detached,
  ]) {
    fault((await read("", undefined, [value])).result, "invalid_chunk");
  }
});
test("runtime stream: native byte getters bypass shadowed accessors", async () => {
  let called = 0;
  const bytes = encoder.encode(full());
  for (const key of ["buffer", "byteOffset", "byteLength", Symbol.iterator])
    Object.defineProperty(bytes, key, {
      get() {
        called++;
        throw Error("raw secret");
      },
    });
  assert.equal((await read("", undefined, [bytes])).result.status, "ended");
  assert.equal(called, 0);
});
test("runtime stream: invalid source does not execute a user getReader accessor", async () => {
  let called = 0;
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const result = await reader.read({
    get getReader() {
      called++;
      throw Error("raw secret");
    },
  });
  fault(result, "invalid_source");
  assert.equal(called, 0);
});
test("runtime stream: a locked source is not unlocked or consumed by another reader", async () => {
  const stream = source([encoder.encode(full())]);
  const existing = stream.getReader();
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  fault(await reader.read(stream), "invalid_source");
  assert.equal(stream.locked, true);
  existing.releaseLock();
});
test("runtime stream: close before read never touches source or signal", async () => {
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const closed = reader.close();
  const poisoned = new Proxy(
    {},
    {
      get() {
        throw Error("must not access");
      },
    },
  );
  assert.equal(await reader.read(poisoned, poisoned), closed);
  assert.equal(closed.observation.stream, null);
});
test("runtime stream: preaborted signal does not take ownership of source", async () => {
  const controller = new AbortController();
  controller.abort("PRIVATE_REASON");
  const stream = source([encoder.encode(full())]);
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const result = await reader.read(stream, controller.signal);
  assert.equal(result.status, "closed");
  assert.equal(stream.locked, false);
  assert.equal(JSON.stringify(result).includes("PRIVATE_REASON"), false);
});
for (const mode of ["close", "abort"]) {
  test(
    `runtime stream: ${mode} interrupts a pending read and hanging cancel`,
    { timeout: 3000 },
    async () => {
      let notify;
      const pending = new Promise((resolve) => {
        notify = resolve;
      });
      let cancelCount = 0;
      const stream = new ReadableStream(
        {
          pull() {
            notify();
            return new Promise(() => {});
          },
          cancel(reason) {
            cancelCount++;
            assert.equal(reason, "runtime_stream_closed");
            return new Promise(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      const reader = new RuntimeEventStreamReader(fixture.start_a);
      const controller = new AbortController();
      const result = reader.read(stream, controller.signal);
      await pending;
      if (mode === "close") reader.close();
      else controller.abort("PRIVATE_REASON");
      const final = await result;
      assert.equal(final.status, "closed");
      assert.equal(final.observation.stream, null);
      assert.equal(final.consumed_bytes, 0);
      assert.equal(cancelCount, 1);
      assert.equal(stream.locked, false);
    },
  );
}
test("runtime stream: close clears accepted data and refuses late queued chunks", async () => {
  let sink;
  const stream = new ReadableStream({
    start(c) {
      sink = c;
    },
  });
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const reading = reader.read(stream);
  sink.enqueue(encoder.encode(wire(started())));
  while (reader.getSnapshot().observation.event_count === 0)
    await new Promise(setImmediate);
  const old = reader.getSnapshot();
  reader.close();
  assert.throws(() => sink.enqueue(encoder.encode(wire(success()))), TypeError);
  const result = await reading;
  assert.equal(result.observation.event_count, 0);
  assert.equal(result.consumed_bytes, 0);
  assert.equal(old.observation.event_count, 1);
});
test("runtime stream: concurrent and subsequent reads cannot replace a source", async () => {
  let sink;
  const original = new ReadableStream({
    start(c) {
      sink = c;
    },
  });
  const second = source([]);
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const promise = reader.read(original);
  await assert.rejects(reader.read(second), /already consumed/u);
  assert.equal(second.locked, false);
  sink.enqueue(encoder.encode(full()));
  sink.close();
  assert.equal((await promise).status, "ended");
  await assert.rejects(reader.read(second), /already consumed/u);
});
test("runtime stream: source errors are fixed and keep accepted prefix for inspection", async () => {
  let i = 0;
  const stream = source([], {
    pull(c) {
      if (i++ === 0) c.enqueue(encoder.encode(wire(started())));
      else c.error(new Error("PRIVATE_SOURCE_REASON"));
    },
  });
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const result = await reader.read(stream);
  fault(result, "transport_lost");
  assert.equal(result.observation.event_count, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE_SOURCE_REASON"), false);
  assert.equal(stream.locked, false);
});
test("runtime stream: rejected cancel cannot leak an unhandled rejection", async () => {
  const stream = source([encoder.encode("bad\n")], {
    cancel() {
      return Promise.reject(Error("PRIVATE_CANCEL"));
    },
  });
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const result = await reader.read(stream);
  await new Promise(setImmediate);
  fault(result, "invalid_frame");
  assert.equal(stream.locked, false);
});
test("runtime stream: consuming an injected source does not call fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error("unexpected fetch");
  };
  try {
    assert.equal((await read(full())).result.status, "ended");
  } finally {
    globalThis.fetch = original;
  }
});

async function httpFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.equal(server.listening, false);
  });
  return `http://127.0.0.1:${server.address().port}/synthetic-events`;
}
test(
  "runtime stream HTTP: real chunked GET feeds one-byte writes",
  { timeout: 10000 },
  async (t) => {
    let arrivals = 0;
    const text = full();
    const url = await httpFixture(t, (req, res) => {
      arrivals++;
      assert.equal(req.method, "GET");
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const byte of encoder.encode(text))
        res.write(new Uint8Array([byte]));
      res.end();
    });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const reader = new RuntimeEventStreamReader(fixture.start_a);
    const result = await reader.read(response.body);
    assert.equal(result.status, "ended");
    assert.equal(result.observation.reported_state, "succeeded");
    assert.equal(arrivals, 1);
    assert.equal(response.body.locked, false);
  },
);
test(
  "runtime stream HTTP: syntactically complete but unterminated tail is rejected",
  { timeout: 10000 },
  async (t) => {
    const url = await httpFixture(t, (_req, res) => {
      res.writeHead(200);
      res.end(full().slice(0, -1));
    });
    const response = await fetch(url);
    const reader = new RuntimeEventStreamReader(fixture.start_a);
    const result = await reader.read(response.body);
    fault(result, "truncated_frame");
    assert.equal(result.observation.event_count, 1);
  },
);
test(
  "runtime stream HTTP: close aborts a live response without another request",
  { timeout: 10000 },
  async (t) => {
    let arrivals = 0,
      closeResponse;
    const responseClosed = new Promise((resolve) => {
      closeResponse = resolve;
    });
    const url = await httpFixture(t, (_req, res) => {
      arrivals++;
      res.on("close", closeResponse);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(wire(started()));
    });
    const response = await fetch(url);
    const controller = new AbortController();
    const reader = new RuntimeEventStreamReader(fixture.start_a);
    const reading = reader.read(response.body, controller.signal);
    while (reader.getSnapshot().observation.event_count === 0)
      await new Promise(setImmediate);
    controller.abort();
    assert.equal((await reading).status, "closed");
    await responseClosed;
    assert.equal(arrivals, 1);
    assert.equal(response.body.locked, false);
  },
);

test("runtime stream: empty chunks have an independent finite budget", async () => {
  const empty = Array.from({ length: 65 }, () => new Uint8Array(0));
  fault((await read("", undefined, empty)).result, "empty_chunk_limit");
  assert.equal(
    (await read("", undefined, [...empty.slice(0, 64), encoder.encode(full())]))
      .result.status,
    "ended",
  );
});

test("runtime stream: artifact revisions and usage numbers survive the byte boundary", async () => {
  const values = [
    started(),
    event("artifact.produced", 2),
    event("usage.reported", 3),
    event("run.succeeded", 4),
  ];
  const { result } = await read(values.map(wire).join(""));
  assert.equal(result.status, "ended");
  assert.equal(result.observation.artifacts[0].revision, 1);
  assert.deepEqual(result.observation.latest_usage.usage, {
    status: "unknown",
  });
});
test("runtime stream JSON: valid literals and nested shapes match JSON parsing", () => {
  const samples = [
    null,
    true,
    false,
    0,
    12,
    -4,
    Number.MAX_SAFE_INTEGER,
    [],
    {},
    [1, null, true, "x"],
    { nested: { list: [false, "🙂"] } },
  ];
  for (const sample of samples)
    assert.equal(
      JSON.stringify(readRuntimeStreamJson(JSON.stringify(sample))),
      JSON.stringify(sample),
    );
});
test("runtime stream JSON: exact depth and node limits reject only beyond their boundaries", () => {
  assert.doesNotThrow(() =>
    readRuntimeStreamJson("[".repeat(16) + "0" + "]".repeat(16)),
  );
  assert.throws(
    () => readRuntimeStreamJson("[".repeat(17) + "0" + "]".repeat(17)),
    TypeError,
  );
  assert.equal(
    readRuntimeStreamJson("[" + Array(8191).fill("null").join(",") + "]")
      .length,
    8191,
  );
  assert.throws(
    () => readRuntimeStreamJson("[" + Array(8192).fill("null").join(",") + "]"),
    TypeError,
  );
});
test("runtime stream JSON: special keys remain data without prototype mutation", () => {
  const value = readRuntimeStreamJson(
    '{"__proto__":{"polluted":true},"constructor":1}',
  );
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.equal({}.polluted, undefined);
  assert.throws(
    () => readRuntimeStreamJson('{"__proto__":1,"__pr\\u006fto__":2}'),
    TypeError,
  );
});
test("runtime stream: failed parsing actively cancels once and never pulls another frame", async () => {
  let pulled = 0,
    cancelled = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulled++;
        controller.enqueue(encoder.encode("not-json\n"));
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  fault(await reader.read(stream), "invalid_frame");
  assert.equal(pulled, 1);
  assert.equal(cancelled, 1);
  reader.close();
  assert.equal(cancelled, 1);
});
test("runtime stream: abort listener is removed after ordinary completion", async () => {
  const controller = new AbortController();
  let added = 0,
    removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    added++;
    return add(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    removed++;
    return remove(...args);
  };
  const reader = new RuntimeEventStreamReader(fixture.start_a);
  const result = await reader.read(
    source([encoder.encode(full())]),
    controller.signal,
  );
  controller.abort();
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.equal(reader.getSnapshot(), result);
  assert.equal(result.status, "ended");
});
test("runtime stream: budget mutations after construction do not change enforcement", async () => {
  const budget = limits({ max_frames: 1 });
  const reader = new RuntimeEventStreamReader(fixture.start_a, budget);
  budget.max_frames = 100;
  fault(
    await reader.read(source([encoder.encode(full())])),
    "frame_count_limit",
  );
});
test(
  "runtime stream HTTP: socket failure preserves the consumed prefix without reconnect",
  { timeout: 10000 },
  async (t) => {
    let responseHandle,
      arrivals = 0;
    const url = await httpFixture(t, (_req, res) => {
      arrivals++;
      responseHandle = res;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(wire(started()));
    });
    const response = await fetch(url);
    const reader = new RuntimeEventStreamReader(fixture.start_a);
    const reading = reader.read(response.body);
    while (reader.getSnapshot().observation.event_count === 0)
      await new Promise(setImmediate);
    responseHandle.destroy();
    const result = await reading;
    fault(result, "transport_lost");
    assert.equal(result.observation.event_count, 1);
    assert.equal(arrivals, 1);
    assert.equal(response.body.locked, false);
  },
);
