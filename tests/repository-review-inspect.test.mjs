import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import {
  createRepositoryReviewSession as sessionFor,
  serializeRepositoryReviewNotes as serialize,
  previewRepositoryReviewMerge as preview,
  applyRepositoryReviewMerge as apply,
} from "../packages/client/dist/index.js";
import {
  inspectRepositoryReview as inspect,
  repositoryReviewInspectMain as main,
  repositoryReviewReportJson as json,
} from "../scripts/repository-review-inspect.mjs";
import { createCommitReviewFixture } from "./fixtures/commit-review-data.mjs";
import { interceptBeforeExec } from "./fixtures/gated-spawn.mjs";

// Synthetic code/opinions; real disposable Git objects, original CLI, and native input files.
const f = await createCommitReviewFixture();
test.after(() => f.cleanup());
const cli = path.resolve("scripts/repository-review-inspect.mjs");
const note = (id = "a", extra = {}) => ({
  id,
  path: "src/example.ts",
  kind: "issue",
  author: "Synthetic reviewer",
  body: `Opinion ${id}`,
  ...extra,
});
async function inputs(t, report = f.detail, notes = [note()]) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zt-feedback-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "feedback");
  await fs.mkdir(directory);
  const session = await sessionFor(report);
  const notesJson = serialize(session, notes);
  await fs.writeFile(path.join(directory, "comparison.json"), report);
  await fs.writeFile(path.join(directory, "review-notes.json"), notesJson);
  return { parent, directory, session, notesJson };
}
function accepted(r) {
  assert.equal(r.status, "inspected", JSON.stringify(r));
  assert.equal(r.exit_code, 0);
  assert.equal(r.authorization, false);
  assert.equal(r.code_execution, false);
  assert.equal(r.notes_trust, "unverified_claims");
  assert.equal(r.author_trust, "unverified");
  assert.equal(r.feedback.comparison_verification, "matches_local_git");
  assert.equal(r.feedback.comparison_content_disclosed, false);
  assert.ok(Object.isFrozen(r.feedback));
}
function refused(r, code) {
  assert.notEqual(r.exit_code, 0);
  assert.equal(r.feedback, null);
  assert.equal(r.authorization, false);
  if (code) assert.equal(r.fault.code, code, JSON.stringify(r));
  assert.ok(!JSON.stringify(r).includes("Opinion"));
}
function git(root, ...args) {
  return cp
    .execFileSync(
      "/usr/bin/git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@zentwine.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    )
    .trim();
}
function intercept(t, fn) {
  const original = cp.spawn;
  t.mock.method(cp, "spawn", (...args) =>
    interceptBeforeExec(original, fn, ...args),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}
async function invoke(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, out, err, report: out ? JSON.parse(out) : null }),
    );
  });
}

