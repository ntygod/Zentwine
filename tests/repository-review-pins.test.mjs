import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import {
  createRepositoryReviewSession as sessionFor,
  serializeRepositoryReviewNotes as serialize,
} from "../packages/client/dist/index.js";
import {
  inspectRepositoryReview as inspect,
  repositoryReviewInspectMain as main,
  repositoryReviewReportJson as json,
} from "../scripts/repository-review-inspect.mjs";
import { createCommitReviewFixture } from "./fixtures/commit-review-data.mjs";
import { interceptBeforeExec } from "./fixtures/gated-spawn.mjs";

// Synthetic opinions and code, real Git objects, original CLI and native input files.
const fixture = await createCommitReviewFixture();
test.after(() => fixture.cleanup());
const digest = (text) => createHash("sha256").update(text).digest("hex");
const note = (id = "one", selected = "src/example.ts") => ({
  id,
  path: selected,
  kind: "issue",
  author: "Synthetic author",
  body: `Private opinion ${id}`,
});
const pinsFor = (original, notesJson) => {
  const { base, head } = JSON.parse(original).comparison;
  return {
    baseCommit: base.commit_sha,
    headCommit: head.commit_sha,
    reportSha256: digest(original),
    notesSha256: digest(notesJson),
  };
};
const flagsFor = (expected) => [
  "--expected-base",
  expected.baseCommit,
  "--expected-head",
  expected.headCommit,
  "--expected-report-sha256",
  expected.reportSha256,
  "--expected-notes-sha256",
  expected.notesSha256,
];
async function inputs(t, original = fixture.detail, notes = [note()]) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "zt-pinned-review-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await sessionFor(original);
  const notesJson = serialize(session, notes);
  await fs.writeFile(path.join(directory, "comparison.json"), original);
  await fs.writeFile(path.join(directory, "review-notes.json"), notesJson);
  return {
    directory,
    session,
    notesJson,
    expected: pinsFor(original, notesJson),
  };
}
function accepted(r) {
  assert.equal(r.status, "inspected", JSON.stringify(r));
  assert.equal(r.exit_code, 0);
  assert.equal(r.feedback.expectation_verification, "matches_explicit_pins");
  assert.equal(r.feedback.comparison_verification, "matches_local_git");
  assert.equal(r.authorization, false);
  assert.equal(r.code_execution, false);
  assert.equal(r.author_trust, "unverified");
  assert.equal(r.feedback.coverage.current_head, "not_inspected");
  assert.equal(r.feedback.coverage.working_tree, "not_inspected");
  assert.equal(r.feedback.comparison_content_disclosed, false);
  assert.ok(Object.isFrozen(r.feedback));
}
function refused(r, code, exit = 2) {
  assert.equal(r.fault.code, code, JSON.stringify(r));
  assert.equal(r.exit_code, exit);
  assert.equal(r.feedback, null);
  assert.equal(r.authorization, false);
  assert.equal(r.code_execution, false);
  assert.ok(Object.isFrozen(r) || exit === 64);
  assert.ok(!json(r).includes("Private opinion"));
  assert.ok(!json(r).includes("Synthetic author"));
}
function forbidGit(t) {
  let count = 0;
  t.mock.method(cp, "spawn", () => {
    count++;
    throw new Error("Git must not run before pins match");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(count, 0);
  });
}
function intercept(t, hook) {
  const original = cp.spawn;
  t.mock.method(cp, "spawn", (...args) =>
    interceptBeforeExec(original, hook, ...args),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}
async function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(
      process.execPath,
      ["scripts/repository-review-inspect.mjs", ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, out, err, report: JSON.parse(out) }),
    );
  });
}

