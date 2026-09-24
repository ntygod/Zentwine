import test from "node:test";
import assert from "node:assert/strict";
import { createTenantFixtures } from "../../packages/testkit/dist/index.js";
import {
  createTestDatabase,
  withTestDatabase,
  parseTestDatabaseEnvironment,
} from "../../packages/testkit/dist/postgres.js";
import { connectTestPostgres } from "./pg-driver.mjs";
const allocatedDatabases = new Set();
const allocatedRoles = new Set();
async function connect(config) {
  const client = await connectTestPostgres(config);
  return {
    close: () => client.close(),
    async query(sql, values) {
      const result = await client.query(sql, values);
      if (sql.startsWith("CREATE DATABASE"))
        allocatedDatabases.add(/"([^"]+)"/.exec(sql)[1]);
      if (sql.startsWith("CREATE ROLE"))
        allocatedRoles.add(/"([^"]+)"/.exec(sql)[1]);
      return result;
    },
  };
}
// Missing configuration is an error, not a skip. Run this explicit suite only against disposable infrastructure.
const env = process.env;
const config = parseTestDatabaseEnvironment(env);
async function adminWork(work) {
  const c = await connect(config);
  try {
    return await work(c);
  } finally {
    await c.close();
  }
}
async function absent(db, role) {
  return adminWork(async (c) => {
    assert.equal(
      (await c.query("SELECT oid FROM pg_database WHERE datname=$1", [db])).rows
        .length,
      0,
    );
    assert.equal(
      (await c.query("SELECT oid FROM pg_roles WHERE rolname=$1", [role])).rows
        .length,
      0,
    );
  });
}
const insert = (c, tenant, id, value) =>
  c.query("INSERT INTO fixture_rows(org_id,id,value) VALUES($1,$2,$3)", [
    tenant.org_id,
    id,
    JSON.stringify(value),
  ]);
