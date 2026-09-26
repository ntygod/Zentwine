import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture,
  query,
  guard,
  execution,
  fails,
  origin,
  request,
  waitForLock,
} from "./setup.mjs";
import { fixture as emergencyFixture } from "../emergency/setup.mjs";
import { PostgresApprovalRepository } from "../../packages/db/dist/index.js";
import { parseApprovalInboxPage } from "../../packages/contracts/dist/index.js";
const select = (lane = "mine", extra = {}) => ({
  lane,
  state: "all",
  limit: 20,
  ...extra,
});
const ids = (p) => p.entries.map((e) => e.id);
const count = async (f, table) =>
  (
    await query(
      f.adminPool,
      `SELECT count(*)::integer AS n FROM zentwine_approvals.${table}`,
    )
  ).rows[0].n;
test("inbox PG: requester and reviewer discover disjoint authorized requests without mutations", () =>
  fixture(async (f) => {
    const alice = await f.propose(),
      bob = await f.propose({ display_name: "By Bob" }, f.reviewer.scope);
    const before = await Promise.all(
      ["requests", "events", "decisions", "permits", "receipts"].map((t) =>
        count(f, t),
      ),
    );
    const mine = await f.approvals.list(f.owner.scope, select()),
      review = await f.approvals.list(f.reviewer.scope, select("review"));
    assert.deepEqual(ids(mine), [alice.id]);
    assert.deepEqual(ids(review), [alice.id]);
    assert.deepEqual(ids(await f.approvals.list(f.reviewer.scope, select())), [
      bob.id,
    ]);
    assert.equal(mine.authorization, false);
    parseApprovalInboxPage(mine, f.orgA, f.alice, select());
    assert.deepEqual(
      await Promise.all(
        ["requests", "events", "decisions", "permits", "receipts"].map((t) =>
          count(f, t),
        ),
      ),
      before,
    );
  }));
test("inbox PG: ordinary member reads own requests but cannot enumerate colleagues", () =>
  fixture(async (f) => {
    const alice = await f.propose();
    await f.propose({}, f.reviewer.scope);
    await f.admin.setMembership(
      randomUUID(),
      f.orgA,
      f.alice,
      "MEM-1",
      "member",
      "active",
    );
    const user = await f.auth(f.alice);
    assert.deepEqual(ids(await f.approvals.list(user.scope, select())), [
      alice.id,
    ]);
    await assert.rejects(
      f.approvals.list(user.scope, select("review")),
      fails("forbidden"),
    );
  }));
test("inbox PG: hidden restricted records are filtered before limit and never affect continuation", () =>
  fixture(async (f) => {
    const visible = await f.propose({ display_name: "Visible only" });
    const hidden = await f.registerResource({
      visibility: "restricted",
      owner_human_id: f.alice,
    });
    for (let i = 0; i < 4; i++)
      await f.propose({ resource_id: hidden.id, display_name: "Secret " + i });
    const p = await f.approvals.list(
      f.reviewer.scope,
      select("review", { limit: 1 }),
    );
    assert.deepEqual(ids(p), [visible.id]);
    assert.equal(p.next_cursor, null);
    assert.ok(!JSON.stringify(p).includes(hidden.id));
    assert.ok(!JSON.stringify(p).includes("Secret"));
  }));
test("inbox PG: explicit deny wins over ownership and grant changes require fresh pages", () =>
  fixture(async (f) => {
    const a = await f.propose();
    assert.deepEqual(
      ids(await f.approvals.list(f.reviewer.scope, select("review"))),
      [a.id],
    );
    await f.add(f.bob, f.a, { action: "resource.read", effect: "deny" });
    assert.deepEqual(
      ids(await f.approvals.list(f.reviewer.scope, select("review"))),
      [],
    );
    await assert.rejects(
      f.approvals.inspect(f.reviewer.scope, a.id),
      fails("unavailable_resource"),
    );
    assert.deepEqual(ids(await f.approvals.list(f.owner.scope, select())), [
      a.id,
    ]);
  }));