test("pins: summary and two selected reads reuse one exact task handoff", async (t) => {
  const i = await inputs(t, fixture.detail, [note(), note("two", "added.txt")]);
  const summary = await inspect(fixture.root, i.directory, {
    expected: i.expected,
  });
  accepted(summary);
  assert.equal(summary.feedback.selected, null);
  assert.equal(summary.feedback.note_content_disclosed, false);
  assert.ok(!json(summary).includes("Private opinion"));
  for (const p of ["src/example.ts", "added.txt"]) {
    const r = await inspect(fixture.root, i.directory, {
      expected: i.expected,
      path: p,
    });
    accepted(r);
    assert.equal(r.feedback.selected.notes.length, 1);
    assert.equal(r.feedback.selected.notes[0].path, p);
    assert.equal(r.feedback.notes_sha256, i.expected.notesSha256);
    assert.ok(!json(r).includes("unsafeReview"));
  }
});
test("pins: omitted expectation preserves legacy output without a pin-match claim", async (t) => {
  const i = await inputs(t);
  const r = await inspect(fixture.root, i.directory);
  assert.equal(r.exit_code, 0);
  assert.ok(!Object.hasOwn(r.feedback, "expectation_verification"));
  assert.equal(r.feedback.selected, null);
});
for (const [key, code] of [
  ["baseCommit", "base_pin_mismatch"],
  ["headCommit", "head_pin_mismatch"],
  ["reportSha256", "report_pin_mismatch"],
  ["notesSha256", "notes_pin_mismatch"],
]) {
  test(`pins: ${key} mismatch refuses before Git and selected opinion disclosure`, async (t) => {
    const i = await inputs(t);
    const expected = {
      ...i.expected,
      [key]: "0".repeat(i.expected[key].length),
    };
    forbidGit(t);
    const r = await inspect(fixture.root, i.directory, {
      expected,
      path: "src/example.ts",
    });
    refused(r, code);
    assert.equal(r.fault.stage, "expectation");
    for (const value of Object.values(i.expected))
      assert.ok(!json(r).includes(value));
  });
}
test("pins: two valid local commits in the wrong direction are not the task baseline", async (t) => {
  const i = await inputs(t);
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, {
      expected: {
        ...i.expected,
        baseCommit: fixture.head,
        headCommit: fixture.base,
      },
    }),
    "base_pin_mismatch",
  );
});
test("pins: notes replacement between summary and detail is refused without refreshing pins", async (t) => {
  const i = await inputs(t);
  accepted(await inspect(fixture.root, i.directory, { expected: i.expected }));
  await fs.writeFile(
    path.join(i.directory, "review-notes.json"),
    serialize(i.session, [note("replacement")]),
  );
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, {
      expected: i.expected,
      path: "src/example.ts",
    }),
    "notes_pin_mismatch",
  );
});
test("pins: semantically identical notes reformatting still changes the pinned input bytes", async (t) => {
  const i = await inputs(t);
  await fs.writeFile(
    path.join(i.directory, "review-notes.json"),
    JSON.stringify(JSON.parse(i.notesJson)),
  );
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, { expected: i.expected }),
    "notes_pin_mismatch",
  );
});
test("pins: valid replacement report plus rebound opinions cannot inherit earlier pins", async (t) => {
  const i = await inputs(t);
  accepted(await inspect(fixture.root, i.directory, { expected: i.expected }));
  const replacement = fixture.listing;
  await fs.writeFile(path.join(i.directory, "comparison.json"), replacement);
  await fs.writeFile(
    path.join(i.directory, "review-notes.json"),
    serialize(await sessionFor(replacement), [note()]),
  );
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, { expected: i.expected }),
    "report_pin_mismatch",
  );
});
test("pins: a new explicit set can intentionally select replacement opinions", async (t) => {
  const i = await inputs(t);
  const replacement = serialize(i.session, [note("new")]);
  await fs.writeFile(path.join(i.directory, "review-notes.json"), replacement);
  const r = await inspect(fixture.root, i.directory, {
    expected: { ...i.expected, notesSha256: digest(replacement) },
    path: "src/example.ts",
  });
  accepted(r);
  assert.equal(r.feedback.selected.notes[0].id, "new");
});
test("pins: caller mutation after invocation cannot change the captured expectation", async (t) => {
  const i = await inputs(t);
  const original = structuredClone(i.expected);
  const options = { expected: i.expected };
  const pending = inspect(fixture.root, i.directory, options);
  for (const key of Object.keys(i.expected)) i.expected[key] = "bad";
  options.expected = null;
  const r = await pending;
  accepted(r);
  assert.equal(r.feedback.binding.base.commit_sha, original.baseCommit);
  assert.equal(r.feedback.notes_sha256, original.notesSha256);
  assert.equal(Object.isFrozen(i.expected), false);
});

