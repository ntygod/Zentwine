import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, query, dsn } from "./setup.mjs";
import {
  createIdentityPool,
  PostgresIdentityRepository,
} from "../../packages/db/dist/index.js";
import {
  secret,
  secretDigest,
} from "../../services/api/dist/identity/security.js";
import { buildApp } from "../../services/api/dist/app.js";
const code = (expected) => (e) => e.code === expected;
const origin = "http://127.0.0.1:5173";
const app = (f) =>
  buildApp({ identity: { repository: f.repo, origins: [origin] } });
const send = (a, path, payload, auth = {}) =>
  a.inject({
    method: "POST",
    url: "/api/v1/auth/" + path,
    headers: {
      origin,
      "x-zentwine-client": "web",
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.csrf ? { "x-zentwine-csrf": auth.csrf } : {}),
    },
    payload,
  });
async function httpLogin(a, f, h = f.alice) {
  const r = await send(a, "login", { ticket: await f.ticket(h) });
  assert.equal(r.statusCode, 200);
  return {
    cookie: r.headers["set-cookie"].split(";")[0],
    csrf: r.json().csrf_token,
    session: r.json().session,
  };
}

test("identity db: runtime is nonprivileged and cannot provision a human", () =>
  fixture(async (f) => {
    await f.repo.assertRuntimeRole();
    await assert.rejects(f.admin.assertRuntimeRole());
    await assert.rejects(
      f.repo.createHuman(randomUUID(), "Denied"),
      code("unavailable"),
    );
  }));
test("identity db: ticket replay races yield one committed session", () =>
  fixture(async (f) => {
    const t = await f.ticket(f.alice);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        f.repo.consumeTicket(secretDigest(t), secretDigest(secret())),
      ),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      (await query(f.adminPool, "SELECT * FROM zentwine_identity.sessions"))
        .rows.length,
      1,
    );
    assert.equal(
      results.filter(
        (x) => x.status === "rejected" && x.reason.code === "invalid_login",
      ).length,
      7,
    );
  }));
test("identity db: duplicate session digest rolls back ticket consumption", () =>
  fixture(async (f) => {
    const old = await f.login();
    const t = await f.ticket(f.alice);
    await assert.rejects(
      f.repo.consumeTicket(secretDigest(t), secretDigest(old.token)),
    );
    const next = await f.repo.consumeTicket(
      secretDigest(t),
      secretDigest(secret()),
    );
    assert.ok(next.id);
  }));
test("identity db: expired tickets fail without allocating a session", () =>
  fixture(async (f) => {
    const t = await f.ticket(f.alice);
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.login_tickets SET expires_at=clock_timestamp()-interval '1 second'",
    );
    await assert.rejects(
      f.repo.consumeTicket(secretDigest(t), secretDigest(secret())),
      code("invalid_login"),
    );
    assert.equal(
      (await query(f.adminPool, "SELECT * FROM zentwine_identity.sessions"))
        .rows.length,
      0,
    );
  }));
test("identity db: disabled identity and old authentication epochs reject tickets", () =>
  fixture(async (f) => {
    const t = await f.ticket(f.alice);
    await f.admin.setHumanStatus(f.alice, "disabled");
    await assert.rejects(
      f.repo.consumeTicket(secretDigest(t), secretDigest(secret())),
      code("invalid_login"),
    );
    await f.admin.setHumanStatus(f.alice, "active");
    await assert.rejects(
      f.repo.consumeTicket(secretDigest(t), secretDigest(secret())),
      code("invalid_login"),
    );
  }));
test("identity db: reconnecting a new repository retains the actual session", () =>
  fixture(async (f) => {
    const x = await f.login();
    const pool = createIdentityPool(dsn(f.appConfig));
    try {
      const second = new PostgresIdentityRepository(pool);
      assert.deepEqual(
        await second.readSession(secretDigest(x.token)),
        x.session,
      );
    } finally {
      await pool.end();
    }
  }));
test("identity db: stored rows contain digests not raw ticket or session values", () =>
  fixture(async (f) => {
    const t = await f.ticket(f.alice),
      raw = secret();
    await f.repo.consumeTicket(secretDigest(t), secretDigest(raw));
    const rows = [
      ...(await query(f.adminPool, "SELECT * FROM zentwine_identity.sessions"))
        .rows,
      ...(
        await query(
          f.adminPool,
          "SELECT * FROM zentwine_identity.login_tickets",
        )
      ).rows,
    ];
    const json = JSON.stringify(rows);
    assert.ok(!json.includes(raw));
    assert.ok(!json.includes(t));
    assert.ok(json.includes(secretDigest(raw)));
  }));
