import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  canonicalizeContent,
  validateRevisionCommand,
  nextRevisionStatus,
  TenantError,
} from "../packages/domain/dist/index.js";
import {
  digestContent,
  verifyContentDigest,
} from "../packages/db/dist/versions.js";
import { versionRuntimeGrantSql } from "../packages/db/dist/version-grants.js";
import { PostgresTenantRepository } from "../packages/db/dist/tenant.js";
const invalid = (e) => e instanceof TenantError && e.code === "invalid_input";
const input = () => ({
  object_id: randomUUID(),
  expected_version: 0,
  action: "revise",
  content: digestContent("test.v1", { b: 2, a: 1 }),
  relations: [],
});
test("versions canonical: stable key ordering does not use JSON integer-key enumeration", () => {
  assert.equal(canonicalizeContent({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalizeContent({ 2: "b", 10: "a" }), '{"10":"a","2":"b"}');
  assert.equal(
    canonicalizeContent({ "\ue000": 1, "😀": 2, a: 3 }),
    '{"a":3,"😀":2,"":1}',
  );
});
test("versions canonical: arrays order and Unicode spelling remain material", () => {
  assert.notEqual(canonicalizeContent([1, 2]), canonicalizeContent([2, 1]));
  assert.notEqual(canonicalizeContent("é"), canonicalizeContent("e\u0301"));
  assert.equal(
    canonicalizeContent({ q: '"\n\\', empty: null }),
    '{"empty":null,"q":"\\\"\\n\\\\"}',
  );
});
test("versions canonical: noninteger nonfinite unsafe and negative-zero numbers fail", () => {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    0.1,
    Number.MAX_SAFE_INTEGER + 1,
    -0,
  ])
    assert.throws(() => canonicalizeContent(value), invalid);
  assert.equal(
    canonicalizeContent(Number.MAX_SAFE_INTEGER),
    "9007199254740991",
  );
});
test("versions canonical: invalid Unicode is rejected in values and keys", () => {
  for (const value of ["\ud800", "\udc00", { ["\ud800"]: 1 }, "a\ud800b"])
    assert.throws(() => canonicalizeContent(value), invalid);
  assert.equal(canonicalizeContent("😀"), '"😀"');
});
test("versions canonical: accessors and toJSON are never evaluated", () => {
  let called = 0;
  const accessor = Object.defineProperty({}, "a", {
    enumerable: true,
    get() {
      called++;
      return 1;
    },
  });
  for (const value of [
    accessor,
    {
      toJSON() {
        called++;
        return {};
      },
    },
    new Date(),
    new Map(),
    new Set(),
  ])
    assert.throws(() => canonicalizeContent(value), invalid);
  assert.equal(called, 0);
});
test("versions canonical: cycles sparse arrays non-JSON and hidden properties fail", () => {
  const cycle = {};
  cycle.a = cycle;
  const hidden = Object.defineProperty({}, "a", { value: 1 });
  for (const value of [
    cycle,
    undefined,
    1n,
    () => 1,
    new Array(2),
    [undefined],
    { a: undefined },
    hidden,
    { [Symbol()]: 1 },
  ])
    assert.throws(() => canonicalizeContent(value), invalid);
  const shared = { a: 1 };
  assert.equal(canonicalizeContent([shared, shared]), '[{"a":1},{"a":1}]');
});
test("versions canonical: byte depth and node limits reject excessive inputs", () => {
  assert.throws(() => canonicalizeContent("界".repeat(22000)), invalid);
  assert.throws(() => canonicalizeContent(Array(4096).fill(0)), invalid);
  let nested = 0;
  for (let i = 0; i < 34; i++) nested = [nested];
  assert.throws(() => canonicalizeContent(nested), invalid);
});
test("versions digest: independently generated golden hash and byte count", () => {
  const result = digestContent("test.v1", { b: 2, a: 1 });
  assert.equal(
    result.content_hash,
    "63c4be7ec8e2ea3ad29c8f65756d8902032068278ab4731c583dbd7380dee30e",
  );
  assert.equal(result.content_bytes, 13);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result, digestContent("test.v1", { a: 1, b: 2 }));
});
test("versions digest: schema content and size mismatches cannot verify", () => {
  const d = digestContent("test.v1", { text: "界" });
  assert.equal(d.content_bytes, 14);
  assert.equal(verifyContentDigest(d, { text: "界" }), true);
  assert.equal(verifyContentDigest(d, { text: "改" }), false);
  assert.equal(
    verifyContentDigest({ ...d, content_bytes: 1 }, { text: "界" }),
    false,
  );
  assert.notEqual(
    d.content_hash,
    digestContent("test.v2", { text: "界" }).content_hash,
  );
  assert.throws(
    () => verifyContentDigest({ ...d, canonicalization_version: "future" }, {}),
    invalid,
  );
});
test("versions input: exact typed content descriptor and command fields", () => {
  validateRevisionCommand(input());
  const c = input();
  for (const patch of [
    { actor_id: randomUUID() },
    { expected_version: -1 },
    { expected_version: 2147483646 },
    { expected_version: 1.5 },
    { object_id: "name" },
    { action: "force" },
  ])
    assert.throws(() => validateRevisionCommand({ ...c, ...patch }), invalid);
  for (const patch of [
    { algorithm: "md5" },
    { content_hash: "bad" },
    { content_bytes: 0 },
    { content_bytes: 65537 },
    { schema_id: "unsafe/" },
    { raw: "secret" },
  ])
    assert.throws(
      () =>
        validateRevisionCommand({ ...c, content: { ...c.content, ...patch } }),
      invalid,
    );
});
test("versions input: transitions bind exact revision and content digest", () => {
  const c = {
    object_id: randomUUID(),
    expected_version: 2,
    action: "approve",
    revision_id: randomUUID(),
    content_hash: "a".repeat(64),
  };
  validateRevisionCommand(c);
  for (const patch of [
    { revision_id: "old" },
    { content_hash: "old" },
    { relations: [] },
    { content: {} },
  ])
    assert.throws(() => validateRevisionCommand({ ...c, ...patch }), invalid);
});
test("versions input: relationships are explicit bounded unique and pinned", () => {
  const c = input(),
    r = {
      kind: "depends_on",
      source: "declared",
      target_object_id: randomUUID(),
      target_revision_id: randomUUID(),
      target_hash: "b".repeat(64),
    };
  validateRevisionCommand({ ...c, relations: [r] });
  for (const relations of [
    null,
    [r, r],
    Array.from({ length: 33 }, () => ({
      ...r,
      target_object_id: randomUUID(),
    })),
    [{ ...r, org_id: randomUUID() }],
    [{ ...r, source: "permission" }],
    [{ ...r, target_hash: "bad" }],
  ])
    assert.throws(() => validateRevisionCommand({ ...c, relations }), invalid);
});
test("versions rules: exhaustive transition table preserves terminal and approved content", () => {
  const allowed = {
    "null/revise": "draft",
    "draft/revise": "draft",
    "superseded/revise": "draft",
    "draft/submit": "in_review",
    "in_review/reject": "draft",
    "in_review/approve": "approved",
    "approved/supersede": "superseded",
    "approved/retire": "retired",
    "superseded/retire": "retired",
  };
  for (const state of [
    null,
    "draft",
    "in_review",
    "approved",
    "superseded",
    "retired",
  ])
    for (const action of [
      "revise",
      "submit",
      "approve",
      "reject",
      "supersede",
      "retire",
    ])
      assert.equal(
        nextRevisionStatus(state, action),
        allowed[`${state}/${action}`] ?? null,
      );
});
test("versions grants: quoted dedicated runtime without direct write privileges", () => {
  const sql = versionRuntimeGrantSql("zt_tenant_app");
  assert.ok(sql.includes("EXECUTE ON FUNCTION zentwine_versions.apply(jsonb)"));
  assert.ok(!/GRANT (?:INSERT|UPDATE|DELETE|ALL).*zentwine_versions/.test(sql));
  for (const role of [
    "public",
    "pg_database_owner",
    'app";',
    "a;DROP TABLE x",
    "",
  ])
    assert.throws(() => versionRuntimeGrantSql(role), TypeError);
});
function fake(workHook = () => undefined) {
  const scope = {
      org_id: randomUUID(),
      session_digest: "a".repeat(64),
      context_version: 1,
    },
    calls = [];
  const connection = {
    async query(sql, values) {
      calls.push({ sql, values });
      const r = await workHook(sql, values);
      if (r) return r;
      if (sql.includes("FROM pg_roles") || sql.includes("safe_definers"))
        return { rows: [{ safe: true }] };
      if (sql.includes("bind_context") || sql.includes("finish_context"))
        return { rows: [{ org_id: scope.org_id }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    scope,
    calls,
    repo: new PostgresTenantRepository({
      connect: async () => connection,
      end: async () => {},
    }),
  };
}
test("versions transaction: caught invalid command poisons the enclosing unit", async () => {
  const f = fake();
  await assert.rejects(
    f.repo.transaction(f.scope, async (t) => {
      await t.versions
        .command({ ...input(), actor_id: randomUUID() })
        .catch(() => {});
    }),
    invalid,
  );
  assert.ok(f.calls.some((x) => x.sql === "ROLLBACK"));
  assert.ok(!f.calls.some((x) => x.sql === "COMMIT"));
});
test("versions transaction: conflict passes final authorization rather than escaping as an error payload", async () => {
  const f = fake((sql) =>
    sql.includes("versions.apply")
      ? {
          rows: [
            {
              result: {
                outcome: "conflict",
                expected_version: 1,
                current: null,
              },
            },
          ],
        }
      : undefined,
  );
  const r = await f.repo.transaction(f.scope, (t) =>
    t.versions.command({ ...input(), expected_version: 1 }),
  );
  assert.equal(r.outcome, "conflict");
  assert.ok(f.calls.some((x) => x.sql.includes("finish_context")));
  assert.equal(f.calls.at(-1).sql, "COMMIT");
});
test("versions transaction: conflict is withheld if final authorization expires", async () => {
  const f = fake((sql) =>
    sql.includes("versions.apply")
      ? {
          rows: [
            {
              result: {
                outcome: "conflict",
                expected_version: 1,
                current: null,
              },
            },
          ],
        }
      : sql.includes("finish_context")
        ? { rows: [{ org_id: null }] }
        : undefined,
  );
  await assert.rejects(
    f.repo.transaction(f.scope, (t) =>
      t.versions.command({ ...input(), expected_version: 1 }),
    ),
    (e) => e.code === "unavailable_resource",
  );
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});
test("versions transaction: command snapshot cannot mutate while awaiting database checks", async () => {
  let observed;
  const f = fake((sql, args) => {
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
  const c = input(),
    original = c.content;
  await f.repo.transaction(f.scope, async (t) => {
    const pending = t.versions.command(c);
    c.content = digestContent("test.v1", { evil: true });
    await pending;
  });
  assert.deepEqual(observed.content, original);
});
test("versions transaction: malformed result rolls back instead of returning raw database data", async () => {
  const f = fake((sql) =>
    sql.includes("versions.apply")
      ? {
          rows: [
            {
              result: {
                outcome: "applied",
                expected_version: 0,
                current: null,
                raw: "secret",
              },
            },
          ],
        }
      : undefined,
  );
  await assert.rejects(
    f.repo.transaction(f.scope, (t) => t.versions.command(input())),
    (e) => e.code === "unavailable",
  );
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});
test("versions transaction: escaped version port cannot query after commit", async () => {
  const f = fake();
  let escaped;
  await f.repo.transaction(f.scope, async (t) => {
    escaped = t.versions;
  });
  const n = f.calls.length;
  await assert.rejects(
    escaped.head(randomUUID()),
    (e) => e.code === "transaction_closed",
  );
  assert.equal(f.calls.length, n);
});
