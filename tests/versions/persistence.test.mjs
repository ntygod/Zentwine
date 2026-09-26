import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture,
  tenantFixture,
  query,
  fails,
  sql,
  revise,
  transition,
  relation,
  digestContent,
  waitForDatabaseLock,
} from "./setup.mjs";

test("version PG: restricted migration owner installs three forced RLS tables and invoker view", () =>
  fixture(async (f) => {
    assert.equal(
      (await query(f.adminPool, await sql("verify"))).rows[0].verified,
      true,
    );
    const flags = (
      await query(
        f.adminPool,
        "SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1",
        [f.tenantOwner],
      )
    ).rows[0];
    assert.deepEqual(flags, {
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
    });
    assert.equal((await f.create()).object_version, 1);
  }));
test("version PG: missing migration fails closed without affecting original tenant access", () =>
  tenantFixture(async (f) => {
    const id = randomUUID();
    await f.tenant.transaction(f.aScope, (t) => t.register(id, "test.key"));
    await assert.rejects(
      f.tenant.transaction(f.aScope, (t) => t.versions.head(id)),
      fails("unavailable"),
    );
    assert.equal(
      (await f.tenant.transaction(f.aScope, (t) => t.getMany([id]))).length,
      1,
    );
  }));
test("version PG: creation and every draft edit append immutable attributed revisions", () =>
  fixture(async (f) => {
    const h = await f.create(),
      next = (
        await f.commandVersion(revise(h.object_id, 1, { text: "Second" }))
      ).current;
    assert.equal(h.created_by, f.alice);
    assert.equal(h.changed_by, f.alice);
    assert.equal(h.status, "draft");
    assert.equal(next.revision_number, 2);
    assert.equal(next.object_version, 2);
    assert.equal(next.parent_revision_id, h.revision_id);
    assert.notEqual(next.revision_id, h.revision_id);
    assert.notEqual(next.content_hash, h.content_hash);
    assert.deepEqual(await f.snapshot(h.object_id, 1), h);
    assert.deepEqual(await f.head(h.object_id), next);
  }));
test("version PG: submit reject resubmit approve supersede new revision and retire use legal transitions", () =>
  fixture(async (f) => {
    let h = await f.create();
    const original = h.revision_id;
    for (const [action, status, scope] of [
      ["submit", "in_review", f.aScope],
      ["reject", "draft", f.reviewer.scope],
      ["submit", "in_review", f.aScope],
      ["approve", "approved", f.reviewer.scope],
      ["supersede", "superseded", f.reviewer.scope],
    ]) {
      const r = await f.commandVersion(transition(h, action), scope);
      assert.equal(r.outcome, "applied");
      assert.equal(r.current.status, status);
      assert.equal(r.current.revision_id, original);
      assert.equal(r.current.object_version, h.object_version + 1);
      h = r.current;
    }
    h = (
      await f.commandVersion(
        revise(h.object_id, h.object_version, { text: "Replacement" }),
      )
    ).current;
    assert.equal(h.status, "draft");
    assert.equal(h.revision_number, 2);
    assert.notEqual(h.revision_id, original);
    h = (await f.commandVersion(transition(h, "submit"))).current;
    h = (await f.commandVersion(transition(h, "approve"), f.reviewer.scope))
      .current;
    h = (await f.commandVersion(transition(h, "retire"), f.reviewer.scope))
      .current;
    assert.equal(h.status, "retired");
    assert.equal(
      (await f.commandVersion(revise(h.object_id, h.object_version))).outcome,
      "invalid_transition",
    );
  }));
test("version PG: approved content cannot be overwritten or revised without explicit supersession", () =>
  fixture(async (f) => {
    const h = await f.approved();
    assert.equal(
      (
        await f.commandVersion(
          revise(h.object_id, h.object_version, { secret: "not committed" }),
        )
      ).outcome,
      "invalid_transition",
    );
    assert.deepEqual(await f.head(h.object_id), h);
    assert.deepEqual(await f.snapshot(h.object_id, 3), h);
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT count(*)::integer AS n FROM zentwine_versions.revisions",
        )
      ).rows[0].n,
      1,
    );
  }));
