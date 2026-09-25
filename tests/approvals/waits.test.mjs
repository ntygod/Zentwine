import {
  invalidateApprovals,
  appendApprovalEvent,
} from "../../packages/db/dist/approval-events.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, query, waitForLock, execution, fails } from "./setup.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("approval PG wait: expiry while waiting for permit row prevents mutation", () =>
  fixture(async (f) => {
    const v = await f.ready();
    await query(
      f.adminPool,
      "UPDATE zentwine_approvals.permits SET expires_at=clock_timestamp()+interval '1 second' WHERE approval_id=$1",
      [v.approval.id],
    );
    const blocker = await f.adminPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT approval_id FROM zentwine_approvals.permits WHERE approval_id=$1 FOR UPDATE",
      [v.approval.id],
    );
    try {
      const work = f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
        checked = assert.rejects(work, fails("forbidden"));
      await waitForLock(f.adminPool, "zentwine_approvals.permits");
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
  }));
test("approval PG wait: requester session expires while waiting for resource lock", () =>
  fixture(async (f) => {
    const a = await f.propose();
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.sessions SET idle_expires_at=clock_timestamp()+interval '1 second' WHERE digest=$1",
      [f.reviewer.scope.session_digest],
    );
    const blocker = await f.adminPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
      [f.a.id],
    );
    try {
      const work = f.approve(a),
        checked = assert.rejects(work, fails("authentication_required"));
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
          "SELECT count(*)::int AS n FROM zentwine_approvals.decisions",
        )
      ).rows[0].n,
      0,
    );
  }));
test("approval PG wait: policy revoke committed ahead of executor denies all effects", () =>
  fixture(async (f) => {
    const v = await f.ready(),
      blocker = await f.adminPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["zentwine.authz.v1:policy:" + f.orgA],
    );
    try {
      const work = f.approvals.execute(
        f.owner.scope,
        v.approval.id,
        execution(v.approval),
        v.digest,
      );
      const checked = assert.rejects(work, (e) =>
        ["version_conflict", "forbidden"].includes(e.code),
      );
      await waitForLock(f.adminPool, "pg_advisory_xact_lock_shared");
      await blocker.query(
        "UPDATE zentwine_policy.organization_policies SET revision=revision+1,write_mode='read_only' WHERE org_id=$1",
        [f.orgA],
      );
      await invalidateApprovals(blocker, f.orgA, null);
      await blocker.query("COMMIT");
      await checked;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const notices = await f.approvals.events(f.owner.scope, "0", 100);
    assert.equal(notices.events.at(-1).kind, "approval.revoked");
  }));
test("approval PG wait: event cursor never jumps over a pending transaction", () =>
  fixture(async (f) => {
    const a = await f.propose(),
      blocker = await f.adminPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["zentwine.authz.v1:approval-events:" + f.orgA],
    );
    try {
      await blocker.query(
        "UPDATE zentwine_approvals.requests SET state='revoked',reason='revoked',object_version=object_version+1 WHERE id=$1 RETURNING *",
        [a.id],
      );
      await appendApprovalEvent(
        blocker,
        (
          await blocker.query(
            "SELECT * FROM zentwine_approvals.requests WHERE id=$1",
            [a.id],
          )
        ).rows[0],
      );
      const polling = f.approvals.events(f.owner.scope, "0", 100);
      await waitForLock(f.adminPool, "pg_advisory_xact_lock");
      await blocker.query("COMMIT");
      const feed = await polling;
      assert.equal(feed.events.at(-1).kind, "approval.revoked");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  }));
