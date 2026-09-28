import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRepositoryComparisonReport as parse,
  comparisonDisplayText as display,
  REPOSITORY_COMPARISON_IMPORT_LIMITS as limits,
} from "../packages/client/dist/index.js";
import {
  readRuntimeStreamJson,
  readRepositoryComparisonJson,
} from "../packages/client/dist/runtime-stream-json.js";
import { createCommitReviewFixture } from "./fixtures/commit-review-data.mjs";

// Shared immutable CLI strings only. Each parser invocation produces its own snapshot.
const fixture = await createCommitReviewFixture();
const listing = fixture.listing,
  detail = fixture.detail,
  binary = fixture.binary,
  empty = fixture.empty;
await fixture.cleanup();
const altered = (fn, source = detail) => {
  const r = JSON.parse(source);
  fn(r, r.comparison, r.comparison.selected);
  return JSON.stringify(r);
};
const reject = (input) =>
  assert.throws(() => parse(input), {
    name: "TypeError",
    message: "Invalid local comparison report",
  });

test("review import accepts real Git CLI metadata without disclosure or authority", () => {
  const r = parse(listing);
  assert.equal(r.trust, "unverified_import");
  assert.equal(r.selected, null);
  assert.equal(r.entries.length, 3);
  assert.equal(r.base.commit_sha, fixture.base);
  assert.equal(Object.hasOwn(r, "authorization"), false);
  assert.equal(Object.hasOwn(r, "source"), false);
});
test("review import validates real multi-hunk CLI detail and keeps literal text", () => {
  const r = parse(detail);
  assert.equal(r.selected.status, "text");
  assert.equal(r.selected.hunks.length, 2);
  const rows = r.selected.hunks.flatMap((h) => h.lines);
  assert.ok(rows.some((l) => l.text.includes("<img")));
  assert.ok(rows.some((l) => !l.newline));
  assert.ok(rows.some((l) => l.text.includes("\u202E")));
  assert.equal(JSON.stringify(r).includes(fixture.root), false);
});
test("review import accepts unchanged pair and binary not-rendered", () => {
  assert.equal(parse(empty).entries.length, 0);
  assert.equal(parse(binary).selected.reason, "binary_or_non_utf8");
});
test("review import accepts the port envelope without optional CLI exit code", () => {
  assert.equal(
    parse(
      altered((r) => {
        delete r.exit_code;
      }),
    ).selected.status,
    "text",
  );
});
test("review import freezes all exposed projections and isolates future calls", () => {
  const r = parse(detail);
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.entries[0].after));
  assert.ok(Object.isFrozen(r.selected.hunks[0].lines[0]));
  assert.throws(() => {
    r.entries[0].path = "wrong";
  });
  assert.notEqual(r, parse(detail));
});
test("review import accepts real SHA256 Git CLI reports", async (t) => {
  const f = await createCommitReviewFixture("sha256");
  t.after(f.cleanup);
  assert.equal(parse(f.detail).head.commit_sha.length, 64);
});
const mutations = [
  [
    "failed status",
    (r) => {
      r.status = "rejected";
    },
  ],
  [
    "wrong version",
    (r) => {
      r.report_version = "2.0.0";
    },
  ],
  [
    "execution flag",
    (r) => {
      r.authorization = true;
    },
  ],
  [
    "failed exit",
    (r) => {
      r.exit_code = 2;
    },
  ],
  [
    "unknown top key",
    (r) => {
      r.url = "https://example.invalid";
    },
  ],
  [
    "raw error",
    (r) => {
      r.fault = { code: "private error" };
    },
  ],
  [
    "wrong scope",
    (r) => {
      r.scope = "local_git_committed_snapshot";
    },
  ],
  [
    "wrong source",
    (r) => {
      r.source = "remote";
    },
  ],
  [
    "snapshot",
    (r) => {
      r.snapshot = {};
    },
  ],
  [
    "merge base semantics",
    (_, c) => {
      c.semantics = "merge_base";
    },
  ],
  [
    "wrong oid format",
    (_, c) => {
      c.base.commit_sha = "HEAD";
    },
  ],
  [
    "mismatched format",
    (_, c) => {
      c.object_format = "sha256";
    },
  ],
  [
    "contradictory same commit",
    (_, c) => {
      c.head.commit_sha = c.base.commit_sha;
    },
  ],
  [
    "same tree with changes",
    (_, c) => {
      c.head.tree_sha = c.base.tree_sha;
    },
  ],
  [
    "duplicate path",
    (_, c) => {
      c.entries.push(c.entries[0]);
    },
  ],
  [
    "absolute path",
    (_, c) => {
      c.entries[0].path = "/private/file";
    },
  ],
  [
    "traversal path",
    (_, c) => {
      c.entries[0].path = "../file";
    },
  ],
  [
    "side path mismatch",
    (_, c) => {
      c.entries[0].after.path = "other.txt";
    },
  ],
  [
    "classification mismatch",
    (_, c) => {
      c.entries[0].change = "deleted";
    },
  ],
  [
    "unknown mode",
    (_, c) => {
      c.entries[0].after.mode = "100777";
    },
  ],
  [
    "wrong kind",
    (_, c) => {
      c.entries[0].after.kind = "gitlink";
    },
  ],
  [
    "negative size",
    (_, c) => {
      c.entries[0].after.size_bytes = -1;
    },
  ],
  [
    "wrong summary",
    (_, c) => {
      c.summary.total++;
    },
  ],
  [
    "unknown selected path",
    (_, c, s) => {
      s.path = "absent";
    },
  ],
  [
    "hidden disclosure",
    (_, c) => {
      c.content_disclosed = false;
    },
  ],
  [
    "wrong algorithm",
    (_, c, s) => {
      s.algorithm = "html";
    },
  ],
  [
    "hunk line count",
    (_, c, s) => {
      s.hunks[0].old_lines++;
    },
  ],
  [
    "wrong old number",
    (_, c, s) => {
      s.hunks[0].lines[0].old_line++;
    },
  ],
  [
    "wrong new number",
    (_, c, s) => {
      s.hunks[0].lines[1].new_line++;
    },
  ],
  [
    "newline embedded",
    (_, c, s) => {
      s.hunks[0].lines[0].text = "x\ny";
    },
  ],
  [
    "unpaired surrogate",
    (_, c, s) => {
      s.hunks[0].lines[0].text = "\uD800";
    },
  ],
  [
    "binary text",
    (_, c, s) => {
      s.hunks[0].lines[0].text = "\0";
    },
  ],
  [
    "premature final line",
    (_, c, s) => {
      s.hunks[0].lines[0].newline = false;
    },
  ],
  [
    "overlapping hunks",
    (_, c, s) => {
      s.hunks.push(s.hunks[0]);
    },
  ],
  [
    "mismatched gaps",
    (_, c, s) => {
      s.hunks[1].old_start++;
    },
  ],
  [
    "wrong added statistics",
    (_, c, s) => {
      s.added_lines++;
    },
  ],
  [
    "missing text hunks",
    (_, c, s) => {
      s.hunks = [];
      s.added_lines = 0;
      s.deleted_lines = 0;
    },
  ],
  [
    "not-rendered contradiction",
    (_, c) => {
      c.selected = {
        path: c.selected.path,
        status: "not_rendered",
        reason: "non_regular_object",
      };
      c.content_disclosed = false;
    },
  ],
];
for (const [name, mutate] of mutations)
  test(`review import rejects ${name} without echoing raw data`, () =>
    reject(altered(mutate)));
