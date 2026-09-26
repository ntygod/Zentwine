import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateTenantScope,
  validateTenantIds,
  validateTenantKind,
  TenantError,
} from "../packages/domain/dist/index.js";
import { PostgresTenantRepository } from "../packages/db/dist/tenant.js";
import { tenantRuntimeGrantSql } from "../packages/db/dist/tenant-grants.js";
const scope = () => ({
  session_digest: "a".repeat(64),
  org_id: randomUUID(),
  context_version: 1,
});
const fails = (code) => (e) => e instanceof TenantError && e.code === code;
function fake(s, hook = () => undefined) {
  const calls = [],
    released = [];
  const c = {
    async query(sql, values) {
      calls.push({ sql, values });
      const changed = await hook(sql, values);
      if (changed) return changed;
      if (sql.includes("FROM pg_roles")) return { rows: [{ safe: true }] };
      if (sql.includes("bind_context") || sql.includes("finish_context"))
        return { rows: [{ org_id: s.org_id }] };
      return { rows: [] };
    },
    release(broken) {
      released.push(broken);
    },
  };
  const pool = {
    async connect() {
      return c;
    },
    async end() {},
  };
  return { repo: new PostgresTenantRepository(pool), calls, released, pool };
}
test("tenant rules: exact context UUID and credential digest validation", () => {
  validateTenantScope(scope());
  for (const value of [
    null,
    [],
    {},
    { ...scope(), role: "owner" },
    { ...scope(), org_id: "other" },
    { ...scope(), session_digest: "secret" },
    { ...scope(), context_version: 0 },
    { ...scope(), context_version: 2147483647 },
  ])
    assert.throws(() => validateTenantScope(value), fails("invalid_input"));
});
test("tenant rules: bounded unique IDs and typed namespace kinds", () => {
  validateTenantIds([]);
  validateTenantIds([randomUUID()]);
  validateTenantKind("project.key-v1");
  const id = randomUUID();
  for (const value of [
    null,
    {},
    [id, id],
    ["x"],
    Array.from({ length: 101 }, randomUUID),
  ])
    assert.throws(() => validateTenantIds(value), fails("invalid_input"));
  for (const value of [
    "",
    null,
    "Project",
    "a".repeat(65),
    "x'; SELECT 1",
    "x\n",
  ])
    assert.throws(() => validateTenantKind(value), fails("invalid_input"));
});
test("tenant grants: fixed least-privilege scope and unsafe role names are refused", () => {
  const sql = tenantRuntimeGrantSql("zt_tenant_app");
  assert.match(sql, /GRANT SELECT,INSERT ON zentwine_tenant.object_keys/);
  assert.ok(
    !/GRANT.*(?:UPDATE|DELETE|TRUNCATE|ALL TABLES|BYPASSRLS)/.test(sql),
  );
  assert.ok(!/GRANT.*zentwine_identity/.test(sql));
  for (const name of [
    "public",
    "pg_monitor",
    'x"; DROP ROLE x',
    "a".repeat(64),
    "",
    null,
  ])
    assert.throws(() => tenantRuntimeGrantSql(name), TypeError);
});
test("tenant transaction: validates before acquiring a connection", async () => {
  const f = fake(scope());
  await assert.rejects(
    f.repo.transaction({ ...scope(), extra: 1 }, async () => {}),
    fails("invalid_input"),
  );
  assert.equal(f.calls.length, 0);
});
test("tenant transaction: scope is copied before awaits and binding is parameterized", async () => {
  const s = scope(),
    original = { ...s },
    f = fake(original);
  const result = f.repo.transaction(s, (t) => t.getMany([]));
  s.org_id = randomUUID();
  s.session_digest = "b".repeat(64);
  assert.deepEqual(await result, []);
  const bind = f.calls.find((x) => x.sql.includes("bind_context"));
  assert.deepEqual(bind.values, [original.session_digest, original.org_id, 1]);
  assert.equal(f.calls[0].sql, "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.equal(f.calls.at(-1).sql, "COMMIT");
  assert.deepEqual(f.released, [false]);
});
test("tenant transaction: missing binding does not invoke caller callback", async () => {
  const s = scope(),
    f = fake(s, (q) =>
      q.includes("bind_context") ? { rows: [{ org_id: null }] } : undefined,
    );
  let used = false;
  await assert.rejects(
    f.repo.transaction(s, async () => {
      used = true;
    }),
    fails("unavailable_resource"),
  );
  assert.equal(used, false);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});
test("tenant transaction: role validation failure blocks all domain SQL", async () => {
  const s = scope(),
    f = fake(s, (q) =>
      q.includes("FROM pg_roles") ? { rows: [{ safe: false }] } : undefined,
    );
  await assert.rejects(
    f.repo.transaction(s, async () => {}),
    fails("unavailable"),
  );
  assert.ok(!f.calls.some((x) => x.sql.includes("bind_context")));
});
test("tenant transaction: final authorization failure rolls back instead of returning data", async () => {
  const s = scope(),
    f = fake(s, (q) =>
      q.includes("finish_context") ? { rows: [{ org_id: null }] } : undefined,
    );
  await assert.rejects(
    f.repo.transaction(s, async () => "not a successful result"),
    fails("unavailable_resource"),
  );
  assert.ok(!f.calls.some((x) => x.sql === "COMMIT"));
});
test("tenant transaction: raw driver and callback details are not exposed", async () => {
  const s = scope(),
    f = fake(s);
  await assert.rejects(
    f.repo.transaction(s, async () => {
      throw new Error("private SQL or credential");
    }),
    (e) => fails("unavailable")(e) && !e.message.includes("private"),
  );
});
test("tenant transaction: failed rollback destroys rather than reuses the connection", async () => {
  const s = scope(),
    f = fake(s, (q) => {
      if (q === "ROLLBACK") throw new Error("broken");
    });
  await assert.rejects(
    f.repo.transaction(s, async () => {
      throw new Error();
    }),
    fails("unavailable"),
  );
  assert.deepEqual(f.released, [true]);
});
test("tenant transaction: failed commit never emits a success and is not automatically replayed", async () => {
  const s = scope(),
    f = fake(s, (q) => {
      if (q === "COMMIT") throw new Error("connection lost");
    });
  let writes = 0;
  await assert.rejects(
    f.repo.transaction(s, async () => {
      writes++;
    }),
    fails("unavailable"),
  );
  assert.equal(writes, 1);
  assert.equal(f.calls.filter((x) => x.sql === "COMMIT").length, 1);
});
test("tenant unit: lease cannot be used after transaction closure", async () => {
  const s = scope(),
    f = fake(s);
  let saved;
  await f.repo.transaction(s, async (t) => {
    saved = t;
  });
  await assert.rejects(saved.getMany([]), fails("transaction_closed"));
});
test("tenant unit: forged cross-org storage response is rejected instead of displayed", async () => {
  const s = scope(),
    f = fake(s, (q) =>
      q.includes("id=ANY")
        ? {
            rows: [
              {
                org_id: randomUUID(),
                id: randomUUID(),
                kind: "test.key",
                created_by: randomUUID(),
                created_at: new Date(),
              },
            ],
          }
        : undefined,
    );
  await assert.rejects(
    f.repo.transaction(s, (t) => t.getMany([randomUUID()])),
    fails("unavailable"),
  );
});
test("tenant unit: SQL failure stays fatal even when caller catches it", async () => {
  const s = scope(),
    f = fake(s, (q) => {
      if (q.includes("id=ANY"))
        throw Object.assign(new Error("hidden"), { code: "42501" });
    });
  await assert.rejects(
    f.repo.transaction(s, async (t) => {
      await assert.rejects(t.getMany([]), fails("forbidden"));
    }),
    fails("forbidden"),
  );
});
test("tenant unit: abandoned asynchronous operation is drained before rollback", async () => {
  let release, entered;
  const waiting = new Promise((r) => {
      release = r;
    }),
    ready = new Promise((r) => {
      entered = r;
    });
  const s = scope(),
    f = fake(s, async (q) => {
      if (q.includes("id=ANY")) {
        entered();
        await waiting;
      }
    });
  let pending;
  const transaction = f.repo.transaction(s, async (t) => {
    pending = t.getMany([]);
  });
  transaction.catch(() => {});
  await ready;
  assert.ok(!f.calls.some((x) => x.sql === "ROLLBACK"));
  release();
  await assert.rejects(transaction, fails("unavailable"));
  await pending;
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});