test("real PG: parallel temporary databases share neither data nor role and are removed", async () => {
  const names = [];
  await Promise.all(
    Array.from({ length: 4 }, (_, i) => {
      const tenants = createTenantFixtures(`parallel_${i}`);
      return withTestDatabase(env, connect, tenants, async (db) => {
        names.push([db.databaseName, db.roleName]);
        await db.transaction(tenants[0], async (c) => {
          await insert(c, tenants[0], "same-key", { i });
          await c.query("SELECT pg_sleep(0.05)");
          assert.deepEqual(
            (await c.query("SELECT value FROM fixture_rows")).rows,
            [{ value: { i } }],
          );
        });
      });
    }),
  );
  assert.equal(new Set(names.map((x) => x[0])).size, 4);
  for (const [db, role] of names) await absent(db, role);
});
test("real PG: RLS filters omitted WHERE clauses and denies foreign writes using a non-owner/non-superuser", async () => {
  const [a, b] = createTenantFixtures("rls");
  await withTestDatabase(env, connect, [a, b], async (db) => {
    await db.transaction(a, (c) => insert(c, a, "shared-key", { owner: "a" }));
    await db.transaction(b, (c) => insert(c, b, "shared-key", { owner: "b" }));
    await Promise.all(
      [a, b].map((t) =>
        db.transaction(t, async (c) => {
          const rows = (await c.query("SELECT org_id,value FROM fixture_rows"))
            .rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].org_id, t.org_id);
          const role = (
            await c.query(
              "SELECT rolsuper,rolbypassrls,rolcreatedb FROM pg_roles WHERE rolname=current_user",
            )
          ).rows[0];
          assert.deepEqual(role, {
            rolsuper: false,
            rolbypassrls: false,
            rolcreatedb: false,
          });
        }),
      ),
    );
    await assert.rejects(
      db.transaction(a, (c) => insert(c, b, "forbidden", {})),
      { code: "42501" },
    );
    await assert.rejects(
      db.transaction(a, (c) =>
        c.query("CREATE TABLE public.escalation(id int)"),
      ),
      { code: "42501" },
    );
  });
});
test("real PG: transaction-local tenant context does not survive commit", async () => {
  const [a] = createTenantFixtures("context");
  await withTestDatabase(env, connect, [a], async (db) => {
    await db.transaction(a, async (c) => {
      await insert(c, a, "a", {});
      await c.query("COMMIT"); // Deliberate lifecycle violation to test the GUC's database semantics.
      assert.equal(
        (await c.query("SELECT * FROM fixture_rows")).rows.length,
        0,
      );
    });
  });
});
test("real PG: callback failure rolls back, closes connection and preserves assertion", async () => {
  const [a] = createTenantFixtures("rollback");
  await withTestDatabase(env, connect, [a], async (db) => {
    const sentinel = new Error("synthetic assertion");
    await assert.rejects(
      db.transaction(a, async (c) => {
        await insert(c, a, "gone", {});
        throw sentinel;
      }),
      (e) => e === sentinel,
    );
    await db.transaction(a, async (c) =>
      assert.equal(
        (await c.query("SELECT * FROM fixture_rows")).rows.length,
        0,
      ),
    );
  });
});
test("real PG: failing test body still removes database and temporary role", async () => {
  const tenants = createTenantFixtures("failure");
  let saved;
  await assert.rejects(
    withTestDatabase(env, connect, tenants, async (db) => {
      saved = [db.databaseName, db.roleName];
      throw new Error("intentional test failure");
    }),
    /intentional test failure/,
  );
  await absent(...saved);
});
test("real PG: partial setup failure cleans resources without hiding original failure", async () => {
  const tenants = createTenantFixtures("partial");
  let savedDb;
  let savedRole;
  const faulty = async (conf) => {
    const c = await connect(conf);
    return {
      close: () => c.close(),
      async query(sql, values) {
        if (sql.startsWith("CREATE ROLE")) savedRole = /"([^"]+)"/.exec(sql)[1];
        if (sql.startsWith("CREATE DATABASE"))
          savedDb = /"([^"]+)"/.exec(sql)[1];
        if (sql.includes("CREATE TABLE public.fixture_rows"))
          throw new Error("synthetic setup failure");
        return c.query(sql, values);
      },
    };
  };
  await assert.rejects(
    createTestDatabase(env, faulty, tenants),
    /synthetic setup failure/,
  );
  await absent(savedDb, savedRole);
});
test("real PG: dispose is idempotent, use after disposal is rejected, unrelated resources survive", async () => {
  const tenants = createTenantFixtures("dispose");
  const keeper = await createTestDatabase(env, connect, tenants);
  const victim = await createTestDatabase(env, connect, tenants);
  try {
    await Promise.all([victim.dispose(), victim.dispose()]);
    await absent(victim.databaseName, victim.roleName);
    await assert.rejects(
      victim.transaction(tenants[0], async () => {}),
      { code: "database_disposed" },
    );
    await keeper.transaction(tenants[0], async (c) =>
      assert.equal((await c.query("SELECT 1 AS present")).rows[0].present, 1),
    );
  } finally {
    await victim.dispose();
    await keeper.dispose();
  }
});
test("real PG: unregistered tenant is rejected before acquiring a connection", async () => {
  const tenants = createTenantFixtures("known");
  const [stranger] = createTenantFixtures("stranger");
  await withTestDatabase(env, connect, tenants, (db) =>
    assert.rejects(
      db.transaction(stranger, async () => assert.fail("must not execute")),
      { code: "unknown_fixture_tenant" },
    ),
  );
});
test("real PG: disposal refuses active transactions and succeeds after they finish", async () => {
  const tenants = createTenantFixtures("busy");
  const db = await createTestDatabase(env, connect, tenants);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  const task = db.transaction(tenants[0], async () => {
    entered();
    await gate;
  });
  try {
    await ready;
    await assert.rejects(db.dispose(), { code: "database_busy" });
  } finally {
    release();
    await task;
    await db.dispose();
  }
  await absent(db.databaseName, db.roleName);
});
test("real PG: synthetic rows cannot claim fixture_only=false", async () => {
  const [a] = createTenantFixtures("tag");
  await withTestDatabase(env, connect, [a], (db) =>
    assert.rejects(
      db.transaction(a, (c) =>
        c.query(
          "INSERT INTO fixture_rows(org_id,id,value,fixture_only) VALUES($1,'bad','{}',false)",
          [a.org_id],
        ),
      ),
      { code: "23514" },
    ),
  );
});
test("real PG: cleanup failures are visible and disposal can be retried", async () => {
  const tenants = createTenantFixtures("retry_cleanup");
  let failDrop = true;
  const flaky = async (config) => {
    const c = await connect(config);
    return {
      close: () => c.close(),
      query(sql, values) {
        if (sql.startsWith("DROP DATABASE") && failDrop) {
          failDrop = false;
          throw new Error("synthetic cleanup failure");
        }
        return c.query(sql, values);
      },
    };
  };
  const db = await createTestDatabase(env, flaky, tenants);
  try {
    await assert.rejects(db.dispose(), /synthetic cleanup failure/);
  } finally {
    await db.dispose();
  }
  await absent(db.databaseName, db.roleName);
});
test("real PG: CREATE DATABASE failure removes already-created role", async () => {
  let savedRole;
  const faulty = async (config) => {
    const c = await connect(config);
    return {
      close: () => c.close(),
      async query(sql, values) {
        if (sql.startsWith("CREATE DATABASE"))
          throw new Error("synthetic create failure");
        const result = await c.query(sql, values);
        if (sql.startsWith("CREATE ROLE")) savedRole = /"([^"]+)"/.exec(sql)[1];
        return result;
      },
    };
  };
  await assert.rejects(
    createTestDatabase(env, faulty, createTenantFixtures("create_failure")),
    /synthetic create failure/,
  );
  await adminWork(async (c) =>
    assert.equal(
      (await c.query("SELECT oid FROM pg_roles WHERE rolname=$1", [savedRole]))
        .rows.length,
      0,
    ),
  );
});
test("real PG: control database contains no leftover databases or roles from this suite", async () => {
  await adminWork(async (c) => {
    assert.equal(
      (
        await c.query(
          "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
          [Array.from(allocatedDatabases)],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await c.query(
          "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
          [Array.from(allocatedRoles)],
        )
      ).rows.length,
      0,
    );
  });
});