test("feedback: default verifies carried text but discloses only counts", async (t) => {
  const i = await inputs(t, f.detail, [
    note(),
    note("b", { kind: "question" }),
    note("c", { path: "added.txt", kind: "suggestion" }),
  ]);
  const r = await inspect(f.root, i.directory);
  accepted(r);
  assert.equal(
    r.feedback.binding.report_sha256,
    createHash("sha256").update(f.detail).digest("hex"),
  );
  assert.equal(
    r.feedback.notes_sha256,
    createHash("sha256").update(i.notesJson).digest("hex"),
  );
  assert.deepEqual(r.feedback.summary, { files_with_notes: 2, notes: 3 });
  assert.equal(
    r.feedback.files.find((x) => x.path === "src/example.ts").question,
    1,
  );
  assert.equal(r.feedback.selected, null);
  assert.equal(r.feedback.note_content_disclosed, false);
  assert.equal(r.feedback.coverage.carried_detail, "text_matched");
  for (const secret of [
    "Opinion",
    "Synthetic reviewer",
    "<img",
    "unsafeReview",
  ])
    assert.ok(!json(r).includes(secret));
});
test("feedback: exact selected path returns only its opinions and no diff", async (t) => {
  const i = await inputs(t, f.detail, [
    note(),
    note("b", { path: "added.txt", body: "Other secret" }),
  ]);
  const r = await inspect(f.root, i.directory, { path: "src/example.ts" });
  accepted(r);
  assert.deepEqual(r.feedback.selected.notes, [note()]);
  assert.equal(r.feedback.note_content_disclosed, true);
  assert.ok(Object.isFrozen(r.feedback.selected.notes[0]));
  assert.ok(!json(r).includes("Other secret"));
  assert.ok(!json(r).includes("unsafeReview"));
});
test("feedback: listing-only reports do not read blob bodies", async (t) => {
  const i = await inputs(t, f.listing);
  intercept(t, (original, command, args, options) => {
    assert.ok(!(args.includes("cat-file") && args.includes("blob")));
    return original(command, args, options);
  });
  const r = await inspect(f.root, i.directory, { path: "src/example.ts" });
  accepted(r);
  assert.equal(r.feedback.coverage.carried_detail, "not_present");
});
test("feedback: binary classification is recomputed without disclosing bytes", async (t) => {
  const i = await inputs(t, f.binary, [note("binary", { path: "binary.dat" })]);
  const r = await inspect(f.root, i.directory);
  accepted(r);
  assert.equal(
    r.feedback.coverage.carried_detail,
    "non_text_classification_matched",
  );
});
test("feedback: empty comparison with no opinions is a narrow success", async (t) => {
  const i = await inputs(t, f.empty, []),
    r = await inspect(f.root, i.directory);
  accepted(r);
  assert.deepEqual(r.feedback.files, []);
  assert.equal(r.feedback.summary.notes, 0);
});
test("feedback: changed path with no opinions is not an invalid selection", async (t) => {
  const i = await inputs(t),
    r = await inspect(f.root, i.directory, { path: "added.txt" });
  accepted(r);
  assert.deepEqual(r.feedback.selected.notes, []);
  assert.equal(r.feedback.note_content_disclosed, false);
});
test("feedback: unknown or unchanged selected path is rejected", async (t) => {
  const i = await inputs(t);
  refused(
    await inspect(f.root, i.directory, { path: "not-present" }),
    "path_not_in_report",
  );
});
test("feedback: explicit merged v1 opinions round trip through the new reader", async (t) => {
  const i = await inputs(t),
    a = note(),
    b = note("b", { kind: "suggestion" });
  const merged = apply(
    i.session,
    preview(i.session, [a], serialize(i.session, [b])),
    [a],
    [],
  );
  await fs.writeFile(
    path.join(i.directory, "review-notes.json"),
    serialize(i.session, merged),
  );
  const r = await inspect(f.root, i.directory, { path: a.path });
  accepted(r);
  assert.deepEqual(r.feedback.selected.notes, [a, b]);
});
for (const [name, report] of [
  ["reversed", () => f.compare("src/example.ts", f.head, f.base)],
  ["same commit", () => f.empty],
]) {
  test(`feedback: ${name} uses direct requested trees`, async (t) => {
    const i = await inputs(t, report(), name === "same commit" ? [] : [note()]);
    accepted(await inspect(f.root, i.directory));
  });
}
test("feedback: SHA256 repository is supported end to end", async (t) => {
  const other = await createCommitReviewFixture("sha256");
  t.after(() => other.cleanup());
  const i = await inputs(t, other.detail),
    r = await inspect(other.root, i.directory);
  accepted(r);
  assert.equal(r.feedback.binding.object_format, "sha256");
});
test("feedback: same objects in a bare clone match regardless of report origin kind", async (t) => {
  const i = await inputs(t),
    bare = path.join(i.parent, "bare.git");
  git(i.parent, "clone", "--bare", "--no-hardlinks", f.root, bare);
  accepted(await inspect(bare, i.directory));
});
test("feedback: different current HEAD and dirty worktree are never substituted", async (t) => {
  const other = await createCommitReviewFixture();
  t.after(() => other.cleanup());
  const i = await inputs(t, other.detail);
  git(other.root, "checkout", "--detach", other.base);
  await fs.writeFile(
    path.join(other.root, "src/example.ts"),
    "Uncommitted secret",
  );
  const before = await fs.readFile(path.join(other.root, ".git/index"));
  const r = await inspect(other.root, i.directory);
  accepted(r);
  assert.equal(r.feedback.coverage.current_head, "not_inspected");
  assert.deepEqual(
    await fs.readFile(path.join(other.root, ".git/index")),
    before,
  );
  assert.equal(
    await fs.readFile(path.join(other.root, "src/example.ts"), "utf8"),
    "Uncommitted secret",
  );
});
for (const [name, mutate] of [
  [
    "text",
    (c) => {
      c.selected.hunks[0].lines.find((l) => l.kind === "insert").text =
        "forged text";
    },
  ],
  [
    "tree",
    (c) => {
      c.base.tree_sha = "a".repeat(40);
    },
  ],
  [
    "object",
    (c) => {
      c.entries.find((e) => e.path === "added.txt").after.object_id =
        "b".repeat(40);
    },
  ],
  [
    "size",
    (c) => {
      c.entries.find((e) => e.path === "added.txt").after.size_bytes++;
    },
  ],
  [
    "omitted entry",
    (c) => {
      c.entries = c.entries.filter((e) => e.path !== "added.txt");
      c.summary.added--;
      c.summary.total--;
    },
  ],
]) {
  test(`feedback: internally valid forged ${name} with rebound opinions still fails local comparison`, async (t) => {
    const raw = JSON.parse(f.detail);
    mutate(raw.comparison);
    const i = await inputs(t, JSON.stringify(raw)); // Existing parser accepts the self-consistent forgery.
    refused(await inspect(f.root, i.directory), "local_comparison_mismatch");
  });
}
test("feedback: unavailable commit object does not yield a partial verified list", async (t) => {
  const raw = JSON.parse(f.detail);
  raw.comparison.base.commit_sha = "c".repeat(40);
  const i = await inputs(t, JSON.stringify(raw));
  refused(await inspect(f.root, i.directory), "local_comparison_unavailable");
});
test("feedback: report whitespace change breaks original note binding", async (t) => {
  const i = await inputs(t);
  await fs.appendFile(path.join(i.directory, "comparison.json"), " ");
  refused(await inspect(f.root, i.directory), "invalid_review_notes");
});
for (const [name, transform, filename, code] of [
  [
    "duplicate report key",
    (s) => s.replace("{", '{"report_version":"1.0.0",'),
    "comparison.json",
    "invalid_comparison_report",
  ],
  [
    "unknown report field",
    (s) => JSON.stringify({ ...JSON.parse(s), command: "do not execute" }),
    "comparison.json",
    "invalid_comparison_report",
  ],
  [
    "duplicate note key",
    (s) => s.replace("{", '{"authorization":false,'),
    "review-notes.json",
    "invalid_review_notes",
  ],
  [
    "forged note path",
    (s) => {
      const n = JSON.parse(s);
      n.notes[0].path = "../outside";
      return JSON.stringify(n);
    },
    "review-notes.json",
    "invalid_review_notes",
  ],
  [
    "wrong note hash",
    (s) => {
      const n = JSON.parse(s);
      n.binding.report_sha256 = "0".repeat(64);
      return JSON.stringify(n);
    },
    "review-notes.json",
    "invalid_review_notes",
  ],
]) {
  test(`feedback: rejects ${name}`, async (t) => {
    const i = await inputs(t);
    const p = path.join(i.directory, filename);
    await fs.writeFile(p, transform(await fs.readFile(p, "utf8")));
    refused(await inspect(f.root, i.directory), code);
  });
}
for (const filename of ["comparison.json", "review-notes.json"]) {
  test(`feedback: missing ${filename} fails closed`, async (t) => {
    const i = await inputs(t);
    await fs.unlink(path.join(i.directory, filename));
    refused(await inspect(f.root, i.directory));
  });
  test(`feedback: ${filename} size limit is enforced before reading`, async (t) => {
    const i = await inputs(t);
    await fs.writeFile(
      path.join(i.directory, filename),
      Buffer.alloc(filename === "comparison.json" ? 4194305 : 524289, 32),
    );
    refused(await inspect(f.root, i.directory), "input_size_limit");
  });
}
for (const kind of ["symlink", "hardlink", "directory", "fifo"]) {
  test(`feedback: rejects ${kind} input without following or blocking`, async (t) => {
    const i = await inputs(t),
      p = path.join(i.directory, "review-notes.json"),
      saved = path.join(i.parent, "saved");
    await fs.rename(p, saved);
    if (kind === "symlink") await fs.symlink(saved, p);
    if (kind === "hardlink") await fs.link(saved, p);
    if (kind === "directory") await fs.mkdir(p);
    if (kind === "fifo") cp.execFileSync("/usr/bin/mkfifo", [p]);
    refused(await inspect(f.root, i.directory), "invalid_input_file");
  });
}
test("feedback: selected root symlink is refused", async (t) => {
  const i = await inputs(t),
    alias = path.join(i.parent, "alias");
  await fs.symlink(i.directory, alias);
  refused(await inspect(f.root, alias), "invalid_input_directory");
});
test("feedback: invalid UTF8 never uses replacement characters", async (t) => {
  const i = await inputs(t);
  await fs.writeFile(
    path.join(i.directory, "review-notes.json"),
    Buffer.from([0xff]),
  );
  refused(await inspect(f.root, i.directory), "invalid_input_encoding");
});
test("feedback: changed input during actual Git calls invalidates all output", async (t) => {
  const i = await inputs(t);
  let changed = false;
  intercept(t, (original, command, args, options) => {
    if (!changed) {
      changed = true;
      syncFs.appendFileSync(path.join(i.directory, "review-notes.json"), " ");
    }
    return original(command, args, options);
  });
  refused(await inspect(f.root, i.directory), "input_changed");
  assert.ok(changed);
});
test("feedback: directory replacement during Git keeps descriptor scope but rejects final result", async (t) => {
  const i = await inputs(t);
  let changed = false;
  intercept(t, (original, command, args, options) => {
    if (!changed) {
      changed = true;
      syncFs.renameSync(i.directory, i.directory + "-old");
      syncFs.mkdirSync(i.directory);
    }
    return original(command, args, options);
  });
  refused(await inspect(f.root, i.directory), "input_directory_changed");
});
test("feedback: partial native reads are accumulated and owned buffers/descriptors cleaned", async (t) => {
  const i = await inputs(t),
    original = fs.open,
    handles = [],
    buffers = [];
  t.mock.method(fs, "open", async (...args) => {
    const h = await original(...args);
    handles.push(h);
    if (String(args[0]).includes("/proc/self/fd/")) {
      const read = h.read.bind(h);
      h.read = async (b, offset, length, position) => {
        buffers.push(b);
        return read(b, offset, Math.min(97, length), position);
      };
    }
    return h;
  });
  accepted(await inspect(f.root, i.directory));
  assert.ok(buffers.length > 3);
  assert.ok(buffers.every((b) => b.every((v) => v === 0)));
  for (const h of handles) await assert.rejects(h.stat());
});
test("feedback: cleanup is retained after malformed input", async (t) => {
  const i = await inputs(t),
    original = fs.open,
    handles = [];
  await fs.writeFile(path.join(i.directory, "comparison.json"), "invalid");
  t.mock.method(fs, "open", async (...args) => {
    const h = await original(...args);
    handles.push(h);
    return h;
  });
  refused(await inspect(f.root, i.directory), "invalid_comparison_report");
  for (const h of handles) await assert.rejects(h.stat());
});
test("feedback: close errors cannot publish success", async (t) => {
  const i = await inputs(t),
    original = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const h = await original(...args),
      close = h.close.bind(h);
    if (String(args[0]).endsWith("/review-notes.json"))
      h.close = async () => {
        await close();
        throw new Error("private close detail");
      };
    return h;
  });
  const r = await inspect(f.root, i.directory);
  refused(r, "cleanup_failed");
  assert.equal(r.exit_code, 3);
});
test("feedback: precancellation performs no reads/spawns and hides reason", async (t) => {
  const i = await inputs(t),
    c = new AbortController();
  c.abort("secret reason");
  t.mock.method(fs, "lstat", () => {
    throw new Error("must not read");
  });
  const r = await inspect(f.root, i.directory, { signal: c.signal });
  refused(r, "cancelled");
  assert.equal(r.exit_code, 130);
  assert.ok(!json(r).includes("secret"));
});
test("feedback: cancellation during pending digest ignores late success", async (t) => {
  const i = await inputs(t),
    c = new AbortController();
  let complete;
  t.mock.method(globalThis.crypto.subtle, "digest", () => {
    c.abort();
    return new Promise((resolve) => (complete = resolve));
  });
  const r = await inspect(f.root, i.directory, { signal: c.signal });
  refused(r, "cancelled");
  complete(new ArrayBuffer(32));
  await Promise.resolve();
  assert.equal(r.feedback, null);
});
test("feedback: total deadline includes a pending native digest", async (t) => {
  const i = await inputs(t);
  let complete;
  t.mock.method(
    globalThis.crypto.subtle,
    "digest",
    () => new Promise((resolve) => (complete = resolve)),
  );
  const r = await inspect(f.root, i.directory, { timeoutMs: 100 });
  refused(r, "timeout");
  assert.equal(r.exit_code, 124);
  if (complete) complete(new ArrayBuffer(32));
});
for (const opts of [
  { timeoutMs: 0 },
  { timeoutMs: 30001 },
  { timeoutMs: "1" },
  { path: "../x" },
  { path: "" },
  { signal: {} },
  { extra: 1 },
]) {
  test(`feedback: invalid option ${JSON.stringify(opts)} rejects before I/O`, async () => {
    assert.equal((await inspect("unused", "unused", opts)).exit_code, 64);
  });
}
test("feedback: options getter is not executed", async () => {
  let read = false;
  const options = {
    get path() {
      read = true;
      return "x";
    },
  };
  assert.equal((await inspect("unused", "unused", options)).exit_code, 64);
  assert.equal(read, false);
});
test("feedback: CLI defaults to metadata and explicitly expands one path", async (t) => {
  const i = await inputs(t),
    list = await invoke([f.root, i.directory]);
  assert.equal(list.code, 0);
  assert.equal(list.err, "");
  assert.ok(!list.out.includes("Opinion"));
  const detail = await invoke([
    f.root,
    i.directory,
    "--path",
    "src/example.ts",
  ]);
  assert.equal(detail.code, 0);
  assert.deepEqual(detail.report.feedback.selected.notes, [note()]);
});
test("feedback: display controls are escaped losslessly at the terminal JSON boundary", async (t) => {
  const n = note("a", {
    author: "name\u202e",
    body: "opinion\x1b[2J\u200b\u2028\ufeff",
  });
  const i = await inputs(t, f.detail, [n]),
    r = await invoke([f.root, i.directory, "--path", n.path]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.report.feedback.selected.notes, [n]);
  assert.ok(!/[\x1b\u202e\u200b\u2028\ufeff]/u.test(r.out));
  assert.ok(r.out.includes("\\u202e"));
});
test("feedback: help and invalid CLI arguments never read inputs", async () => {
  assert.equal((await main(["--help"])).status, "help");
  for (const args of [
    [],
    ["x"],
    ["x", "y", "--path"],
    ["x", "y", "--path", "a", "--path", "b"],
    ["x", "y", "--timeout-ms", "1e3"],
    ["x", "y", "--exec", "x"],
  ])
    assert.equal((await main(args)).exit_code, 64);
});
for (const name of ["SIGINT", "SIGTERM"]) {
  test(`feedback: CLI ${name} cleans held owned Git process and returns no feedback`, async (t) => {
    const i = await inputs(t),
      preload = path.join(i.parent, "hold.mjs");
    const gate = pathToFileURL(
      path.resolve("tests/fixtures/gated-spawn.mjs"),
    ).href;
    await fs.writeFile(
      preload,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {interceptBeforeExec} from ${JSON.stringify(gate)};const original=cp.spawn;let once=false;cp.spawn=(...input)=>interceptBeforeExec(original,(run,c,a,o)=>{const p=run(c,a,o);if(!once){once=true;process.kill(-p.pid,'SIGSTOP');process.send({pid:p.pid});}return p;},...input);syncBuiltinESMExports();`,
    );
    const child = cp.spawn(
      process.execPath,
      ["--import", preload, cli, f.root, i.directory],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let out = "",
      err = "",
      pid;
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.once("message", (m) => {
      pid = m.pid;
      child.kill(name);
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, name === "SIGINT" ? 130 : 143, err);
    assert.equal(err, "");
    refused(JSON.parse(out), "cancelled");
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}
test("feedback: missing client build produces a structured unavailable result", async (t) => {
  const i = await inputs(t),
    scripts = path.join(i.parent, "copy/scripts");
  await fs.mkdir(scripts, { recursive: true });
  await fs.copyFile(cli, path.join(scripts, "repository-review-inspect.mjs"));
  await fs.cp(path.resolve("scripts/lib"), path.join(scripts, "lib"), {
    recursive: true,
  });
  const result = cp.spawnSync(
    process.execPath,
    [path.join(scripts, "repository-review-inspect.mjs"), f.root, i.directory],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  refused(JSON.parse(result.stdout), "build_required");
});

test("feedback: special path is an exact JSON value, not a pathspec or command", async (t) => {
  const other = await createCommitReviewFixture();
  t.after(() => other.cleanup());
  const special = ":(glob)*\n中文\u202e.txt";
  await fs.writeFile(path.join(other.root, special), "synthetic content\n");
  git(other.root, "add", ".");
  git(other.root, "commit", "-qm", "special path");
  const head = git(other.root, "rev-parse", "HEAD");
  const report = other.compare(special, other.head, head);
  const n = note("special", { path: special });
  const i = await inputs(t, report, [n]);
  const r = await invoke([other.root, i.directory, "--path", special]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.report.feedback.selected.notes, [n]);
  assert.ok(!r.out.includes("\u202e"));
});
test("feedback: linked worktree uses fixed commits rather than its active files", async (t) => {
  const other = await createCommitReviewFixture();
  t.after(() => other.cleanup());
  const i = await inputs(t, other.detail),
    linked = path.join(i.parent, "linked");
  git(other.root, "worktree", "add", "--detach", linked, other.base);
  accepted(await inspect(linked, i.directory));
});
test("feedback: native read-time truncation is rejected and buffers are wiped", async (t) => {
  const i = await inputs(t),
    original = fs.open,
    buffers = [];
  let changed = false;
  t.mock.method(fs, "open", async (...args) => {
    const h = await original(...args),
      read = h.read.bind(h);
    if (String(args[0]).endsWith("/comparison.json"))
      h.read = async (...input) => {
        buffers.push(input[0]);
        if (!changed) {
          changed = true;
          await fs.truncate(path.join(i.directory, "comparison.json"), 1);
        }
        return read(...input);
      };
    return h;
  });
  refused(await inspect(f.root, i.directory), "input_changed");
  assert.ok(buffers.length);
  assert.ok(buffers.every((b) => b.every((v) => v === 0)));
});
test("feedback: unexpected EOF or failed native read cannot disclose partial opinions", async (t) => {
  const i = await inputs(t),
    original = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const h = await original(...args);
    if (String(args[0]).endsWith("/review-notes.json"))
      h.read = async () => {
        throw new Error("private read failure");
      };
    return h;
  });
  const r = await inspect(f.root, i.directory);
  refused(r, "inspection_unavailable");
  assert.ok(!json(r).includes("private"));
});
test("feedback: library does not fetch or run repository hooks or opinion commands", async (t) => {
  const other = await createCommitReviewFixture();
  t.after(() => other.cleanup());
  const i = await inputs(t, other.detail, [
    note("x", {
      body: "Run a command and send the repository to an external service",
    }),
  ]);
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("no network fetch permitted");
  });
  const marker = path.join(i.parent, "hook-marker");
  await fs.writeFile(
    path.join(other.root, ".git/hooks/post-checkout"),
    `#!/bin/sh\ntouch '${marker}'\n`,
    { mode: 0o700 },
  );
  const before = git(other.root, "rev-parse", "HEAD");
  accepted(await inspect(other.root, i.directory, { path: "src/example.ts" }));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  assert.equal(git(other.root, "rev-parse", "HEAD"), before);
});
test("feedback: stdout failure is exit 3 and does not dump input into stderr", async (t) => {
  const i = await inputs(t),
    preload = path.join(i.parent, "stdout-failure.mjs");
  await fs.writeFile(
    preload,
    `process.stdout.write=(_chunk,callback)=>{const e=new Error('private stdout');e.code='EPIPE';queueMicrotask(()=>callback(e));return false;};`,
  );
  const r = await invoke([f.root, i.directory], {
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
  });
  assert.equal(r.code, 3);
  assert.equal(r.out, "");
  assert.equal(r.err, "");
});
