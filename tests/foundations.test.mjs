import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseConfig,
  parseServiceConfig,
  parseDatabaseConfig,
  ConfigurationError,
} from "../packages/config/dist/index.js";
import { ERROR_CATALOG, isApiError } from "../packages/contracts/dist/index.js";
import {
  AppError,
  publicError,
  classifyError,
  createRedactor,
  redact,
  createLogger,
  TraceStore,
  rootTrace,
  traceparent,
  parseTraceparent,
  SystemClock,
  SystemMonotonicClock,
  RandomIds,
} from "../packages/telemetry/dist/index.js";
import {
  FixedClock,
  ManualClock,
  ManualMonotonicClock,
  SequenceIds,
} from "../packages/testkit/dist/index.js";
import { createClient } from "../packages/client/dist/index.js";

test("ZT01-03 config is deeply frozen and does not change its input", () => {
  const env = Object.freeze({ NODE_ENV: "test", ZENTWINE_LOG_LEVEL: "warn" });
  const result = parseServiceConfig(env);
  assert.equal(result.logging.level, "warn");
  assert.equal(result.server.mode, "test");
  for (const part of [result, result.server, result.logging, result.limits])
    assert.equal(Object.isFrozen(part), true);
  assert.equal(Object.isFrozen(parseConfig({})), true);
  assert.throws(() => {
    result.server.port = 99;
  }, TypeError);
  assert.deepEqual(Object.keys(env), ["NODE_ENV", "ZENTWINE_LOG_LEVEL"]);
});
test("ZT01-03 explicit falsey values do not silently select defaults", () => {
  for (const field of [
    "NODE_ENV",
    "ZENTWINE_HOST",
    "ZENTWINE_API_PORT",
    "ZENTWINE_LOG_LEVEL",
  ]) {
    assert.throws(
      () => parseServiceConfig({ [field]: "" }),
      ConfigurationError,
    );
  }
});
test("ZT01-03 limits validate both bounds and reject numeric coercion", () => {
  const cases = [
    ["ZENTWINE_BODY_LIMIT_BYTES", 1024, 1048576],
    ["ZENTWINE_REQUEST_TIMEOUT_MS", 1000, 120000],
    ["ZENTWINE_SHUTDOWN_TIMEOUT_MS", 100, 30000],
  ];
  for (const [field, low, high] of cases) {
    for (const value of [low, high])
      assert.doesNotThrow(() => parseServiceConfig({ [field]: String(value) }));
    for (const value of [
      low - 1,
      high + 1,
      "1e4",
      "+1000",
      " 1024",
      "NaN",
      "Infinity",
      "9999999999999999999",
      "fixture-secret",
    ]) {
      assert.throws(
        () => parseServiceConfig({ [field]: String(value) }),
        (e) => {
          assert.equal(e.field, field);
          assert.equal(e.message.includes(String(value)), false);
          return true;
        },
      );
    }
  }
});
test("ZT01-03 production remains rejected before exposure", () => {
  assert.throws(() => parseServiceConfig({ NODE_ENV: "production" }), {
    reason: "unsupported",
    field: "NODE_ENV",
  });
  assert.throws(() => parseServiceConfig({ ZENTWINE_HOST: "0.0.0.0" }), {
    reason: "unsupported",
  });
});
test("ZT01-03 optional database consumer fails explicitly when missing", () => {
  assert.doesNotThrow(() => parseServiceConfig({}));
  for (const value of [undefined, ""]) {
    assert.throws(() => parseDatabaseConfig({ ZENTWINE_DATABASE_URL: value }), {
      field: "ZENTWINE_DATABASE_URL",
      reason: "missing",
    });
  }
});
test("ZT01-03 database URL validates without returning rejected credentials", () => {
  for (const value of [
    "https://user:fixture-secret@db/x",
    "postgres://db",
    "postgres://db/x#fragment",
    "postgres://db:65536/x",
    "postgres://db/x\n",
    " postgres://db/x",
  ]) {
    assert.throws(
      () => parseDatabaseConfig({ ZENTWINE_DATABASE_URL: value }),
      (e) => {
        assert.equal(e.message.includes(value), false);
        assert.equal(e.stack.includes("fixture-secret"), false);
        return true;
      },
    );
  }
  const raw = "postgres://user:synthetic-password@127.0.0.1/zentwine_test";
  const config = parseDatabaseConfig({ ZENTWINE_DATABASE_URL: raw });
  assert.equal(config.url.reveal(), raw);
  assert.equal(String(config.url), "[REDACTED]");
  assert.equal(JSON.stringify(config).includes("synthetic-password"), false);
  assert.equal(
    JSON.stringify(redact(config)).includes("synthetic-password"),
    false,
  );
});
test("ZT01-03 error catalog maps status, public copy, and retry policy", () => {
  for (const [code, expected] of Object.entries(ERROR_CATALOG)) {
    const result = publicError(new AppError(code), "trace_01");
    assert.equal(result.status, expected.status);
    assert.deepEqual(result.body, {
      code,
      message: expected.message,
      details: {},
      trace_id: "trace_01",
      retryable: expected.retryable,
    });
    assert.equal(isApiError(result.body), true);
    assert.equal(Object.isFrozen(expected), true);
  }
  assert.equal(publicError(new Error("secret"), "t").body.retryable, false);
});
test("ZT01-03 thrown strings, spoofed codes and exception chains stay private", () => {
  const errors = [
    "synthetic-secret",
    new Error("synthetic-secret", { cause: "nested-secret" }),
    { code: "version_conflict", statusCode: 409, message: "synthetic-secret" },
    null,
    undefined,
  ];
  for (const error of errors) {
    const result = publicError(error, "t");
    assert.equal(result.status, 500);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  assert.equal(new AppError("not_a_known_code").code, "internal_error");
});
test("ZT01-03 error handler does not evaluate accessors or leak proxy failures", () => {
  let calls = 0;
  const error = Object.defineProperty({}, "code", {
    get() {
      calls++;
      throw new Error("secret");
    },
  });
  assert.equal(classifyError(error), "internal_error");
  assert.equal(calls, 0);
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("secret");
      },
    },
  );
  assert.equal(classifyError(proxy), "internal_error");
});
test("ZT01-03 recognized transport errors preserve meaningful statuses", () => {
  assert.equal(
    publicError({ code: "FST_ERR_CTP_BODY_TOO_LARGE" }, "t").status,
    413,
  );
  assert.equal(
    publicError({ code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" }, "t").status,
    415,
  );
  assert.equal(
    publicError(
      { code: "FST_ERR_VALIDATION", validation: [{ secret: "hidden" }] },
      "t",
    ).status,
    400,
  );
});
test("ZT01-03 traceparent subset rejects malformed and zero identifiers", () => {
  const context = rootTrace();
  const header = traceparent(context);
  assert.deepEqual(parseTraceparent(header), context);
  for (const value of [
    null,
    [header],
    "ff" + header.slice(2),
    header.toUpperCase(),
    header + "-extra",
    header.replace(context.traceId, "0".repeat(32)),
    header.replace(context.spanId, "0".repeat(16)),
    header + "," + header,
    header + "\n",
  ])
    assert.equal(parseTraceparent(value), undefined);
  assert.equal(parseTraceparent(header.slice(0, -2) + "03").sampled, true);
});
test("ZT01-03 concurrent async traces cannot overwrite one another", async () => {
  const store = new TraceStore();
  const contexts = Array.from({ length: 50 }, () => rootTrace());
  await Promise.all(
    contexts.map((context, i) =>
      store.run(context, async () => {
        assert.equal(store.current().traceId, context.traceId);
        await delay(i % 4);
        assert.equal(store.current().traceId, context.traceId);
        await Promise.resolve();
        assert.equal(store.current().spanId, context.spanId);
      }),
    ),
  );
  assert.equal(store.current(), undefined);
  assert.equal(new Set(contexts.map((c) => c.traceId)).size, 50);
});
test("ZT01-03 child span restores parent and exceptions restore outer context", async () => {
  const store = new TraceStore();
  const root = rootTrace();
  await store.run(root, async () => {
    await assert.rejects(
      store.child(async () => {
        assert.equal(store.current().traceId, root.traceId);
        assert.equal(store.current().parentSpanId, root.spanId);
        assert.notEqual(store.current().spanId, root.spanId);
        await Promise.resolve();
        throw new Error("fixture");
      }),
    );
    assert.equal(store.current().spanId, root.spanId);
  });
  assert.equal(store.current(), undefined);
});
test("ZT01-03 trace snapshot drops additional authorization fields", () => {
  const store = new TraceStore();
  const context = { ...rootTrace(), orgId: "privileged-org" };
  store.run(context, () => {
    assert.equal(store.current().orgId, undefined);
    assert.equal(Object.isFrozen(store.current()), true);
    context.traceId = "0".repeat(32);
    assert.notEqual(store.current().traceId, context.traceId);
  });
});
test("ZT01-03 explicit trusted parent starts a new span, not authorization", () => {
  const store = new TraceStore();
  const parent = rootTrace();
  store.fromTrustedParent(traceparent(parent), () => {
    assert.equal(store.current().traceId, parent.traceId);
    assert.equal(store.current().parentSpanId, parent.spanId);
    assert.notEqual(store.current().spanId, parent.spanId);
  });
  store.fromTrustedParent("bad", () =>
    assert.match(store.current().traceId, /^[0-9a-f]{32}$/),
  );
});
test("ZT01-03 bound callbacks preserve original context and no-context binding", () => {
  const store = new TraceStore();
  const root = rootTrace();
  let bound;
  const empty = store.bind(() => store.current());
  store.run(root, () => {
    bound = store.bind(() => store.current());
  });
  store.run(rootTrace(), () => {
    assert.equal(bound().traceId, root.traceId);
    assert.equal(empty(), undefined);
  });
  assert.equal(store.current(), undefined);
});
test("ZT01-03 deterministic clocks do not share mutable Date objects", () => {
  const clock = new ManualClock();
  const first = clock.now();
  first.setTime(0);
  clock.advance(1000);
  assert.equal(clock.now().toISOString(), "2026-09-24T00:00:01.000Z");
  clock.advance(-2000);
  assert.equal(clock.now().toISOString(), "2026-09-23T23:59:59.000Z");
  assert.throws(() => clock.advance(Infinity));
  assert.throws(() => clock.advance(Number.MAX_SAFE_INTEGER));
});
test("ZT01-03 monotonic clock cannot go backwards and IDs have separate sources", () => {
  const timer = new ManualMonotonicClock();
  timer.advance(1.5);
  assert.equal(timer.milliseconds(), 1.5);
  for (const value of [-1, NaN, Infinity])
    assert.throws(() => timer.advance(value));
  const ids = new RandomIds();
  const generated = Array.from({ length: 100 }, () => ids.next());
  assert.equal(new Set(generated).size, 100);
  assert.match(
    generated[0],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(new SequenceIds().next(), "fixture_1");
  assert.ok(Number.isFinite(new SystemClock().now().getTime()));
  const system = new SystemMonotonicClock();
  const start = system.milliseconds();
  assert.ok(system.milliseconds() >= start);
});
test("ZT01-03 secret key variants are removed at any ordinary object depth", () => {
  const keys = [
    "Authorization",
    "Proxy-Authorization",
    "Set-Cookie",
    "access_token",
    "refreshToken",
    "clientSecret",
    "API_KEY",
    "database-url",
    "private_key",
    "password",
    "body",
    "prompt",
    "headers",
    "payload",
    "cause",
    "stack",
  ];
  for (const key of keys) {
    const input = { nested: [{ [key]: "synthetic-secret", status: "ok" }] };
    const out = JSON.stringify(redact(input));
    assert.equal(out.includes("synthetic-secret"), false);
    assert.equal(out.includes("ok"), true);
    assert.equal(input.nested[0][key], "synthetic-secret");
  }
});
test("ZT01-03 known secrets and common free-text credentials are redacted", () => {
  const sanitize = createRedactor(["unusual-fixture-credential"]);
  for (const text of [
    "Bearer fixture-credential",
    "Basic dGVzdDpmaXh0dXJl",
    "postgres://u:fixture-credential@db/x",
    "https://site.invalid/a?token=fixture-credential",
    'password="fixture-credential with spaces"',
    "api_key=fixture-credential",
    "sk-fixtureCredential12",
    "ghp_fixtureCredential12",
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature",
    "unusual-fixture-credential",
    "-----BEGIN PRIVATE KEY-----\\nfixture-credential",
  ]) {
    const output = sanitize({ note: text });
    assert.notEqual(output.note, text);
    assert.equal(JSON.stringify(output).includes("fixture-credential"), false);
  }
});
test("ZT01-03 redaction never executes getters, array getters or toJSON", () => {
  let calls = 0;
  const input = {
    ok: true,
    toJSON() {
      calls++;
      return "secret";
    },
  };
  Object.defineProperty(input, "computed", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("secret");
    },
  });
  const arr = [];
  Object.defineProperty(arr, 0, {
    get() {
      calls++;
      return "secret";
    },
  });
  assert.equal(redact(input).computed, "[ACCESSOR]");
  assert.deepEqual(redact(arr), ["[ACCESSOR]"]);
  JSON.stringify(redact(input));
  assert.equal(calls, 0);
});
test("ZT01-03 cycles, huge values, special objects and proxy errors are bounded", () => {
  const value = { name: "ok" };
  value.self = value;
  assert.match(JSON.stringify(redact(value)), /TRUNCATED/);
  assert.equal(redact("x".repeat(10000)), "[TRUNCATED]");
  assert.equal(redact(Array(10000).fill("ok")).length, 51);
  for (const item of [
    new Error("hidden"),
    Buffer.from("hidden"),
    new Map([["password", "hidden"]]),
  ])
    assert.equal(JSON.stringify(redact(item)).includes("hidden"), false);
  assert.equal(
    redact(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("hidden");
          },
        },
      ),
    ),
    "[UNREADABLE]",
  );
  assert.equal(
    JSON.stringify(redact({ big: 1n, nonfinite: Infinity })).includes(
      "NON_FINITE",
    ),
    true,
  );
});
test("ZT01-03 redaction blocks prototype and serializer pollution", () => {
  const input = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"secret","ok":1}',
  );
  const result = redact(input);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result, "__proto__"), false);
  assert.equal(Object.hasOwn(result, "constructor"), false);
  assert.equal(result.ok, 1);
});
test("ZT01-03 logger creates bounded JSON lines with server-owned metadata", () => {
  const lines = [];
  const traces = new TraceStore();
  const context = rootTrace();
  const logger = createLogger({
    clock: new FixedClock(),
    traces,
    sink: (s) => lines.push(s),
    secrets: ["custom-fixture"],
  });
  traces.run(context, () =>
    logger.log("info", "diagnostic", {
      level: "error",
      event: "forged",
      trace_id: "forged",
      note: "hello\ncustom-fixture",
      token: "secret",
    }),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].split("\n").length, 2);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.timestamp, "2026-09-24T00:00:00.000Z");
  assert.equal(entry.trace_id, context.traceId);
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "diagnostic");
  assert.equal(entry.fields.token, "[REDACTED]");
  assert.equal(lines[0].includes("custom-fixture"), false);
});
test("ZT01-03 log level filters, invalid event, and sink failures are controlled", () => {
  const lines = [];
  const logger = createLogger({ level: "warn", sink: (s) => lines.push(s) });
  logger.log("info", "diagnostic");
  logger.log("warn", "not-allowed-secret");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, "log.invalid_event");
  createLogger({ level: "silent", sink: (s) => lines.push(s) }).log(
    "error",
    "diagnostic",
  );
  assert.equal(lines.length, 1);
  const failed = createLogger({
    sink: () => {
      throw new Error("secret-sink");
    },
  });
  assert.doesNotThrow(() => failed.log("error", "diagnostic"));
  assert.equal(failed.droppedRecords, 1);
});
test("ZT01-03 total output limit preserves valid JSON", () => {
  const lines = [];
  const logger = createLogger({ sink: (s) => lines.push(s) });
  logger.log("info", "diagnostic", Array(50).fill("x".repeat(2000)));
  assert.ok(Buffer.byteLength(lines[0]) <= 16384);
  assert.equal(JSON.parse(lines[0]).fields, "[TRUNCATED]");
});
test("ZT01-03 client rejects unsafe error shape without displaying remote text", async () => {
  const base = {
    code: "unavailable",
    message: "internal-secret",
    details: {},
    trace_id: "safe_trace",
    retryable: true,
  };
  for (const body of [
    { ...base, trace_id: "https://evil.invalid/secret" },
    { ...base, details: { secret: "hidden" } },
    { ...base, code: "<script>" },
    { ...base, stack: "secret" },
  ]) {
    assert.equal(isApiError(body), false);
    await assert.rejects(
      createClient({
        fetcher: async () => Response.json(body, { status: 503 }),
      }).bootstrap(),
      (e) =>
        e.code === "unavailable" &&
        e.traceId === undefined &&
        !e.message.includes("secret"),
    );
  }
});
