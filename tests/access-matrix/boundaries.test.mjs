/** Synthetic records; real disposable PostgreSQL, loopback HTTP and established WebSocket. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
import {
  fixture,
  origin,
  waitForLock,
} from "../organizations/setup.mjs";
import {
  surfaces,
  scenarios,
  caseId,
} from "../../scripts/access-matrix.mjs";
const { WebSocket } = createRequire(
  new URL("../../services/api/package.json", import.meta.url),
)("ws");
const reserved = new Set(["files", "preview", "export"]);
const base = (org) => `/api/v1/orgs/${org}`;
const readCommand = (id) => ({ operation: "catalog.read", resource_id: id });
async function transport(f, surface, auth, work) {
  const lines = [],
    sockets = [],
    app = f.app({ logSink: (line) => lines.push(line) });
  let ws;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = app.server.address().port;
    const http = async (path, method = "GET", body) => {
      const result = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          origin,
          cookie: auth.cookie,
          "x-zentwine-client": "web",
          "x-zentwine-csrf": auth.csrf,
          "x-zentwine-context-version": String(auth.scope.context_version),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(result.headers.get("cache-control"), "no-store");
      const text = await result.text();
      for (const secret of [auth.token, auth.csrf])
        assert.ok(!text.includes(secret));
      return { status: result.status, body: text ? JSON.parse(text) : null };
    };
    const reopen = async () => {
      if (surface !== "websocket") return;
      ws?.terminate();
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/policy/socket?org_id=${auth.scope.org_id}&context_version=${auth.scope.context_version}`,
        { headers: { origin, cookie: auth.cookie } },
      );
      sockets.push(ws);
      ws.on("error", () => {});
      await once(ws, "open", { signal: AbortSignal.timeout(5000) });
    };
    const exchange = async (command) => {
      const received = once(ws, "message", {
        signal: AbortSignal.timeout(10000),
      });
      ws.send(JSON.stringify({ csrf_token: auth.csrf, ...command }));
      const body = JSON.parse((await received)[0].toString());
      return { status: body.type === "result" ? 200 : 403, body };
    };
    const search = (q = "") =>
      http(base(f.orgA) + "/catalog/search?q=" + encodeURIComponent(q));
    const read = (id = f.a.id) => {
      if (surface === "websocket") return exchange(readCommand(id));
      if (surface === "search") return search();
      if (surface === "files") return http(base(f.orgA) + "/files/" + id);
      if (surface === "preview")
        return http(base(f.orgA) + `/resources/${id}/preview`);
      if (surface === "export")
        return http(base(f.orgA) + `/resources/${id}/export`, "POST", {});
      return http(base(f.orgA) + "/resources/" + id);
    };
    const rename = async () => {
      const input = {
        display_name: "MUST-NOT-WRITE",
        expected_version: 1,
        expected_policy_revision: await f.revision(),
      };
      return surface === "websocket"
        ? exchange({
            operation: "catalog.rename",
            resource_id: f.a.id,
            ...input,
          })
        : http(base(f.orgA) + "/resources/" + f.a.id, "PATCH", input);
    };
    await reopen();
    // An actually authorized request must succeed before ANY denial is counted.
    const positive = await http(base(f.orgA) + "/resources/" + f.a.id);
    assert.equal(positive.status, 200);
    assert.equal(positive.body.resource.id, f.a.id);
    await work({ read, search, rename, http, reopen });
    const logs = lines.join("");
    for (const secret of [auth.token, auth.csrf, auth.scope.session_digest])
      assert.ok(!logs.includes(secret));
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
  }
}
function allowed(surface, response, id) {
  assert.equal(response.status, 200);
  if (surface === "search") {
    assert.ok(Array.isArray(response.body));
    assert.ok(response.body.some((r) => r.id === id));
  } else {
    assert.equal(response.body.resource.id, id);
  }
}
function rejected(response, code = "unavailable_resource") {
  assert.ok(response.status >= 400 && response.status < 500);
  assert.equal(response.body.code, code);
  assert.equal(response.body.resource, undefined);
  assert.ok(!JSON.stringify(response.body).includes("Synthetic catalog"));
}
async function downgrade(f) {
  const member = (await f.organizations.members(f.owner.scope)).find(
    (m) => m.human_id === f.bob,
  );
  assert.equal(member.role, "owner");
  await f.organizations.updateMember(
    f.owner.scope,
    member.id,
    "viewer",
    "active",
    member.object_version,
  );
}
/** Commit ordering, not a sleep: revoker owns org lock and waits to append its event. */
async function revocationRace(f, read, implemented) {
  const lock = await f.adminPool.connect();
  let revocation, pending;
  try {
    await lock.query("BEGIN");
    await lock.query(
      "LOCK TABLE zentwine_organizations.events IN ACCESS EXCLUSIVE MODE",
    );
    revocation = f.organizations.revokeOrganizationSessions(
      f.owner.scope,
      f.bob,
    );
    // Observe all promises even when the wait/assertion itself fails.
    revocation.catch(() => {});
    await waitForLock(f.adminPool, "INSERT INTO zentwine_organizations.events");
    let returned = false;
    pending = read().then((r) => {
      returned = true;
      return r;
    });
    pending.catch(() => {});
    if (implemented) {
      await waitForLock(f.adminPool, "pg_advisory_xact_lock_shared");
      assert.equal(returned, false);
    } else {
      // Missing routes deny immediately. This is NOT a concurrent business-path test.
      rejected(await pending, "unauthenticated");
    }
    await lock.query("COMMIT");
    await revocation;
    const result = await pending;
    rejected(result, implemented ? "unavailable_resource" : "unauthenticated");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    await Promise.allSettled([revocation, pending].filter(Boolean));
  }
}
async function implementedCase(f, surface, scenario, auth, c) {
  allowed(surface, await c.read(), f.a.id);
  if (scenario === "cross_tenant") {
    const hidden = await f.registerResource({
      visibility: "private",
      display_name: "Hidden-Matrix-Canary",
    });
    if (surface === "search") {
      const all = await c.search();
      assert.ok(!all.body.some((r) => [hidden.id, f.b.id].includes(r.id)));
      const result = await c.search(hidden.display_name);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, []);
      const foreign = await c.http(base(f.orgB) + "/catalog/search?q=");
      rejected(foreign);
    } else {
      const foreign = await c.read(f.b.id);
      rejected(foreign);
      await c.reopen();
      const absent = await c.read(randomUUID());
      rejected(absent);
      assert.equal(foreign.body.code, absent.body.code);
      await c.reopen();
      rejected(await c.read(hidden.id));
    }
  } else if (scenario === "role_downgrade") {
    const cached = await f.policy.evaluate(auth.scope, f.a.id, "resource.update");
    assert.equal(cached.outcome, "allow");
    await downgrade(f);
    rejected(await c.read());
    const fresh = await f.auth(f.bob);
    await transport(f, surface, fresh, async (next) => {
      allowed(surface, await next.read(), f.a.id);
      rejected(await next.rename(), "forbidden");
      rejected(await next.http(base(f.orgA) + "/members"), "forbidden");
    });
    const resource = await f.policy.readResource(f.owner.scope, f.a.id);
    assert.equal(resource.resource.object_version, 1);
    assert.equal(resource.resource.display_name, "Synthetic catalog");
  } else if (scenario === "stale_authority") {
    const cached = await f.policy.evaluate(auth.scope, f.a.id, "resource.read");
    assert.equal(cached.outcome, "allow");
    await f.add(f.bob, f.a, { action: "resource.read", effect: "deny" });
    const result = await c.read();
    if (surface === "search") {
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, []);
    } else rejected(result);
    assert.equal(
      (await f.policy.evaluate(auth.scope, f.a.id, "resource.read")).outcome,
      "deny",
    );
    assert.equal(cached.outcome, "allow");
  } else {
    assert.equal(scenario, "concurrent_revocation");
    await revocationRace(f, c.read, true);
    const other = await f.auth(f.bob, f.orgB);
    assert.equal(
      (await f.policy.readResource(other.scope, f.b.id)).resource.id,
      f.b.id,
    );
  }
}
async function reservedCase(f, surface, scenario, c) {
  rejected(await c.read(), "unauthenticated");
  if (scenario === "cross_tenant") {
    rejected(await c.read(f.b.id), "unauthenticated");
    rejected(await c.read(randomUUID()), "unauthenticated");
  } else if (scenario === "role_downgrade") {
    await downgrade(f);
    rejected(await c.read(), "unauthenticated");
    await transport(f, surface, await f.auth(f.bob), async (next) => {
      rejected(await next.read(), "unauthenticated");
    });
  } else if (scenario === "stale_authority") {
    await f.organizations.revokeOrganizationSessions(f.owner.scope, f.bob);
    rejected(await c.read(), "unauthenticated");
  } else {
    assert.equal(scenario, "concurrent_revocation");
    await revocationRace(f, c.read, false);
  }
}
for (const surface of surfaces)
  for (const scenario of scenarios)
    test(caseId(surface, scenario), () =>
      fixture(async (f) => {
        const auth = await f.auth(f.bob);
        await transport(f, surface, auth, (c) =>
          reserved.has(surface)
            ? reservedCase(f, surface, scenario, c)
            : implementedCase(f, surface, scenario, auth, c),
        );
      }),
    );
