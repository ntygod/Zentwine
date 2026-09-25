import { invalidateApprovals } from "../../packages/db/dist/approval-events.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture,
  query,
  guard,
  execution,
  fails,
  secret,
  secretDigest,
} from "./setup.mjs";
import { PostgresApprovalRepository } from "../../packages/db/dist/index.js";
import { createApprovedCatalogTool } from "../../services/api/dist/approvals/tools.js";
const p = "approval PG: ";
const refused = (e) =>
  [
    "forbidden",
    "version_conflict",
    "approval_required",
    "authentication_required",
    "unavailable_resource",
  ].includes(e.code);
const count = async (f, table) =>
  Number(
    (
      await query(
        f.adminPool,
        `SELECT count(*)::int AS n FROM zentwine_approvals.${table}`,
      )
    ).rows[0].n,
  );
test(
  p +
    "nonprivileged runtime cannot rewrite binding decisions receipts or historical events",
  () =>
    fixture(async (f) => {
      await f.approvals.assertRuntimeRole();
      const a = await f.propose();
      for (const sql of [
        "UPDATE zentwine_approvals.requests SET binding='{}'",
        "DELETE FROM zentwine_approvals.decisions",
        "DELETE FROM zentwine_approvals.events",
        "DELETE FROM zentwine_approvals.receipts",
      ])
        await assert.rejects(query(f.appPool, sql));
      assert.equal(
        (await f.approvals.inspect(f.owner.scope, a.id)).state,
        "pending",
      );
    }),
);
test(
  p +
    "production catalog action needs independent approval then executes exactly once",
  () =>
    fixture(async (f) => {
      const r = await f.registerResource({ environment: "production" });
      await assert.rejects(
        f.policy.renameResource(
          f.owner.scope,
          r.id,
          "Approved name",
          1,
          await f.revision(),
        ),
        (e) => e.code === "approval_required",
      );
      const a = await f.propose({ resource_id: r.id, review: "policy" });
      assert.equal(a.state, "pending");
      assert.equal(a.decision, null);
      const v = await f.permit(await f.approve(a));
      assert.equal(v.approval.decision.source, "human");
      const done = await f.approvals.execute(
        f.owner.scope,
        a.id,
        execution(v.approval),
        v.digest,
      );
      assert.equal(done.state, "consumed");
      assert.equal(done.receipt.resource.display_name, "Approved name");
      assert.equal(done.receipt.resource.object_version, 2);
      await assert.rejects(
        f.approvals.execute(
          f.owner.scope,
          a.id,
          execution(v.approval),
          v.digest,
        ),
        refused,
      );
      assert.equal(await count(f, "receipts"), 1);
    }),
);
test(
  p + "low-risk policy approval is recorded separately from human decision",
  () =>
    fixture(async (f) => {
      const a = await f.propose({ review: "policy" });
      assert.equal(a.state, "approved");
      assert.equal(a.decision.source, "preauthorized_policy");
      assert.equal(a.decision.actor_id, f.alice);
      const v = await f.permit(a);
      assert.equal(
        (
          await f.approvals.execute(
            f.owner.scope,
            a.id,
            execution(v.approval),
            v.digest,
          )
        ).state,
        "consumed",
      );
    }),
);
test(p + "self approval rejected even for organization owner", () =>
  fixture(async (f) => {
    const a = await f.propose();
    await assert.rejects(
      f.approvals.decide(f.owner.scope, a.id, guard(a), "approve"),
      fails("forbidden"),
    );
    assert.equal(await count(f, "decisions"), 0);
  }),
);
test(p + "reviewer requires owner role AND access to restricted resource", () =>
  fixture(async (f) => {
    const r = await f.registerResource({
      visibility: "restricted",
      owner_human_id: f.alice,
    });
    const a = await f.propose({ resource_id: r.id });
    await assert.rejects(f.approve(a), fails("unavailable_resource"));
    assert.equal(await count(f, "decisions"), 0);
  }),
);
test(p + "owner status alone does not override explicit deny", () =>
  fixture(async (f) => {
    await f.add(f.alice, f.a, { effect: "deny" });
    await assert.rejects(f.propose({ review: "policy" }), fails("forbidden"));
    assert.equal(await count(f, "requests"), 0);
  }),
);
test(
  p + "same creation request is idempotent but changed payload conflicts",
  () =>
    fixture(async (f) => {
      const input = await f.input();
      const rows = await Promise.all(
        Array.from({ length: 4 }, () =>
          f.approvals.request(f.owner.scope, input),
        ),
      );
      assert.equal(new Set(rows.map((r) => r.id)).size, 1);
      assert.equal(await count(f, "requests"), 1);
      assert.equal(await count(f, "events"), 1);
      await assert.rejects(
        f.approvals.request(f.owner.scope, {
          ...input,
          display_name: "different",
        }),
        fails("version_conflict"),
      );
    }),
);
test(
  p + "approval decision replay and second reviewer cannot replace decision",
  () =>
    fixture(async (f) => {
      const a = await f.propose();
      const approved = await f.approve(a);
      await assert.rejects(f.approve(a), fails("version_conflict"));
      await assert.rejects(
        f.approvals.decide(f.reviewer.scope, a.id, guard(approved), "reject"),
        fails("version_conflict"),
      );
      assert.equal(await count(f, "decisions"), 1);
    }),
);
test(p + "rejection is terminal and cannot yield a permit", () =>
  fixture(async (f) => {
    const a = await f.propose();
    const denied = await f.approvals.decide(
      f.reviewer.scope,
      a.id,
      guard(a),
      "reject",
    );
    assert.equal(denied.state, "rejected");
    await assert.rejects(f.permit(denied), refused);
  }),
);
test(
  p + "only requester can claim permit; second claim never recovers secret",
  () =>
    fixture(async (f) => {
      const a = await f.approve(await f.propose());
      await assert.rejects(
        f.approvals.issuePermit(
          f.reviewer.scope,
          a.id,
          guard(a),
          secretDigest(secret()),
        ),
        fails("forbidden"),
      );
      const v = await f.permit(a);
      await assert.rejects(f.permit(v.approval), refused);
      assert.equal(await count(f, "permits"), 1);
      const stored = (
        await query(f.adminPool, "SELECT * FROM zentwine_approvals.permits")
      ).rows[0];
      assert.equal(stored.digest, v.digest);
      assert.equal(JSON.stringify(stored).includes(v.token), false);
    }),
);
test(p + "approval id alone without correct permit cannot execute", () =>
  fixture(async (f) => {
    const v = await f.ready();
    await assert.rejects(
      f.approvals.execute(
        f.owner.scope,
        v.approval.id,
        execution(v.approval),
        secretDigest(secret()),
      ),
      fails("forbidden"),
    );
    assert.equal(await count(f, "receipts"), 0);
  }),
);
for (const field of [
  "display_name",
  "content_hash",
  "resource_id",
  "expected_resource_version",
  "expected_policy_revision",
])
  test(p + "approved input cannot change " + field, () =>
    fixture(async (f) => {
      const v = await f.ready();
      const changes = {
        display_name: "tampered",
        content_hash: "b".repeat(64),
        resource_id: f.b.id,
        expected_resource_version: 2,
        expected_policy_revision: 999,
      };
      await assert.rejects(
        f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          { ...execution(v.approval), [field]: changes[field] },
          v.digest,
        ),
        fails("version_conflict"),
      );
      assert.equal(await count(f, "receipts"), 0);
    }),
  );