test("version PG: stale expected version returns current and expected without overwriting", () =>
  fixture(async (f) => {
    const h = await f.create(),
      r = await f.commandVersion(revise(h.object_id, 0, { text: "stale" }));
    assert.equal(r.outcome, "conflict");
    assert.equal(r.expected_version, 0);
    assert.deepEqual(r.current, h);
    assert.deepEqual(await f.head(h.object_id), h);
  }));
test("version PG: two real human sessions creating from version zero yield exactly one winner", () =>
  fixture(async (f) => {
    const id = await f.register();
    const results = await Promise.all([
      f.commandVersion(revise(id, 0, { writer: "A" })),
      f.commandVersion(revise(id, 0, { writer: "B" }), f.reviewer.scope),
    ]);
    assert.equal(results.filter((r) => r.outcome === "applied").length, 1);
    assert.equal(results.filter((r) => r.outcome === "conflict").length, 1);
    assert.equal((await f.head(id)).object_version, 1);
    assert.deepEqual(results[0].current, results[1].current);
  }));
test("version PG: concurrent state transitions from one version do not silently overwrite", () =>
  fixture(async (f) => {
    const h = await f.create();
    const results = await Promise.all([
      f.commandVersion(transition(h, "submit")),
      f.commandVersion(
        revise(h.object_id, 1, { writer: "other" }),
        f.reviewer.scope,
      ),
    ]);
    assert.equal(results.filter((r) => r.outcome === "applied").length, 1);
    assert.equal(results.filter((r) => r.outcome === "conflict").length, 1);
    assert.equal((await f.head(h.object_id)).object_version, 2);
  }));
test("version PG: mismatched revision or hash conflicts even with the current version", () =>
  fixture(async (f) => {
    const h = (await f.commandVersion(transition(await f.create(), "submit")))
      .current;
    for (const patch of [
      { revision_id: randomUUID() },
      { content_hash: "a".repeat(64) },
    ]) {
      const r = await f.commandVersion(
        { ...transition(h, "approve"), ...patch },
        f.reviewer.scope,
      );
      assert.equal(r.outcome, "conflict");
      assert.deepEqual(r.current, h);
    }
  }));
test("version PG: author cannot self-approve and a different owner is attributed", () =>
  fixture(async (f) => {
    const h = (await f.commandVersion(transition(await f.create(), "submit")))
      .current;
    await assert.rejects(
      f.commandVersion(transition(h, "approve")),
      fails("forbidden"),
    );
    assert.deepEqual(await f.head(h.object_id), h);
    const a = (
      await f.commandVersion(transition(h, "approve"), f.reviewer.scope)
    ).current;
    assert.equal(a.created_by, f.alice);
    assert.equal(a.changed_by, f.bob);
    assert.equal(a.content_hash, h.content_hash);
  }));
test("version PG: ordinary member can author but cannot approve retire or supersede", () =>
  fixture(async (f) => {
    const h = await f.create();
    await f.admin.setMembership(
      f.bobMember.id,
      f.orgA,
      f.bob,
      "MEM-2",
      "member",
      "active",
    );
    const member = (await f.auth(f.bob)).scope;
    const submitted = (await f.commandVersion(transition(h, "submit"), member))
      .current;
    assert.equal(submitted.status, "in_review");
    await assert.rejects(
      f.commandVersion(transition(submitted, "approve"), member),
      fails("forbidden"),
    );
    assert.equal((await f.create(member)).created_by, f.bob);
  }));
test("version PG: readonly member reads snapshots but cannot issue revision commands", () =>
  fixture(async (f) => {
    const h = await f.create();
    await f.admin.setMembership(
      f.bobMember.id,
      f.orgA,
      f.bob,
      "MEM-2",
      "viewer",
      "active",
    );
    const viewer = (await f.auth(f.bob)).scope;
    assert.deepEqual(await f.head(h.object_id, viewer), h);
    await assert.rejects(
      f.commandVersion(transition(h, "submit"), viewer),
      fails("forbidden"),
    );
  }));