const validPins = {
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  reportSha256: "c".repeat(64),
  notesSha256: "d".repeat(64),
};
for (const [label, value] of [
  ["undefined", undefined],
  ["null", null],
  ["array", []],
  ["empty", {}],
  ["partial", { baseCommit: validPins.baseCommit }],
  ["unknown", { ...validPins, extra: "unexpected" }],
  ["mixed algorithms", { ...validPins, headCommit: "b".repeat(64) }],
  ["branch", { ...validPins, baseCommit: "HEAD" }],
  ["abbreviated", { ...validPins, headCommit: "b".repeat(8) }],
  ["uppercase commit", { ...validPins, baseCommit: "A".repeat(40) }],
  ["uppercase digest", { ...validPins, notesSha256: "D".repeat(64) }],
  [
    "trailing newline commit",
    {
      ...validPins,
      baseCommit: validPins.baseCommit + "\n",
      headCommit: validPins.headCommit + "\n",
    },
  ],
  [
    "trailing newline digest",
    { ...validPins, reportSha256: validPins.reportSha256 + "\n" },
  ],
  ["short digest", { ...validPins, notesSha256: "d".repeat(63) }],
  ["numeric", { ...validPins, baseCommit: 42 }],
  ["null prototype", Object.assign(Object.create(null), validPins)],
  ["inherited", Object.create(validPins)],
  ["symbol key", { ...validPins, [Symbol("extra")]: "x" }],
  [
    "hidden field",
    Object.defineProperty({ ...validPins }, "baseCommit", {
      enumerable: false,
    }),
  ],
]) {
  test(`pins: invalid ${label} refuses before filesystem or Git access`, async (t) => {
    let reads = 0;
    t.mock.method(fs, "lstat", () => {
      reads++;
      throw new Error("unexpected read");
    });
    forbidGit(t);
    refused(
      await inspect("unused", "unused", { expected: value }),
      "invalid_arguments",
      64,
    );
    assert.equal(reads, 0);
  });
}
test("pins: nested expectation getters and coercion hooks are never evaluated", async () => {
  let reads = 0;
  const getter = Object.defineProperty({ ...validPins }, "baseCommit", {
    get() {
      reads++;
      return validPins.baseCommit;
    },
  });
  const coercible = {
    ...validPins,
    notesSha256: {
      toString() {
        reads++;
        return validPins.notesSha256;
      },
    },
  };
  for (const expected of [getter, coercible])
    refused(
      await inspect("unused", "unused", { expected }),
      "invalid_arguments",
      64,
    );
  assert.equal(reads, 0);
});
test("pins: top-level expectation getter is not evaluated", async () => {
  let reads = 0;
  refused(
    await inspect("unused", "unused", {
      get expected() {
        reads++;
        return validPins;
      },
    }),
    "invalid_arguments",
    64,
  );
  assert.equal(reads, 0);
});
test("pins: frozen caller expectations work without being modified", async (t) => {
  const i = await inputs(t);
  accepted(
    await inspect(
      fixture.root,
      i.directory,
      Object.freeze({ expected: Object.freeze(i.expected) }),
    ),
  );
});
test("pins: matching outer hashes never replace Git verification of carried code", async (t) => {
  const forged = JSON.parse(fixture.detail);
  const line = forged.comparison.selected.hunks
    .flatMap((h) => h.lines)
    .find((l) => l.kind === "insert");
  line.text = "forged but structurally valid";
  const i = await inputs(t, JSON.stringify(forged));
  refused(
    await inspect(fixture.root, i.directory, {
      expected: i.expected,
      path: "src/example.ts",
    }),
    "local_comparison_mismatch",
  );
});
test("pins: matching hashes still reject structurally invalid comparison input", async (t) => {
  const i = await inputs(t),
    original = "{invalid}";
  await fs.writeFile(path.join(i.directory, "comparison.json"), original);
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, {
      expected: { ...i.expected, reportSha256: digest(original) },
    }),
    "invalid_comparison_report",
  );
});
test("pins: matching hashes still enforce original opinion-to-report binding", async (t) => {
  const i = await inputs(t);
  const other = serialize(await sessionFor(fixture.listing), [note()]);
  await fs.writeFile(path.join(i.directory, "review-notes.json"), other);
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, {
      expected: { ...i.expected, notesSha256: digest(other) },
    }),
    "invalid_review_notes",
  );
});
test("pins: listing-only pinning does not fetch blob bodies", async (t) => {
  const i = await inputs(t, fixture.listing);
  intercept(t, (run, command, args, options) => {
    assert.ok(!(args.includes("cat-file") && args.includes("blob")));
    return run(command, args, options);
  });
  const r = await inspect(fixture.root, i.directory, { expected: i.expected });
  accepted(r);
  assert.equal(r.feedback.coverage.carried_detail, "not_present");
});
test("pins: binary detail pins verify classification without exposing code", async (t) => {
  const i = await inputs(t, fixture.binary, [note("binary", "binary.dat")]);
  const r = await inspect(fixture.root, i.directory, { expected: i.expected });
  accepted(r);
  assert.equal(
    r.feedback.coverage.carried_detail,
    "non_text_classification_matched",
  );
});
test("pins: reverse historical comparisons use the explicitly requested pair", async (t) => {
  const i = await inputs(
    t,
    fixture.compare("src/example.ts", fixture.head, fixture.base),
  );
  const r = await inspect(fixture.root, i.directory, { expected: i.expected });
  accepted(r);
  assert.equal(r.feedback.binding.head.commit_sha, fixture.base);
});
test("pins: same commit and empty opinions do not become approval", async (t) => {
  const i = await inputs(t, fixture.empty, []);
  const r = await inspect(fixture.root, i.directory, { expected: i.expected });
  accepted(r);
  assert.deepEqual(r.feedback.files, []);
  assert.equal(r.feedback.summary.notes, 0);
});
test("pins: SHA256 Git uses 64-character commit pins independently of file hashes", async (t) => {
  const f = await createCommitReviewFixture("sha256");
  t.after(() => f.cleanup());
  const i = await inputs(t, f.detail);
  assert.equal(i.expected.baseCommit.length, 64);
  const r = await inspect(f.root, i.directory, { expected: i.expected });
  accepted(r);
  assert.equal(r.feedback.binding.object_format, "sha256");
});
test("pins: a changed input after pin checks is still caught at final sampling", async (t) => {
  const i = await inputs(t);
  let changed = false;
  intercept(t, (run, command, args, options) => {
    if (!changed) {
      changed = true;
      // Explicit test fault: mutation during local Git inspection, not a second input read.
      cp.execFileSync(process.execPath, [
        "-e",
        "require('fs').appendFileSync(process.argv[1], '\\n')",
        path.join(i.directory, "review-notes.json"),
      ]);
    }
    return run(command, args, options);
  });
  refused(
    await inspect(fixture.root, i.directory, { expected: i.expected }),
    "input_changed",
  );
  assert.equal(changed, true);
});
test("pins: pre-cancelled calls never disclose pinned input", async (t) => {
  const i = await inputs(t),
    controller = new AbortController();
  controller.abort("private cancellation reason");
  forbidGit(t);
  const r = await inspect(fixture.root, i.directory, {
    expected: i.expected,
    signal: controller.signal,
  });
  refused(r, "cancelled", 130);
  assert.ok(!json(r).includes("private cancellation"));
});
test("pins: cancelled pending digest ignores its late result", async (t) => {
  const i = await inputs(t),
    controller = new AbortController();
  let finish;
  t.mock.method(globalThis.crypto.subtle, "digest", () => {
    controller.abort();
    return new Promise((resolve) => (finish = resolve));
  });
  forbidGit(t);
  const r = await inspect(fixture.root, i.directory, {
    expected: i.expected,
    signal: controller.signal,
  });
  refused(r, "cancelled", 130);
  finish(new ArrayBuffer(32));
  await Promise.resolve();
  assert.equal(r.feedback, null);
});
test("pins: pending digest remains within the original total deadline", async (t) => {
  const i = await inputs(t);
  let finish;
  t.mock.method(
    globalThis.crypto.subtle,
    "digest",
    () => new Promise((resolve) => (finish = resolve)),
  );
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, {
      expected: i.expected,
      timeoutMs: 100,
    }),
    "timeout",
    124,
  );
  if (finish) finish(new ArrayBuffer(32));
});
test("pins: cleanup failure after matching pins still withholds success", async (t) => {
  const i = await inputs(t),
    originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith("/review-notes.json")) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw new Error("synthetic cleanup failure");
      };
    }
    return handle;
  });
  refused(
    await inspect(fixture.root, i.directory, { expected: i.expected }),
    "cleanup_failed",
    3,
  );
});
test("pins: nonexistent selected path never gains access through correct hashes", async (t) => {
  const i = await inputs(t);
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, {
      expected: i.expected,
      path: "not-present.txt",
    }),
    "path_not_in_report",
  );
});
test("pins: CLI summary and detail enforce the complete expectation", async (t) => {
  const i = await inputs(t),
    flags = flagsFor(i.expected);
  const summary = await invoke([fixture.root, i.directory, ...flags]);
  assert.equal(summary.code, 0);
  assert.equal(summary.err, "");
  assert.equal(
    summary.report.feedback.expectation_verification,
    "matches_explicit_pins",
  );
  assert.ok(!summary.out.includes("Private opinion"));
  const selected = await invoke([
    fixture.root,
    i.directory,
    "--path",
    "src/example.ts",
    ...flags,
  ]);
  assert.equal(selected.code, 0);
  assert.deepEqual(selected.report.feedback.selected.notes, [note()]);
});
test("pins: every nonempty partial CLI pin combination rejects before I/O", async (t) => {
  let reads = 0;
  t.mock.method(fs, "lstat", () => {
    reads++;
    throw new Error("unexpected read");
  });
  const pairs = flagsFor(validPins);
  for (let mask = 1; mask < 15; mask++) {
    const args = ["unused", "unused"];
    for (let bit = 0; bit < 4; bit++)
      if (mask & (1 << bit)) args.push(...pairs.slice(bit * 2, bit * 2 + 2));
    refused(await main(args), "invalid_arguments", 64);
  }
  assert.equal(reads, 0);
});
test("pins: CLI duplicates, missing values and misspelled flags never downgrade", async () => {
  const all = flagsFor(validPins);
  for (const args of [
    [...all, "--expected-base", validPins.baseCommit],
    [...all.slice(0, -1)],
    [...all, "--expected-notes", validPins.notesSha256],
    [...all, "--path", "a", "--path", "b"],
    [...all, "--timeout-ms", "1e3"],
  ])
    refused(await main(["unused", "unused", ...args]), "invalid_arguments", 64);
});
test("pins: real CLI mismatch returns exit 2 and no expected or actual identifiers", async (t) => {
  const i = await inputs(t);
  const expected = { ...i.expected, notesSha256: "0".repeat(64) };
  const r = await invoke([
    fixture.root,
    i.directory,
    ...flagsFor(expected),
    "--path",
    "src/example.ts",
  ]);
  assert.equal(r.code, 2);
  assert.equal(r.err, "");
  assert.equal(r.report.fault.code, "notes_pin_mismatch");
  assert.equal(r.report.feedback, null);
  for (const value of Object.values(expected))
    assert.ok(!r.out.includes(value));
});
test("pins: CLI help documents all-or-none without input access", async (t) => {
  forbidGit(t);
  const r = await main(["--help"]);
  assert.equal(r.status, "help");
  assert.equal(r.exit_code, 0);
  for (const flag of flagsFor(validPins).filter((_, i) => i % 2 === 0))
    assert.ok(r.usage.includes(flag));
  assert.ok(r.usage.includes("all four pins or none"));
});
test("pins: mismatch zeroes all owned input bytes and closes held descriptors", async (t) => {
  const i = await inputs(t),
    originalOpen = fs.open;
  const buffers = new Set(),
    handles = [];
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args),
      read = handle.read.bind(handle),
      close = handle.close.bind(handle);
    const state = { closed: false };
    handles.push(state);
    handle.read = async (buffer, ...rest) => {
      buffers.add(buffer);
      return read(buffer, ...rest);
    };
    handle.close = async () => {
      await close();
      state.closed = true;
    };
    return handle;
  });
  const r = await inspect(fixture.root, i.directory, {
    expected: { ...i.expected, notesSha256: "0".repeat(64) },
  });
  refused(r, "notes_pin_mismatch");
  assert.equal(handles.length, 3);
  assert.ok(handles.every((h) => h.closed));
  assert.equal(buffers.size, 2);
  assert.ok([...buffers].every((buffer) => buffer.every((b) => b === 0)));
});
test("pins: matching digests do not allow input symlinks", async (t) => {
  const i = await inputs(t);
  await fs.rename(
    path.join(i.directory, "review-notes.json"),
    path.join(i.directory, "original.json"),
  );
  await fs.symlink(
    "original.json",
    path.join(i.directory, "review-notes.json"),
  );
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, { expected: i.expected }),
    "invalid_input_file",
  );
});
test("pins: matching digests do not allow multiple hardlinks", async (t) => {
  const i = await inputs(t);
  await fs.link(
    path.join(i.directory, "review-notes.json"),
    path.join(i.directory, "extra.json"),
  );
  forbidGit(t);
  refused(
    await inspect(fixture.root, i.directory, { expected: i.expected }),
    "invalid_input_file",
  );
});
test("pins: failure to load required client build never downgrades pinned validation", async (t) => {
  const i = await inputs(t),
    root = await fs.mkdtemp(path.join(os.tmpdir(), "zt-pin-unbuilt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts/lib"), { recursive: true });
  await fs.copyFile(
    "scripts/repository-review-inspect.mjs",
    path.join(root, "scripts/repository-review-inspect.mjs"),
  );
  for (const name of [
    "local-repository.mjs",
    "local-worktree.mjs",
    "local-commit-comparison.mjs",
  ])
    await fs.copyFile(
      `scripts/lib/${name}`,
      path.join(root, `scripts/lib/${name}`),
    );
  const { pathToFileURL } = await import("node:url");
  const isolated = await import(
    pathToFileURL(path.join(root, "scripts/repository-review-inspect.mjs")).href
  );
  refused(
    await isolated.inspectRepositoryReview(fixture.root, i.directory, {
      expected: i.expected,
    }),
    "build_required",
    3,
  );
});
for (const name of ["SIGINT", "SIGTERM"]) {
  test(`pins: actual CLI ${name} cancels pinned Git inspection with no feedback`, async (t) => {
    const i = await inputs(t),
      preload = path.join(i.directory, "hold.mjs");
    const { pathToFileURL } = await import("node:url");
    const gate = pathToFileURL(
      path.resolve("tests/fixtures/gated-spawn.mjs"),
    ).href;
    // Test-only exec-before-handshake: paused child may still be the wrapper, not Git.
    await fs.writeFile(
      preload,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {interceptBeforeExec} from ${JSON.stringify(gate)};const original=cp.spawn;let once=false;cp.spawn=(...args)=>interceptBeforeExec(original,(run,c,a,o)=>{const p=run(c,a,o);if(!once){once=true;process.kill(-p.pid,'SIGSTOP');process.send({pid:p.pid});}return p;},...args);syncBuiltinESMExports();`,
    );
    const child = cp.spawn(
      process.execPath,
      [
        "--import",
        preload,
        "scripts/repository-review-inspect.mjs",
        fixture.root,
        i.directory,
        ...flagsFor(i.expected),
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let out = "",
      err = "",
      pid;
    const cleanup = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      if (pid)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already cleaned. */
        }
    };
    t.after(cleanup);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.once("message", (m) => {
      pid = m.pid;
      child.kill(name);
    });
    const code = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error("signal test deadline"));
      }, 10000);
      child.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once("close", (value) => {
        clearTimeout(deadline);
        resolve(value);
      });
    });
    assert.ok(pid);
    assert.equal(code, name === "SIGINT" ? 130 : 143);
    assert.equal(err, "");
    const r = JSON.parse(out);
    assert.equal(r.feedback, null);
    assert.equal(r.fault.code, "cancelled");
    assert.equal(r.exit_code, code);
    assert.ok(!out.includes("Private opinion"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}
