import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fixture, query, fails, waitForLock } from "./setup.mjs";
import {
  secret,
  secretDigest,
} from "../../services/api/dist/identity/security.js";
import { PostgresAgentRepository } from "../../packages/db/dist/index.js";
import { canonicalSnapshot } from "../../packages/policy/dist/index.js";
import { createAgentTools } from "../../services/api/dist/agents/tools.js";
const prefix = "agent PG: ";
test(
  prefix +
    "runtime can append but cannot rewrite snapshots, credentials or owners",
  () =>
    fixture(async (f) => {
      await f.agents.assertRuntimeRole();
      const root = await f.issue();
      for (const sql of [
        "UPDATE zentwine_agents.snapshots SET content='{}'",
        "DELETE FROM zentwine_agents.snapshots",
        "UPDATE zentwine_agents.delegations SET credential_digest=repeat('a',64)",
        "UPDATE zentwine_agents.identities SET accountable_owner_id=id",
      ]) {
        await assert.rejects(
          () => query(f.appPool, sql),
          (e) => e.code === "42501",
        );
      }
      assert.equal((await f.agents.inspect(root.scope)).id, root.delegation.id);
    }),
);
test(
  prefix +
    "register assigns the authenticated owner; idempotence and request conflict",
  () =>
    fixture(async (f) => {
      const id = randomUUID(),
        a = await f.agents.register(f.owner.scope, id, "Idempotent");
      const b = await f.agents.register(f.owner.scope, id, "Idempotent");
      assert.equal(a.id, b.id);
      assert.equal(a.accountable_owner_id, f.alice);
      await assert.rejects(
        () => f.agents.register(f.owner.scope, id, "Changed"),
        fails("version_conflict"),
      );
    }),
);
test(
  prefix +
    "snapshot is deterministic, contains no credential and survives repository reconnect",
  () =>
    fixture(async (f) => {
      const r = await f.issue();
      const next = new PostgresAgentRepository(f.appPool);
      const v = await next.inspect(r.scope);
      assert.equal(
        v.snapshot_sha256,
        createHash("sha256")
          .update(canonicalSnapshot(v.snapshot))
          .digest("hex"),
      );
      assert.equal(v.snapshot.reusable, false);
      const serialized = JSON.stringify(
        (await query(f.adminPool, "SELECT * FROM zentwine_agents.snapshots"))
          .rows,
      );
      assert.ok(!serialized.includes(r.token));
      assert.ok(!serialized.includes(secretDigest(r.token)));
      assert.deepEqual(v.snapshot, r.delegation.snapshot);
    }),
);
test(
  prefix +
    "duplicate root requests mint once and do not reveal a second credential",
  () =>
    fixture(async (f) => {
      const root = await f.issue();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          f.agents.issueRoot(f.owner.scope, root.input, secretDigest(secret())),
        ),
      );
      assert.ok(
        results.every(
          (r) => !r.created && r.delegation.id === root.delegation.id,
        ),
      );
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT count(*)::int AS n FROM zentwine_agents.delegations",
          )
        ).rows[0].n,
        1,
      );
    }),
);
test(prefix + "root cannot claim foreign resource", () =>
  fixture(async (f) => {
    await assert.rejects(
      () =>
        f.issue({
          terms: f.terms({
            scopes: [
              {
                resource_id: f.b.id,
                actions: ["resource.read"],
                environment: "development",
              },
            ],
          }),
        }),
      fails("unavailable_resource"),
    );
  }),
);
test(prefix + "root cannot act for another human agent", () =>
  fixture(async (f) => {
    const bob = await f.auth(f.bob, f.orgB);
    const foreign = await f.register("Other", bob.scope);
    await assert.rejects(
      () => f.issue({ agent_id: foreign.id }),
      fails("unavailable_resource"),
    );
  }),
);
test(prefix + "viewer cannot delegate writes not personally allowed", () =>
  fixture(async (f) => {
    const a = await f.auth(f.alice, f.orgB),
      target = await f.register("Viewer", a.scope);
    await assert.rejects(
      () =>
        f.agents.issueRoot(
          a.scope,
          {
            request_id: randomUUID(),
            agent_id: target.id,
            terms: f.terms({
              scopes: [
                {
                  resource_id: f.b.id,
                  actions: ["resource.read", "resource.update"],
                  environment: "development",
                },
              ],
            }),
          },
          secretDigest(secret()),
        ),
      fails("forbidden"),
    );
  }),
);
test(prefix + "approval-required production writes cannot be delegated", () =>
  fixture(async (f) => {
    const p = { ...f.a, id: randomUUID(), environment: "production" };
    await f.operator.registerResource(p);
    await assert.rejects(
      () =>
        f.issue({
          terms: f.terms({
            scopes: [
              {
                resource_id: p.id,
                actions: ["resource.read", "resource.update"],
                environment: "production",
              },
            ],
          }),
        }),
      fails("approval_required"),
    );
  }),
);
test(prefix + "parent and child preserve owner and exact scope", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      child = await f.delegate(root);
    const r = await f.agents.invoke(child.scope, f.read());
    assert.equal(r.accountable_owner_id, f.alice);
    assert.equal(r.delegation_id, child.delegation.id);
    const p = await f.agents.inspect(root.scope);
    assert.equal(p.reserved_calls, 3);
    assert.equal(p.remaining_calls, 7);
    assert.equal((await f.agents.inspect(child.scope)).used_calls, 1);
  }),
);
for (const [label, change] of [
  ["calls", (t) => ({ ...t, max_calls: 11 })],
  ["expiry", (t) => ({ ...t, expires_at: t.expires_at + 1 })],
  ["start", (t) => ({ ...t, not_before: t.not_before - 1 })],
  ["depth", (t) => ({ ...t, max_depth: t.max_depth })],
  [
    "environment",
    (t) => ({ ...t, scopes: [{ ...t.scopes[0], environment: "production" }] }),
  ],
  [
    "actions",
    (t) => ({
      ...t,
      scopes: [
        {
          ...t.scopes[0],
          actions: ["resource.read", "resource.update", "resource.export"],
        },
      ],
    }),
  ],
  [
    "resource",
    (t) => ({ ...t, scopes: [{ ...t.scopes[0], resource_id: randomUUID() }] }),
  ],
])
  test(prefix + "child rejects expanded " + label, () =>
    fixture(async (f) => {
      const root = await f.issue();
      const base = { ...root.delegation.terms, max_calls: 3, max_depth: 3 };
      const child = change(label === "depth" ? root.delegation.terms : base);
      await assert.rejects(
        () => f.delegate(root, { terms: child }),
        fails("forbidden"),
      );
      assert.equal((await f.agents.inspect(root.scope)).reserved_calls, 0);
    }),
  );
