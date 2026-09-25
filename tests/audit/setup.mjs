import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {
  fixture as organizationFixture,
  query,
  request,
  origin,
} from "../organizations/setup.mjs";
export { query, request, origin };
export const path = (f) => `/api/v1/orgs/${f.orgA}/audit-events`;
export const fails = (code) => (e) => e.code === code;
export const migration = (part) =>
  fs.readFile(
    `packages/db/migrations/0006-organization-audit-view.${part}.sql`,
    "utf8",
  );
export async function fixture(work) {
  return organizationFixture(async (f) => {
    await query(f.adminPool, await migration("up"));
    const record = async () =>
      f.organizations.updateSettings(f.owner.scope, await f.settingsInput());
    return work({ ...f, record });
  });
}
export async function waitForDatabaseLock(pool, fragment) {
  for (let n = 0; n < 200; n++) {
    const rows = (
      await query(
        pool,
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
        ["%" + fragment + "%"],
      )
    ).rows;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("A real lock wait in this fixture database was not observed");
}
