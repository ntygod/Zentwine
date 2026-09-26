import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, query, fails, sql, waitForDatabaseLock } from "./setup.mjs";
import { PostgresTenantRepository } from "../../packages/db/dist/index.js";
const read = (f, s, ids) => f.tenant.transaction(s, (t) => t.getMany(ids));

test("tenant PG: dedicated non-login owner installs forced RLS and least-privilege runtime", () =>
  fixture(async (f) => {
    const flags = (
      await query(
        f.adminPool,
        "SELECT rolcanlogin,rolbypassrls,rolsuper FROM pg_roles WHERE rolname=$1",
        [f.tenantOwner],
      )
    ).rows[0];
    assert.deepEqual(flags, {
      rolcanlogin: false,
      rolbypassrls: false,
      rolsuper: false,
    });
    assert.equal(
      (await query(f.adminPool, await sql("verify"))).rows[0].verified,
      true,
    );
    await f.tenant.assertRuntimeRole();
    const { onlyA } = await f.seed();
    assert.equal((await read(f, f.aScope, [onlyA])).length, 1);
  }));
test("tenant PG: no context returns zero rows and explicit writes are denied", () =>
  fixture(async (f) => {
    await f.seed();
    assert.deepEqual(
      (await query(f.tenantPool, "SELECT * FROM zentwine_tenant.object_keys"))
        .rows,
      [],
    );
    await f.raw(null, async (c) => {
      await assert.rejects(
        c.query(
          "INSERT INTO zentwine_tenant.object_keys(org_id,id,kind,created_by) VALUES($1,$2,'test.denied',$3)",
          [f.orgA, randomUUID(), f.alice],
        ),
        fails("42501"),
      );
    });
  }));
test("tenant PG: caller-controlled GUC and search_path never select a tenant", () =>
  fixture(async (f) => {
    const { onlyA, onlyB } = await f.seed();
    await f.raw(null, async (c) => {
      await c.query(
        "SELECT set_config('zentwine.org_id',$1,true),set_config('app.current_tenant',$1,true)",
        [f.orgB],
      );
      assert.deepEqual(
        (await c.query("SELECT * FROM zentwine_tenant.object_keys")).rows,
        [],
      );
    });
    await f.raw(f.aScope, async (c) => {
      await c.query(
        "SELECT set_config('zentwine.org_id',$1,true),set_config('app.current_tenant',$1,true)",
        [f.orgB],
      );
      await c.query("SET LOCAL search_path=pg_temp,public,zentwine_tenant");
      const rows = (
        await c.query(
          "SELECT * FROM zentwine_tenant.object_keys WHERE id=ANY($1::uuid[])",
          [[onlyA, onlyB]],
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => r.id),
        [onlyA],
      );
    });
  }));
test("tenant PG: forged org and digest fail before exposing repository operations", () =>
  fixture(async (f) => {
    const { onlyB } = await f.seed();
    await assert.rejects(
      read(f, { ...f.aScope, org_id: f.orgB }, [onlyB]),
      fails("unavailable_resource"),
    );
    await assert.rejects(
      read(f, { ...f.aScope, session_digest: "a".repeat(64) }, [onlyB]),
      fails("unavailable_resource"),
    );
    await assert.rejects(
      read(f, { ...f.aScope, context_version: 999 }, [onlyB]),
      fails("unavailable_resource"),
    );
  }));
test("tenant PG: mixed batch IDs and concurrent tenants expose only their own keys", () =>
  fixture(async (f) => {
    const { shared, onlyA, onlyB } = await f.seed(),
      ids = [shared, onlyA, onlyB];
    const rows = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        read(f, n % 2 ? f.bScope : f.aScope, ids),
      ),
    );
    for (const [n, values] of rows.entries()) {
      assert.equal(values.length, 2);
      assert.ok(values.every((r) => r.org_id === (n % 2 ? f.orgB : f.orgA)));
      assert.equal(
        values.find((r) => r.id === shared).kind,
        n % 2 ? "test.shared-b" : "test.shared-a",
      );
    }
  }));
