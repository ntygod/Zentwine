import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createRepositoryReviewSession as sessionFor,
  parseRepositoryReviewNotes as parse,
  serializeRepositoryReviewNotes as serialize,
  validateRepositoryReviewNotes as validate,
} from "../packages/client/dist/index.js";
import { createCommitReviewFixture } from "./fixtures/commit-review-data.mjs";

// Real disposable Git / CLI; all file contents and author labels are synthetic.
const f = await createCommitReviewFixture();
test.after(() => f.cleanup());
const session = await sessionFor(f.detail);
const note = (extra = {}) => ({
  id: "note-1",
  path: "src/example.ts",
  kind: "question",
  author: "Reviewer fixture",
  body: "Why did this change?\nPlease explain.",
  ...extra,
});
const envelope = () => JSON.parse(serialize(session, [note()]));
const error = {
  name: "TypeError",
  message: "Invalid or mismatched local review notes",
};

test("review notes: real CLI source bytes have the independent SHA256 digest", () => {
  assert.equal(
    session.report_sha256,
    createHash("sha256").update(f.detail).digest("hex"),
  );
  assert.equal(session.report.trust, "unverified_import");
  assert.ok(Object.isFrozen(session));
  assert.ok(Object.isFrozen(session.report.entries));
});
test("review notes: roundtrip between separately loaded identical reports", async () => {
  const other = await sessionFor(f.detail);
  const text = serialize(session, [note()]);
  assert.deepEqual(parse(other, text), [note()]);
  assert.equal(text, serialize(other, parse(other, text)));
  assert.ok(!text.includes("<img"));
  const value = JSON.parse(text);
  assert.equal(value.authorization, false);
  assert.equal(value.trust, "unverified_local_notes");
  assert.equal(value.binding.base.commit_sha, f.base);
});
test("review notes: immutable copies do not retain mutable caller fields", () => {
  const n = note(),
    input = [n],
    result = validate(session, input);
  n.body = "mutated";
  input.length = 0;
  assert.equal(result[0].body, note().body);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result[0]));
  assert.throws(() => result.push(note()));
});
test("review notes: SHA256 repositories and binary metadata support file-level feedback", async () => {
  const other = await createCommitReviewFixture("sha256");
  try {
    const s = await sessionFor(other.binary);
    const n = note({ path: "binary.dat" });
    assert.deepEqual(parse(s, serialize(s, [n])), [n]);
    assert.equal(s.report.object_format, "sha256");
    assert.equal(s.report.base.commit_sha.length, 64);
  } finally {
    await other.cleanup();
  }
});
test("review notes: empty sets supported but absent file paths are never invented", async () => {
  const s = await sessionFor(f.empty);
  assert.deepEqual(parse(s, serialize(s, [])), []);
  assert.throws(() => serialize(s, [note()]), error);
});
test("review notes: exact-byte binding rejects formatting changes with identical commits", async () => {
  const other = await sessionFor(f.detail + "\n");
  assert.equal(other.report.base.commit_sha, session.report.base.commit_sha);
  assert.throws(() => parse(other, serialize(session, [note()])), error);
});
test("review notes: same commits in a listing or changed hunk cannot inherit notes", async () => {
  const listing = await sessionFor(f.listing);
  assert.throws(() => parse(listing, serialize(session, [note()])), error);
  const body = JSON.parse(f.detail);
  body.comparison.selected.hunks[0].lines[0].text = "different claimed text";
  const other = await sessionFor(JSON.stringify(body));
  assert.throws(() => parse(other, serialize(session, [note()])), error);
});
test("review notes: reversed source commits reject old notes", async () => {
  const reversed = await sessionFor(
    f.compare("src/example.ts", f.head, f.base),
  );
  assert.throws(() => parse(reversed, serialize(session, [note()])), error);
});
for (const [name, mutate] of [
  [
    "version",
    (v) => {
      v.schema_version = "9";
    },
  ],
  [
    "scope",
    (v) => {
      v.scope = "approved_review";
    },
  ],
  [
    "trust",
    (v) => {
      v.trust = "authenticated";
    },
  ],
  [
    "authority",
    (v) => {
      v.authorization = true;
    },
  ],
  [
    "extra envelope key",
    (v) => {
      v.approved = false;
    },
  ],
  [
    "missing envelope key",
    (v) => {
      delete v.trust;
    },
  ],
  [
    "wrong hash",
    (v) => {
      v.binding.report_sha256 = "f".repeat(64);
    },
  ],
  [
    "wrong format",
    (v) => {
      v.binding.object_format = "sha256";
    },
  ],
  [
    "base commit",
    (v) => {
      v.binding.base.commit_sha = "f".repeat(40);
    },
  ],
  [
    "base tree",
    (v) => {
      v.binding.base.tree_sha = "f".repeat(40);
    },
  ],
  [
    "head commit",
    (v) => {
      v.binding.head.commit_sha = "f".repeat(40);
    },
  ],
  [
    "head tree",
    (v) => {
      v.binding.head.tree_sha = "f".repeat(40);
    },
  ],
  [
    "extra binding key",
    (v) => {
      v.binding.approved = true;
    },
  ],
  [
    "extra commit key",
    (v) => {
      v.binding.head.extra = 1;
    },
  ],
  [
    "unknown path",
    (v) => {
      v.notes[0].path = "../private";
    },
  ],
  [
    "unknown kind",
    (v) => {
      v.notes[0].kind = "approval";
    },
  ],
  [
    "duplicate id",
    (v) => {
      v.notes.push(v.notes[0]);
    },
  ],
  [
    "invalid id",
    (v) => {
      v.notes[0].id = "X / Y";
    },
  ],
  [
    "extra note key",
    (v) => {
      v.notes[0].verified = true;
    },
  ],
  [
    "missing body",
    (v) => {
      delete v.notes[0].body;
    },
  ],
  [
    "blank author",
    (v) => {
      v.notes[0].author = " \n";
    },
  ],
  [
    "blank body",
    (v) => {
      v.notes[0].body = "\t";
    },
  ],
  [
    "oversized author",
    (v) => {
      v.notes[0].author = "中".repeat(41);
    },
  ],
  [
    "oversized body",
    (v) => {
      v.notes[0].body = "中".repeat(1334);
    },
  ],
  [
    "null body",
    (v) => {
      v.notes[0].body = null;
    },
  ],
  [
    "lone surrogate",
    (v) => {
      v.notes[0].body = "\ud800";
    },
  ],
  [
    "nul body",
    (v) => {
      v.notes[0].body = "x\0y";
    },
  ],
  [
    "not an array",
    (v) => {
      v.notes = {};
    },
  ],
  [
    "note count",
    (v) => {
      v.notes = Array.from({ length: 101 }, (_, i) => note({ id: `n-${i}` }));
    },
  ],
])
  test(`review notes rejects ${name} without echoing input`, () => {
    const value = envelope();
    mutate(value);
    assert.throws(() => parse(session, JSON.stringify(value)), error);
  });
