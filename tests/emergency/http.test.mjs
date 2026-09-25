import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fixture, query, request, path, origin } from "./setup.mjs";
import { parseEmergencyState, parseEmergencyResult } from "../../packages/contracts/dist/index.js";
const { WebSocket } = createRequire(new URL("../../services/api/package.json", import.meta.url))("ws");
test("emergency HTTP TCP: state confirmation receipt and idempotent retry round trip with no-store", () => fixture(async (f) => {
  const app = f.app();
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`, url = base + path(f, f.bobMember.id);
    const headers = { origin, cookie: f.owner.cookie, "x-zentwine-context-version": String(f.owner.scope.context_version), "x-zentwine-client": "web", "content-type": "application/json", "x-zentwine-csrf": f.owner.csrf };
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(parseEmergencyState(await response.json(), f.orgA, f.bobMember.id).held, false);
    const body = JSON.stringify(await f.command());
    for (const replayed of [false, true]) {
      const changed = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
      assert.equal(changed.status, 200);
      const result = parseEmergencyResult(await changed.json(), f.orgA, f.bobMember.id);
      assert.equal(result.replayed, replayed); assert.equal(result.current.held, true);
    }
  } finally { await app.close(); }
}));
test("emergency HTTP: authorization CSRF forged origin and Agent bearer cannot invoke control", () => fixture(async (f) => {
  const guest = await f.accept(await f.invite()), input = await f.command(), app = f.app();
  const url = path(f, f.bobMember.id), headers = { origin, cookie: f.owner.cookie, "content-type": "application/json", "x-zentwine-client": "web", "x-zentwine-csrf": f.owner.csrf, "x-zentwine-context-version": String(f.owner.scope.context_version) };
  try {
    assert.equal((await request(app, f.owner, "GET", url)).statusCode, 200);
    for (const extra of [{ cookie: "" }, { "x-zentwine-csrf": "bad" }, { origin: "https://evil.example.test" }, { authorization: "Bearer zt_agent_synthetic" }]) {
      const res = await app.inject({ method: "POST", url, headers: { ...headers, ...extra }, payload: input });
      assert.ok([401, 403].includes(res.statusCode)); assert.ok(!res.body.includes("receipt"));
    }
    assert.equal((await request(app, guest, "POST", url, input)).statusCode, 403);
    assert.equal((await request(app, f.owner, "GET", `/api/v1/orgs/${f.orgB}/members/${f.bobMember.id}/emergency-access`)).statusCode, 404);
    assert.equal((await request(app, f.owner, "GET", path(f, randomUUID()))).statusCode, 404);
    assert.equal((await f.state()).held, false);
  } finally { await app.close(); }
}));
test("emergency HTTP: unexpected fields stale versions and false confirmations are rejected", () => fixture(async (f) => {
  const app = f.app(), input = await f.command(), url = path(f, f.bobMember.id);
  try {
    for (const patch of [{ role: "owner" }, { reason: "secret narrative" }, { action: "release" }, { expected_version: -1 }])
      assert.equal((await request(app, f.owner, "POST", url, { ...input, ...patch })).statusCode, 400);
    assert.equal((await request(app, f.owner, "POST", url, { ...input, confirm_human_id: f.alice })).statusCode, 403);
    assert.equal((await request(app, f.owner, "POST", url, { ...input, expected_member_version: 100 })).statusCode, 409);
    assert.equal((await f.state()).version, 0);
  } finally { await app.close(); }
}));
test("emergency HTTP: storage failure returns fixed error without success or raw database details", () => fixture(async (f) => {
  const app = f.app(), input = await f.command();
  try {
    await query(f.adminPool, `REVOKE INSERT ON zentwine_organizations.emergency_receipts FROM "${f.managerRole}"`);
    const response = await request(app, f.owner, "POST", path(f, f.bobMember.id), input);
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, "unavailable");
    for (const value of ["receipt", "permission denied", "zentwine_organizations", f.managerRole, f.owner.token]) assert.ok(!response.body.includes(value));
    assert.equal((await f.state()).held, false);
  } finally { await app.close(); }
}));
test("emergency WS: existing connection rejects its next frame while another organization keeps working", () => fixture(async (f) => {
  const app = f.app(), sockets = [];
  const other = await f.auth(f.bob, f.orgB);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const connect = async (auth) => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/api/v1/policy/socket?org_id=${auth.scope.org_id}&context_version=${auth.scope.context_version}`, { headers: { origin, cookie: auth.cookie } });
      sockets.push(ws); ws.on("error", () => {}); await once(ws, "open"); return ws;
    };
    const exchange = async (ws, auth, id) => {
      const answer = once(ws, "message", { signal: AbortSignal.timeout(5000) });
      ws.send(JSON.stringify({ csrf_token: auth.csrf, operation: "catalog.read", resource_id: id }));
      return JSON.parse((await answer)[0].toString());
    };
    const ws = await connect(f.reviewer), second = await connect(other);
    assert.equal((await exchange(ws, f.reviewer, f.a.id)).type, "result");
    assert.equal((await exchange(second, other, f.b.id)).type, "result");
    await f.change();
    const denied = await exchange(ws, f.reviewer, f.a.id);
    assert.equal(denied.code, "unavailable_resource"); assert.equal(denied.resource, undefined);
    assert.equal((await exchange(second, other, f.b.id)).type, "result");
  } finally { for (const ws of sockets) ws.terminate(); await app.close(); }
}));