test("review import rejects duplicate decoded keys and dangerous unknown keys", () => {
  reject(
    detail.replace(
      '"status":"compared"',
      '"status":"rejected","sta\\u0074us":"compared"',
    ),
  );
  reject(detail.replace('"report_version"', '"__proto__":{},"report_version"'));
  assert.equal({}.polluted, undefined);
});
test("review import rejects malformed, trailing, deeply nested and noninteger JSON", () => {
  for (const v of [
    "",
    "{",
    "null",
    "[]",
    detail + "{}",
    "[".repeat(18) + "0" + "]".repeat(18),
    detail.replace('"exit_code":0', '"exit_code":0.0'),
  ])
    reject(v);
});
test("review import enforces byte and path limits on multibyte content", () => {
  reject(" ".repeat(limits.bytes + 1));
  reject("中".repeat(Math.floor(limits.bytes / 3) + 1));
  reject(
    altered((_, c) => {
      c.entries[0].path = "中".repeat(1400);
    }),
  );
});
test("review import enforces entry and node budgets without widening runtime limits", () => {
  reject(
    altered((_, c) => {
      c.entries = Array.from(
        { length: limits.entries + 1 },
        () => c.entries[0],
      );
    }),
  );
  assert.throws(() =>
    readRuntimeStreamJson(JSON.stringify(Array(8192).fill(0))),
  );
  assert.equal(
    readRepositoryComparisonJson(JSON.stringify(Array(8192).fill(0))).length,
    8192,
  );
  assert.throws(() =>
    readRepositoryComparisonJson(JSON.stringify(Array(100000).fill(0))),
  );
});
test("review display makes control and direction characters visible without interpreting HTML", () => {
  assert.equal(
    display("x\t\r\n\u202E\ufeff"),
    "x\\u{0009}\\u{000D}\\u{000A}\\u{202E}\\u{FEFF}",
  );
  assert.equal(display("<b>中文🙂</b>"), "<b>中文🙂</b>");
});
