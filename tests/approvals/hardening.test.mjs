import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, query, execution, waitForLock, fails } from "./setup.mjs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventCount = async (f) =>
  (
    await query(
      f.adminPool,
      "SELECT count(*)::int AS n FROM zentwine_approvals.events",
    )
  ).rows[0].n;

test("approval fault: governance cannot report success if revocation event insert fails", () =>
  fixture(async (f) => {
    const v = await f.ready(),
      before = await eventCount(f);
    const human = (
      await query(
        f.adminPool,
        "SELECT status,auth_version FROM zentwine_identity.humans WHERE id=$1",
        [f.bob],
      )
    ).rows[0];
    // Deliberate storage-fault injection only in this disposable database.
    await query(
      f.adminPool,
      "ALTER TABLE zentwine_approvals.events ADD CONSTRAINT injected_event_failure CHECK(kind<>'approval.revoked')",
    );
    await assert.rejects(
      f.admin.setHumanStatus(f.bob, "disabled"),
      fails("unavailable"),
    );
    assert.deepEqual(
      (
        await query(
          f.adminPool,
          "SELECT status,auth_version FROM zentwine_identity.humans WHERE id=$1",
          [f.bob],
        )
      ).rows[0],
      human,
    );
    assert.equal(
      (await f.approvals.inspect(f.owner.scope, v.approval.id)).state,
      "issued",
    );
    assert.equal(await eventCount(f), before);
  }));

test("approval fault: event failure rolls back effect and permits a single retry after recovery", () =>
  fixture(async (f) => {
    const v = await f.ready(),
      before = await eventCount(f);
    await query(
      f.adminPool,
      "ALTER TABLE zentwine_approvals.events ADD CONSTRAINT injected_event_failure CHECK(kind<>'approval.consumed')",
    );
    const run = () =>
      f.approvals.execute(
        f.owner.scope,
        v.approval.id,
        execution(v.approval),
        v.digest,
      );
    await assert.rejects(run(), fails("unavailable"));
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT object_version FROM zentwine_policy.resources WHERE id=$1",
          [f.a.id],
        )
      ).rows[0].object_version,
      1,
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT consumed_at FROM zentwine_approvals.permits",
        )
      ).rows[0].consumed_at,
      null,
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT count(*)::int AS n FROM zentwine_approvals.receipts",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(await eventCount(f), before);
    await query(
      f.adminPool,
      "ALTER TABLE zentwine_approvals.events DROP CONSTRAINT injected_event_failure",
    );
    assert.equal((await run()).state, "consumed");
    await assert.rejects(run(), fails("version_conflict"));
  }));

test("approval wait: expiry during final event bookkeeping rolls back the complete operation", () =>
  fixture(async (f) => {
    const v = await f.ready(),
      blocker = await f.adminPool.connect();
    await query(
      f.adminPool,
      "UPDATE zentwine_approvals.permits SET expires_at=clock_timestamp()+interval '1 second' WHERE approval_id=$1",
      [v.approval.id],
    );
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE zentwine_approvals.events IN SHARE MODE");
    try {
      const work = f.approvals.execute(
        f.owner.scope,
        v.approval.id,
        execution(v.approval),
        v.digest,
      );
      const checked = assert.rejects(work, fails("forbidden"));
      await waitForLock(f.adminPool, "INSERT INTO zentwine_approvals.events");
      await sleep(1100);
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
          "SELECT object_version FROM zentwine_policy.resources WHERE id=$1",
          [f.a.id],
        )
      ).rows[0].object_version,
      1,
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT consumed_at FROM zentwine_approvals.permits",
        )
      ).rows[0].consumed_at,
      null,
    );
    assert.equal(
      (await f.approvals.inspect(f.owner.scope, v.approval.id)).state,
      "issued",
    );
  }));

test("approval authority: expiring reviewer resource grant cannot be reused by a permit", () =>
  fixture(async (f) => {
    const r = await f.registerResource({
      visibility: "restricted",
      owner_human_id: f.alice,
    });
    const rule = {
      id: randomUUID(),
      org_id: f.orgA,
      human_id: f.bob,
      resource_id: r.id,
      role: "editor",
      valid_from: Date.now() - 1000,
      expires_at: Date.now() + 10000,
      revoked: false,
    };
    await f.operator.addRule(rule, await f.revision());
    const v = await f.ready({ resource_id: r.id });
    // Controlled clock-boundary fixture: does not call governance invalidation.
    await query(
      f.adminPool,
      "UPDATE zentwine_policy.role_bindings SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
      [rule.id],
    );
    const blocker = await f.adminPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
      [r.id],
    );
    try {
      const work = f.approvals.execute(
        f.owner.scope,
        v.approval.id,
        execution(v.approval),
        v.digest,
      );
      const checked = assert.rejects(work, fails("forbidden"));
      await waitForLock(f.adminPool, "zentwine_policy.resources");
      await sleep(1100);
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
          "SELECT count(*)::int AS n FROM zentwine_approvals.receipts",
        )
      ).rows[0].n,
      0,
    );
  }));