test("inbox PG: explicitly shared restricted resources use the same visibility as detail", () =>
  fixture(async (f) => {
    const r = await f.registerResource({
      visibility: "restricted",
      owner_human_id: f.alice,
    });
    const a = await f.propose({ resource_id: r.id });
    assert.deepEqual(
      ids(await f.approvals.list(f.reviewer.scope, select("review"))),
      [],
    );
    await f.add(f.bob, r, { action: "resource.read", effect: "allow" });
    assert.deepEqual(
      ids(await f.approvals.list(f.reviewer.scope, select("review"))),
      [a.id],
    );
    assert.equal((await f.approvals.inspect(f.reviewer.scope, a.id)).id, a.id);
  }));
test("inbox PG: keyset pages exclude newly created requests until refresh", () =>
  fixture(async (f) => {
    const created = [];
    for (let i = 0; i < 5; i++)
      created.push((await f.propose({ display_name: "Page " + i })).id);
    const q = select("mine", { limit: 2 }),
      first = await f.approvals.list(f.owner.scope, q);
    assert.deepEqual(ids(first), created.slice(3).reverse());
    assert.ok(first.next_cursor);
    const added = await f.propose({ display_name: "After boundary" });
    const second = await f.approvals.list(f.owner.scope, {
      ...q,
      cursor: first.next_cursor,
    });
    const third = await f.approvals.list(f.owner.scope, {
      ...q,
      cursor: second.next_cursor,
    });
    assert.deepEqual(
      [...ids(first), ...ids(second), ...ids(third)],
      created.reverse(),
    );
    assert.equal(third.next_cursor, null);
    assert.equal(
      (await f.approvals.list(f.owner.scope, q)).entries[0].id,
      added.id,
    );
  }));
test("inbox PG: big event sequences paginate without number precision loss", () =>
  fixture(async (f) => {
    await query(
      f.adminPool,
      "SELECT setval(pg_get_serial_sequence('zentwine_approvals.events','sequence'),9007199254741000,false)",
    );
    const a = await f.propose(),
      b = await f.propose();
    const q = select("mine", { limit: 1 });
    const first = await f.approvals.list(f.owner.scope, q);
    assert.deepEqual(ids(first), [b.id]);
    assert.deepEqual(
      ids(
        await f.approvals.list(f.owner.scope, {
          ...q,
          cursor: first.next_cursor,
        }),
      ),
      [a.id],
    );
  }));
test("inbox PG: states and expiry use observed time without updating stored requests", () =>
  fixture(async (f) => {
    const pending = await f.propose(),
      expired = await f.propose({ display_name: "Expired" });
    const rejected = await f.propose({ display_name: "Rejected" });
    await f.approvals.decide(
      f.reviewer.scope,
      rejected.id,
      guard(rejected),
      "reject",
    );
    await query(
      f.adminPool,
      "UPDATE zentwine_approvals.requests SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])",
      [[expired.id, rejected.id]],
    );
    const p = await f.approvals.list(
      f.owner.scope,
      select("mine", { state: "pending" }),
    );
    assert.deepEqual(ids(p), [pending.id]);
    assert.deepEqual(
      ids(
        await f.approvals.list(
          f.owner.scope,
          select("mine", { state: "expired" }),
        ),
      ),
      [expired.id],
    );
    const rejectedPage = await f.approvals.list(
      f.owner.scope,
      select("mine", { state: "rejected" }),
    );
    assert.deepEqual(ids(rejectedPage), [rejected.id]);
    assert.equal(rejectedPage.entries[0].expired, false);
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT state FROM zentwine_approvals.requests WHERE id=$1",
          [expired.id],
        )
      ).rows[0].state,
      "pending",
    );
  }));
test("inbox PG: current status changes do not duplicate entries or create new snapshots", () =>
  fixture(async (f) => {
    const a = await f.propose(),
      b = await f.propose();
    const q = select("mine", { limit: 1 });
    const first = await f.approvals.list(f.owner.scope, q);
    assert.deepEqual(ids(first), [b.id]);
    await f.approve(a);
    const second = await f.approvals.list(f.owner.scope, {
      ...q,
      cursor: first.next_cursor,
    });
    assert.deepEqual(ids(second), [a.id]);
    assert.equal(second.entries[0].state, "approved");
    assert.equal(second.entries[0].object_version, 2);
  }));
