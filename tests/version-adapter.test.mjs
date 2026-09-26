import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as shared from "../packages/db/dist/content-digest.js";
import * as legacy from "../packages/db/dist/versions.js";
import { TenantError } from "../packages/domain/dist/index.js";
import { PostgresTenantRepository } from "../packages/db/dist/tenant.js";
// Synthetic SQL responses only: these tests do not prove PostgreSQL/RLS/CAS behavior.
const fails = (code) => (e) => e instanceof TenantError && e.code === code;
const command = () => ({
  object_id: randomUUID(),
  expected_version: 0,
  action: "revise",
  content: { ...shared.digestContent("test.document", { title: "One" }) },
  relations: [],
});
function fixture(hook = () => undefined) {
  const scope = {
    org_id: randomUUID(),
    session_digest: "a".repeat(64),
    context_version: 1,
  };
  const actor = randomUUID(),
    calls = [];
  const connection = {
    async query(sql, values) {
      calls.push({ sql, values });
      const r = await hook(sql, values);
      if (r !== undefined) return r;
      if (sql.includes("FROM pg_roles") || sql.includes("safe_definers"))
        return { rows: [{ safe: true }] };
      if (sql.includes("bind_context") || sql.includes("finish_context"))
        return { rows: [{ org_id: scope.org_id }] };
      return { rows: [] };
    },
    release() {},
  };
  const repo = new PostgresTenantRepository({
    connect: async () => connection,
    end: async () => {},
  });
  return { scope, actor, calls, run: (work) => repo.transaction(scope, work) };
}
function row(f, c, patch = {}) {
  return {
    ...c.content,
    org_id: f.scope.org_id,
    object_id: c.object_id,
    object_version: c.expected_version + 1,
    revision_id: randomUUID(),
    revision_number: 1,
    parent_revision_id: null,
    status: "draft",
    created_by: f.actor,
    changed_by: f.actor,
    created_at: "2026-09-26T00:00:00.000Z",
    changed_at: "2026-09-26T00:00:00.000Z",
    ...patch,
  };
}
const applied = (c, current) => ({
  rows: [
    {
      result: {
        outcome: "applied",
        expected_version: c.expected_version,
        current,
      },
    },
  ],
});
function rolledBack(f) {
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
  assert.ok(!f.calls.some((c) => c.sql === "COMMIT"));
}
test("version adapter unit: legacy digest exports are the exact shared implementation", () => {
  for (const name of ["digestContent", "verifyContentDigest"]) {
    assert.equal(legacy[name], shared[name]);
  }
});
test("version adapter unit: legacy verification cannot execute descriptor accessors", () => {
  let called = 0;
  const digest = { ...shared.digestContent("test.document", {}) };
  Object.defineProperty(digest, "content_hash", {
    enumerable: true,
    get() {
      called++;
      return "a".repeat(64);
    },
  });
  assert.throws(
    () => legacy.verifyContentDigest(digest, {}),
    fails("invalid_input"),
  );
  assert.equal(called, 0);
});
test("version adapter unit: nested caller mutations do not change the queued command", async () => {
  let observed;
  const f = fixture((sql, args) => {
    if (sql.includes("versions.apply")) {
      observed = JSON.parse(args[0]);
      return {
        rows: [
          {
            result: { outcome: "conflict", expected_version: 0, current: null },
          },
        ],
      };
    }
  });
  const c = command();
  c.relations.push({
    kind: "depends_on",
    source: "declared",
    target_object_id: randomUUID(),
    target_revision_id: randomUUID(),
    target_hash: "a".repeat(64),
  });
  const original = structuredClone(c);
  await f.run(async (t) => {
    const p = t.versions.command(c);
    c.content.content_hash = "b".repeat(64);
    c.relations[0].target_hash = "c".repeat(64);
    c.relations.length = 0;
    await p;
  });
  assert.deepEqual(observed, original);
});
test("version adapter unit: a matching applied revision returns a frozen snapshot after final verification", async () => {
  const c = command();
  const f = fixture((sql) =>
    sql.includes("versions.apply") ? applied(c, row(f, c)) : undefined,
  );
  const r = await f.run((t) => t.versions.command(c));
  assert.equal(r.outcome, "applied");
  assert.equal(r.current.content_hash, c.content.content_hash);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.current));
  assert.ok(f.calls.some((q) => q.sql.includes("finish_context")));
  assert.equal(f.calls.at(-1).sql, "COMMIT");
});
test("version adapter unit: applied revision must agree with submitted descriptor and draft attribution", async () => {
  for (const patch of [
    { content_hash: "b".repeat(64) },
    { content_bytes: 1 },
    { schema_id: "other.document" },
    { status: "approved" },
    { changed_by: randomUUID() },
  ]) {
    const c = command();
    const f = fixture((sql) =>
      sql.includes("versions.apply") ? applied(c, row(f, c, patch)) : undefined,
    );
    await assert.rejects(
      f.run((t) => t.versions.command(c)),
      fails("unavailable"),
    );
    rolledBack(f);
  }
});
test("version adapter unit: every matching transition response is decoded without changing its revision", async () => {
  const statuses = {
    submit: "in_review",
    approve: "approved",
    reject: "draft",
    supersede: "superseded",
    retire: "retired",
  };
  for (const [action, status] of Object.entries(statuses)) {
    const content = command();
    const c = {
      object_id: content.object_id,
      expected_version: 1,
      action,
      revision_id: randomUUID(),
      content_hash: content.content.content_hash,
    };
    const f = fixture((sql) =>
      sql.includes("versions.apply")
        ? applied(
            c,
            row(f, content, {
              object_version: 2,
              revision_id: c.revision_id,
              status,
            }),
          )
        : undefined,
    );
    const r = await f.run((t) => t.versions.command(c));
    assert.equal(r.current.revision_id, c.revision_id);
    assert.equal(r.current.status, status);
  }
});
test("version adapter unit: transition success cannot substitute revision hash or status", async () => {
  for (const patch of [
    { revision_id: randomUUID() },
    { content_hash: "b".repeat(64) },
    { status: "draft" },
  ]) {
    const content = command();
    const c = {
      object_id: content.object_id,
      expected_version: 1,
      action: "approve",
      revision_id: randomUUID(),
      content_hash: content.content.content_hash,
    };
    const f = fixture((sql) =>
      sql.includes("versions.apply")
        ? applied(
            c,
            row(f, content, {
              object_version: 2,
              revision_id: c.revision_id,
              status: "approved",
              ...patch,
            }),
          )
        : undefined,
    );
    await assert.rejects(
      f.run((t) => t.versions.command(c)),
      fails("unavailable"),
    );
    rolledBack(f);
  }
});
test("version adapter unit: malformed database descriptors and versions are service failures not caller faults", async () => {
  for (const patch of [
    { content_hash: "bad" },
    { content_bytes: 0 },
    { canonicalization_version: "unknown" },
    { schema_id: "invalid/" },
    { object_version: 0 },
    { revision_number: 0 },
  ]) {
    const c = command();
    const f = fixture((sql) =>
      sql.startsWith("SELECT * FROM zentwine_versions.snapshots")
        ? { rows: [row(f, c, patch)] }
        : undefined,
    );
    await assert.rejects(
      f.run((t) => t.versions.head(c.object_id)),
      fails("unavailable"),
    );
    rolledBack(f);
  }
});
test("version adapter unit: historical reads preserve the requested version and absent reads remain null", async () => {
  const c = command();
  const f = fixture((sql, args) =>
    sql.startsWith("SELECT * FROM zentwine_versions.snapshots")
      ? { rows: args[1] === 4 ? [row(f, c, { object_version: 4 })] : [] }
      : undefined,
  );
  assert.equal(
    (await f.run((t) => t.versions.snapshot(c.object_id, 4))).object_version,
    4,
  );
  assert.equal(await f.run((t) => t.versions.snapshot(c.object_id, 3)), null);
});
test("version adapter unit: latest data cannot be returned as a requested historical snapshot", async () => {
  const c = command();
  const f = fixture((sql) =>
    sql.startsWith("SELECT * FROM zentwine_versions.snapshots")
      ? { rows: [row(f, c, { object_version: 5 })] }
      : undefined,
  );
  await assert.rejects(
    f.run((t) => t.versions.snapshot(c.object_id, 4)),
    fails("unavailable"),
  );
  rolledBack(f);
});
test("version adapter unit: impossible revision ancestry is never published", async () => {
  for (const [number, parent] of [
    [1, randomUUID()],
    [2, null],
    [2, "self"],
  ]) {
    const c = command();
    const f = fixture((sql) => {
      if (!sql.startsWith("SELECT * FROM zentwine_versions.snapshots")) return;
      const r = row(f, c, {
        object_version: 3,
        revision_number: number,
        parent_revision_id: parent,
      });
      if (parent === "self") r.parent_revision_id = r.revision_id;
      return { rows: [r] };
    });
    await assert.rejects(
      f.run((t) => t.versions.head(c.object_id)),
      fails("unavailable"),
    );
    rolledBack(f);
  }
});
test("version adapter unit: malformed relationship output is a service failure and has no raw payload", async () => {
  const f = fixture((sql) =>
    sql.startsWith("SELECT kind,source,target_object_id")
      ? {
          rows: [
            {
              kind: "depends_on",
              source: "declared",
              target_object_id: randomUUID(),
              target_revision_id: randomUUID(),
              target_hash: "raw-database-secret",
            },
          ],
        }
      : undefined,
  );
  await assert.rejects(
    f.run((t) => t.versions.relations(randomUUID(), randomUUID())),
    (e) => fails("unavailable")(e) && !e.message.includes("secret"),
  );
  rolledBack(f);
});
test("version adapter unit: duplicate database rows cannot choose an arbitrary command or snapshot", async () => {
  for (const mode of ["command", "read"]) {
    const c = command();
    const f = fixture((sql) => {
      if (mode === "command" && sql.includes("versions.apply")) {
        const r = applied(c, row(f, c));
        return { rows: [r.rows[0], r.rows[0]] };
      }
      if (
        mode === "read" &&
        sql.startsWith("SELECT * FROM zentwine_versions.snapshots")
      ) {
        const r = row(f, c);
        return { rows: [r, r] };
      }
    });
    await assert.rejects(
      f.run((t) =>
        mode === "command"
          ? t.versions.command(c)
          : t.versions.head(c.object_id),
      ),
      fails("unavailable"),
    );
    rolledBack(f);
  }
});
test("version adapter unit: invalid caller inputs still poison a caught operation without issuing a write", async () => {
  const f = fixture();
  await assert.rejects(
    f.run(async (t) => {
      await t.versions
        .command({ ...command(), actor_id: randomUUID() })
        .catch(() => {});
    }),
    fails("invalid_input"),
  );
  assert.ok(!f.calls.some((q) => q.sql.includes("versions.apply")));
  rolledBack(f);
});
test("version adapter unit: applied response remains withheld when final authorization fails", async () => {
  const c = command();
  const f = fixture((sql) =>
    sql.includes("versions.apply")
      ? applied(c, row(f, c))
      : sql.includes("finish_context")
        ? { rows: [{ org_id: null }] }
        : undefined,
  );
  await assert.rejects(
    f.run((t) => t.versions.command(c)),
    fails("unavailable_resource"),
  );
  rolledBack(f);
});
test("version adapter unit: foreign scope and substituted object snapshots are rejected", async () => {
  for (const patch of [{ org_id: randomUUID() }, { object_id: randomUUID() }]) {
    const c = command();
    const f = fixture((sql) =>
      sql.startsWith("SELECT * FROM zentwine_versions.snapshots")
        ? { rows: [row(f, c, patch)] }
        : undefined,
    );
    await assert.rejects(
      f.run((t) => t.versions.head(c.object_id)),
      fails("unavailable"),
    );
    rolledBack(f);
  }
});