test("tenant PG: joins aggregate counts and explicit foreign filters remain row-isolated", () =>
  fixture(async (f) => {
    const { shared, onlyA } = await f.seed();
    await f.raw(f.aScope, async (c) => {
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::integer AS n FROM zentwine_tenant.object_keys",
          )
        ).rows[0].n,
        2,
      );
      assert.deepEqual(
        (
          await c.query(
            "SELECT * FROM zentwine_tenant.object_keys WHERE org_id=$1",
            [f.orgB],
          )
        ).rows,
        [],
      );
      const joined = (
        await c.query(
          "SELECT k.id,l.org_id FROM zentwine_tenant.object_links l JOIN zentwine_tenant.object_keys k ON l.target_id=k.id WHERE l.source_id=$1",
          [shared],
        )
      ).rows;
      assert.deepEqual(joined, [{ id: onlyA, org_id: f.orgA }]);
    });
    assert.deepEqual(
      (await f.tenant.transaction(f.aScope, (t) => t.linked(shared))).map(
        (r) => r.id,
      ),
      [onlyA],
    );
  }));
test("tenant PG: explicit cross-tenant insert is blocked by WITH CHECK", () =>
  fixture(async (f) => {
    await f.seed();
    await f.raw(f.aScope, (c) =>
      assert.rejects(
        c.query(
          "INSERT INTO zentwine_tenant.object_keys(org_id,id,kind,created_by) VALUES($1,$2,'test.forbidden',$3)",
          [f.orgB, randomUUID(), f.alice],
        ),
        fails("42501"),
      ),
    );
  }));
test("tenant PG: forged actor attribution cannot pass the insert policy", () =>
  fixture(async (f) => {
    await f.raw(f.aScope, (c) =>
      assert.rejects(
        c.query(
          "INSERT INTO zentwine_tenant.object_keys(id,kind,created_by) VALUES($1,'test.forged',$2)",
          [randomUUID(), f.bob],
        ),
        fails("42501"),
      ),
    );
  }));
test("tenant PG: composite foreign keys reject cross-tenant links without an existence oracle", () =>
  fixture(async (f) => {
    const { onlyA, onlyB } = await f.seed();
    for (const target of [onlyB, randomUUID()])
      await assert.rejects(
        f.tenant.transaction(f.aScope, (t) =>
          t.link(onlyA, target, "test.cross"),
        ),
        fails("unavailable_resource"),
      );
    await f.raw(f.aScope, (c) =>
      assert.rejects(
        c.query(
          "INSERT INTO zentwine_tenant.object_links(org_id,source_id,target_id,kind,created_by) VALUES($1,$2,$3,'test.cross',$4)",
          [f.orgB, onlyB, onlyB, f.alice],
        ),
        fails("42501"),
      ),
    );
  }));
test("tenant PG: tenant-scoped uniqueness permits identical IDs without leaking foreign existence", () =>
  fixture(async (f) => {
    const { shared } = await f.seed();
    const original = await f.tenant.transaction(f.aScope, (t) =>
      t.register(shared, "test.shared-a"),
    );
    const repeated = await f.tenant.transaction(f.aScope, (t) =>
      t.register(shared, "test.shared-a"),
    );
    assert.deepEqual(repeated, original);
    await assert.rejects(
      f.tenant.transaction(f.aScope, (t) => t.register(shared, "test.changed")),
      fails("version_conflict"),
    );
    assert.equal((await read(f, f.bScope, [shared]))[0].kind, "test.shared-b");
  }));
test("tenant PG: readonly members can read keys but cannot register or link", () =>
  fixture(async (f) => {
    const { shared, onlyB } = await f.seed(),
      viewer = (await f.auth(f.alice, f.orgB)).scope;
    assert.equal((await read(f, viewer, [onlyB])).length, 1);
    await assert.rejects(
      f.tenant.transaction(viewer, (t) =>
        t.register(randomUUID(), "test.viewer"),
      ),
      fails("forbidden"),
    );
    await assert.rejects(
      f.tenant.transaction(viewer, (t) => t.link(shared, onlyB, "test.viewer")),
      fails("forbidden"),
    );
  }));
test("tenant PG: guests have no unfiltered registry access even when catalog sharing exists", () =>
  fixture(async (f) => {
    const { onlyA } = await f.seed(),
      guest = await f.accept(await f.invite());
    assert.equal(
      (await f.policy.readResource(guest.scope, f.a.id)).resource.id,
      f.a.id,
    );
    await assert.rejects(
      read(f, guest.scope, [onlyA]),
      fails("unavailable_resource"),
    );
  }));