test("version PG: unbound SQL and forged tenant GUC expose no snapshot or relationship", () =>
  fixture(async (f) => {
    const target = await f.create(),
      id = await f.register();
    await f.commandVersion(revise(id, 0, {}, [relation(target)]));
    await f.raw(null, async (c) => {
      await c.query("SELECT set_config('zentwine.org_id',$1,true)", [f.orgA]);
      for (const table of ["revisions", "states", "relations", "snapshots"])
        assert.equal(
          (await c.query(`SELECT * FROM zentwine_versions.${table}`)).rows
            .length,
          0,
        );
      await assert.rejects(
        c.query("SELECT zentwine_versions.apply($1::jsonb)", [
          JSON.stringify(revise(id)),
        ]),
        (e) => e.code === "P0002",
      );
    });
  }));
test("version PG: foreign and absent object commands share the same unavailable result", () =>
  fixture(async (f) => {
    const h = await f.create(f.bScope);
    for (const id of [h.object_id, randomUUID()]) {
      assert.equal(await f.head(id), null);
      await assert.rejects(
        f.commandVersion(revise(id)),
        fails("unavailable_resource"),
      );
    }
  }));
test("version PG: identical object UUIDs across tenants have independent versions and hashes", () =>
  fixture(async (f) => {
    const id = await f.register();
    await f.register(f.bScope, id);
    const a = (await f.commandVersion(revise(id, 0, { tenant: "a" }))).current,
      b = (await f.commandVersion(revise(id, 0, { tenant: "b" }), f.bScope))
        .current;
    assert.notEqual(a.content_hash, b.content_hash);
    assert.notEqual(a.revision_id, b.revision_id);
    assert.deepEqual(await f.head(id), a);
    assert.deepEqual(await f.head(id, f.bScope), b);
  }));
test("version PG: immutable relationship pins target revision and does not follow later target changes", () =>
  fixture(async (f) => {
    const target = await f.create(),
      id = await f.register(),
      r = relation(target);
    const source = (
      await f.commandVersion(revise(id, 0, { text: "source" }, [r]))
    ).current;
    await f.commandVersion(revise(target.object_id, 1, { text: "new target" }));
    assert.deepEqual(await f.relations(source), [r]);
    assert.equal((await f.head(target.object_id)).revision_number, 2);
  }));
test("version PG: a new content revision never inherits old relationships implicitly", () =>
  fixture(async (f) => {
    const target = await f.create(),
      id = await f.register(),
      source = (await f.commandVersion(revise(id, 0, {}, [relation(target)])))
        .current;
    const next = (await f.commandVersion(revise(id, 1, {}))).current;
    assert.equal(next.content_hash, source.content_hash);
    assert.notEqual(next.revision_id, source.revision_id);
    assert.deepEqual(await f.relations(next), []);
    assert.equal((await f.relations(source)).length, 1);
  }));
test("version PG: foreign absent and wrong-hash relation targets reject atomically", () =>
  fixture(async (f) => {
    const own = await f.create(),
      foreign = await f.create(f.bScope),
      id = await f.register();
    for (const r of [
      relation(foreign),
      { ...relation(own), target_revision_id: randomUUID() },
      { ...relation(own), target_hash: "b".repeat(64) },
    ]) {
      await assert.rejects(
        f.commandVersion(revise(id, 0, {}, [r])),
        fails("unavailable_resource"),
      );
      assert.equal(await f.head(id), null);
    }
  }));
test("version PG: database validates extra authority fields enums hashes and relation duplicates", () =>
  fixture(async (f) => {
    const id = await f.register(),
      target = await f.create(),
      c = revise(id);
    const commands = [
      { ...c, actor_id: f.bob },
      { ...c, expected_version: -1 },
      { ...c, content: { ...c.content, algorithm: "md5" } },
      { ...c, content: { ...c.content, raw: "hidden" } },
      { ...c, relations: [relation(target), relation(target)] },
      { ...c, action: "force" },
    ];
    for (const value of commands)
      await f.raw(f.aScope, (p) =>
        assert.rejects(
          p.query("SELECT zentwine_versions.apply($1::jsonb)", [
            JSON.stringify(value),
          ]),
          (e) => e.code === "22023",
        ),
      );
    assert.equal(await f.head(id), null);
  }));
test("version PG: runtime cannot directly insert update delete or bypass RLS", () =>
  fixture(async (f) => {
    const h = await f.create();
    for (const statement of [
      "INSERT INTO zentwine_versions.states(org_id) VALUES(NULL)",
      "UPDATE zentwine_versions.revisions SET content_hash=repeat('a',64)",
      "DELETE FROM zentwine_versions.relations",
      "TRUNCATE zentwine_versions.states",
      "ALTER TABLE zentwine_versions.states DISABLE ROW LEVEL SECURITY",
    ])
      await f.raw(f.aScope, (c) =>
        assert.rejects(c.query(statement), (e) => e.code === "42501"),
      );
    assert.deepEqual(await f.head(h.object_id), h);
  }));
