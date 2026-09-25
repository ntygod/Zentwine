import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, request, query, path, origin } from "./setup.mjs";
import { buildApp } from "../../services/api/dist/app.js";
import { parseOrganizationAuditPage } from "../../packages/contracts/dist/index.js";
test("audit HTTP TCP: actual persisted lifecycle events round trip with no-store and bounded projection", () => fixture(async (f) => {
  await f.record(); await f.record(); const lines = [], app = f.app({ logSink: (line) => lines.push(line) });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`, headers = { origin, cookie: f.owner.cookie, "x-zentwine-context-version": String(f.owner.scope.context_version) };
    const response = await fetch(base + path(f) + "?limit=1", { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const page = parseOrganizationAuditPage(await response.json(), f.orgA); assert.equal(page.entries.length, 1); assert.ok(page.next_cursor);
    const second = await fetch(base + path(f) + "?limit=1&cursor=" + page.next_cursor, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(second.status, 200); const body = parseOrganizationAuditPage(await second.json(), f.orgA);
    assert.notEqual(body.entries[0].reference, page.entries[0].reference); assert.equal(body.next_cursor, null);
    const log = lines.join(""); for (const value of [f.owner.token, f.owner.scope.session_digest, page.next_cursor]) assert.ok(!log.includes(value));
  } finally { await app.close(); }
}));
test("audit HTTP: unauthorized reads cannot expose records or counts including forged organizations", () => fixture(async (f) => {
  await f.record(); const guest = await f.accept(await f.invite()), app = f.app();
  try {
    assert.equal((await request(app, f.owner, "GET", path(f))).statusCode, 200);
    const cases = [
      { url: path(f), headers: {} },
      { url: path(f), headers: { cookie: f.owner.cookie } },
      { url: path(f), headers: { cookie: guest.cookie, "x-zentwine-context-version": String(guest.scope.context_version) } },
      { url: `/api/v1/orgs/${f.orgB}/audit-events`, headers: { cookie: f.owner.cookie, "x-zentwine-context-version": String(f.owner.scope.context_version) } },
      { url: `/api/v1/orgs/${randomUUID()}/audit-events`, headers: { cookie: f.owner.cookie, "x-zentwine-context-version": String(f.owner.scope.context_version) } },
      { url: path(f), headers: { cookie: f.owner.cookie, authorization: "Bearer zt_agent_synthetic", "x-zentwine-context-version": String(f.owner.scope.context_version) } },
      { url: path(f), headers: { cookie: f.owner.cookie, origin: "https://untrusted.example.test", "x-zentwine-context-version": String(f.owner.scope.context_version) } },
    ];
    const codes = [];
    for (const input of cases) {
      const response = await app.inject({ method: "GET", ...input }); codes.push(response.statusCode);
      assert.ok(!response.body.includes("entries")); assert.ok(!response.body.includes("total")); assert.ok(!response.body.includes(f.alice));
    }
    assert.deepEqual(codes, [401, 400, 403, 404, 404, 403, 403]);
  } finally { await app.close(); }
}));
test("audit HTTP: malformed duplicate and unbounded query fields are rejected before reading", () => fixture(async (f) => {
  await f.record(); const app = f.app();
  try {
    for (const q of ["limit=0", "limit=51", "limit=1.2", "limit=no", "limit=1&limit=2", "kind=secrets", "kind=all&kind=member.updated", "cursor=not-valid", "sort=id", "org_id=" + f.orgB, "cursor=" + "a".repeat(1025)]) {
      const result = await request(app, f.owner, "GET", path(f) + "?" + q); assert.equal(result.statusCode, 400, q);
      assert.ok(!result.body.includes("SELECT"));
    }
    const result = await request(app, f.owner, "GET", path(f) + "?kind=invitation.created&limit=1");
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json().entries, []);
  } finally { await app.close(); }
}));
test("audit HTTP: there are no public event editing or deletion endpoints", () => fixture(async (f) => {
  await f.record(); const app = f.app(), before = (await f.organizations.audit(f.owner.scope, {})).entries;
  try {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await request(app, f.owner, method, path(f), {}); assert.ok([401, 403, 404, 405].includes(response.statusCode));
    }
    assert.deepEqual((await f.organizations.audit(f.owner.scope, {})).entries, before);
    const head = await request(app, f.owner, "HEAD", path(f)); assert.equal(head.statusCode, 200); assert.equal(head.body, "");
  } finally { await app.close(); }
}));
test("audit HTTP: database denial is a fixed failure rather than an empty page or raw driver error", () => fixture(async (f) => {
  await f.record(); const app = f.app();
  try {
    await query(f.adminPool, `REVOKE SELECT ON zentwine_organizations.events FROM "${f.managerRole}"`);
    const response = await request(app, f.owner, "GET", path(f)); assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "unavailable");
    for (const text of ["zentwine_organizations", f.managerRole, "entries", "SELECT", "permission denied"]) assert.ok(!response.body.includes(text));
  } finally { await app.close(); }
}));
test("audit HTTP: default disabled mode exposes no audit history", async () => {
  const app = buildApp();
  try { const response = await app.inject({ method: "GET", url: `/api/v1/orgs/${randomUUID()}/audit-events` }); assert.equal(response.statusCode, 401); assert.ok(!response.body.includes("entries")); }
  finally { await app.close(); }
});
