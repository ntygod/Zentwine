import test from "node:test";
import assert from "node:assert/strict";
import { fixture, query, fails, waitForLock } from "./setup.mjs";
test("agent PG: human session expiring behind resource lock cannot mint a root", () =>
  fixture(async (f) => {
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.sessions SET idle_expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE digest=$1",
      [f.owner.scope.session_digest],
    );
    const blocker = await f.adminPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
      [f.a.id],
    );
    try {
      const work = f.issue();
      const checked = assert.rejects(work, fails("authentication_required"));
      await waitForLock(f.adminPool, "zentwine_policy.resources");
      await new Promise((r) => setTimeout(r, 1600));
      await blocker.query("COMMIT");
      await checked;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT count(*)::int AS n FROM zentwine_agents.delegations",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT count(*)::int AS n FROM zentwine_agents.snapshots",
        )
      ).rows[0].n,
      0,
    );
  }));
test("agent PG: grant checked first expires while a later resource lock waits; entire issuance rolls back", () =>
  fixture(async (f) => {
    const first = {
      ...f.a,
      id: "00000000-0000-4000-8000-000000000001",
      visibility: "restricted",
    };
    await f.operator.registerResource(first);
    const expires = Date.now() + 2000;
    await f.add(f.alice, first, {
      action: "resource.read",
      expires_at: expires,
    });
    const blocker = await f.adminPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
      [f.a.id],
    );
    try {
      const work = f.issue({
        terms: f.terms({
          scopes: [first, f.a].map((r) => ({
            resource_id: r.id,
            actions: ["resource.read"],
            environment: "development",
          })),
        }),
      });
      const checked = assert.rejects(work, fails("unavailable_resource"));
      await waitForLock(f.adminPool, "zentwine_policy.resources");
      await new Promise((r) =>
        setTimeout(r, Math.max(0, expires - Date.now() + 100)),
      );
      await blocker.query("COMMIT");
      await checked;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT count(*)::int AS n FROM zentwine_agents.delegations",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT count(*)::int AS n FROM zentwine_agents.snapshots",
        )
      ).rows[0].n,
      0,
    );
  }));