test("identity db: same member number in two organizations never selects by display number", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    const hash = secretDigest(token);
    await f.repo.selectOrganization(hash, f.orgA, 1);
    const a = await f.repo.tenantContext(hash, f.orgA, 2);
    await f.repo.selectOrganization(hash, f.orgB, 2);
    const b = await f.repo.tenantContext(hash, f.orgB, 3);
    assert.equal(a.membership.display_number, b.membership.display_number);
    assert.notEqual(a.membership.id, b.membership.id);
    assert.equal(a.membership.role, "owner");
    assert.equal(b.membership.role, "viewer");
    await assert.rejects(
      f.repo.tenantContext(hash, f.orgA, 2),
      code("version_conflict"),
    );
  }));
test("identity db: ungranted and nonexistent organizations have indistinguishable refusal", () =>
  fixture(async (f) => {
    const { token } = await f.login(f.bob);
    for (const org of [f.orgA, randomUUID()])
      await assert.rejects(
        f.repo.selectOrganization(secretDigest(token), org, 1),
        code("unavailable_resource"),
      );
  }));
test("identity db: parallel organization switches require the same current version only once", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    const hash = secretDigest(token);
    const r = await Promise.allSettled([
      f.repo.selectOrganization(hash, f.orgA, 1),
      f.repo.selectOrganization(hash, f.orgB, 1),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      r.filter(
        (x) => x.status === "rejected" && x.reason.code === "version_conflict",
      ).length,
      1,
    );
  }));
test("identity db: membership revocation invalidates the next read without cached permissions", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    const hash = secretDigest(token);
    await f.repo.selectOrganization(hash, f.orgA, 1);
    await f.admin.setMembership(
      randomUUID(),
      f.orgA,
      f.alice,
      "MEM-1",
      "owner",
      "revoked",
    );
    await assert.rejects(
      f.repo.tenantContext(hash, f.orgA, 2),
      code("unavailable_resource"),
    );
    const session = await f.repo.readSession(hash);
    assert.equal(session.active_org_id, null);
    assert.equal(
      session.organizations.some((o) => o.id === f.orgA),
      false,
    );
    await f.repo.selectOrganization(hash, f.orgB, 2);
  }));
test("identity db: role downgrades are re-read even without a session version change", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    const hash = secretDigest(token);
    await f.repo.selectOrganization(hash, f.orgA, 1);
    await f.admin.setMembership(
      randomUUID(),
      f.orgA,
      f.alice,
      "MEM-1",
      "viewer",
      "active",
    );
    const c = await f.repo.tenantContext(hash, f.orgA, 2);
    assert.equal(c.membership.role, "viewer");
    assert.equal(c.membership.object_version, 2);
  }));
test("identity db: organization disabled denies existing membership", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    const hash = secretDigest(token);
    await f.repo.selectOrganization(hash, f.orgA, 1);
    await f.admin.setOrganizationStatus(f.orgA, "disabled");
    await assert.rejects(
      f.repo.tenantContext(hash, f.orgA, 2),
      code("unavailable_resource"),
    );
  }));
test("identity db: human disabled revokes all old sessions permanently", () =>
  fixture(async (f) => {
    const a = await f.login(),
      b = await f.login();
    await f.admin.setHumanStatus(f.alice, "disabled");
    await assert.rejects(
      f.repo.readSession(secretDigest(a.token)),
      code("authentication_required"),
    );
    await f.admin.setHumanStatus(f.alice, "active");
    await assert.rejects(
      f.repo.readSession(secretDigest(b.token)),
      code("authentication_required"),
    );
  }));
test("identity db: idle expiry cannot be revived by reads or rotation", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.sessions SET idle_expires_at=clock_timestamp()-interval '1 second'",
    );
    await assert.rejects(
      f.repo.readSession(secretDigest(token)),
      code("authentication_required"),
    );
    await assert.rejects(
      f.repo.rotateSession(secretDigest(token), secretDigest(secret()), 1),
      code("authentication_required"),
    );
  }));
test("identity db: absolute expiry dominates idle extension", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.sessions SET created_at=clock_timestamp()-interval '9 hours',expires_at=clock_timestamp()-interval '1 second',idle_expires_at=clock_timestamp()-interval '1 second'",
    );
    await assert.rejects(
      f.repo.readSession(secretDigest(token)),
      code("authentication_required"),
    );
  }));
test("identity db: rotation revokes the old secret and retains original absolute deadline", () =>
  fixture(async (f) => {
    const { token, session } = await f.login();
    const next = secret();
    const rotated = await f.repo.rotateSession(
      secretDigest(token),
      secretDigest(next),
      1,
    );
    assert.equal(rotated.expires_at, session.expires_at);
    assert.notEqual(rotated.id, session.id);
    assert.equal(rotated.context_version, 2);
    await assert.rejects(
      f.repo.readSession(secretDigest(token)),
      code("authentication_required"),
    );
    assert.equal((await f.repo.readSession(secretDigest(next))).id, rotated.id);
  }));
test("identity db: logout is repeatable and prevents replay", () =>
  fixture(async (f) => {
    const { token } = await f.login();
    await f.repo.revokeSession(secretDigest(token));
    await f.repo.revokeSession(secretDigest(token));
    await assert.rejects(
      f.repo.readSession(secretDigest(token)),
      code("authentication_required"),
    );
  }));
