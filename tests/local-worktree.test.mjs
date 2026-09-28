import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createLocalRepositoryPort } from "../scripts/lib/local-repository.mjs";
import { repositoryWorktreeInspectMain } from "../scripts/repository-worktree-inspect.mjs";

const cli = path.resolve("scripts/repository-worktree-inspect.mjs");
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
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    .trim();
}
async function fixture(t, format = "sha1") {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zt-worktree-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo");
  await fs.mkdir(root);
  git(
    root,
    "init",
    "--quiet",
    "--initial-branch=main",
    `--object-format=${format}`,
  );
  await fs.writeFile(path.join(root, "a.txt"), "original\n");
  await fs.writeFile(path.join(root, "b.bin"), Buffer.from([0, 255, 128, 1]));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "baseline");
  return {
    root,
    parent,
    head: git(root, "rev-parse", "HEAD"),
    port: createLocalRepositoryPort(root),
  };
}
const row = (r, name) => r.working_tree.entries.find((v) => v.path === name);
function accepted(r) {
  assert.equal(r.status, "inspected", JSON.stringify(r));
  assert.equal(r.scope, "local_git_worktree_observation");
  assert.equal(r.authorization, false);
  assert.equal(r.working_tree.atomic, false);
}
function rejected(r, code) {
  assert.equal(r.status, "rejected");
  assert.equal(r.snapshot, null);
  assert.equal(r.working_tree, null);
  if (code) assert.equal(r.fault.code, code);
}
function intercept(t, fn) {
  const original = cp.spawn;
  t.mock.method(cp, "spawn", (...args) => fn(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}
async function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (v) => (out += v));
    child.stderr.on("data", (v) => (err += v));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, out, err, report: JSON.parse(out) }),
    );
  });
}

