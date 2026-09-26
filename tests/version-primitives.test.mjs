import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  canonicalizeContent,
  snapshotRevisionCommand,
  nextRevisionStatus,
  validateContentDigest,
  validateRevisionCommand,
  validateRevisionRelation,
  validateVersion,
  TenantError,
} from "../packages/domain/dist/index.js";
import {
  digestContent,
  verifyContentDigest,
} from "../packages/db/dist/content-digest.js";
const invalid = (e) => e instanceof TenantError && e.code === "invalid_input";
const relation = () => ({
  kind: "depends_on",
  source: "declared",
  target_object_id: randomUUID(),
  target_revision_id: randomUUID(),
  target_hash: "a".repeat(64),
});
const command = () => ({
  object_id: randomUUID(),
  action: "revise",
  expected_version: 0,
  content: { ...digestContent("test.document", { title: "One" }) },
  relations: [relation()],
});
const vectors = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/version-primitives-vectors.json", import.meta.url),
    "utf8",
  ),
);
for (const v of vectors)
  test(`version primitives golden: ${v.name}`, () => {
    assert.equal(canonicalizeContent(v.input), v.canonical);
    const actual = digestContent(v.schema_id, v.input);
    assert.equal(actual.content_hash, v.content_hash);
    assert.equal(actual.content_bytes, v.content_bytes);
    assert.equal(actual.algorithm, "sha256");
    assert.equal(actual.canonicalization_version, "zt-json-v1");
    assert.equal(verifyContentDigest(actual, v.input), true);
  });
