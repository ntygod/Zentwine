import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  applyMigration,
  revertMigration,
  inMigrationDatabase,
  loadMigrations,
  validateSql,
} from "../../scripts/quality/migrations.mjs";
const one = {
  id: "0001-synthetic",
  up: "CREATE TABLE public.synthetic_migration(id integer PRIMARY KEY)",
  down: "DROP TABLE public.synthetic_migration",
  verify:
    "SELECT (to_regclass('public.synthetic_migration') IS NOT NULL) AS verified",
};
test("migration: apply and retry use one ledger effect", () =>
  inMigrationDatabase(async (c) => {
    assert.equal(await applyMigration(c, one), "applied");
    assert.equal(await applyMigration(c, one), "already_applied");
    assert.equal(
      (await c.query("SELECT * FROM public.zt_migration_ledger")).rows.length,
      1,
    );
  }));
test("migration: changed historical SQL is refused", () =>
  inMigrationDatabase(async (c) => {
    await applyMigration(c, one);
    await assert.rejects(
      applyMigration(c, { ...one, up: one.up + "; SELECT 1" }),
      /history_changed/,
    );
  }));
test("migration: invalid SQL rolls back DDL and ledger", () =>
  inMigrationDatabase(async (c) => {
    await assert.rejects(
      applyMigration(c, {
        ...one,
        up: one.up + "; SELECT * FROM missing_migration_table",
      }),
    );
    assert.equal(
      (
        await c.query(
          "SELECT to_regclass('public.synthetic_migration') AS name",
        )
      ).rows[0].name,
      null,
    );
    assert.equal(
      (await c.query("SELECT * FROM public.zt_migration_ledger")).rows.length,
      0,
    );
  }));
test("migration: failed verification cannot commit", () =>
  inMigrationDatabase(async (c) => {
    await assert.rejects(
      applyMigration(c, { ...one, verify: "SELECT false AS verified" }),
      /verification_failed/,
    );
    assert.equal(
      (
        await c.query(
          "SELECT to_regclass('public.synthetic_migration') AS name",
        )
      ).rows[0].name,
      null,
    );
  }));
test("migration: reverse then reapply succeeds", () =>
  inMigrationDatabase(async (c) => {
    await applyMigration(c, one);
    await revertMigration(c, one);
    assert.equal(
      (
        await c.query(
          "SELECT to_regclass('public.synthetic_migration') AS name",
        )
      ).rows[0].name,
      null,
    );
    assert.equal(await applyMigration(c, one), "applied");
  }));
test("migration: a failed down script leaves the applied version intact", () =>
  inMigrationDatabase(async (c) => {
    const broken = {
      ...one,
      down: one.down + "; SELECT * FROM missing_rollback_table",
    };
    await applyMigration(c, broken);
    await assert.rejects(revertMigration(c, broken));
    assert.notEqual(
      (
        await c.query(
          "SELECT to_regclass('public.synthetic_migration') AS name",
        )
      ).rows[0].name,
      null,
    );
    assert.equal(
      (await c.query("SELECT * FROM public.zt_migration_ledger")).rows.length,
      1,
    );
  }));
test("migration: transaction escape and nontransactional statements are blocked", () => {
  for (const sql of [
    "COMMIT; SELECT 1",
    "/* prefix */ BEGIN",
    "CREATE INDEX CONCURRENTLY ix ON x(a)",
    "COPY x FROM PROGRAM 'echo'",
    "ALTER SYSTEM SET x=1",
  ])
    assert.throws(() => validateSql(sql));
});
test("migration: repository fresh install, upgrade, retry and rollback are explicit", async () => {
  const items = await loadMigrations();
  let priorCount = 0;
  if (process.env.QUALITY_BASE_REF) {
    const base = process.env.QUALITY_BASE_REF;
    assert.match(base, /^[a-f0-9]{40}$/);
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", base], {
      encoding: "utf8",
    });
    if (files.split("\n").includes("packages/db/migrations/manifest.json"))
      priorCount = JSON.parse(
        execFileSync(
          "git",
          ["show", `${base}:packages/db/migrations/manifest.json`],
          { encoding: "utf8" },
        ),
      ).migrations.length;
  }
  await inMigrationDatabase(async (c) => {
    for (const item of items)
      assert.equal(await applyMigration(c, item), "applied");
    for (const item of items)
      assert.equal(await applyMigration(c, item), "already_applied");
    for (const item of [...items].reverse()) await revertMigration(c, item);
    assert.equal(
      (await c.query("SELECT * FROM public.zt_migration_ledger")).rows.length,
      0,
    );
  });
  await inMigrationDatabase(async (c) => {
    for (const item of items.slice(0, priorCount))
      await applyMigration(c, item);
    for (const [i, item] of items.entries())
      assert.equal(
        await applyMigration(c, item),
        i < priorCount ? "already_applied" : "applied",
      );
  });
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile(
    "reports/migration-rehearsal.json",
    JSON.stringify(
      {
        status: "passed",
        business_migration_count: items.length,
        applicability: items.length
          ? "fresh_and_upgrade_verified"
          : "no_business_migrations",
        synthetic_test_cases: 7,
        production_migration_verified: false,
      },
      null,
      2,
    ),
  );
});