test("tenant PG: runtime cannot read credentials or change private context and schema", () =>
  fixture(async (f) => {
    for (const statement of [
      "SELECT * FROM zentwine_identity.sessions",
      "SELECT * FROM zentwine_identity.login_tickets",
      "SELECT * FROM zentwine_tenant_private.contexts",
      "UPDATE zentwine_tenant_private.contexts SET org_id=NULL",
      "SELECT * FROM zentwine_tenant_private.verified_scope()",
      "CREATE TABLE zentwine_tenant.illegal(id integer)",
      "CREATE TEMP TABLE illegal(id integer)",
      "TRUNCATE zentwine_tenant.object_keys",
      "DELETE FROM zentwine_tenant.object_keys",
      "UPDATE zentwine_tenant.object_keys SET kind='test.changed'",
    ])
      await assert.rejects(query(f.tenantPool, statement), fails("42501"));
  }));
test("tenant PG: disabling RLS and replacing guard functions are unavailable to runtime", () =>
  fixture(async (f) => {
    await f.seed();
    for (const statement of [
      "ALTER TABLE zentwine_tenant.object_keys DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE zentwine_tenant.object_links NO FORCE ROW LEVEL SECURITY",
      "DROP POLICY tenant_fence ON zentwine_tenant.object_keys",
      "CREATE OR REPLACE FUNCTION zentwine_tenant.current_org() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'",
      `SET ROLE "${f.tenantOwner}"`,
    ])
      await assert.rejects(query(f.tenantPool, statement), fails("42501"));
    await f.raw(f.aScope, async (c) => {
      await c.query("SET LOCAL row_security=off");
      await assert.rejects(
        c.query("SELECT * FROM zentwine_tenant.object_keys"),
        fails("42501"),
      );
    });
  }));