test("worktree explicit mode preserves old committed-only inspection", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "a.txt"), "unstaged");
  assert.equal((await f.port.inspect()).working_tree, "not_inspected");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(r.snapshot.index_state, "matches_head");
  assert.equal(row(r, "a.txt").worktree.state, "modified");
  assert.equal(r.working_tree.assessment, "changes_observed");
});
test("worktree unchanged raw files report narrow observation not a clean lease", async (t) => {
  const f = await fixture(t),
    r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(r.working_tree.assessment, "no_changes_observed");
  assert.equal(r.working_tree.coverage, "complete_for_reported_scope");
  assert.equal(r.working_tree.canonicalization, false);
  assert.ok(Object.isFrozen(row(r, "a.txt").worktree));
  assert.equal(r.working_tree.summary.bytes_read, 13);
  assert.ok(!Object.hasOwn(r.working_tree, "clean"));
});
test("worktree SHA256 compares binary content using correct Git algorithm", async (t) => {
  const f = await fixture(t, "sha256"),
    r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(r.snapshot.object_format, "sha256");
  assert.equal(row(r, "b.bin").worktree.state, "matches_index");
});
test("worktree staged plus unstaged edits have separate comparisons", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "a.txt"), "index-version");
  git(f.root, "add", "a.txt");
  await fs.writeFile(path.join(f.root, "a.txt"), "worktree-version");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").index_change, "modified");
  assert.equal(row(r, "a.txt").worktree.state, "modified");
});
test("worktree staged-only addition matches index but is not no-changes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "new"), "new");
  git(f.root, "add", "new");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "new").index_change, "added");
  assert.equal(row(r, "new").worktree.state, "matches_index");
  assert.equal(r.working_tree.summary.index_changes, 1);
});
test("worktree missing tracked file is an unstaged deletion", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "a.txt"));
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").index_change, "none");
  assert.equal(row(r, "a.txt").worktree.state, "deleted");
});
test("worktree index deletion retained on disk appears as untracked metadata", async (t) => {
  const f = await fixture(t);
  git(f.root, "rm", "--cached", "a.txt");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").index_change, "deleted");
  assert.equal(row(r, "a.txt").worktree.reason, "not_in_index");
  assert.ok(r.working_tree.untracked.some((v) => v.path === "a.txt"));
});
test("worktree unresolved merge exposes stages without reading conflict content", async (t) => {
  const f = await fixture(t);
  git(f.root, "checkout", "--quiet", "-b", "other");
  await fs.writeFile(path.join(f.root, "a.txt"), "other\n");
  git(f.root, "commit", "--quiet", "-am", "other");
  git(f.root, "checkout", "--quiet", "main");
  await fs.writeFile(path.join(f.root, "a.txt"), "main\n");
  git(f.root, "commit", "--quiet", "-am", "main");
  assert.throws(() => git(f.root, "merge", "--no-edit", "other"));
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  assert.equal(r.working_tree.assessment, "conflicted");
  assert.deepEqual(
    row(r, "a.txt").index_stages.map((v) => v.stage),
    [1, 2, 3],
  );
  assert.equal(row(r, "a.txt").worktree.reason, "unmerged_index");
  assert.equal(r.working_tree.summary.bytes_read, 4);
});
test("worktree rename is explicit deletion and addition without content similarity guess", async (t) => {
  const f = await fixture(t);
  git(f.root, "mv", "a.txt", "renamed");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").index_change, "deleted");
  assert.equal(row(r, "renamed").index_change, "added");
});
test("worktree executable-mode drift is detected even with core.filemode false", async (t) => {
  const f = await fixture(t);
  git(f.root, "config", "core.filemode", "false");
  await fs.chmod(path.join(f.root, "a.txt"), 0o755);
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").worktree.state, "modified");
});
test("worktree assume-unchanged cannot conceal a raw content edit", async (t) => {
  const f = await fixture(t);
  git(f.root, "update-index", "--assume-unchanged", "a.txt");
  await fs.writeFile(path.join(f.root, "a.txt"), "changed");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").assume_unchanged, true);
  assert.equal(row(r, "a.txt").worktree.state, "modified");
});
test("worktree skip-worktree file absence is incomplete not a deletion", async (t) => {
  const f = await fixture(t);
  git(f.root, "update-index", "--skip-worktree", "a.txt");
  await fs.unlink(path.join(f.root, "a.txt"));
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").worktree.reason, "skip_worktree");
  assert.equal(r.working_tree.assessment, "incomplete");
});
test("worktree actual sparse-index directories do not become false HEAD deletions", async (t) => {
  const f = await fixture(t);
  for (const name of ["keep", "omit"]) {
    await fs.mkdir(path.join(f.root, name));
    await fs.writeFile(path.join(f.root, name, "file"), name);
  }
  git(f.root, "add", ".");
  git(f.root, "commit", "--quiet", "-m", "directories");
  git(f.root, "sparse-checkout", "init", "--cone", "--sparse-index");
  git(f.root, "sparse-checkout", "set", "keep");
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  assert.equal(r.working_tree.summary.index_changes, 0);
  assert.equal(r.working_tree.assessment, "incomplete");
  assert.equal(row(r, "omit").index_change, "not_compared");
  assert.equal(row(r, "omit/file"), undefined);
});
test("worktree intent-to-add entry does not qualify as no changes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "intent"), "");
  git(f.root, "add", "-N", "intent");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "intent").index_change, "added");
  assert.equal(r.working_tree.assessment, "changes_observed");
});
test("worktree tracked symlink compares link bytes and never reads target body", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.parent, "outside");
  await fs.writeFile(target, "outside-private-body");
  await fs.symlink(target, path.join(f.root, "link"));
  git(f.root, "add", "link");
  git(f.root, "commit", "--quiet", "-m", "link");
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  assert.equal(row(r, "link").worktree.state, "matches_index");
  assert.ok(!JSON.stringify(r).includes(target));
  assert.ok(!JSON.stringify(r).includes("outside-private-body"));
});
test("worktree replaced regular leaf symlink is a type change not followed", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "a.txt"));
  await fs.symlink("/dev/zero", path.join(f.root, "a.txt"));
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").worktree.state, "type_changed");
  assert.equal(r.working_tree.summary.bytes_read, 4);
});
test("worktree symlink parent never redirects tracked content outside root", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "dir"));
  await fs.writeFile(path.join(f.root, "dir", "file"), "baseline");
  git(f.root, "add", ".");
  git(f.root, "commit", "--quiet", "-m", "directory");
  await fs.rename(path.join(f.root, "dir"), path.join(f.parent, "elsewhere"));
  await fs.symlink(path.join(f.parent, "elsewhere"), path.join(f.root, "dir"));
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  assert.equal(row(r, "dir/file").worktree.state, "type_changed");
  assert.equal(r.working_tree.summary.bytes_read, 13);
});
test("worktree special FIFO leaf is reported without blocking or reading", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "a.txt"));
  cp.execFileSync("/usr/bin/mkfifo", [path.join(f.root, "a.txt")]);
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").worktree.state, "type_changed");
});
test("worktree gitlink does not recursively inspect a nested working directory", async (t) => {
  const f = await fixture(t);
  git(
    f.root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.head},module`,
  );
  git(f.root, "commit", "--quiet", "-m", "gitlink");
  await fs.mkdir(path.join(f.root, "module"));
  await fs.writeFile(path.join(f.root, "module", "secret"), "not inspected");
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  assert.equal(row(r, "module").worktree.reason, "submodule");
  assert.equal(r.working_tree.assessment, "incomplete");
  assert.ok(!JSON.stringify(r).includes("secret"));
});
test("worktree ignore rules omit generated content and collapse untracked directories", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".gitignore"), "ignored/\n");
  git(f.root, "add", ".gitignore");
  git(f.root, "commit", "--quiet", "-m", "ignore");
  await fs.mkdir(path.join(f.root, "ignored"));
  await fs.mkdir(path.join(f.root, "untracked"));
  await fs.writeFile(path.join(f.root, "ignored", "secret"), "ignored body");
  await fs.writeFile(
    path.join(f.root, "untracked", "secret"),
    "untracked body",
  );
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  assert.deepEqual(r.working_tree.untracked, [
    { path: "untracked/", kind: "directory" },
  ]);
  assert.ok(!JSON.stringify(r).includes("secret"));
});
test("worktree untracked special filenames survive NUL parsing exactly", async (t) => {
  const f = await fixture(t);
  const names = [
    "中文",
    "new\nline",
    "tab\tfile",
    "-option",
    "colon:name",
    "\uFEFFbom",
  ];
  for (const name of names)
    await fs.writeFile(path.join(f.root, name), "not read");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.deepEqual(
    r.working_tree.untracked.map((v) => v.path).sort(),
    names.sort(),
  );
});
test("worktree tracked special filenames compare without revision or shell interpolation", async (t) => {
  const f = await fixture(t);
  const names = [
    "中文",
    "new\nline",
    "tab\tfile",
    "-option",
    "colon:name",
    "back\\slash",
  ];
  for (const name of names) await fs.writeFile(path.join(f.root, name), name);
  git(f.root, "add", ".");
  git(f.root, "commit", "--quiet", "-m", "names");
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  for (const name of names)
    assert.equal(row(r, name).worktree.state, "matches_index");
});
test("worktree filters hooks external diff and fsmonitor are not executed", async (t) => {
  const f = await fixture(t),
    marker = path.join(f.parent, "executed");
  await fs.writeFile(
    path.join(f.root, ".gitattributes"),
    "*.txt filter=fixture diff=fixture\n",
  );
  git(f.root, "add", ".gitattributes");
  git(f.root, "commit", "--quiet", "-m", "attributes");
  const program = `touch '${marker}'`;
  for (const key of [
    "filter.fixture.clean",
    "filter.fixture.smudge",
    "filter.fixture.process",
    "diff.fixture.command",
    "diff.fixture.textconv",
    "core.fsmonitor",
  ])
    git(f.root, "config", key, program);
  await fs.writeFile(
    path.join(f.root, ".git", "hooks", "post-index-change"),
    `#!/bin/sh\n${program}\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(f.root, "a.txt"), "changed");
  const r = await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD"));
  accepted(r);
  assert.equal(row(r, "a.txt").worktree.state, "modified");
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});
test("worktree CRLF is a raw difference without invoking Git normalization", async (t) => {
  const f = await fixture(t);
  git(f.root, "config", "core.autocrlf", "true");
  await fs.writeFile(path.join(f.root, "a.txt"), "original\r\n");
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").worktree.state, "modified");
  assert.equal(r.working_tree.canonicalization, false);
});
test("worktree reading does not rewrite index config HEAD or reflog", async (t) => {
  const f = await fixture(t);
  const files = ["index", "config", "HEAD", "logs/HEAD"];
  const before = await Promise.all(
    files.map((n) => fs.readFile(path.join(f.root, ".git", n))),
  );
  accepted(await f.port.inspectWorktree(f.head));
  assert.deepEqual(
    await Promise.all(
      files.map((n) => fs.readFile(path.join(f.root, ".git", n))),
    ),
    before,
  );
});
test("worktree stale or missing expected commit cannot acquire content", async (t) => {
  const f = await fixture(t);
  rejected(await f.port.inspectWorktree("0".repeat(40)), "stale_baseline");
  for (const value of [undefined, null, "HEAD", f.head.slice(0, 7), {}, true])
    rejected(await f.port.inspectWorktree(value), "invalid_arguments");
});
test("worktree bare repository is explicitly not applicable", async (t) => {
  const f = await fixture(t),
    bare = path.join(f.parent, "bare");
  git(f.root, "clone", "--quiet", "--bare", f.root, bare);
  rejected(
    await createLocalRepositoryPort(bare).inspectWorktree(f.head),
    "worktree_not_applicable",
  );
});
test("worktree linked worktree uses its own index and physical files", async (t) => {
  const f = await fixture(t),
    linked = path.join(f.parent, "linked");
  git(f.root, "worktree", "add", "--quiet", "-b", "linked", linked);
  await fs.writeFile(path.join(linked, "a.txt"), "linked edit");
  const r = await createLocalRepositoryPort(linked).inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").worktree.state, "modified");
  assert.equal(
    (await f.port.inspectWorktree(f.head)).working_tree.assessment,
    "no_changes_observed",
  );
});
test("worktree per-file byte budget rejects without partial report", async (t) => {
  const f = await fixture(t);
  rejected(
    await createLocalRepositoryPort(f.root, {
      maxBlobBytes: 8,
    }).inspectWorktree(f.head),
    "worktree_file_limit",
  );
});
test("worktree aggregate byte budget rejects across otherwise small files", async (t) => {
  const f = await fixture(t);
  rejected(
    await createLocalRepositoryPort(f.root, {
      maxWorktreeBytes: 12,
    }).inspectWorktree(f.head),
    "worktree_byte_limit",
  );
});
test("worktree combined entry budget includes untracked metadata", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "untracked"), "");
  rejected(
    await createLocalRepositoryPort(f.root, { maxEntries: 2 }).inspectWorktree(
      f.head,
    ),
    "entry_limit",
  );
});
test("worktree pre-cancellation spawns no child and redacts reason", async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  abort.abort("private cancellation");
  let calls = 0;
  intercept(t, () => {
    calls++;
    throw Error();
  });
  const r = await f.port.inspectWorktree(f.head, abort.signal);
  rejected(r, "cancelled");
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(r).includes("private cancellation"));
});
test("worktree cancellation reaps a stopped real ls-files child before reporting", async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  let pid;
  intercept(t, (original, command, args, options) => {
    const child = original(command, args, options);
    if (args.includes("ls-files")) {
      pid = child.pid;
      process.kill(-pid, "SIGSTOP");
      setTimeout(() => abort.abort(), 10);
    }
    return child;
  });
  rejected(await f.port.inspectWorktree(f.head, abort.signal), "cancelled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("worktree index mutation after byte comparison rejects whole observation", async (t) => {
  const f = await fixture(t);
  let seen = 0;
  intercept(t, (original, command, args, options) => {
    if (args.includes("--stage") && ++seen === 2)
      git(f.root, "update-index", "--assume-unchanged", "a.txt");
    return original(command, args, options);
  });
  rejected(await f.port.inspectWorktree(f.head), "index_changed");
});
test("worktree file mutation after byte comparison is detected by final stat", async (t) => {
  const f = await fixture(t);
  let seen = 0;
  intercept(t, (original, command, args, options) => {
    if (args.includes("--stage") && ++seen === 2)
      cp.execFileSync("/usr/bin/touch", [path.join(f.root, "a.txt")]);
    return original(command, args, options);
  });
  rejected(await f.port.inspectWorktree(f.head), "worktree_changed");
});
test("worktree untracked addition during observation rejects stale enumeration", async (t) => {
  const f = await fixture(t);
  let seen = 0;
  intercept(t, (original, command, args, options) => {
    if (args.includes("--others") && ++seen === 2)
      cp.execFileSync("/usr/bin/touch", [path.join(f.root, "new")]);
    return original(command, args, options);
  });
  rejected(await f.port.inspectWorktree(f.head), "worktree_changed");
});
test("worktree malformed index metadata refuses unsafe paths", async (t) => {
  const f = await fixture(t);
  intercept(t, (original, command, args, options) =>
    args.includes("--stage")
      ? original(
          process.execPath,
          [
            "-e",
            `process.stdout.write('H 100644 ${"1".repeat(40)} 0\\t../outside\\0')`,
          ],
          options,
        )
      : original(command, args, options),
  );
  rejected(await f.port.inspectWorktree(f.head), "unsafe_worktree_path");
});
test("worktree CLI is metadata-only and explicit about observed changes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "a.txt"), "private-worktree-body");
  const r = await invoke([f.root, "--expected-commit", f.head]);
  assert.equal(r.code, 0);
  accepted(r.report);
  assert.equal(r.report.working_tree.assessment, "changes_observed");
  assert.equal(r.err, "");
  assert.equal(r.out.trim().split("\n").length, 1);
  assert.ok(!r.out.includes("private-worktree-body"));
  assert.ok(!r.out.includes(f.root));
});
test("worktree CLI help performs no I/O and invalid invocations fail", async (t) => {
  const f = await fixture(t);
  const help = await repositoryWorktreeInspectMain(["--help"]);
  assert.equal(help.executed, false);
  assert.equal(help.status, "help");
  for (const args of [
    [],
    [f.root],
    [f.root, "--expected-commit", "HEAD"],
    [f.root, "--expected-commit", f.head, "--file", "a.txt"],
    [f.root, "--expected-commit", f.head, "--timeout-ms", "30001"],
    [f.root, "--expected-commit", f.head, "--expected-commit", f.head],
  ])
    assert.equal((await repositoryWorktreeInspectMain(args)).exit_code, 64);
});

