import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import {
  FakeRuntime,
  fakeRequest,
  createTenantFixtures,
} from "../packages/testkit/dist/index.js";
// node:test runs this file in a separate process; no shared global patch with API/browser tests.
test("FakeRuntime does not use fetch, sockets, HTTP or subprocesses, even with inherited provider secrets", (t) => {
  let attempts = 0;
  const deny = () => {
    attempts++;
    throw new Error("Unexpected external effect from simulator");
  };
  t.mock.method(globalThis, "fetch", deny);
  t.mock.method(net.Socket.prototype, "connect", deny);
  t.mock.method(http, "request", deny);
  t.mock.method(https, "request", deny);
  t.mock.method(childProcess, "spawn", deny);
  t.mock.method(childProcess, "execFile", deny);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-not-a-real-credential";
  try {
    const [tenant] = createTenantFixtures("network");
    const r = new FakeRuntime(tenant);
    const request = fakeRequest(tenant, "fixture_run_network");
    r.start(request, [
      { type: "wait" },
      { type: "artifact", artifact_id: "fixture_result" },
      { type: "succeed" },
    ]);
    r.advance(tenant.org_id, request.run_id);
    r.sendInput(
      tenant.org_id,
      request.run_id,
      "fixture_input",
      tenant.context_snapshot_id,
      "continue",
    );
    r.advance(tenant.org_id, request.run_id);
    r.advance(tenant.org_id, request.run_id);
    assert.equal(r.observe(tenant.org_id, request.run_id).charge_microusd, 0);
    assert.equal(attempts, 0);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
