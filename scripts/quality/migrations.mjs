/** Test-only migration rehearsal on the disposable PostgreSQL server. Never a production migrator. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTenantFixtures } from "../../packages/testkit/dist/index.js";
import {
  withTestDatabase,
  parseTestDatabaseEnvironment,
} from "../../packages/testkit/dist/postgres.js";
import { connectTestPostgres } from "../../tests/integration/pg-driver.mjs";

export function validateSql(sql) {
  if (
    typeof sql !== "string" ||
    !sql.trim() ||
    Buffer.byteLength(sql) > 256000 ||
    /\b(BEGIN|COMMIT|ROLLBACK|CONCURRENTLY|VACUUM|COPY|DO|CALL|pg_sleep|dblink)\b|\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|DATABASE|SYSTEM|EXTENSION)\b|\\(?:connect|include)/i.test(
      sql,
    )
  )
    throw new Error("unsupported_migration_statement");
}
const hash = (s) => createHash("sha256").update(s).digest("hex");
export function migrationDigest(migration) {
  return hash(
    JSON.stringify([
      migration.id,
      migration.up,
      migration.down,
      migration.verify,
    ]),
  );
}
export async function initializeLedger(client) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS public.zt_migration_ledger(id text PRIMARY KEY, digest text NOT NULL)",
  );
}
export async function applyMigration(client, migration) {
  if (!/^\d{4}-[a-z][a-z0-9-]{0,60}$/.test(migration.id))
    throw new Error("invalid_migration_id");
  for (const p of ["up", "down", "verify"]) validateSql(migration[p]);
  const digest = migrationDigest(migration);
  await client.query("BEGIN");
  try {
    await client.query(
      "LOCK TABLE public.zt_migration_ledger IN EXCLUSIVE MODE",
    );
    const prior = await client.query(
      "SELECT digest FROM public.zt_migration_ledger WHERE id=$1",
      [migration.id],
    );
    if (prior.rows.length) {
      if (prior.rows[0].digest !== digest)
        throw new Error("migration_history_changed");
      await client.query("COMMIT");
      return "already_applied";
    }
    await client.query(migration.up);
    const result = await client.query(migration.verify);
    if (result.rows.length !== 1 || result.rows[0].verified !== true)
      throw new Error("migration_verification_failed");
    await client.query(
      "INSERT INTO public.zt_migration_ledger(id,digest) VALUES($1,$2)",
      [migration.id, digest],
    );
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK");
    // No raw SQL/database exception is exposed by the guarded driver.
    throw error;
  }
}
export async function revertMigration(client, migration) {
  validateSql(migration.down);
  await client.query("BEGIN");
  try {
    await client.query(
      "LOCK TABLE public.zt_migration_ledger IN EXCLUSIVE MODE",
    );
    const rows = (
      await client.query(
        "SELECT id,digest FROM public.zt_migration_ledger ORDER BY id DESC LIMIT 1",
      )
    ).rows;
    if (
      rows.length !== 1 ||
      rows[0].id !== migration.id ||
      rows[0].digest !== migrationDigest(migration)
    )
      throw new Error("rollback_order_or_digest_invalid");
    await client.query(migration.down);
    await client.query("DELETE FROM public.zt_migration_ledger WHERE id=$1", [
      migration.id,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
export async function inMigrationDatabase(work) {
  const config = parseTestDatabaseEnvironment(process.env);
  const tenants = createTenantFixtures("migration_rehearsal");
  return withTestDatabase(
    process.env,
    connectTestPostgres,
    tenants,
    async (db) => {
      const client = await connectTestPostgres({
        ...config,
        database: db.databaseName,
      });
      try {
        await initializeLedger(client);
        return await work(client);
      } finally {
        await client.close();
      }
    },
  );
}
export async function loadMigrations() {
  const result = spawnSync(
    process.env.QUALITY_PYTHON ?? "python3",
    ["scripts/quality/gate.py", "migrations"],
    { encoding: "utf8", timeout: 15000 },
  );
  if (result.status !== 0) throw new Error("migration_manifest_check_failed");
  const data = JSON.parse(
    await fs.readFile("packages/db/migrations/manifest.json", "utf8"),
  );
  const items = [];
  for (const entry of data.migrations) {
    const item = { id: entry.id };
    for (const part of ["up", "down", "verify"]) {
      const file = path.resolve(entry[part].path);
      const bytes = await fs.readFile(file);
      if (hash(bytes) !== entry[part].sha256)
        throw new Error("migration_digest_changed_after_check");
      item[part] = bytes.toString("utf8");
      validateSql(item[part]);
    }
    items.push(item);
  }
  return items;
}