test("identity http: actual login switch context and logout round trip", () =>
  fixture(async (f) => {
    const a = app(f);
    try {
      const auth = await httpLogin(a, f);
      assert.equal(auth.session.organizations.length, 2);
      const selected = await send(
        a,
        "organization",
        { org_id: f.orgA, expected_version: 1 },
        auth,
      );
      assert.equal(selected.statusCode, 200);
      const c = await a.inject({
        url: `/api/v1/orgs/${f.orgA}/context`,
        headers: {
          cookie: auth.cookie,
          "x-zentwine-context-version": "2",
          "x-human-id": f.bob,
        },
      });
      assert.equal(c.statusCode, 200);
      assert.equal(c.json().context.human.id, f.alice);
      assert.equal((await send(a, "logout", {}, auth)).statusCode, 204);
      assert.equal(
        (
          await a.inject({
            url: "/api/v1/auth/session",
            headers: { cookie: auth.cookie },
          })
        ).statusCode,
        401,
      );
    } finally {
      await a.close();
    }
  }));
test("identity http: restart API preserves session and selected organization", () =>
  fixture(async (f) => {
    let a = app(f);
    const auth = await httpLogin(a, f);
    await send(
      a,
      "organization",
      { org_id: f.orgA, expected_version: 1 },
      auth,
    );
    await a.close();
    a = app(f);
    try {
      const r = await a.inject({
        url: "/api/v1/auth/session",
        headers: { cookie: auth.cookie },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().session.active_org_id, f.orgA);
    } finally {
      await a.close();
    }
  }));
test("identity http: two users with parallel requests never share context", () =>
  fixture(async (f) => {
    const a = app(f);
    try {
      const alice = await httpLogin(a, f),
        bob = await httpLogin(a, f, f.bob);
      await send(
        a,
        "organization",
        { org_id: f.orgA, expected_version: 1 },
        alice,
      );
      await send(
        a,
        "organization",
        { org_id: f.orgB, expected_version: 1 },
        bob,
      );
      const items = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const who = i % 2 ? bob : alice;
          const org = i % 2 ? f.orgB : f.orgA;
          const r = await a.inject({
            url: `/api/v1/orgs/${org}/context`,
            headers: { cookie: who.cookie, "x-zentwine-context-version": "2" },
          });
          assert.equal(r.statusCode, 200);
          assert.equal(r.json().context.human.id, i % 2 ? f.bob : f.alice);
          assert.equal(r.json().context.organization.id, org);
        }),
      );
      assert.equal(items.length, 20);
    } finally {
      await a.close();
    }
  }));
test("identity http: stale window and foreign target cannot read data", () =>
  fixture(async (f) => {
    const a = app(f);
    try {
      const auth = await httpLogin(a, f);
      await send(
        a,
        "organization",
        { org_id: f.orgA, expected_version: 1 },
        auth,
      );
      await send(
        a,
        "organization",
        { org_id: f.orgB, expected_version: 2 },
        auth,
      );
      assert.equal(
        (
          await a.inject({
            url: `/api/v1/orgs/${f.orgA}/context`,
            headers: { cookie: auth.cookie, "x-zentwine-context-version": "2" },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await a.inject({
            url: `/api/v1/orgs/${f.orgA}/context`,
            headers: { cookie: auth.cookie, "x-zentwine-context-version": "3" },
          })
        ).statusCode,
        404,
      );
    } finally {
      await a.close();
    }
  }));
test("identity http: cookies and raw credentials never appear in structured request logs", () =>
  fixture(async (f) => {
    const lines = [];
    const a = buildApp({
      logSink: (line) => lines.push(line),
      identity: { repository: f.repo, origins: [origin] },
    });
    try {
      const t = await f.ticket(f.alice);
      const r = await send(a, "login", { ticket: t });
      assert.equal(r.statusCode, 200);
      const cookie = r.headers["set-cookie"].split(";")[0];
      await a.inject({ url: "/api/v1/auth/session", headers: { cookie } });
      const log = lines.join("");
      assert.ok(!log.includes(t));
      assert.ok(!log.includes(cookie.split("=")[1]));
      assert.ok(!r.body.includes(t));
      assert.ok(!r.body.includes(cookie.split("=")[1]));
    } finally {
      await a.close();
    }
  }));
test("identity http: post login replaces supplied session instead of fixing it", () =>
  fixture(async (f) => {
    const a = app(f);
    try {
      const old = await httpLogin(a, f);
      const r = await send(a, "login", { ticket: await f.ticket(f.bob) }, old);
      assert.equal(r.statusCode, 200);
      assert.notEqual(r.headers["set-cookie"].split(";")[0], old.cookie);
      assert.equal(
        (
          await a.inject({
            url: "/api/v1/auth/session",
            headers: { cookie: old.cookie },
          })
        ).statusCode,
        401,
      );
    } finally {
      await a.close();
    }
  }));