test(
  p +
    "environment substitution rejected even when privileged SQL omits version increment",
  () =>
    fixture(async (f) => {
      const v = await f.ready();
      await query(
        f.adminPool,
        "UPDATE zentwine_policy.resources SET environment='production' WHERE id=$1",
        [f.a.id],
      );
      await assert.rejects(
        f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
        fails("version_conflict"),
      );
    }),
);
test(p + "resource changed after approval invalidates the bound version", () =>
  fixture(async (f) => {
    const v = await f.ready();
    await f.policy.renameResource(
      f.owner.scope,
      f.a.id,
      "Other change",
      1,
      await f.revision(),
    );
    await assert.rejects(
      f.approvals.execute(
        f.owner.scope,
        v.approval.id,
        execution(v.approval),
        v.digest,
      ),
      fails("version_conflict"),
    );
  }),
);
test(
  p + "expired request cannot be approved and expired permit cannot execute",
  () =>
    fixture(async (f) => {
      const a = await f.propose();
      await query(
        f.adminPool,
        "UPDATE zentwine_approvals.requests SET created_at=statement_timestamp()-interval '20 minutes',expires_at=statement_timestamp()-interval '5 minutes' WHERE id=$1",
        [a.id],
      );
      await assert.rejects(f.approve(a), fails("forbidden"));
      const v = await f.ready();
      await query(
        f.adminPool,
        "UPDATE zentwine_approvals.permits SET created_at=statement_timestamp()-interval '3 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE approval_id=$1",
        [v.approval.id],
      );
      await assert.rejects(
        f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
        fails("forbidden"),
      );
      assert.equal(await count(f, "receipts"), 0);
    }),
);
test(p + "parallel permit consumers commit only once", () =>
  fixture(async (f) => {
    const v = await f.ready();
    const r = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
      ),
    );
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(await count(f, "receipts"), 1);
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT object_version FROM zentwine_policy.resources WHERE id=$1",
          [f.a.id],
        )
      ).rows[0].object_version,
      2,
    );
  }),
);
test(
  p + "receipt failure rolls back mutation permit consumption and event",
  () =>
    fixture(async (f) => {
      const v = await f.ready();
      const before = await count(f, "events");
      await query(
        f.adminPool,
        `REVOKE INSERT ON zentwine_approvals.receipts FROM "${f.appConfig.user}"`,
      );
      await assert.rejects(
        f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
        fails("unavailable"),
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
            "SELECT object_version FROM zentwine_policy.resources WHERE id=$1",
            [f.a.id],
          )
        ).rows[0].object_version,
        1,
      );
      assert.equal(await count(f, "events"), before);
    }),
);
test(
  p + "policy revision change atomically revokes approval and records notice",
  () =>
    fixture(async (f) => {
      const v = await f.ready(),
        before = await f.approvals.events(f.owner.scope, "0", 100);
      await f.operator.setWriteMode(f.orgA, "read_only", await f.revision());
      const after = await f.approvals.events(
        f.owner.scope,
        before.next_cursor,
        100,
      );
      assert.equal(after.authorization, false);
      assert.equal(after.events.length, 1);
      assert.equal(after.events[0].kind, "approval.revoked");
      assert.equal(after.events[0].reason, "authority_changed");
      await assert.rejects(
        f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
        refused,
      );
    }),
);
test(
  p + "reviewer membership downgrade invalidates already issued permits",
  () =>
    fixture(async (f) => {
      const v = await f.ready();
      await f.admin.setMembership(
        randomUUID(),
        f.orgA,
        f.bob,
        "MEM-2",
        "viewer",
        "active",
      );
      assert.equal(
        (await f.approvals.inspect(f.owner.scope, v.approval.id)).state,
        "revoked",
      );
      await assert.rejects(
        f.approvals.execute(
          f.owner.scope,
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
        refused,
      );
    }),
);
test(p + "reviewer disable and reenable never resurrect approval", () =>
  fixture(async (f) => {
    const v = await f.ready();
    await f.admin.setHumanStatus(f.bob, "disabled");
    await f.admin.setHumanStatus(f.bob, "active");
    assert.equal(
      (await f.approvals.inspect(f.owner.scope, v.approval.id)).state,
      "revoked",
    );
  }),
);
test(
  p +
    "explicit revoke notice survives repository reconstruction and cursor replay",
  () =>
    fixture(async (f) => {
      const v = await f.ready();
      const before = await f.approvals.events(f.owner.scope, "0", 100);
      await f.approvals.revoke(f.owner.scope, v.approval.id, guard(v.approval));
      const other = new PostgresApprovalRepository(f.appPool),
        next = await other.events(f.owner.scope, before.next_cursor, 100);
      assert.equal(next.events.length, 1);
      assert.deepEqual(
        await other.events(f.owner.scope, before.next_cursor, 100),
        next,
      );
      assert.equal(
        (await other.events(f.owner.scope, next.next_cursor, 100)).events
          .length,
        0,
      );
    }),
);
test(
  p + "unrelated readers and organizations do not see approval notifications",
  () =>
    fixture(async (f) => {
      await f.propose();
      const bob = await f.auth(f.bob, f.orgB);
      assert.equal(
        (await f.approvals.events(bob.scope, "0", 100)).events.length,
        0,
      );
      const reviewer = await f.approvals.events(f.reviewer.scope, "0", 100);
      assert.equal(reviewer.events.length, 0);
    }),
);
test(
  p +
    "foreign organizations cannot inspect approval even with same display number",
  () =>
    fixture(async (f) => {
      const a = await f.propose();
      const other = await f.auth(f.alice, f.orgB);
      await assert.rejects(
        f.approvals.inspect(other.scope, a.id),
        fails("unavailable_resource"),
      );
    }),
);
test(p + "approved catalog tool reuses the exact permission transaction", () =>
  fixture(async (f) => {
    const v = await f.ready();
    const tool = createApprovedCatalogTool(
      f.approvals,
      f.owner.scope,
      v.approval.id,
      v.digest,
    );
    assert.equal((await tool.invoke(execution(v.approval))).state, "consumed");
    await assert.rejects(tool.invoke(execution(v.approval)), refused);
  }),
);
test(
  p +
    "Agent bearer and prior delegation cannot consume human permit or bypass production policy",
  () =>
    fixture(async (f) => {
      const r = await f.registerResource({ environment: "production" });
      await assert.rejects(
        f.issue({
          terms: f.terms({
            scopes: [
              {
                resource_id: r.id,
                actions: ["resource.read", "resource.update"],
                environment: "production",
              },
            ],
          }),
        }),
        (e) => e.code === "approval_required",
      );
      const v = await f.ready();
      await assert.rejects(
        f.approvals.execute(
          { credential_digest: v.digest },
          v.approval.id,
          execution(v.approval),
          v.digest,
        ),
        fails("authentication_required"),
      );
    }),
);
test(
  p + "upstream mutation rollback leaves approval and event stream unchanged",
  () =>
    fixture(async (f) => {
      const v = await f.ready(),
        before = await count(f, "events");
      const c = await f.adminPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "UPDATE zentwine_policy.organization_policies SET revision=revision+1 WHERE org_id=$1",
          [f.orgA],
        );
        await invalidateApprovals(c, f.orgA, null);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      assert.equal(
        (await f.approvals.inspect(f.owner.scope, v.approval.id)).state,
        "issued",
      );
      assert.equal(await count(f, "events"), before);
    }),
);