test("version PG: immutable triggers reject administrator UPDATE and DELETE of existing records", () =>
  fixture(async (f) => {
    const h = await f.approved();
    for (const statement of [
      "UPDATE zentwine_versions.revisions SET content_hash=repeat('a',64)",
      "DELETE FROM zentwine_versions.states",
    ])
      await assert.rejects(
        query(f.adminPool, statement),
        (e) => e.code === "42501",
      );
    assert.deepEqual(await f.head(h.object_id), h);
  }));
test("version PG: misgranted table or column writes fail runtime checks and recover after revoke", () =>
  fixture(async (f) => {
    const h = await f.create();
    for (const grant of [
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "TRIGGER",
      "REFERENCES",
      "UPDATE(content_hash)",
    ]) {
      await query(
        f.adminPool,
        `GRANT ${grant} ON zentwine_versions.revisions TO "${f.tenantRole}"`,
      );
      await assert.rejects(f.head(h.object_id), fails("unavailable"));
      await query(
        f.adminPool,
        `REVOKE ${grant} ON zentwine_versions.revisions FROM "${f.tenantRole}"`,
      );
      assert.deepEqual(await f.head(h.object_id), h);
    }
  }));
test("version PG: command privilege failure rolls back prior registration in the same unit", () =>
  fixture(async (f) => {
    const id = randomUUID();
    await query(
      f.adminPool,
      `REVOKE EXECUTE ON FUNCTION zentwine_versions.apply(jsonb) FROM "${f.tenantRole}"`,
    );
    await assert.rejects(
      f.tenant.transaction(f.aScope, async (t) => {
        await t.register(id, "test.spec");
        return t.versions.command(revise(id));
      }),
      fails("forbidden"),
    );
    assert.deepEqual(
      await f.tenant.transaction(f.aScope, (t) => t.getMany([id])),
      [],
    );
  }));
test("version PG: invalid or unawaited version operations cannot commit partial writes", () =>
  fixture(async (f) => {
    const id = await f.register();
    await assert.rejects(
      f.tenant.transaction(f.aScope, async (t) => {
        await t.versions.command(revise(id));
        await t.versions
          .command({ ...revise(id, 1), actor_id: f.bob })
          .catch(() => {});
      }),
      fails("invalid_input"),
    );
    assert.equal(await f.head(id), null);
    await assert.rejects(
      f.tenant.transaction(f.aScope, async (t) => {
        void t.versions.command(revise(id));
      }),
      fails("unavailable"),
    );
    assert.equal(await f.head(id), null);
  }));
test("version PG: revoked and stale organization sessions do not disclose conflict metadata", () =>
  fixture(async (f) => {
    const h = await f.create(),
      auth = await f.auth(f.bob);
    await f.repo.selectOrganization(
      auth.scope.session_digest,
      f.orgB,
      auth.scope.context_version,
    );
    await assert.rejects(
      f.commandVersion(revise(h.object_id, 0), auth.scope),
      fails("unavailable_resource"),
    );
    const another = await f.auth(f.bob);
    await f.repo.revokeSession(another.scope.session_digest);
    await assert.rejects(
      f.commandVersion(revise(h.object_id, 0), another.scope),
      fails("unavailable_resource"),
    );
  }));
test("version PG: emergency hold blocks old snapshot reads and requires fresh session after release", () =>
  fixture(async (f) => {
    const h = await f.create();
    assert.deepEqual(await f.head(h.object_id, f.reviewer.scope), h);
    await f.change();
    await assert.rejects(
      f.head(h.object_id, f.reviewer.scope),
      fails("unavailable_resource"),
    );
    await f.change(f.bobMember.id, f.owner.scope, "release");
    await assert.rejects(
      f.head(h.object_id, f.reviewer.scope),
      fails("unavailable_resource"),
    );
    assert.deepEqual(await f.head(h.object_id, (await f.auth(f.bob)).scope), h);
  }));