test("tenant PG: FORCE RLS also restricts the non-bypass table owner without context", () =>
  fixture(async (f) => {
    await f.seed();
    const c = await f.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE "${f.tenantOwner}"`);
      assert.deepEqual(
        (await c.query("SELECT * FROM zentwine_tenant.object_keys")).rows,
        [],
      );
      assert.deepEqual(
        (await c.query("SELECT * FROM zentwine_tenant.object_links")).rows,
        [],
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }));
test("tenant PG: migration and identity-control credentials are rejected as tenant runtime", () =>
  fixture(async (f) => {
    await assert.rejects(
      new PostgresTenantRepository(f.adminPool).assertRuntimeRole(),
      fails("unavailable"),
    );
    await assert.rejects(
      new PostgresTenantRepository(f.appPool).assertRuntimeRole(),
      fails("unavailable"),
    );
    await assert.rejects(
      new PostgresTenantRepository(f.managerPool).assertRuntimeRole(),
      fails("unavailable"),
    );
  }));
test("tenant PG: role bypass and inherited privileges are rechecked on every transaction", () =>
  fixture(async (f) => {
    await query(f.adminPool, `ALTER ROLE "${f.tenantRole}" BYPASSRLS`);
    await assert.rejects(read(f, f.aScope, []), fails("unavailable"));
    await query(
      f.adminPool,
      `ALTER ROLE "${f.tenantRole}" NOBYPASSRLS; GRANT "${f.tenantOwner}" TO "${f.tenantRole}"`,
    );
    await assert.rejects(read(f, f.aScope, []), fails("unavailable"));
    await query(
      f.adminPool,
      `REVOKE "${f.tenantOwner}" FROM "${f.tenantRole}"`,
    );
    assert.deepEqual(await read(f, f.aScope, []), []);
  }));
test("tenant PG: sequential pooled requests neither reuse tenant scope nor retain a session digest", () =>
  fixture(async (f) => {
    const { shared, onlyA, onlyB } = await f.seed();
    const before = (await query(f.tenantPool, "SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    assert.equal((await read(f, f.aScope, [shared, onlyA, onlyB])).length, 2);
    assert.deepEqual(
      (await query(f.tenantPool, "SELECT * FROM zentwine_tenant.object_keys"))
        .rows,
      [],
    );
    assert.equal((await read(f, f.bScope, [shared, onlyA, onlyB])).length, 2);
    const after = (await query(f.tenantPool, "SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    assert.equal(before, after);
    const row = (
      await query(
        f.adminPool,
        "SELECT session_digest,org_id,context_version FROM zentwine_tenant_private.contexts WHERE backend_pid=$1",
        [after],
      )
    ).rows[0];
    assert.deepEqual(row, {
      session_digest: null,
      org_id: null,
      context_version: null,
    });
  }));
test("tenant PG: rebinding within one transaction is refused even after explicit closure", () =>
  fixture(async (f) => {
    for (const close of [false, true])
      await f.raw(f.aScope, async (c) => {
        if (close)
          assert.equal(
            (await c.query("SELECT zentwine_tenant.finish_context() AS org"))
              .rows[0].org,
            f.orgA,
          );
        await assert.rejects(
          c.query("SELECT zentwine_tenant.bind_context($1,$2,$3)", [
            f.bScope.session_digest,
            f.orgB,
            f.bScope.context_version,
          ]),
          fails("23505"),
        );
      });
    assert.deepEqual(await read(f, f.bScope, []), []);
  }));
test("tenant PG: callback failure rolls back keys and links and never returns a successful result", () =>
  fixture(async (f) => {
    const x = randomUUID(),
      y = randomUUID();
    await assert.rejects(
      f.tenant.transaction(f.aScope, async (t) => {
        await t.register(x, "test.rollback");
        await t.register(y, "test.rollback");
        await t.link(x, y, "test.rollback");
        throw new Error("raw detail must stay private");
      }),
      fails("unavailable"),
    );
    assert.deepEqual(await read(f, f.aScope, [x, y]), []);
  }));
test("tenant PG: caught operation error still prevents partial commit", () =>
  fixture(async (f) => {
    const x = randomUUID();
    await assert.rejects(
      f.tenant.transaction(f.aScope, async (t) => {
        await t.register(x, "test.first");
        await assert.rejects(
          t.register(x, "test.conflict"),
          fails("version_conflict"),
        );
      }),
      fails("version_conflict"),
    );
    assert.deepEqual(await read(f, f.aScope, [x]), []);
  }));
test("tenant PG: escaped units reject future queries and unawaited work is drained then rolled back", () =>
  fixture(async (f) => {
    let escaped;
    await f.tenant.transaction(f.aScope, async (t) => {
      escaped = t;
      await t.getMany([]);
    });
    await assert.rejects(escaped.getMany([]), fails("transaction_closed"));
    const x = randomUUID();
    let pending;
    await assert.rejects(
      f.tenant.transaction(f.aScope, async (t) => {
        pending = t.register(x, "test.unawaited");
      }),
      fails("unavailable"),
    );
    await pending;
    assert.deepEqual(await read(f, f.aScope, [x]), []);
  }));
test("tenant PG: revoked session and stale selected-organization version cannot create a new scope", () =>
  fixture(async (f) => {
    await f.seed();
    const auth = await f.auth(f.alice);
    await f.repo.selectOrganization(
      auth.scope.session_digest,
      f.orgB,
      auth.scope.context_version,
    );
    await assert.rejects(
      read(f, auth.scope, []),
      fails("unavailable_resource"),
    );
    await f.repo.revokeSession(f.aScope.session_digest);
    await assert.rejects(read(f, f.aScope, []), fails("unavailable_resource"));
  }));
test("tenant PG: emergency containment propagates and release requires a fresh session", () =>
  fixture(async (f) => {
    const { onlyA } = await f.seed();
    assert.equal((await read(f, f.reviewer.scope, [onlyA])).length, 1);
    await f.change();
    await assert.rejects(
      read(f, f.reviewer.scope, [onlyA]),
      fails("unavailable_resource"),
    );
    await f.change(f.bobMember.id, f.owner.scope, "release");
    await assert.rejects(
      read(f, f.reviewer.scope, [onlyA]),
      fails("unavailable_resource"),
    );
    assert.equal(
      (await read(f, (await f.auth(f.bob)).scope, [onlyA])).length,
      1,
    );
  }));
test("tenant PG: human disable and member revocation prevent future tenant reads", () =>
  fixture(async (f) => {
    const { onlyA } = await f.seed();
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.humans SET status='disabled',auth_version=auth_version+1 WHERE id=$1",
      [f.bob],
    );
    await assert.rejects(
      read(f, f.reviewer.scope, [onlyA]),
      fails("unavailable_resource"),
    );
    await f.admin.setMembership(
      f.aliceMember.id,
      f.orgA,
      f.alice,
      "MEM-1",
      "owner",
      "revoked",
    );
    await assert.rejects(
      read(f, f.aScope, [onlyA]),
      fails("unavailable_resource"),
    );
  }));
test("tenant PG: expiry after a successful operation is rechecked and rolls back before returning", () =>
  fixture(async (f) => {
    const auth = await f.auth(f.alice),
      x = randomUUID();
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.sessions SET expires_at=statement_timestamp()+interval '2 seconds',idle_expires_at=statement_timestamp()+interval '2 seconds' WHERE digest=$1",
      [auth.scope.session_digest],
    );
    await assert.rejects(
      f.tenant.transaction(auth.scope, async (t) => {
        await t.register(x, "test.expiry");
        await query(f.adminPool, "SELECT pg_sleep(2.1)");
        return "must not escape as success";
      }),
      fails("unavailable_resource"),
    );
    assert.deepEqual(await read(f, f.aScope, [x]), []);
  }));
test("tenant PG: a real table-lock wait cannot preserve expired authority", () =>
  fixture(async (f) => {
    const auth = await f.auth(f.alice),
      blocker = await f.adminPool.connect(),
      x = randomUUID();
    let operation;
    try {
      await query(
        f.adminPool,
        "UPDATE zentwine_identity.sessions SET expires_at=statement_timestamp()+interval '2 seconds',idle_expires_at=statement_timestamp()+interval '2 seconds' WHERE digest=$1",
        [auth.scope.session_digest],
      );
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE zentwine_tenant.object_keys IN ACCESS EXCLUSIVE MODE",
      );
      operation = f.tenant.transaction(auth.scope, (t) =>
        t.register(x, "test.lock-expiry"),
      );
      operation.catch(() => {});
      await waitForDatabaseLock(
        f.adminPool,
        "INSERT INTO zentwine_tenant.object_keys",
      );
      await blocker.query("SELECT pg_sleep(2.1)");
      await blocker.query("COMMIT");
      await assert.rejects(operation, (e) =>
        ["forbidden", "unavailable_resource"].includes(e.code),
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([operation].filter(Boolean));
    }
    assert.deepEqual(await read(f, f.aScope, [x]), []);
  }));
test("tenant PG: containment waiting ahead of a tenant request wins through actual authority locks", () =>
  fixture(async (f) => {
    const command = await f.command(),
      blocker = await f.adminPool.connect();
    let changed, reading;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
        ["zentwine.authz.v1:policy:" + f.orgA],
      );
      changed = f.organizations.emergencyChange(
        f.owner.scope,
        f.bobMember.id,
        command,
      );
      changed.catch(() => {});
      await waitForDatabaseLock(f.adminPool, "pg_advisory_xact_lock(");
      reading = read(f, f.reviewer.scope, []);
      reading.catch(() => {});
      await waitForDatabaseLock(f.adminPool, "zentwine_tenant.bind_context");
      await blocker.query("COMMIT");
      await changed;
      await assert.rejects(reading, fails("unavailable_resource"));
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([changed, reading].filter(Boolean));
    }
  }));
test("tenant PG: an authorized in-flight transaction completes before later containment without deadlock", () =>
  fixture(async (f) => {
    const { onlyA } = await f.seed(),
      command = await f.command();
    let ready, release;
    const entered = new Promise((r) => {
        ready = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const running = f.tenant.transaction(f.reviewer.scope, async (t) => {
      await t.getMany([onlyA]);
      ready();
      await gate;
      return t.getMany([onlyA]);
    });
    running.catch(() => {});
    let changed;
    try {
      await entered;
      changed = f.organizations.emergencyChange(
        f.owner.scope,
        f.bobMember.id,
        command,
      );
      changed.catch(() => {});
      await waitForDatabaseLock(f.adminPool, "pg_advisory_xact_lock(");
      release();
      assert.equal((await running).length, 1);
      await changed;
      await assert.rejects(
        read(f, f.reviewer.scope, [onlyA]),
        fails("unavailable_resource"),
      );
    } finally {
      release();
      await Promise.allSettled([running, changed].filter(Boolean));
    }
  }));
test("tenant PG: unused owner migration reverses and reapplies transactionally", () =>
  fixture(async (f) => {
    const c = await f.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE "${f.tenantOwner}"`);
      await c.query(await sql("down"));
      await c.query(await sql("up"));
      assert.equal((await c.query(await sql("verify"))).rows[0].verified, true);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    await f.tenant.assertRuntimeRole();
  }));
test("tenant PG: populated registry refuses destructive downgrade and restores FORCE after rollback", () =>
  fixture(async (f) => {
    const { onlyA } = await f.seed(),
      c = await f.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE "${f.tenantOwner}"`);
      await assert.rejects(c.query(await sql("down")), fails("23514"));
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    assert.equal(
      (await query(f.adminPool, await sql("verify"))).rows[0].verified,
      true,
    );
    assert.equal((await read(f, f.aScope, [onlyA])).length, 1);
  }));
