import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fixture, origin } from "./setup.mjs";
const { WebSocket } = createRequire(
  new URL("../../services/api/package.json", import.meta.url),
)("ws");
async function live(f, fn) {
  const app = f.app(),
    sockets = [];
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = app.server.address().port;
  const connect = async (auth, overrides = {}) => {
    const url =
      `ws://127.0.0.1:${port}/api/v1/policy/socket?org_id=${auth.scope.org_id}&context_version=${auth.scope.context_version}` +
      (overrides.query ?? "");
    const ws = new WebSocket(url, {
      headers: {
        origin,
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...overrides.headers,
      },
    });
    sockets.push(ws);
    ws.on("error", () => {});
    await once(ws, "open");
    return ws;
  };
  try {
    return await fn({ app, connect });
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
}
async function exchange(ws, auth, input) {
  const response = once(ws, "message");
  ws.send(JSON.stringify({ csrf_token: auth.csrf, ...input }));
  return JSON.parse((await response)[0].toString());
}
const read = (id) => ({ operation: "catalog.read", resource_id: id });
test("policy WS real: cookie and exact origin are required before upgrade", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth();
      await assert.rejects(
        connect(auth, { headers: { origin: "http://evil.invalid" } }),
      );
      await assert.rejects(connect({ ...auth, cookie: "" }));
      await assert.rejects(connect(auth, { query: "&role=owner" }));
    }),
  ));
test("policy WS real: first message requires session-bound CSRF", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth);
      const bad = await exchange(
        ws,
        { ...auth, csrf: "not-a-token" },
        read(f.a.id),
      );
      assert.equal(bad.code, "forbidden");
      const good = await exchange(ws, auth, read(f.a.id));
      assert.equal(good.type, "result");
      assert.equal(good.resource.id, f.a.id);
    }),
  ));
test("policy WS real: direct viewer mutation denied, authorized read allowed", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(f.alice, f.orgB),
        ws = await connect(auth);
      assert.equal((await exchange(ws, auth, read(f.b.id))).type, "result");
      const r = await exchange(ws, auth, {
        operation: "catalog.rename",
        resource_id: f.b.id,
        display_name: "no",
        expected_version: 1,
        expected_policy_revision: await f.revision(f.orgB),
      });
      assert.equal(r.code, "forbidden");
    }),
  ));
test("policy WS real: approved ordinary metadata mutation persists", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth);
      const r = await exchange(ws, auth, {
        operation: "catalog.rename",
        resource_id: f.a.id,
        display_name: "Via WS",
        expected_version: 1,
        expected_policy_revision: await f.revision(),
      });
      assert.equal(r.resource.object_version, 2);
      assert.equal(
        (await f.policy.readResource(auth.scope, f.a.id)).resource.display_name,
        "Via WS",
      );
    }),
  ));
test("policy WS real: established connection cannot reuse access after membership revocation", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(f.bob, f.orgB),
        ws = await connect(auth);
      await exchange(ws, auth, read(f.b.id));
      await f.admin.setMembership(
        randomUUID(),
        f.orgB,
        f.bob,
        "MEM-2",
        "member",
        "revoked",
      );
      const r = await exchange(ws, auth, read(f.b.id));
      assert.equal(r.code, "unavailable_resource");
      assert.equal(r.resource, undefined);
    }),
  ));
test("policy WS real: logout invalidates next frame", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth);
      await exchange(ws, auth, read(f.a.id));
      await f.repo.revokeSession(auth.scope.session_digest);
      assert.equal(
        (await exchange(ws, auth, read(f.a.id))).code,
        "authentication_required",
      );
    }),
  ));
test("policy WS real: organization switch invalidates old connection context", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth);
      await f.repo.selectOrganization(auth.scope.session_digest, f.orgB, 2);
      assert.equal(
        (await exchange(ws, auth, read(f.a.id))).code,
        "version_conflict",
      );
    }),
  ));
test("policy WS real: newly denied resource cannot leak through existing socket", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth);
      await exchange(ws, auth, read(f.a.id));
      await f.add(f.alice, f.a, { action: "resource.read", effect: "deny" });
      assert.equal(
        (await exchange(ws, auth, read(f.a.id))).code,
        "unavailable_resource",
      );
    }),
  ));
test("policy WS real: spoofed principal and environment are not accepted tool arguments", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth);
      const r = await exchange(ws, auth, {
        ...read(f.a.id),
        role: "owner",
        environment: "development",
      });
      assert.equal(r.code, "invalid_input");
    }),
  ));
test("policy WS real: foreign resource has the same unavailable error", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth);
      const r = await exchange(ws, auth, read(f.b.id));
      assert.equal(r.code, "unavailable_resource");
      assert.equal(r.resource, undefined);
    }),
  ));
test("policy WS real: binary frames are refused without tool execution", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth),
        closed = once(ws, "close");
      ws.send(Buffer.from("not a JSON text frame"));
      await closed;
      assert.equal(
        (await f.policy.readResource(auth.scope, f.a.id)).resource
          .object_version,
        1,
      );
    }),
  ));
test("policy WS real: payload size limit terminates oversized input", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth(),
        ws = await connect(auth),
        closed = once(ws, "close");
      ws.send("x".repeat(10000));
      await closed;
    }),
  ));
test("policy WS real: one session cannot occupy more than four sockets", () =>
  fixture((f) =>
    live(f, async ({ connect }) => {
      const auth = await f.auth();
      for (let i = 0; i < 4; i++) await connect(auth);
      await assert.rejects(connect(auth));
    }),
  ));
test("policy WS real: closing server releases upgraded connections", () =>
  fixture((f) =>
    live(f, async ({ connect, app }) => {
      const auth = await f.auth(),
        ws = await connect(auth),
        closed = once(ws, "close");
      await app.close();
      await closed;
      assert.ok([2, 3].includes(ws.readyState));
    }),
  ));