test("inbox PG: consumed and revoked results remain discovery records not executable permits", () =>
  fixture(async (f) => {
    const revoked = await f.propose();
    await f.approvals.revoke(f.owner.scope, revoked.id, guard(revoked));
    const ready = await f.ready();
    await f.approvals.execute(
      f.owner.scope,
      ready.approval.id,
      execution(ready.approval),
      ready.digest,
    );
    const p = await f.approvals.list(
      f.owner.scope,
      select("mine", { state: "consumed" }),
    );
    assert.deepEqual(ids(p), [ready.approval.id]);
    assert.equal(p.entries[0].resource_version, 1);
    assert.deepEqual(
      ids(
        await f.approvals.list(
          f.owner.scope,
          select("mine", { state: "revoked" }),
        ),
      ),
      [revoked.id],
    );
    for (const key of [
      "permit",
      "content_hash",
      "binding",
      "receipt",
      "digest",
    ])
      assert.ok(!JSON.stringify(p).includes('"' + key + '"'));
  }));
test("inbox PG: session filter lane page-size and organization cursor reuse fail", () =>
  fixture(async (f) => {
    await f.propose();
    await f.propose();
    const q = select("mine", { limit: 1 });
    const { next_cursor: cursor } = await f.approvals.list(f.owner.scope, q);
    assert.ok(cursor);
    for (const patch of [
      { lane: "review" },
      { state: "pending" },
      { limit: 2 },
    ])
      await assert.rejects(
        f.approvals.list(f.owner.scope, { ...q, ...patch, cursor }),
        fails("invalid_input"),
      );
    const fresh = await f.auth(f.alice),
      other = await f.auth(f.bob, f.orgB);
    for (const s of [fresh.scope, other.scope])
      await assert.rejects(
        f.approvals.list(s, { ...q, cursor }),
        fails("invalid_input"),
      );
  }));
test("inbox PG: corrupted or restarted cursor is rejected instead of resetting silently", () =>
  fixture(async (f) => {
    await f.propose();
    await f.propose();
    const q = select("mine", { limit: 1 });
    const p = await f.approvals.list(f.owner.scope, q),
      bytes = Buffer.from(p.next_cursor, "base64url");
    bytes[bytes.length - 1] ^= 1;
    await assert.rejects(
      f.approvals.list(f.owner.scope, {
        ...q,
        cursor: bytes.toString("base64url"),
      }),
      fails("invalid_input"),
    );
    await assert.rejects(
      new PostgresApprovalRepository(f.appPool).list(f.owner.scope, {
        ...q,
        cursor: p.next_cursor,
      }),
      fails("invalid_input"),
    );
  }));
test("inbox PG: policy version invalidates a valid old cursor", () =>
  fixture(async (f) => {
    await f.propose();
    await f.propose();
    const q = select("mine", { limit: 1 });
    const p = await f.approvals.list(f.owner.scope, q);
    await f.add(f.alice, f.a, { action: "resource.read", effect: "allow" });
    await assert.rejects(
      f.approvals.list(f.owner.scope, { ...q, cursor: p.next_cursor }),
      fails("invalid_input"),
    );
    assert.equal((await f.approvals.list(f.owner.scope, q)).entries.length, 1);
  }));
test("inbox PG: revoked session and stale organization context cannot enumerate", () =>
  fixture(async (f) => {
    await f.propose();
    assert.equal((await f.approvals.list(f.owner.scope, {})).entries.length, 1);
    await f.repo.selectOrganization(
      f.owner.scope.session_digest,
      f.orgB,
      f.owner.scope.context_version,
    );
    await assert.rejects(
      f.approvals.list(f.owner.scope, {}),
      fails("version_conflict"),
    );
    await f.repo.revokeSession(f.reviewer.scope.session_digest);
    await assert.rejects(
      f.approvals.list(f.reviewer.scope, {}),
      fails("authentication_required"),
    );
  }));