test(prefix + "same agent cannot create a cycle in its chain", () =>
  fixture(async (f) => {
    const root = await f.issue();
    await assert.rejects(
      () => f.delegate(root, { agent_id: root.delegation.agent.id }),
      fails("forbidden"),
    );
  }),
);
test(prefix + "concurrent siblings cannot oversubscribe parent", () =>
  fixture(async (f) => {
    const root = await f.issue();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        f.delegate(root, {
          terms: { ...root.delegation.terms, max_depth: 3, max_calls: 6 },
        }),
      ),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.ok(
      results
        .filter((x) => x.status === "rejected")
        .every((x) => x.reason.code === "budget_exhausted"),
    );
    assert.equal((await f.agents.inspect(root.scope)).remaining_calls, 4);
  }),
);
test(prefix + "duplicate child issuance reserves quota once", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      child = await f.delegate(root);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.agents.delegate(root.scope, child.input, secretDigest(secret())),
      ),
    );
    assert.ok(
      results.every(
        (r) => !r.created && r.delegation.id === child.delegation.id,
      ),
    );
    assert.equal((await f.agents.inspect(root.scope)).reserved_calls, 3);
  }),
);
test(
  prefix + "child issuance collision rolls back snapshot and allocation",
  () =>
    fixture(async (f) => {
      const root = await f.issue();
      await assert.rejects(
        () =>
          f.agents.delegate(
            root.scope,
            {
              request_id: randomUUID(),
              agent_id: f.childAgent.id,
              terms: { ...root.delegation.terms, max_depth: 3, max_calls: 3 },
            },
            secretDigest(root.token),
          ),
        fails("unavailable"),
      );
      assert.equal((await f.agents.inspect(root.scope)).reserved_calls, 0);
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT count(*)::int AS n FROM zentwine_agents.snapshots",
          )
        ).rows[0].n,
        1,
      );
    }),
);
test(prefix + "root revoke blocks child and grandchild on next tool call", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      child = await f.delegate(root),
      grand = await f.delegate(child, {
        agent_id: f.grandAgent.id,
        terms: { ...child.delegation.terms, max_depth: 2, max_calls: 1 },
      });
    await f.agents.revoke(
      f.owner.scope,
      root.delegation.id,
      (await f.agents.inspect(root.scope)).object_version,
    );
    for (const leaf of [root, child, grand])
      await assert.rejects(
        () => f.agents.invoke(leaf.scope, f.read()),
        fails("forbidden"),
      );
  }),
);
test(
  prefix +
    "disabling an ancestor agent blocks descendants without deleting history",
  () =>
    fixture(async (f) => {
      const root = await f.issue(),
        child = await f.delegate(root);
      await f.agents.disable(f.owner.scope, f.parentAgent.id, 1);
      await assert.rejects(
        () => f.agents.invoke(child.scope, f.read()),
        fails("forbidden"),
      );
      const v = await f.agents.inspectOwned(f.owner.scope, child.delegation.id);
      assert.equal(v.snapshot.parent_id, root.delegation.id);
    }),
);
test(
  prefix + "human disable and reenable never resurrect prior delegations",
  () =>
    fixture(async (f) => {
      const root = await f.issue();
      await f.admin.setHumanStatus(f.alice, "disabled");
      await assert.rejects(
        () => f.agents.invoke(root.scope, f.read()),
        fails("unavailable_resource"),
      );
      await f.admin.setHumanStatus(f.alice, "active");
      await assert.rejects(
        () => f.agents.invoke(root.scope, f.read()),
        fails("forbidden"),
      );
    }),
);
test(prefix + "membership role change invalidates pinned authority", () =>
  fixture(async (f) => {
    const root = await f.issue();
    await f.admin.setMembership(
      randomUUID(),
      f.orgA,
      f.alice,
      "MEM-1",
      "viewer",
      "active",
    );
    await assert.rejects(
      () => f.agents.invoke(root.scope, f.read()),
      fails("forbidden"),
    );
  }),
);
test(
  prefix + "organization disabled then reenabled cannot revive snapshot",
  () =>
    fixture(async (f) => {
      const root = await f.issue();
      await f.admin.setOrganizationStatus(f.orgA, "disabled");
      await assert.rejects(
        () => f.agents.invoke(root.scope, f.read()),
        fails("unavailable_resource"),
      );
      await f.admin.setOrganizationStatus(f.orgA, "active");
      await assert.rejects(
        () => f.agents.invoke(root.scope, f.read()),
        fails("forbidden"),
      );
    }),
);
test(
  prefix + "policy change invalidates old snapshot without caching allow",
  () =>
    fixture(async (f) => {
      const root = await f.issue();
      await f.operator.setWriteMode(f.orgA, "read_only", await f.revision());
      await assert.rejects(
        () => f.agents.invoke(root.scope, f.read()),
        fails("forbidden"),
      );
    }),
);
test(prefix + "root expiry blocks introspection and invocation", () =>
  fixture(async (f) => {
    const root = await f.issue({
      terms: f.terms({ expires_at: Date.now() + 350 }),
    });
    await new Promise((r) => setTimeout(r, 400));
    await assert.rejects(
      () => f.agents.inspect(root.scope),
      fails("forbidden"),
    );
    await assert.rejects(
      () => f.agents.invoke(root.scope, f.read()),
      fails("forbidden"),
    );
  }),
);
test(prefix + "future activation is not a usable token", () =>
  fixture(async (f) => {
    const root = await f.issue({
      terms: f.terms({ not_before: Date.now() + 10000 }),
    });
    await assert.rejects(
      () => f.agents.invoke(root.scope, f.read()),
      fails("forbidden"),
    );
  }),
);
test(prefix + "all direct calls share a durable quota under concurrency", () =>
  fixture(async (f) => {
    const root = await f.issue({ terms: f.terms({ max_calls: 2 }) });
    const r = await Promise.allSettled(
      Array.from({ length: 6 }, () => f.agents.invoke(root.scope, f.read())),
    );
    assert.equal(r.filter((v) => v.status === "fulfilled").length, 2);
    assert.ok(
      r
        .filter((v) => v.status === "rejected")
        .every((v) => v.reason.code === "budget_exhausted"),
    );
    assert.equal((await f.agents.inspect(root.scope)).used_calls, 2);
  }),
);
test(
  prefix +
    "idempotent rename performs and charges once; different content conflicts",
  () =>
    fixture(async (f) => {
      const root = await f.issue(),
        cmd = await f.rename();
      const r = await Promise.all(
        Array.from({ length: 5 }, () => f.agents.invoke(root.scope, cmd)),
      );
      assert.equal(r.filter((x) => !x.replayed).length, 1);
      assert.equal((await f.agents.inspect(root.scope)).used_calls, 1);
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
      await assert.rejects(
        () => f.agents.invoke(root.scope, { ...cmd, display_name: "Other" }),
        fails("version_conflict"),
      );
    }),
);
test(prefix + "replay after root revoke does not leak cached response", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      cmd = f.read();
    await f.agents.invoke(root.scope, cmd);
    await f.agents.revoke(f.owner.scope, root.delegation.id, 2);
    await assert.rejects(
      () => f.agents.invoke(root.scope, cmd),
      fails("forbidden"),
    );
  }),
);
test(
  prefix + "stale resource write spends no quota and records no effect",
  () =>
    fixture(async (f) => {
      const root = await f.issue(),
        cmd = await f.rename();
      await assert.rejects(
        () => f.agents.invoke(root.scope, { ...cmd, expected_version: 44 }),
        fails("version_conflict"),
      );
      assert.equal((await f.agents.inspect(root.scope)).used_calls, 0);
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT count(*)::int AS n FROM zentwine_agents.operations",
          )
        ).rows[0].n,
        0,
      );
    }),
);
test(prefix + "revocation does not refund escrowed child budget", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      child = await f.delegate(root);
    await f.agents.revoke(f.owner.scope, child.delegation.id, 1);
    assert.equal((await f.agents.inspect(root.scope)).reserved_calls, 3);
    await assert.rejects(
      () =>
        f.delegate(root, {
          terms: { ...root.delegation.terms, max_depth: 3, max_calls: 8 },
        }),
      fails("budget_exhausted"),
    );
  }),
);
test(prefix + "owner-only inspection and revoke reject another tenant", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      bob = await f.auth(f.bob, f.orgB);
    await assert.rejects(
      () => f.agents.inspectOwned(bob.scope, root.delegation.id),
      fails("unavailable_resource"),
    );
    await assert.rejects(
      () => f.agents.revoke(bob.scope, root.delegation.id, 1),
      fails("unavailable_resource"),
    );
  }),
);
test(
  prefix + "independent human logout does not revoke an explicit delegation",
  () =>
    fixture(async (f) => {
      const root = await f.issue();
      await f.repo.revokeSession(f.owner.scope.session_digest);
      assert.equal(
        (await f.agents.invoke(root.scope, f.read())).accountable_owner_id,
        f.alice,
      );
    }),
);
test(prefix + "immutable snapshot integrity is checked before execution", () =>
  fixture(async (f) => {
    const root = await f.issue();
    await query(
      f.adminPool,
      "UPDATE zentwine_agents.snapshots SET content=jsonb_set(content,'{terms,max_calls}','999')",
    );
    await assert.rejects(
      () => f.agents.invoke(root.scope, f.read()),
      fails("unavailable"),
    );
  }),
);
test(prefix + "bound tool cannot import unrelated human privilege", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      tools = createAgentTools(f.agents, root.scope);
    await assert.rejects(
      () => tools.invoke({ ...f.read(), role: "owner" }),
      fails("invalid_input"),
    );
    assert.equal((await f.agents.inspect(root.scope)).used_calls, 0);
  }),
);
test(
  prefix + "expiry while waiting for actual resource lock is rechecked",
  () =>
    fixture(async (f) => {
      const root = await f.issue({
          terms: f.terms({ expires_at: Date.now() + 700 }),
        }),
        block = await f.adminPool.connect();
      await block.query("BEGIN");
      await block.query(
        "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
        [f.a.id],
      );
      try {
        const call = f.agents.invoke(root.scope, f.read());
        const checked = assert.rejects(call, fails("forbidden"));
        await waitForLock(f.adminPool, "zentwine_policy.resources");
        await new Promise((r) => setTimeout(r, 800));
        await block.query("COMMIT");
        await checked;
      } finally {
        await block.query("ROLLBACK");
        block.release();
      }
      assert.equal(
        (await f.agents.inspectOwned(f.owner.scope, root.delegation.id))
          .used_calls,
        0,
      );
    }),
);
test(
  prefix +
    "root revocation orders after already-authorized operation then blocks later work",
  () =>
    fixture(async (f) => {
      const root = await f.issue(),
        block = await f.adminPool.connect();
      await block.query("BEGIN");
      await block.query(
        "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
        [f.a.id],
      );
      try {
        const work = f.agents.invoke(root.scope, f.read());
        await waitForLock(f.adminPool, "zentwine_policy.resources");
        const revoke = f.agents.revoke(f.owner.scope, root.delegation.id, 2);
        await waitForLock(f.adminPool, "pg_advisory_xact_lock");
        await block.query("COMMIT");
        await work;
        await revoke;
        await assert.rejects(
          () => f.agents.invoke(root.scope, f.read()),
          fails("forbidden"),
        );
      } finally {
        await block.query("ROLLBACK");
        block.release();
      }
    }),
);
test("agent PG: operation receipt failure rolls back both catalog mutation and quota", () =>
  fixture(async (f) => {
    const root = await f.issue(),
      cmd = await f.rename();
    await query(
      f.adminPool,
      `REVOKE INSERT ON zentwine_agents.operations FROM "${f.appConfig.user}"`,
    );
    await assert.rejects(
      () => f.agents.invoke(root.scope, cmd),
      fails("unavailable"),
    );
    assert.equal((await f.agents.inspect(root.scope)).used_calls, 0);
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
test("agent PG: natural expiry of original resource grant is rechecked despite unchanged policy revision", () =>
  fixture(async (f) => {
    const r = { ...f.a, id: randomUUID(), visibility: "restricted" };
    await f.operator.registerResource(r);
    const until = Date.now() + 800;
    await f.add(f.alice, r, { action: "resource.read", expires_at: until });
    const root = await f.issue({
      terms: f.terms({
        scopes: [
          {
            resource_id: r.id,
            environment: "development",
            actions: ["resource.read"],
          },
        ],
      }),
    });
    assert.equal(
      (await f.agents.invoke(root.scope, f.read(r.id))).resource.id,
      r.id,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, until - Date.now() + 50)),
    );
    await assert.rejects(
      () => f.agents.invoke(root.scope, f.read(r.id)),
      fails("unavailable_resource"),
    );
    assert.equal((await f.agents.inspect(root.scope)).used_calls, 1);
  }));
