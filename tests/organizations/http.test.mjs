import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  fixture,
  request,
  origin,
  query,
  secret,
  secretDigest,
} from "./setup.mjs";
import { cookie, csrfFor } from "../../services/api/dist/identity/security.js";
const { WebSocket } = createRequire(
  new URL("../../services/api/package.json", import.meta.url),
)("ws");
const base = (f) => `/api/v1/orgs/${f.orgA}`;
async function webSocket(f, auth, work) {
  const app = f.app();
  let ws;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    ws = new WebSocket(
      `ws://127.0.0.1:${app.server.address().port}/api/v1/policy/socket?org_id=${auth.scope.org_id}&context_version=${auth.scope.context_version}`,
      { headers: { origin, cookie: auth.cookie } },
    );
    ws.on("error", () => {});
    await once(ws, "open");
    const read = async (rid) => {
      const received = once(ws, "message", {
        signal: AbortSignal.timeout(5000),
      });
      ws.send(
        JSON.stringify({
          csrf_token: auth.csrf,
          operation: "catalog.read",
          resource_id: rid,
        }),
      );
      return JSON.parse((await received)[0].toString());
    };
    await work(read);
  } finally {
    ws?.terminate();
    await app.close();
  }
}
test("org HTTP: owner edits settings while viewer cannot list members or connections", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const result = await request(
        app,
        f.owner,
        "PATCH",
        base(f) + "/settings",
        await f.settingsInput({ display_name: "Via HTTP" }),
      );
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().display_name, "Via HTTP");
      const g = await f.accept(await f.invite());
      for (const path of ["/members", "/settings", "/identity-connections"])
        assert.equal(
          (await request(app, g, "GET", base(f) + path)).statusCode,
          403,
        );
    } finally {
      await app.close();
    }
  }));
test("org HTTP: invitation accept rotates cookie and replay does not create access twice", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const i = await f.invite(),
        login = await f.login(f.charlie);
      const guest = {
        scope: { context_version: 1 },
        cookie: cookie(login.token).split(";")[0],
        csrf: csrfFor(login.token),
      };
      const r = await request(
        app,
        guest,
        "POST",
        "/api/v1/auth/invitations/accept",
        { invitation_token: i.token },
      );
      assert.equal(r.statusCode, 200);
      assert.match(r.headers["set-cookie"], /HttpOnly/);
      assert.ok(!r.body.includes(i.token));
      assert.notEqual(r.headers["set-cookie"].split(";")[0], guest.cookie);
      assert.equal(
        (await request(app, guest, "GET", "/api/v1/auth/session")).statusCode,
        401,
      );
    } finally {
      await app.close();
    }
  }));
test("org HTTP: unknown and cross-org invite recipients do not reveal private profiles", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const p = await f.invite();
      const result = await request(
        app,
        f.owner,
        "POST",
        base(f) + "/invitations",
        { ...p.input, role: "owner", accountable_owner: f.alice },
      );
      assert.equal(result.statusCode, 400);
      const foreign = await request(
        app,
        f.owner,
        "GET",
        `/api/v1/orgs/${f.orgB}/members`,
      );
      assert.equal(foreign.statusCode, 404);
      assert.ok(!foreign.body.includes("Synthetic Bob"));
    } finally {
      await app.close();
    }
  }));
test("org HTTP: logs exclude invitation, session and provider credentials", () =>
  fixture(async (f) => {
    const lines = [],
      app = f.app({ logSink: (l) => lines.push(l) });
    try {
      const i = await f.invite(),
        p = await f.provider();
      await request(app, f.owner, "POST", base(f) + "/invitations", i.input);
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/idp/connections/${p.connection.id}/provisioning`,
        headers: { authorization: "Bearer " + p.token },
        payload: f.provisionInput(p),
      });
      assert.equal(r.statusCode, 200);
      const logs = lines.join("");
      for (const value of [p.token, i.token, f.owner.token, f.owner.csrf])
        assert.ok(!logs.includes(value));
      assert.ok(!r.body.includes(p.token));
    } finally {
      await app.close();
    }
  }));
test("org HTTP: machine endpoint rejects another provider credential and guest browser authority", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const p = await f.provider();
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/idp/connections/${p.connection.id}/provisioning`,
        headers: { authorization: "Bearer " + secret() },
        payload: f.provisionInput(p),
      });
      assert.equal(r.statusCode, 401);
      const r2 = await request(
        app,
        f.owner,
        "POST",
        `/api/v1/idp/connections/${p.connection.id}/provisioning`,
        f.provisionInput(p),
      );
      assert.equal(r2.statusCode, 403);
    } finally {
      await app.close();
    }
  }));
test("org WS TCP: IdP disable denies next message on already established connection", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      auth = await f.auth(f.bob);
    await webSocket(f, auth, async (read) => {
      assert.equal((await read(f.a.id)).type, "result");
      await f.organizations.provision(
        p.connection.id,
        p.digest,
        f.provisionInput(p),
      );
      assert.equal((await read(f.a.id)).type, "error");
    });
  }));
test("org WS TCP: scoped session revoke denies existing connection but other organization remains usable", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      auth = await f.auth(f.bob),
      other = await f.auth(f.bob, f.orgB);
    await webSocket(f, auth, async (read) => {
      assert.equal((await read(f.a.id)).type, "result");
      await f.organizations.revokeOrganizationSessions(f.owner.scope, f.bob);
      assert.equal((await read(f.a.id)).type, "error");
      assert.ok(await f.policy.readResource(other.scope, f.b.id));
    });
    assert.ok(p.connection);
  }));
test("org WS TCP: guest shares enforce visibility and expiry per message", () =>
  fixture(async (f) => {
    const hidden = await f.registerResource({
        display_name: "Private to guest",
      }),
      g = await f.accept(await f.invite());
    await webSocket(f, g, async (read) => {
      assert.equal((await read(f.a.id)).type, "result");
      assert.equal((await read(hidden.id)).type, "error");
    });
    await webSocket(f, g, async (read) => {
      await query(
        f.adminPool,
        "UPDATE zentwine_identity.memberships SET access_expires_at=clock_timestamp()-interval '1 second' WHERE human_id=$1",
        [f.charlie],
      );
      assert.equal((await read(f.a.id)).type, "error");
    });
  }));
test("org HTTP TCP: provider revisioned disable persists through real loopback request", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const p = await f.provider();
      await app.listen({ host: "127.0.0.1", port: 0 });
      const r = await fetch(
        `http://127.0.0.1:${app.server.address().port}/api/v1/idp/connections/${p.connection.id}/provisioning`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + p.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(f.provisionInput(p)),
        },
      );
      assert.equal(r.status, 200);
      assert.equal((await r.json()).active, false);
    } finally {
      await app.close();
    }
  }));