test("worktree time budget terminates a stopped child and reaps it", async (t) => {
  const f = await fixture(t);
  let pid;
  intercept(t, (original, command, args, options) => {
    const child = original(command, args, options);
    if (args.includes("--stage")) {
      pid = child.pid;
      process.kill(-pid, "SIGSTOP");
    }
    return child;
  });
  rejected(
    await createLocalRepositoryPort(f.root, { timeoutMs: 500 }).inspectWorktree(
      f.head,
    ),
    "timeout",
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("worktree EOF and duplicate stage violations are rejected", async (t) => {
  const f = await fixture(t);
  let payload = "unterminated";
  intercept(t, (original, command, args, options) =>
    args.includes("--stage")
      ? original(
          process.execPath,
          ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
          options,
        )
      : original(command, args, options),
  );
  rejected(await f.port.inspectWorktree(f.head), "invalid_git_output");
  payload = `H 100644 ${"1".repeat(40)} 0\ta.txt\0`.repeat(2);
  rejected(await f.port.inspectWorktree(f.head), "invalid_git_output");
});
test("worktree invalid UTF8 untracked path is refused rather than lossy decoded", async (t) => {
  const f = await fixture(t);
  intercept(t, (original, command, args, options) =>
    args.includes("--others")
      ? original(
          process.execPath,
          ["-e", "process.stdout.write(Buffer.from([255,0]))"],
          options,
        )
      : original(command, args, options),
  );
  rejected(await f.port.inspectWorktree(f.head), "invalid_git_output");
});
test("worktree index cannot direct the reader into Git administrative paths", async (t) => {
  const f = await fixture(t);
  intercept(t, (original, command, args, options) =>
    args.includes("--stage")
      ? original(
          process.execPath,
          [
            "-e",
            `process.stdout.write('H 100644 ${"1".repeat(40)} 0\\t.git/config\\0')`,
          ],
          options,
        )
      : original(command, args, options),
  );
  rejected(await f.port.inspectWorktree(f.head), "unsafe_worktree_path");
});
test("worktree raw buffers are wiped and all native file handles close", async (t) => {
  const f = await fixture(t),
    original = fs.open,
    buffers = [],
    handles = [];
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    handles.push(handle);
    const read = handle.read.bind(handle);
    handle.read = async (...values) => {
      buffers.push(values[0]);
      return read(...values);
    };
    return handle;
  });
  accepted(await f.port.inspectWorktree(f.head));
  assert.ok(buffers.length >= 2);
  for (const b of buffers) assert.ok(b.every((value) => value === 0));
  for (const h of handles) assert.equal(h.fd, -1);
});
test("worktree cancellation during file read wipes buffers and closes handles", async (t) => {
  const f = await fixture(t),
    original = fs.open,
    buffers = [],
    handles = [],
    abort = new AbortController();
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    handles.push(handle);
    const read = handle.read.bind(handle);
    handle.read = async (...values) => {
      buffers.push(values[0]);
      const result = await read(...values);
      abort.abort("private reason");
      return result;
    };
    return handle;
  });
  rejected(await f.port.inspectWorktree(f.head, abort.signal), "cancelled");
  assert.ok(buffers.length);
  for (const b of buffers) assert.ok(b.every((value) => value === 0));
  for (const h of handles) assert.equal(h.fd, -1);
});
test("worktree parent directory replacement after read is rejected", async (t) => {
  const f = await fixture(t);
  let seen = 0;
  await fs.mkdir(path.join(f.root, "dir"));
  await fs.writeFile(path.join(f.root, "dir", "file"), "body");
  git(f.root, "add", ".");
  git(f.root, "commit", "--quiet", "-m", "directory");
  intercept(t, (original, command, args, options) => {
    if (args.includes("--stage") && ++seen === 2) {
      cp.execFileSync("/usr/bin/mv", [
        path.join(f.root, "dir"),
        path.join(f.parent, "old"),
      ]);
      cp.execFileSync("/usr/bin/cp", [
        "-r",
        path.join(f.parent, "old"),
        path.join(f.root, "dir"),
      ]);
    }
    return original(command, args, options);
  });
  rejected(
    await f.port.inspectWorktree(git(f.root, "rev-parse", "HEAD")),
    "worktree_changed",
  );
});
test("worktree HEAD drift after sampling cannot return a completed observation", async (t) => {
  const f = await fixture(t);
  let seen = 0;
  git(f.root, "commit", "--quiet", "--allow-empty", "-m", "new");
  const next = git(f.root, "rev-parse", "HEAD");
  git(f.root, "update-ref", "HEAD", f.head);
  intercept(t, (original, command, args, options) => {
    if (args.includes("--others") && ++seen === 2)
      git(f.root, "update-ref", "HEAD", next);
    return original(command, args, options);
  });
  rejected(await f.port.inspectWorktree(f.head), "stale_baseline");
});
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`worktree CLI ${signal} clears observation and reaps its child`, async (t) => {
    const f = await fixture(t),
      preload = path.join(f.parent, "pause.mjs");
    await fs.writeFile(
      preload,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;cp.spawn=(command,args,options)=>{const child=original(command,args,options);if(args.includes('ls-files')){process.kill(-child.pid,'SIGSTOP');process.send({pid:child.pid});}return child};syncBuiltinESMExports();`,
    );
    const child = cp.spawn(
      process.execPath,
      ["--import", preload, cli, f.root, "--expected-commit", f.head],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let pid,
      output = "";
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    });
    child.stdout.on("data", (v) => (output += v));
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const ready = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("CLI exited before pause")));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    t.after(() => clearTimeout(timer));
    ({ pid } = await ready);
    child.kill(signal);
    assert.equal(await done, code);
    rejected(JSON.parse(output), "cancelled");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("worktree Git index summary is sampled inside the verified index projection", async (t) => {
  const f = await fixture(t);
  let observed = false;
  await fs.writeFile(path.join(f.root, "a.txt"), "new-index-content");
  intercept(t, (original, command, args, options) => {
    if (args.includes("--stage") && !observed) {
      observed = true;
      git(f.root, "add", "a.txt");
    }
    return original(command, args, options);
  });
  const r = await f.port.inspectWorktree(f.head);
  accepted(r);
  assert.equal(row(r, "a.txt").index_change, "modified");
  assert.equal(row(r, "a.txt").worktree.state, "matches_index");
  assert.equal(r.snapshot.index_state, "differs_from_head");
  assert.equal(r.snapshot.index_state, r.working_tree.index_state);
});