test("inbox PG: emergency containment and guests cannot enumerate even public resources", () =>
  emergencyFixture(async (f) => {
    const a = await f.propose({}, f.reviewer.scope);
    assert.deepEqual(ids(await f.approvals.list(f.reviewer.scope, {})), [a.id]);
    const guest = await f.accept(await f.invite());
    await assert.rejects(
      f.approvals.list(guest.scope, {}),
      fails("unavailable_resource"),
    );
    await f.change();
    await assert.rejects(
      f.approvals.list(f.reviewer.scope, {}),
      fails("unavailable_resource"),
    );
  }));
test("inbox HTTP TCP: actual paginated GET enforces no-store and fixed error responses", () =>
  fixture(async (f) => {
    const a = await f.propose(),
      app = f.app();
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const path = `/api/v1/orgs/${f.orgA}/approvals`,
        url = `http://127.0.0.1:${app.server.address().port}` + path;
      const r = await fetch(url, {
        headers: {
          origin,
          cookie: f.owner.cookie,
          "x-zentwine-context-version": String(f.owner.scope.context_version),
        },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.deepEqual(
        ids(parseApprovalInboxPage(await r.json(), f.orgA, f.alice, select())),
        [a.id],
      );
      for (const q of [
        "?limit=0",
        "?state=admin",
        "?include_hidden=true",
        "?cursor=1",
      ])
        assert.equal(
          (await request(app, f.owner, "GET", path + q)).statusCode,
          400,
        );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: path,
            headers: { authorization: "Bearer synthetic_agent" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: path,
            headers: { origin: "https://evil.example.test" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: path })).statusCode,
        401,
      );
    } finally {
      await app.close();
    }
  }));
test("inbox HTTP: read permission failure returns no rows or database details and recovers", () =>
  fixture(async (f) => {
    await f.propose();
    const app = f.app();
    try {
      await query(
        f.adminPool,
        `REVOKE SELECT ON zentwine_approvals.events FROM "${f.appConfig.user}"`,
      );
      const r = await request(
        app,
        f.owner,
        "GET",
        `/api/v1/orgs/${f.orgA}/approvals`,
      );
      assert.equal(r.statusCode, 503);
      assert.equal(r.json().code, "unavailable");
      for (const text of [
        "Synthetic",
        "permission denied",
        f.appConfig.user,
        "zentwine_approvals",
      ])
        assert.ok(!r.body.includes(text));
      await query(
        f.adminPool,
        `GRANT SELECT ON zentwine_approvals.events TO "${f.appConfig.user}"`,
      );
      assert.equal(
        (await f.approvals.list(f.owner.scope, {})).entries.length,
        1,
      );
      assert.equal(await count(f, "events"), 1);
    } finally {
      await app.close();
    }
  }));
test("inbox PG wait: final authorization refuses a session that expires during query lock wait", () =>
  fixture(async (f) => {
    await f.propose();
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.sessions SET idle_expires_at=clock_timestamp()+interval '1 second' WHERE digest=$1",
      [f.owner.scope.session_digest],
    );
    const blocker = await f.adminPool.connect();
    let work;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE zentwine_approvals.requests IN ACCESS EXCLUSIVE MODE",
      );
      work = f.approvals.list(f.owner.scope, {});
      const checked = assert.rejects(work, fails("authentication_required"));
      await waitForLock(f.adminPool, "SELECT r.*,e.sequence");
      await new Promise((r) => setTimeout(r, 1100));
      await blocker.query("COMMIT");
      await checked;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([work].filter(Boolean));
    }
  }));
test("inbox PG wait: existing stream ordering includes creation committed ahead of discovery", () =>
  fixture(async (f) => {
    const blocker = await f.adminPool.connect();
    let writing, reading;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["zentwine.authz.v1:approval-events:" + f.orgA],
      );
      writing = f.propose();
      writing.catch(() => {});
      await waitForLock(f.adminPool, "pg_advisory_xact_lock");
      reading = f.approvals.list(f.owner.scope, {});
      reading.catch(() => {});
      await blocker.query("COMMIT");
      assert.deepEqual(ids(await reading), [(await writing).id]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([writing, reading].filter(Boolean));
    }
  }));
