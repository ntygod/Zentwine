import { randomBytes } from "node:crypto";
import type { TenantFixture } from "./fixtures.js";

export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
}
export interface TestSqlClient {
  query(sql: string, values?: unknown[]): Promise<SqlResult>;
  close(): Promise<void>;
}
export interface TestConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}
export type TestConnector = (config: TestConnection) => Promise<TestSqlClient>;
export class TestDatabaseError extends Error {
  constructor(readonly code: string) {
    super(`Test database: ${code}`);
    this.name = "TestDatabaseError";
  }
}
/** Requires an explicitly disposable local server, independent of all production configuration. */
export function parseTestDatabaseEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): TestConnection {
  if (
    env["NODE_ENV"] !== "test" ||
    env["ZENTWINE_TEST_DATABASE_ACK"] !== "disposable-local-only"
  )
    throw new TestDatabaseError("explicit_test_opt_in_required");
  let u: URL;
  try {
    u = new URL(env["ZENTWINE_TEST_DATABASE_URL"] ?? "");
  } catch {
    throw new TestDatabaseError("invalid_test_database_url");
  }
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    !["127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/zentwine_test_control" ||
    u.username !== "zt_test_admin" ||
    !u.password ||
    u.search ||
    u.hash ||
    !u.port
  )
    throw new TestDatabaseError("unsafe_test_database_target");
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new TestDatabaseError("unsafe_test_database_target");
  try {
    return Object.freeze({
      host: u.hostname === "[::1]" ? "::1" : u.hostname,
      port,
      user: u.username,
      password: decodeURIComponent(u.password),
      database: "zentwine_test_control",
    });
  } catch {
    throw new TestDatabaseError("invalid_test_database_url");
  }
}
export interface TestDatabase {
  readonly fixture_only: true;
  readonly databaseName: string;
  readonly roleName: string;
  transaction<T>(
    tenant: TenantFixture,
    work: (client: TestSqlClient) => Promise<T>,
  ): Promise<T>;
  dispose(): Promise<void>;
}
async function guardedAdmin(
  config: TestConnection,
  connect: TestConnector,
): Promise<TestSqlClient> {
  const client = await connect(config);
  try {
    const check = await client.query(
      "SELECT current_database() AS db, current_user AS usr",
    );
    const guard = await client.query(
      "SELECT marker FROM public.zentwine_test_guard WHERE singleton = true",
    );
    if (
      check.rows[0]?.["db"] !== "zentwine_test_control" ||
      check.rows[0]?.["usr"] !== "zt_test_admin" ||
      guard.rows[0]?.["marker"] !== "zentwine-disposable-tests-v1"
    )
      throw new TestDatabaseError("test_server_guard_missing");
    return client;
  } catch {
    await client.close();
    throw new TestDatabaseError("test_server_guard_missing");
  }
}
export async function createTestDatabase(
  env: Readonly<Record<string, string | undefined>>,
  connect: TestConnector,
  tenants: readonly TenantFixture[],
): Promise<TestDatabase> {
  const adminConfig = parseTestDatabaseEnvironment(env);
  if (
    tenants.length < 1 ||
    tenants.some(
      (t) =>
        t.fixture_only !== true || !/^fixture_[a-z0-9_]{1,100}$/.test(t.org_id),
    ) ||
    new Set(tenants.map((t) => t.org_id)).size !== tenants.length
  )
    throw new TestDatabaseError("invalid_tenant_fixtures");
  const organizations = new Set(tenants.map((t) => t.org_id));
  const suffix = randomBytes(12).toString("hex");
  const databaseName = `zt_test_${suffix}`;
  const roleName = `zt_role_${suffix}`;
  const rolePassword = randomBytes(24).toString("hex");
  let databaseOid: unknown;
  let roleOid: unknown;
  let databaseCreated = false;
  let roleCreated = false;
  let closed = false;
  let active = 0;
  let disposing: Promise<void> | undefined;
  const appConfig = Object.freeze({
    ...adminConfig,
    database: databaseName,
    user: roleName,
    password: rolePassword,
  });
  async function cleanup(): Promise<void> {
    const admin = await guardedAdmin(adminConfig, connect);
    try {
      if (databaseCreated) {
        const rows = (
          await admin.query("SELECT oid FROM pg_database WHERE datname=$1", [
            databaseName,
          ])
        ).rows;
        if (
          rows.length &&
          databaseOid !== undefined &&
          rows[0]?.["oid"] !== databaseOid
        )
          throw new TestDatabaseError("database_ownership_changed");
        if (rows.length)
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        databaseCreated = false;
      }
      if (roleCreated) {
        const rows = (
          await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [
            roleName,
          ])
        ).rows;
        if (
          rows.length &&
          roleOid !== undefined &&
          rows[0]?.["oid"] !== roleOid
        )
          throw new TestDatabaseError("role_ownership_changed");
        if (rows.length) await admin.query(`DROP ROLE "${roleName}"`);
        roleCreated = false;
      }
    } finally {
      await admin.close();
    }
  }
  const admin = await guardedAdmin(adminConfig, connect);
  try {
    // All SQL identifiers and the password below are generated hexadecimal, never caller input.
    await admin.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    roleCreated = true;
    roleOid = (
      await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [roleName])
    ).rows[0]?.["oid"];
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    databaseCreated = true;
    databaseOid = (
      await admin.query("SELECT oid FROM pg_database WHERE datname=$1", [
        databaseName,
      ])
    ).rows[0]?.["oid"];
    await admin.query(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE "${databaseName}" TO "${roleName}"`,
    );
    const setup = await connect({ ...adminConfig, database: databaseName });
    try {
      await setup.query(`
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        CREATE TABLE public.fixture_rows (
          org_id text NOT NULL, id text NOT NULL, value jsonb NOT NULL,
          fixture_only boolean NOT NULL DEFAULT true CHECK (fixture_only), PRIMARY KEY (org_id, id)
        );
        ALTER TABLE public.fixture_rows ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.fixture_rows FORCE ROW LEVEL SECURITY;
        CREATE POLICY fixture_tenant_policy ON public.fixture_rows
          USING (org_id = current_setting('zentwine.test_org', true))
          WITH CHECK (org_id = current_setting('zentwine.test_org', true));
        GRANT USAGE ON SCHEMA public TO "${roleName}";
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.fixture_rows TO "${roleName}";
      `);
    } finally {
      await setup.close();
    }
  } catch (original) {
    try {
      await cleanup();
    } catch (failure) {
      throw new AggregateError(
        [original, failure],
        "Test database setup and cleanup failed",
      );
    }
    throw original;
  } finally {
    await admin.close();
  }
  return Object.freeze({
    fixture_only: true,
    databaseName,
    roleName,
    async transaction<T>(
      tenant: TenantFixture,
      work: (client: TestSqlClient) => Promise<T>,
    ): Promise<T> {
      if (closed || disposing) throw new TestDatabaseError("database_disposed");
      if (tenant.fixture_only !== true || !organizations.has(tenant.org_id))
        throw new TestDatabaseError("unknown_fixture_tenant");
      active++;
      let client: TestSqlClient | undefined;
      try {
        client = await connect(appConfig);
        await client.query("BEGIN");
        await client.query("SELECT set_config('zentwine.test_org', $1, true)", [
          tenant.org_id,
        ]);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (original) {
        if (client) {
          try {
            await client.query("ROLLBACK");
          } catch (rollback) {
            throw new AggregateError(
              [original, rollback],
              "Test transaction and rollback failed",
            );
          }
        }
        throw original;
      } finally {
        try {
          await client?.close();
        } finally {
          active--;
        }
      }
    },
    async dispose(): Promise<void> {
      if (closed) return;
      if (disposing) return disposing;
      if (active > 0) throw new TestDatabaseError("database_busy");
      disposing = cleanup();
      try {
        await disposing;
        closed = true;
      } finally {
        disposing = undefined;
      }
    },
  });
}
export async function withTestDatabase<T>(
  env: Readonly<Record<string, string | undefined>>,
  connect: TestConnector,
  tenants: readonly TenantFixture[],
  work: (db: TestDatabase) => Promise<T>,
): Promise<T> {
  const db = await createTestDatabase(env, connect, tenants);
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await work(db) };
  } catch (error) {
    outcome = { error };
  }
  try {
    await db.dispose();
  } catch (cleanup) {
    if ("error" in outcome)
      throw new AggregateError(
        [outcome.error, cleanup],
        "Test body and cleanup failed",
      );
    throw cleanup;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