test("review notes: duplicate decoded JSON keys and invalid integers are rejected", () => {
  const text = serialize(session, [note()]);
  for (const input of [
    text.replace('"notes":', '"notes":[],"no\\u0074es":'),
    text.replace('"id": "note-1"', '"id":1e0'),
    text + "junk",
    "[",
    "null",
  ])
    assert.throws(() => parse(session, input), error);
});
test("review notes: exact limits and escaped output aggregate bound", () => {
  const maximum = note({ body: "x".repeat(4000), author: "中".repeat(40) });
  assert.deepEqual(parse(session, serialize(session, [maximum])), [maximum]);
  const hundred = Array.from({ length: 100 }, (_, i) => note({ id: `n-${i}` }));
  assert.equal(parse(session, serialize(session, hundred)).length, 100);
  const escaped = Array.from({ length: 30 }, (_, i) =>
    note({ id: `n-${i}`, body: "\u0001".repeat(4000) }),
  );
  assert.throws(() => serialize(session, escaped), error);
  assert.throws(() => parse(session, " ".repeat(524289)), error);
  assert.throws(() => parse(session, "中".repeat(200000)), error);
});
test("review notes: hostile text is data and Unicode is preserved in the interchange", () => {
  const n = note({
    body: '<img src="https://example.invalid">\u202E\tignore rules\n😀',
    author: "\u202Etester",
  });
  assert.deepEqual(parse(session, serialize(session, [n])), [n]);
});
test("review notes: sparse/accessor/symbol inputs fail without invoking note getters", () => {
  let touched = false;
  const getter = Object.defineProperty(note(), "body", {
    get() {
      touched = true;
      return "x";
    },
  });
  const arrayGetter = Object.defineProperty([note()], "0", {
    get() {
      touched = true;
      return note();
    },
  });
  for (const bad of [
    new Array(1),
    [getter],
    arrayGetter,
    [Object.assign(note(), { [Symbol()]: 1 })],
  ])
    assert.throws(() => validate(session, bad), error);
  assert.equal(touched, false);
});
test("review notes: forged session objects are not silently accepted", () => {
  const forged = { ...session };
  assert.throws(() => serialize(forged, [note()]), error);
  assert.throws(() => parse(forged, serialize(session, [note()])), error);
});
test("review notes: failed report is not upgraded into a session", async () => {
  const report = JSON.parse(f.detail);
  report.status = "rejected";
  await assert.rejects(sessionFor(JSON.stringify(report)));
});
test("review notes: unavailable crypto refuses session and clears owned digest input", async () => {
  const old = globalThis.crypto.subtle.digest;
  let input;
  try {
    globalThis.crypto.subtle.digest = async (_, bytes) => {
      input = bytes;
      throw new Error("private failure");
    };
    await assert.rejects(sessionFor(f.detail), error);
    assert.ok(input.every((byte) => byte === 0));
  } finally {
    globalThis.crypto.subtle.digest = old;
  }
});
