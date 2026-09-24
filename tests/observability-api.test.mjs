import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { buildApp } from "../services/api/dist/app.js";
import { parseServiceConfig } from "../packages/config/dist/index.js";
import {
  AppError,
  TraceStore,
  rootTrace,
  traceparent,
} from "../packages/telemetry/dist/index.js";
import {
  ManualClock,
  ManualMonotonicClock,
} from "../packages/testkit/dist/index.js";
async function usingApp(options, setup, run) {
  const app = buildApp(options);
  setup(app);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}
test("ZT01-03 HTTP ignores forged trace headers and never captures credential content", async () => {
  const logs = [];
  const foreign = rootTrace();
  await usingApp(
    { logSink: (line) => logs.push(line) },
    () => {},
    async (app) => {
      const response = await app.inject({
        url: "/api/v1/system/bootstrap?token=secret-query-value",
        headers: {
          "x-request-id": "secret-request-id",
          traceparent: traceparent(foreign),
          tracestate: "secret-trace-state",
          baggage: "secret-baggage",
          authorization: "Bearer secret-header-value",
          cookie: "session=secret-cookie-value",
        },
      });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().trace_id, /^[0-9a-f]{32}$/);
      assert.notEqual(response.json().trace_id, foreign.traceId);
      assert.equal(response.headers["x-request-id"], response.json().trace_id);
      assert.ok(
        response.headers.traceparent.includes(response.json().trace_id),
      );
      assert.equal(response.headers.tracestate, undefined);
      for (const secret of [
        "secret-query-value",
        "secret-request-id",
        "secret-trace-state",
        "secret-baggage",
        "secret-header-value",
        "secret-cookie-value",
      ]) {
        assert.equal(response.body.includes(secret), false);
        assert.equal(logs.join("").includes(secret), false);
      }
      const completed = logs
        .map(JSON.parse)
        .find((l) => l.event === "http.completed");
      assert.equal(completed.trace_id, response.json().trace_id);
      assert.equal(completed.fields.route, "/api/v1/system/bootstrap");
    },
  );
});
test("ZT01-03 HTTP concurrent handlers and logs retain their own async trace", async () => {
  const traces = new TraceStore();
  const logs = [];
  await usingApp(
    { traces, logSink: (line) => logs.push(JSON.parse(line)) },
    (app) => {
      app.get("/test-trace", async (request) => {
        const before = traces.current();
        await delay(Math.floor(Math.random() * 5));
        assert.equal(traces.current().traceId, before.traceId);
        assert.equal(traces.current().traceId, request.id);
        return { trace: traces.current().traceId };
      });
    },
    async (app) => {
      const responses = await Promise.all(
        Array.from({ length: 40 }, () => app.inject("/test-trace")),
      );
      const ids = responses.map((r) => {
        assert.equal(r.statusCode, 200);
        return r.json().trace;
      });
      assert.equal(new Set(ids).size, 40);
      const completed = logs.filter((l) => l.event === "http.completed");
      assert.equal(completed.length, 40);
      assert.deepEqual(new Set(completed.map((l) => l.trace_id)), new Set(ids));
      assert.equal(traces.current(), undefined);
    },
  );
});
test("ZT01-03 HTTP logs template routes, not arbitrary resource paths", async () => {
  const logs = [];
  await usingApp(
    { logSink: (line) => logs.push(line) },
    () => {},
    async (app) => {
      const response = await app.inject(
        "/api/v1/orgs/secret-org/workspaces/secret-workspace?token=secret-token",
      );
      assert.equal(response.statusCode, 401);
      for (const secret of ["secret-org", "secret-workspace", "secret-token"])
        assert.equal(logs.join("").includes(secret), false);
    },
  );
});
test("ZT01-03 HTTP body limit and media errors have stable public statuses", async () => {
  const logs = [];
  const config = parseServiceConfig({ ZENTWINE_BODY_LIMIT_BYTES: "1024" });
  await usingApp(
    { config, logSink: (line) => logs.push(line) },
    (app) => {
      app.post("/test-body", async () => ({ ok: true }));
    },
    async (app) => {
      const large = await app.inject({
        method: "POST",
        url: "/test-body",
        payload: { note: "secret-body".repeat(300) },
      });
      assert.equal(large.statusCode, 413);
      assert.equal(large.json().code, "payload_too_large");
      const malformed = await app.inject({
        method: "POST",
        url: "/test-body",
        headers: { "content-type": "application/json" },
        payload: '{"secret-body":',
      });
      assert.equal(malformed.statusCode, 400);
      const media = await app.inject({
        method: "POST",
        url: "/test-body",
        headers: { "content-type": "application/unsupported" },
        payload: "secret-body",
      });
      assert.equal(media.statusCode, 415);
      assert.equal(logs.join("").includes("secret-body"), false);
      for (const response of [large, malformed, media])
        assert.equal(response.body.includes("secret-body"), false);
    },
  );
});
test("ZT01-03 public errors preserve status without logging exception details", async () => {
  const logs = [];
  await usingApp(
    { logSink: (line) => logs.push(line) },
    (app) => {
      app.get("/test-conflict", async () => {
        throw new AppError("version_conflict");
      });
      app.get("/test-internal", async () => {
        throw new Error("secret-error", { cause: "secret-cause" });
      });
    },
    async (app) => {
      const conflict = await app.inject("/test-conflict");
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().retryable, false);
      const internal = await app.inject("/test-internal");
      assert.equal(internal.statusCode, 500);
      assert.equal(internal.json().retryable, false);
      assert.equal(logs.join("").includes("secret-error"), false);
      assert.equal(logs.join("").includes("secret-cause"), false);
      assert.equal(internal.body.includes("secret"), false);
      const failure = logs
        .map(JSON.parse)
        .find((l) => l.event === "http.failed" && l.fields.status === 500);
      assert.equal(failure.trace_id, internal.json().trace_id);
    },
  );
});
test("ZT01-03 elapsed timings use monotonic rather than wall-clock time", async () => {
  const clock = new ManualClock();
  const timer = new ManualMonotonicClock();
  const logs = [];
  await usingApp(
    {
      clock,
      monotonicClock: timer,
      logSink: (line) => logs.push(JSON.parse(line)),
    },
    (app) => {
      app.get("/test-clock", async () => {
        clock.advance(-3600000);
        timer.advance(12.5);
        return { ok: true };
      });
    },
    async (app) => {
      await app.inject("/test-clock");
      const completed = logs.find((l) => l.event === "http.completed");
      assert.equal(completed.fields.duration_ms, 12.5);
      assert.equal(completed.timestamp, "2026-09-23T23:00:00.000Z");
    },
  );
});
test("ZT01-03 one failing diagnostic sink does not fail HTTP requests", () =>
  usingApp(
    {
      logSink: () => {
        throw new Error("secret-sink");
      },
    },
    () => {},
    async (app) => {
      assert.equal((await app.inject("/livez")).statusCode, 200);
      assert.equal((await app.inject("/missing")).statusCode, 404);
    },
  ));
test("ZT01-03 malformed process configuration fails safely before binding", () => {
  const result = spawnSync(process.execPath, ["services/api/dist/main.js"], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      ZENTWINE_API_PORT: "secret-port-input",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes("api.started"), false);
  assert.equal(result.stderr.includes("secret-port-input"), false);
  const entry = JSON.parse(result.stderr.trim());
  assert.equal(entry.event, "api.start_failed");
  assert.equal(entry.fields.field, "ZENTWINE_API_PORT");
});
