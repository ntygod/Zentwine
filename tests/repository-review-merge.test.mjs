import test from "node:test";
import assert from "node:assert/strict";
import {
  createRepositoryReviewSession as sessionFor,
  serializeRepositoryReviewNotes as serialize,
  parseRepositoryReviewNotes as parse,
  previewRepositoryReviewMerge as preview,
  applyRepositoryReviewMerge as apply,
} from "../packages/client/dist/index.js";
import { createCommitReviewFixture } from "./fixtures/commit-review-data.mjs";

// Real disposable Git -> original CLI -> report -> local, synthetic reviewer opinions.
const f = await createCommitReviewFixture();
test.after(() => f.cleanup());
const session = await sessionFor(f.detail);
const note = (id = "a", extra = {}) => ({
  id,
  path: "src/example.ts",
  kind: "question",
  author: "Synthetic reviewer",
  body: `Question ${id}`,
  ...extra,
});
const reject = {
  name: "TypeError",
  message: "Invalid, stale or oversized local review merge",
};
const plan = (a, b) => preview(session, a, serialize(session, b));

test("review merge: independent real CLI sessions exchange combined v1 notes", async () => {
  const left = [note()],
    right = [note("b", { author: "Other reviewer" })];
  const p = plan(left, right);
  assert.equal(p.total, 2);
  assert.deepEqual(left, [note()]);
  const result = apply(session, p, left, []);
  const other = await sessionFor(f.detail);
  assert.deepEqual(parse(other, serialize(session, result)), [
    ...left,
    ...right,
  ]);
  assert.equal(JSON.parse(serialize(session, result)).authorization, false);
});
test("review merge: identical IDs and fields deduplicate, not just matching body", () => {
  const a = note(),
    b = note("b", { body: a.body });
  const p = plan([a], [a, b]);
  assert.deepEqual(p.duplicates, ["a"]);
  assert.deepEqual(p.additions, [b]);
  assert.equal(p.conflicts.length, 0);
  assert.deepEqual(apply(session, p, [a], []), [a, b]);
});
for (const [field, value] of [
  ["body", "Different"],
  ["author", "Different"],
  ["kind", "issue"],
  ["path", "added.txt"],
]) {
  test(`review merge: same ID with different ${field} requires an explicit choice`, () => {
    const a = note(),
      b = note("a", { [field]: value }),
      p = plan([a], [b]);
    assert.equal(p.conflicts.length, 1);
    assert.throws(() => apply(session, p, [a], []), reject);
    assert.deepEqual(apply(session, p, [a], [{ id: "a", keep: "current" }]), [
      a,
    ]);
    assert.deepEqual(apply(session, p, [a], [{ id: "a", keep: "incoming" }]), [
      b,
    ]);
  });
}
test("review merge: independent conflict choices keep current positions and append incoming order", () => {
  const current = [note("a"), note("b"), note("c")];
  const incoming = [
    note("x"),
    note("c", { body: "new c" }),
    note("b", { body: "new b" }),
    note("y"),
  ];
  const p = plan(current, incoming);
  assert.deepEqual(
    apply(session, p, current, [
      { id: "b", keep: "incoming" },
      { id: "c", keep: "current" },
    ]),
    [current[0], incoming[2], current[2], incoming[0], incoming[3]],
  );
});
test("review merge: frozen preview snapshots cannot retain mutable caller objects", () => {
  const a = note(),
    input = [a],
    p = plan(input, [note("b")]);
  a.body = "changed";
  input.length = 0;
  assert.equal(p.current[0].body, "Question a");
  for (const value of [
    p,
    p.current,
    p.current[0],
    p.incoming,
    p.additions,
    p.duplicates,
    p.conflicts,
  ])
    assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(apply(session, p, [note()], [])));
});
test("review merge: empty incoming does not delete existing opinions", () => {
  const current = [note()],
    p = plan(current, []);
  assert.deepEqual(apply(session, p, current, []), current);
});
test("review merge: empty current requires confirmation and supports normal interchange", () => {
  const p = plan([], [note()]);
  assert.deepEqual(p.current, []);
  assert.deepEqual(apply(session, p, [], []), [note()]);
});
test("review merge: empty reports only accept empty opinions", async () => {
  const empty = await sessionFor(f.empty);
  const p = preview(empty, [], serialize(empty, []));
  assert.deepEqual(apply(empty, p, [], []), []);
  assert.throws(() => preview(empty, [], serialize(session, [note()])), reject);
});
for (const [name, incoming] of [
  ["formatting", f.detail + "\n"],
  ["listing", f.listing],
  ["reversed", f.compare("src/example.ts", f.head, f.base)],
]) {
  test(`review merge: ${name} report binding cannot be merged`, async () => {
    const other = await sessionFor(incoming);
    assert.throws(
      () => preview(session, [note()], serialize(other, [note("b")])),
      reject,
    );
  });
}
test("review merge: SHA256 repositories use the same exact report boundary", async () => {
  const g = await createCommitReviewFixture("sha256");
  try {
    const s = await sessionFor(g.detail),
      a = [note()],
      b = [note("b")];
    const p = preview(s, a, serialize(s, b));
    assert.equal(s.report.base.commit_sha.length, 64);
    assert.deepEqual(apply(s, p, a, []), [...a, ...b]);
  } finally {
    await g.cleanup();
  }
});
for (const [name, change] of [
  ["added note", (a) => [...a, note("x")]],
  ["removed note", (a) => a.slice(1)],
  ["changed body", (a) => [{ ...a[0], body: "changed" }, a[1]]],
  ["reordered", (a) => [...a].reverse()],
]) {
  test(`review merge: stale ${name} rejects without modifying current`, () => {
    const a = [note("a"), note("b")],
      p = plan(a, [note("c")]),
      current = change(a),
      before = structuredClone(current);
    assert.throws(() => apply(session, p, current, []), reject);
    assert.deepEqual(current, before);
  });
}
test("review merge: forged preview or another session cannot apply", async () => {
  const a = [note()],
    p = plan(a, [note("b")]),
    other = await sessionFor(f.detail);
  assert.throws(() => apply(session, { ...p }, a, []), reject);
  assert.throws(() => apply(other, p, a, []), reject);
  assert.throws(() => apply({ ...session }, p, a, []), reject);
});
const invalidChoices = [
  ["null", () => null],
  ["object", () => ({ a: "incoming" })],
  ["missing", () => []],
  [
    "extra",
    () => [
      { id: "a", keep: "incoming" },
      { id: "x", keep: "current" },
    ],
  ],
  ["wrong id", () => [{ id: "x", keep: "incoming" }]],
  ["wrong keep", () => [{ id: "a", keep: "both" }]],
  ["unknown field", () => [{ id: "a", keep: "incoming", approved: true }]],
  ["inherited", () => [Object.create({ id: "a", keep: "incoming" })]],
  ["sparse", () => new Array(1)],
  [
    "array properties",
    () => Object.assign([{ id: "a", keep: "incoming" }], { extra: true }),
  ],
  ["symbol", () => [{ id: "a", keep: "incoming", [Symbol("extra")]: true }]],
];
for (const [name, choices] of invalidChoices) {
  test(`review merge: rejects ${name} decisions`, () => {
    const current = [note()],
      p = plan(current, [note("a", { body: "changed" })]);
    assert.throws(() => apply(session, p, current, choices()), reject);
    assert.deepEqual(current, [note()]);
  });
}
test("review merge: decision getters are rejected without invocation", () => {
  let calls = 0;
  const a = [note()],
    p = plan(a, [note("a", { body: "changed" })]);
  const values = [
    Object.defineProperty({ id: "a" }, "keep", {
      enumerable: true,
      get() {
        calls++;
        return "incoming";
      },
    }),
  ];
  assert.throws(() => apply(session, p, a, values), reject);
  const accessor = [];
  Object.defineProperty(accessor, "0", {
    get() {
      calls++;
      return values[0];
    },
  });
  assert.throws(() => apply(session, p, a, accessor), reject);
  assert.equal(calls, 0);
});
test("review merge: repeated decision IDs cannot stand in for unresolved conflicts", () => {
  const a = [note("a"), note("b")],
    p = plan(
      a,
      a.map((n) => ({ ...n, body: "changed" })),
    );
  assert.throws(
    () =>
      apply(session, p, a, [
        { id: "a", keep: "current" },
        { id: "a", keep: "incoming" },
      ]),
    reject,
  );
});
test("review merge: invalid current cannot enter a preview", () => {
  assert.throws(() => plan([note(), note()], []), reject);
  assert.throws(() => plan([note("a", { path: "absent" })], []), reject);
});
test("review merge: original strict parser still rejects duplicate keys and bad IDs", () => {
  const text = serialize(session, [note("b")]);
  assert.throws(
    () =>
      preview(
        session,
        [],
        text.replace(
          '"schema_version":',
          '"schema_version":"1.0.0","schema_version":',
        ),
      ),
    reject,
  );
  const invalid = JSON.parse(text);
  invalid.notes.push(invalid.notes[0]);
  assert.throws(() => preview(session, [], JSON.stringify(invalid)), reject);
});
test("review merge: at most 100 combined IDs, repeated imports remain idempotent", () => {
  const a = Array.from({ length: 100 }, (_, i) => note(`n-${i}`));
  assert.equal(apply(session, plan(a, a), a, []).length, 100);
  assert.throws(() => plan(a, [note("new")]), reject);
  const p = plan(a.slice(0, 99), [a[99]]);
  assert.equal(apply(session, p, a.slice(0, 99), []).length, 100);
});
test("review merge: final aggregate export budget checked before any result is returned", () => {
  // Control characters are valid note data but expand to six bytes in JSON.
  const body = "\x01".repeat(3999);
  const a = Array.from({ length: 12 }, (_, i) => note(`a-${i}`, { body }));
  const b = Array.from({ length: 12 }, (_, i) => note(`b-${i}`, { body }));
  const p = plan(a, b);
  assert.throws(() => apply(session, p, a, []), reject);
  assert.equal(a.length, 12);
});
test("review merge: shorter explicit conflict choices can resolve an export-budget failure", () => {
  const a = Array.from({ length: 12 }, (_, i) =>
    note(`a-${i}`, { body: "\x01".repeat(3999) }),
  );
  const b = [
    ...a.map((n) => ({ ...n, body: "short" })),
    ...Array.from({ length: 12 }, (_, i) =>
      note(`b-${i}`, { body: "\x01".repeat(3999) }),
    ),
  ];
  const p = plan(a, b);
  assert.throws(
    () =>
      apply(
        session,
        p,
        a,
        a.map((n) => ({ id: n.id, keep: "current" })),
      ),
    reject,
  );
  assert.equal(
    apply(
      session,
      p,
      a,
      a.map((n) => ({ id: n.id, keep: "incoming" })),
    ).length,
    24,
  );
});
test("review merge: null and revoked proxies are normalized to the public error", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.throws(() => preview(session, proxy, "{}"), reject);
  assert.throws(() => apply(session, null, [], []), reject);
});
