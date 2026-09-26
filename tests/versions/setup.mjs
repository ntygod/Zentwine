import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture as tenantFixture,
  query,
  fails,
  waitForDatabaseLock,
} from "../tenant/setup.mjs";
import {
  digestContent,
  versionRuntimeGrantSql,
} from "../../packages/db/dist/index.js";
export { query, fails, waitForDatabaseLock, tenantFixture, digestContent };
export const sql = (part) =>
  fs.readFile(`packages/db/migrations/0009-version-cas.${part}.sql`, "utf8");
export const revise = (
  id,
  expected = 0,
  content = { text: "Synthetic revision" },
  relations = [],
) => ({
  object_id: id,
  expected_version: expected,
  action: "revise",
  content: digestContent("test.spec.v1", content),
  relations,
});
export const transition = (h, action) => ({
  object_id: h.object_id,
  expected_version: h.object_version,
  action,
  revision_id: h.revision_id,
  content_hash: h.content_hash,
});
export const relation = (h) => ({
  kind: "depends_on",
  source: "declared",
  target_object_id: h.object_id,
  target_revision_id: h.revision_id,
  target_hash: h.content_hash,
});
export async function fixture(work) {
  return tenantFixture(async (f) => {
    const c = await f.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE "${f.tenantOwner}"`);
      await c.query(await sql("up"));
      assert.equal((await c.query(await sql("verify"))).rows[0].verified, true);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    await query(f.adminPool, versionRuntimeGrantSql(f.tenantRole));
    const command = (input, scope = f.aScope) =>
      f.tenant.transaction(scope, (t) => t.versions.command(input));
    const head = (id, scope = f.aScope) =>
      f.tenant.transaction(scope, (t) => t.versions.head(id));
    const snapshot = (id, v, scope = f.aScope) =>
      f.tenant.transaction(scope, (t) => t.versions.snapshot(id, v));
    const relations = (h, scope = f.aScope) =>
      f.tenant.transaction(scope, (t) =>
        t.versions.relations(h.object_id, h.revision_id),
      );
    const register = async (scope = f.aScope, id = randomUUID()) => {
      await f.tenant.transaction(scope, (t) => t.register(id, "test.spec"));
      return id;
    };
    const create = async (scope = f.aScope) => {
      const id = await register(scope);
      const r = await command(revise(id), scope);
      assert.equal(r.outcome, "applied");
      return r.current;
    };
    const approved = async () => {
      let h = await create();
      h = (await command(transition(h, "submit"))).current;
      h = (await command(transition(h, "approve"), f.reviewer.scope)).current;
      assert.equal(h.status, "approved");
      return h;
    };
    return work({
      ...f,
      commandVersion: command,
      head,
      snapshot,
      relations,
      register,
      create,
      approved,
    });
  });
}
