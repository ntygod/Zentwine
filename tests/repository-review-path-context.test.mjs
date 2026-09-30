import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createRepositoryReviewSession,
  serializeRepositoryReviewNotes,
} from "../packages/client/dist/index.js";
import {
  inspectRepositoryReview as inspect,
  repositoryReviewInspectMain as main,
} from "../scripts/repository-review-inspect.mjs";
import { createCommitReviewFixture } from "./fixtures/commit-review-data.mjs";

// Real disposable repositories and native files. A mocked digest boundary only
// changes this isolated test process's cwd; the digest and Git remain real.
const initialCwd = process.cwd();
const fixture = await createCommitReviewFixture();
const other = await createCommitReviewFixture("sha1", 13);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "zt-review-cwd-"));
const first = path.join(scratch, "first");
const second = path.join(scratch, "second");
await fs.mkdir(first);
await fs.mkdir(second);
await fs.cp(fixture.root, path.join(first, "repository"), { recursive: true });
await fs.cp(other.root, path.join(second, "repository"), { recursive: true });
test.after(async () => {
  process.chdir(initialCwd);
  await fixture.cleanup();
  await other.cleanup();
  await fs.rm(scratch, { recursive: true, force: true });
});
const secret = "SYNTHETIC_PATH_BOUND_OPINION";
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function inputs(t, report = fixture.detail) {
  const directory = await fs.mkdtemp(path.join(first, "feedback-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createRepositoryReviewSession(report);
  const notes = serializeRepositoryReviewNotes(session, [
    {
      id: "path-note",
      path: "src/example.ts",
      kind: "issue",
      author: "Synthetic reviewer",
      body: secret,
    },
  ]);
  await fs.writeFile(path.join(directory, "comparison.json"), report);
  await fs.writeFile(path.join(directory, "review-notes.json"), notes);
  return {
    directory,
    expected: {
      baseCommit: session.report.base.commit_sha,
      headCommit: session.report.head.commit_sha,
      reportSha256: hash(report),
      notesSha256: hash(notes),
    },
  };
}
function enter(t, directory) {
  const previous = process.cwd();
  t.after(() => process.chdir(previous));
  process.chdir(directory);
}
function changeDuringDigest(t, directory) {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let calls = 0;
  t.mock.method(crypto.subtle, "digest", (...args) => {
    calls++;
    process.chdir(directory);
    return digest(...args);
  });
  return () => assert.ok(calls > 0, "the real digest boundary was reached");
}
function accepted(result, pinned = false) {
  assert.equal(result.status, "inspected", JSON.stringify(result));
  assert.equal(result.exit_code, 0);
  assert.equal(result.feedback.comparison_verification, "matches_local_git");
  assert.equal(
    result.feedback.expectation_verification,
    pinned ? "matches_explicit_pins" : undefined,
  );
  assert.equal(result.authorization, false);
  assert.equal(result.code_execution, false);
  assert.equal(result.feedback.comparison_content_disclosed, false);
}
function refused(result, code, exit = 2) {
  assert.equal(result.fault?.code, code, JSON.stringify(result));
  assert.equal(result.exit_code, exit);
  assert.equal(result.feedback, null);
  assert.equal(result.authorization, false);
  assert.equal(result.code_execution, false);
  assert.ok(!JSON.stringify(result).includes(secret));
}

for (const pinned of [false, true]) {
  test(`review paths: ${pinned ? "pinned" : "legacy"} relative repository stays at invocation cwd during digest`, async (t) => {
    const input = await inputs(t);
    enter(t, first);
    const reached = changeDuringDigest(t, second);
    const result = await inspect(
      "repository",
      input.directory,
      pinned ? { expected: input.expected } : {},
    );
    accepted(result, pinned);
    assert.equal(result.feedback.binding.head.commit_sha, fixture.head);
    assert.equal(result.feedback.selected, null);
    reached();
  });
  test(`review paths: ${pinned ? "pinned" : "legacy"} alternate repository cannot validate a foreign handoff`, async (t) => {
    const input = await inputs(t, other.detail);
    enter(t, first);
    const reached = changeDuringDigest(t, second);
    const result = await inspect("repository", input.directory, {
      path: "src/example.ts",
      ...(pinned ? { expected: input.expected } : {}),
    });
    refused(result, "local_comparison_unavailable");
    reached();
  });
}
test("review paths: synchronous cwd change after invocation cannot retarget repository", async (t) => {
  const input = await inputs(t);
  enter(t, first);
  const pending = inspect("repository", input.directory, {
    expected: input.expected,
  });
  process.chdir(second);
  accepted(await pending, true);
});
test("review paths: both relative arguments share invocation context", async (t) => {
  const input = await inputs(t);
  enter(t, first);
  const reached = changeDuringDigest(t, second);
  const result = await inspect("repository", path.basename(input.directory), {
    expected: input.expected,
    path: "src/example.ts",
  });
  accepted(result, true);
  assert.equal(result.feedback.selected.notes[0].body, secret);
  reached();
});
test("review paths: dot segments are resolved before asynchronous work", async (t) => {
  const input = await inputs(t);
  enter(t, path.join(first, "repository"));
  const reached = changeDuringDigest(t, path.join(second, "repository"));
  accepted(await inspect("../repository/.", input.directory), false);
  reached();
});
test("review paths: listing-only handoff retains the same repository", async (t) => {
  const input = await inputs(t, fixture.listing);
  enter(t, first);
  const reached = changeDuringDigest(t, second);
  const result = await inspect("repository", input.directory, {
    expected: input.expected,
  });
  accepted(result, true);
  assert.equal(result.feedback.coverage.carried_detail, "not_present");
  reached();
});
test("review paths: CLI argument API preserves relative repository context", async (t) => {
  const input = await inputs(t);
  enter(t, first);
  const reached = changeDuringDigest(t, second);
  const p = input.expected;
  accepted(
    await main([
      "repository",
      input.directory,
      "--expected-base",
      p.baseCommit,
      "--expected-head",
      p.headCommit,
      "--expected-report-sha256",
      p.reportSha256,
      "--expected-notes-sha256",
      p.notesSha256,
    ]),
    true,
  );
  reached();
});
test("review paths: absolute repository ignores later cwd changes", async (t) => {
  const input = await inputs(t);
  enter(t, first);
  const reached = changeDuringDigest(t, second);
  accepted(
    await inspect(path.join(first, "repository"), input.directory, {
      expected: input.expected,
    }),
    true,
  );
  reached();
});
test("review paths: ordinary relative calls remain compatible", async (t) => {
  const input = await inputs(t);
  enter(t, first);
  accepted(await inspect("repository", path.basename(input.directory)), false);
});
test("review paths: inaccessible cwd gives structured error for relative repository", async (t) => {
  const input = await inputs(t);
  const removed = await fs.mkdtemp(path.join(scratch, "removed-"));
  enter(t, removed);
  await fs.rmdir(removed);
  refused(
    await inspect("repository", input.directory),
    "invalid_arguments",
    64,
  );
});
test("review paths: inaccessible cwd gives structured error for relative feedback", async (t) => {
  const removed = await fs.mkdtemp(path.join(scratch, "removed-"));
  enter(t, removed);
  await fs.rmdir(removed);
  refused(
    await inspect(fixture.root, "feedback", { timeoutMs: 100 }),
    "invalid_arguments",
    64,
  );
});
test("review paths: absolute inputs still work when cwd is inaccessible", async (t) => {
  const input = await inputs(t);
  const removed = await fs.mkdtemp(path.join(scratch, "removed-"));
  enter(t, removed);
  await fs.rmdir(removed);
  accepted(
    await inspect(fixture.root, input.directory, { expected: input.expected }),
    true,
  );
});
test("review paths: invalid pins are rejected before cwd lookup", async (t) => {
  const removed = await fs.mkdtemp(path.join(scratch, "removed-"));
  enter(t, removed);
  await fs.rmdir(removed);
  refused(
    await inspect("repository", "feedback", { expected: {} }),
    "invalid_arguments",
    64,
  );
});
test("review paths: failed normalization allocates no operation timer or input reads", async (t) => {
  const removed = await fs.mkdtemp(path.join(scratch, "removed-"));
  enter(t, removed);
  await fs.rmdir(removed);
  const start = globalThis.setTimeout;
  const timers = [];
  let reads = 0;
  t.mock.method(globalThis, "setTimeout", (...args) => {
    const timer = start(...args);
    timers.push(timer);
    return timer;
  });
  t.mock.method(fs, "lstat", () => {
    reads++;
    throw new Error("unexpected input read");
  });
  t.after(() => timers.forEach(clearTimeout));
  refused(
    await inspect(fixture.root, "feedback", { timeoutMs: 100 }),
    "invalid_arguments",
    64,
  );
  assert.equal(timers.length, 0);
  assert.equal(reads, 0);
});
test("review paths: cancellation during a cwd change still withholds feedback", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  enter(t, first);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "digest", (...args) => {
    process.chdir(second);
    controller.abort(secret);
    return digest(...args);
  });
  refused(
    await inspect("repository", input.directory, {
      expected: input.expected,
      signal: controller.signal,
      path: "src/example.ts",
    }),
    "cancelled",
    130,
  );
});
test("review paths: SHA256 repository stays anchored before the digest await", async (t) => {
  const sha256 = await createCommitReviewFixture("sha256");
  t.after(() => sha256.cleanup());
  const input = await inputs(t, sha256.detail);
  enter(t, path.dirname(sha256.root));
  const reached = changeDuringDigest(t, second);
  const result = await inspect(path.basename(sha256.root), input.directory, {
    expected: input.expected,
  });
  accepted(result, true);
  assert.equal(result.feedback.binding.object_format, "sha256");
  reached();
});
