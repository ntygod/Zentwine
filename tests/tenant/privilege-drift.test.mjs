import test from "node:test";
import assert from "node:assert/strict";
import { fixture, query, fails } from "./setup.mjs";

test("tenant PG drift: identity schema access is incompatible with the dedicated runtime", () =>
  fixture(async (f) => {
    const { onlyA } = await f.seed();
    await query(
      f.adminPool,
      `GRANT USAGE ON SCHEMA zentwine_identity TO "${f.tenantRole}"`,
    );
    await assert.rejects(
      f.tenant.transaction(f.aScope, (t) => t.getMany([onlyA])),
      fails("unavailable"),
    );
    await query(
      f.adminPool,
      `REVOKE USAGE ON SCHEMA zentwine_identity FROM "${f.tenantRole}"`,
    );
    assert.equal(
      (await f.tenant.transaction(f.aScope, (t) => t.getMany([onlyA]))).length,
      1,
    );
  }));

test("tenant PG drift: column-only credential grants are detected without exposing the schema", () =>
  fixture(async (f) => {
    await query(
      f.adminPool,
      `GRANT SELECT(digest) ON zentwine_identity.sessions TO "${f.tenantRole}"`,
    );
    await assert.rejects(f.tenant.assertRuntimeRole(), fails("unavailable"));
    await query(
      f.adminPool,
      `REVOKE SELECT(digest) ON zentwine_identity.sessions FROM "${f.tenantRole}"`,
    );
    await f.tenant.assertRuntimeRole();
  }));

test("tenant PG drift: TRUNCATE and trigger privileges block transaction entry rather than bypass row policies", () =>
  fixture(async (f) => {
    const { onlyA } = await f.seed();
    for (const privilege of [
      "TRUNCATE",
      "TRIGGER",
      "REFERENCES",
      "UPDATE",
      "DELETE",
    ]) {
      await query(
        f.adminPool,
        `GRANT ${privilege} ON zentwine_tenant.object_keys TO "${f.tenantRole}"`,
      );
      let entered = false;
      await assert.rejects(
        f.tenant.transaction(f.aScope, async () => {
          entered = true;
        }),
        fails("unavailable"),
      );
      assert.equal(entered, false);
      await query(
        f.adminPool,
        `REVOKE ${privilege} ON zentwine_tenant.object_keys FROM "${f.tenantRole}"`,
      );
    }
    assert.equal(
      (await f.tenant.transaction(f.aScope, (t) => t.getMany([onlyA]))).length,
      1,
    );
  }));
