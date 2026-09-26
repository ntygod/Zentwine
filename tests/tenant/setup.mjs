import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  fixture as emergencyFixture,
  query,
  waitForDatabaseLock,
} from "../emergency/setup.mjs";
import { dsn } from "../identity/setup.mjs";
import {
  createIdentityPool,
  PostgresTenantRepository,
  tenantRuntimeGrantSql,
} from "../../packages/db/dist/index.js";
export { query, waitForDatabaseLock };
export const fails = (code) => (e) => e.code === code;
export const sql = (part) =>
  fs.readFile(
    `packages/db/migrations/0008-tenant-repository.${part}.sql`,
    "utf8",
  );
export async function fixture(work) {
  return emergencyFixture(async (f) => {
    const suffix = randomBytes(12).toString("hex"),
      owner = "zt_tenant_owner_" + suffix,
      runtime = "zt_tenant_app_" + suffix;
    const password = randomBytes(24).toString("hex");
    let ownerCreated = false,
      appCreated = false,
      pool;
    try {
      await query(
        f.adminPool,
        `CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      ownerCreated = true;
      await query(
        f.adminPool,
        `CREATE ROLE "${runtime}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      appCreated = true;
      const c = await f.adminPool.connect();
      try {
        await c.query(`GRANT CREATE ON DATABASE "${f.appConfig.database}" TO "${owner}";
          GRANT USAGE ON SCHEMA zentwine_identity,zentwine_organizations TO "${owner}";
          GRANT SELECT ON zentwine_identity.sessions,zentwine_identity.humans,zentwine_identity.organizations,zentwine_identity.memberships,zentwine_organizations.session_cutoffs TO "${owner}";
          GRANT REFERENCES(id) ON zentwine_identity.humans,zentwine_identity.organizations TO "${owner}";
          GRANT UPDATE(id) ON zentwine_identity.sessions TO "${owner}";`);
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE "${owner}"`);
        await c.query(await sql("up"));
        assert.equal(
          (await c.query(await sql("verify"))).rows[0].verified,
          true,
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
      await query(f.adminPool, tenantRuntimeGrantSql(runtime));
      pool = createIdentityPool(
        dsn({ ...f.appConfig, user: runtime, password }),
      );
      const tenant = new PostgresTenantRepository(pool);
      await tenant.assertRuntimeRole();
      const a = f.owner.scope,
        b = (await f.auth(f.bob, f.orgB)).scope;
      const seed = async () => {
        const shared = randomUUID(),
          onlyA = randomUUID(),
          onlyB = randomUUID();
        await tenant.transaction(a, async (t) => {
          await t.register(shared, "test.shared-a");
          await t.register(onlyA, "test.only-a");
          await t.link(shared, onlyA, "test.related");
        });
        await tenant.transaction(b, async (t) => {
          await t.register(shared, "test.shared-b");
          await t.register(onlyB, "test.only-b");
          await t.link(shared, onlyB, "test.related");
        });
        return { shared, onlyA, onlyB };
      };
      const raw = async (scope, action) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          if (scope)
            assert.equal(
              (
                await client.query(
                  "SELECT zentwine_tenant.bind_context($1,$2,$3) AS org_id",
                  [scope.session_digest, scope.org_id, scope.context_version],
                )
              ).rows[0].org_id,
              scope.org_id,
            );
          return await action(client);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      };
      return await work({
        ...f,
        tenant,
        tenantPool: pool,
        tenantOwner: owner,
        tenantRole: runtime,
        aScope: a,
        bScope: b,
        seed,
        raw,
      });
    } finally {
      await pool?.end();
      if (appCreated)
        await query(
          f.adminPool,
          `DROP OWNED BY "${runtime}"; DROP ROLE "${runtime}";`,
        );
      if (ownerCreated)
        await query(
          f.adminPool,
          `DROP OWNED BY "${owner}" CASCADE; DROP ROLE "${owner}";`,
        );
    }
  });
}