test("version PG: final expiry rolls back a successful append before returning its result", () =>
  fixture(async (f) => {
    const id = await f.register(),
      auth = await f.auth(f.alice);
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.sessions SET expires_at=clock_timestamp()+interval '2 seconds',idle_expires_at=clock_timestamp()+interval '2 seconds' WHERE digest=$1",
      [auth.scope.session_digest],
    );
    await assert.rejects(
      f.tenant.transaction(auth.scope, async (t) => {
        const result = await t.versions.command(revise(id));
        assert.equal(result.outcome, "applied");
        await query(f.adminPool, "SELECT pg_sleep(2.1)");
        return result;
      }),
      fails("unavailable_resource"),
    );
    assert.equal(await f.head(id), null);
  }));
test("version PG: expired advisory-lock waiter cannot reuse pre-wait authority", () =>
  fixture(async (f) => {
    const id = await f.register(),
      auth = await f.auth(f.alice),
      blocker = await f.adminPool.connect();
    let running;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`zentwine.versions.v1:${f.orgA}:${id}`],
      );
      await query(
        f.adminPool,
        "UPDATE zentwine_identity.sessions SET expires_at=clock_timestamp()+interval '2 seconds',idle_expires_at=clock_timestamp()+interval '2 seconds' WHERE digest=$1",
        [auth.scope.session_digest],
      );
      running = f.commandVersion(revise(id), auth.scope);
      running.catch(() => {});
      await waitForDatabaseLock(f.adminPool, "zentwine_versions.apply");
      await blocker.query("SELECT pg_sleep(2.1)");
      await blocker.query("COMMIT");
      await assert.rejects(running, fails("unavailable_resource"));
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([running].filter(Boolean));
    }
    assert.equal(await f.head(id), null);
  }));
test("version PG: pooled tenants and repeated state reads never reuse a previous context", () =>
  fixture(async (f) => {
    const a = await f.create(),
      b = await f.create(f.bScope);
    for (let n = 0; n < 4; n++) {
      assert.equal(await f.head(a.object_id, f.bScope), null);
      assert.equal(await f.head(b.object_id), null);
      assert.deepEqual(await f.head(a.object_id), a);
    }
    const rows = (
      await query(
        f.adminPool,
        "SELECT session_digest FROM zentwine_tenant_private.contexts",
      )
    ).rows;
    assert.ok(rows.every((r) => r.session_digest === null));
  }));
test("version PG: unused migration reverses and reapplies as the restricted owner", () =>
  fixture(async (f) => {
    const c = await f.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE "${f.tenantOwner}"`);
      await c.query(await sql("down"));
      await c.query(await sql("up"));
      assert.equal((await c.query(await sql("verify"))).rows[0].verified, true);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    assert.equal((await f.create()).object_version, 1);
  }));
test("version PG: populated migration refuses destructive downgrade and restores forced RLS", () =>
  fixture(async (f) => {
    const h = await f.approved(),
      c = await f.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE "${f.tenantOwner}"`);
      await assert.rejects(
        c.query(await sql("down")),
        /version_history_requires_forward_recovery/,
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    assert.equal(
      (await query(f.adminPool, await sql("verify"))).rows[0].verified,
      true,
    );
    assert.deepEqual(await f.head(h.object_id), h);
  }));
test("version PG: old approval tuple is never valid for a new revision with identical content", () =>
  fixture(async (f) => {
    const approved = await f.approved();
    const superseded = (
      await f.commandVersion(
        transition(approved, "supersede"),
        f.reviewer.scope,
      )
    ).current;
    const next = (
      await f.commandVersion({
        ...revise(approved.object_id, superseded.object_version),
        content: digestContent("test.spec.v1", { text: "Synthetic revision" }),
      })
    ).current;
    const review = (await f.commandVersion(transition(next, "submit"))).current;
    assert.equal(review.content_hash, approved.content_hash);
    assert.notEqual(review.revision_id, approved.revision_id);
    const stale = {
      ...transition(approved, "approve"),
      expected_version: review.object_version,
    };
    assert.equal(
      (await f.commandVersion(stale, f.reviewer.scope)).outcome,
      "conflict",
    );
    assert.deepEqual(
      await f.snapshot(approved.object_id, approved.object_version),
      approved,
    );
  }));