test("version primitives: all object-key permutations produce the same digest", () => {
  const entries = [
    ["b", 1],
    ["a", "中"],
    ["2", true],
    ["10", null],
  ];
  function permutations(a) {
    return a.length
      ? a.flatMap((v, i) =>
          permutations(a.filter((_, j) => j !== i)).map((tail) => [v, ...tail]),
        )
      : [[]];
  }
  const expected = digestContent("test.document", Object.fromEntries(entries));
  for (const order of permutations(entries))
    assert.deepEqual(
      digestContent("test.document", Object.fromEntries(order)),
      expected,
    );
  assert.notEqual(
    digestContent("test.document", [1, 2]).content_hash,
    digestContent("test.document", [2, 1]).content_hash,
  );
});
test("version primitives: Unicode normalization is never silently applied", () => {
  assert.notEqual(
    digestContent("test.document", "é").content_hash,
    digestContent("test.document", "e\u0301").content_hash,
  );
  for (const v of ["\uD800", "\uDC00", { ["\uD800"]: 1 }])
    assert.throws(() => canonicalizeContent(v), invalid);
  assert.equal(canonicalizeContent("😀"), '"😀"');
});
test("version primitives: only safe integers are admitted", () => {
  for (const v of [
    -0,
    1.5,
    Infinity,
    -Infinity,
    NaN,
    9007199254740992,
    -9007199254740992,
  ])
    assert.throws(() => canonicalizeContent(v), invalid);
  for (const v of [0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])
    assert.equal(canonicalizeContent(v), String(v));
});
test("version primitives: non-JSON values and exotic objects are rejected", () => {
  for (const v of [
    undefined,
    1n,
    Symbol("x"),
    () => 1,
    new Date(),
    new Map(),
    new Set(),
    new Number(1),
    new Uint8Array(2),
    Object.create({ inherited: true }),
  ])
    assert.throws(() => canonicalizeContent(v), invalid);
  const o = Object.create(null);
  o.a = 1;
  assert.equal(canonicalizeContent(o), '{"a":1}');
});
test("version primitives: getters and toJSON are rejected without executing them", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "a", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const serializer = {
    toJSON() {
      calls++;
      return 1;
    },
  };
  for (const v of [
    getter,
    serializer,
    Object.defineProperty({}, "a", { value: 1 }),
    { [Symbol("hidden")]: 1 },
  ])
    assert.throws(() => canonicalizeContent(v), invalid);
  assert.equal(calls, 0);
});
test("version primitives: sparse arrays extra properties and array accessors are rejected", () => {
  let calls = 0;
  const extra = [1];
  extra.note = "ignored by JSON.stringify";
  const getter = Object.defineProperty([1], "0", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const symbol = [1];
  symbol[Symbol("x")] = 1;
  for (const v of [new Array(1), [, 1], extra, getter, symbol])
    assert.throws(() => canonicalizeContent(v), invalid);
  assert.equal(calls, 0);
});
test("version primitives: cycles fail but shared acyclic values are serialized by value", () => {
  const cycle = {};
  cycle.self = cycle;
  const array = [];
  array.push(array);
  for (const v of [cycle, array])
    assert.throws(() => canonicalizeContent(v), invalid);
  const shared = { a: 1 };
  assert.equal(canonicalizeContent([shared, shared]), '[{"a":1},{"a":1}]');
});
test("version primitives: canonical UTF-8 size enforces the inclusive 65536-byte boundary", () => {
  assert.equal(
    Buffer.byteLength(canonicalizeContent("a".repeat(65534))),
    65536,
  );
  assert.throws(() => canonicalizeContent("a".repeat(65535)), invalid);
  assert.equal(
    Buffer.byteLength(canonicalizeContent("中".repeat(21844))),
    65534,
  );
  assert.throws(() => canonicalizeContent("中".repeat(21845)), invalid);
  assert.throws(() => canonicalizeContent("\n".repeat(32768)), invalid);
});
test("version primitives: depth and visited-value limits include their exact boundaries", () => {
  let value = null;
  for (let i = 0; i < 32; i++) value = [value];
  assert.doesNotThrow(() => canonicalizeContent(value));
  assert.throws(() => canonicalizeContent([value]), invalid);
  assert.doesNotThrow(() => canonicalizeContent(Array(4095).fill(0)));
  assert.throws(() => canonicalizeContent(Array(4096).fill(0)), invalid);
});
test("version primitives: schema separation and byte length participate in verification", () => {
  const value = { x: 1 },
    d = digestContent("test.document", value);
  assert.notEqual(
    d.content_hash,
    digestContent("other.document", value).content_hash,
  );
  assert.equal(verifyContentDigest(d, { x: 2 }), false);
  assert.equal(
    verifyContentDigest({ ...d, schema_id: "other.document" }, value),
    false,
  );
  assert.equal(
    verifyContentDigest({ ...d, content_bytes: d.content_bytes + 1 }, value),
    false,
  );
  assert.ok(Object.isFrozen(d));
  assert.deepEqual(Object.keys(d).sort(), [
    "algorithm",
    "canonicalization_version",
    "content_bytes",
    "content_hash",
    "schema_id",
  ]);
});
test("version primitives: malformed digest descriptors and schemas fail closed", () => {
  const d = digestContent("test.document", null);
  for (const patch of [
    { algorithm: "md5" },
    { canonicalization_version: "RFC8785" },
    { content_hash: "A".repeat(64) },
    { content_bytes: 0 },
    { content_bytes: 65537 },
    { content_bytes: 2.2 },
    { raw: "secret" },
    { schema_id: "../test" },
  ]) {
    assert.throws(() => validateContentDigest({ ...d, ...patch }), invalid);
    assert.throws(() => verifyContentDigest({ ...d, ...patch }, null), invalid);
  }
  for (const schema of ["", "A", "bad\0schema", "a".repeat(65), null])
    assert.throws(() => digestContent(schema, null), invalid);
});
test("version primitives: digest verification snapshots descriptors without invoking accessors", () => {
  let calls = 0;
  const d = { ...digestContent("test.document", null) };
  Object.defineProperty(d, "schema_id", {
    enumerable: true,
    get() {
      calls++;
      return "test.document";
    },
  });
  assert.throws(() => verifyContentDigest(d, null), invalid);
  assert.equal(calls, 0);
});
test("version primitives: all 36 state-action pairs match the finite transition specification", () => {
  const states = [
    null,
    "draft",
    "in_review",
    "approved",
    "superseded",
    "retired",
  ];
  const actions = [
    "revise",
    "submit",
    "approve",
    "reject",
    "supersede",
    "retire",
  ];
  const rows = [
    ["draft", null, null, null, null, null],
    ["draft", "in_review", null, null, null, null],
    [null, null, "approved", "draft", null, null],
    [null, null, null, null, "superseded", "retired"],
    ["draft", null, null, null, null, "retired"],
    [null, null, null, null, null, null],
  ];
  for (let i = 0; i < states.length; i++)
    for (let j = 0; j < actions.length; j++)
      assert.equal(nextRevisionStatus(states[i], actions[j]), rows[i][j]);
  assert.equal(nextRevisionStatus("unknown", "approve"), null);
  assert.equal(nextRevisionStatus("draft", "force"), null);
});
test("version primitives: valid commands bind explicit expected version revision and hash", () => {
  const c = command();
  assert.doesNotThrow(() => validateRevisionCommand(c));
  for (const action of ["submit", "approve", "reject", "supersede", "retire"]) {
    const t = {
      object_id: c.object_id,
      action,
      expected_version: 1,
      revision_id: randomUUID(),
      content_hash: c.content.content_hash,
    };
    assert.deepEqual(snapshotRevisionCommand(t), t);
  }
});
test("version primitives: unexpected authority fields missing tuples and unsafe versions fail", () => {
  const c = command();
  for (const patch of [
    { org_id: randomUUID() },
    { actor_id: randomUUID() },
    { object_id: "name" },
    { expected_version: -1 },
    { expected_version: "0" },
    { expected_version: 1.1 },
    { expected_version: 2147483646 },
    { action: "force" },
    { relations: null },
  ])
    assert.throws(() => snapshotRevisionCommand({ ...c, ...patch }), invalid);
  const t = {
    object_id: c.object_id,
    action: "approve",
    expected_version: 1,
    revision_id: randomUUID(),
    content_hash: c.content.content_hash,
  };
  for (const key of Object.keys(t)) {
    const v = { ...t };
    delete v[key];
    assert.throws(() => snapshotRevisionCommand(v), invalid);
  }
  assert.doesNotThrow(() => validateVersion(2147483646, 1));
  for (const v of [null, "1", NaN, Infinity, 2147483647])
    assert.throws(() => validateVersion(v), invalid);
});
test("version primitives: immutable command snapshots detach all nested mutable inputs", () => {
  const input = command(),
    copy = snapshotRevisionCommand(input);
  const hash = copy.content.content_hash,
    target = copy.relations[0].target_object_id;
  input.expected_version = 7;
  input.content.content_hash = "b".repeat(64);
  input.relations[0].target_object_id = randomUUID();
  input.relations.push(relation());
  assert.equal(copy.expected_version, 0);
  assert.equal(copy.content.content_hash, hash);
  assert.equal(copy.relations[0].target_object_id, target);
  assert.equal(copy.relations.length, 1);
  for (const v of [copy, copy.content, copy.relations, copy.relations[0]])
    assert.ok(Object.isFrozen(v));
  assert.throws(() => {
    copy.relations[0].kind = "other";
  }, TypeError);
});
test("version primitives: command snapshot rejects getters without evaluating authority", () => {
  const c = command();
  let calls = 0;
  Object.defineProperty(c, "action", {
    enumerable: true,
    get() {
      calls++;
      return "revise";
    },
  });
  assert.throws(() => snapshotRevisionCommand(c), invalid);
  assert.equal(calls, 0);
  assert.throws(
    () => snapshotRevisionCommand({ ...command(), [Symbol("role")]: "owner" }),
    invalid,
  );
});
test("version primitives: precise relationship tuples are bounded and duplicates never ignored", () => {
  const c = command(),
    r = c.relations[0];
  assert.doesNotThrow(() => validateRevisionRelation(r));
  assert.throws(
    () =>
      snapshotRevisionCommand({
        ...c,
        relations: [r, { ...r, target_hash: "b".repeat(64) }],
      }),
    invalid,
  );
  assert.doesNotThrow(() =>
    snapshotRevisionCommand({
      ...c,
      relations: Array.from({ length: 32 }, relation),
    }),
  );
  assert.throws(
    () =>
      snapshotRevisionCommand({
        ...c,
        relations: Array.from({ length: 33 }, relation),
      }),
    invalid,
  );
  for (const patch of [
    { source: "trusted" },
    { kind: "../depends" },
    { target_hash: "bad" },
    { target_revision_id: "latest" },
    { org_id: randomUUID() },
  ])
    assert.throws(
      () => snapshotRevisionCommand({ ...c, relations: [{ ...r, ...patch }] }),
      invalid,
    );
  assert.deepEqual(
    snapshotRevisionCommand({ ...c, relations: [] }).relations,
    [],
  );
});
