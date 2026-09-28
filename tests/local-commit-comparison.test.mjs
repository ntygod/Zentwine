import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import {
  createLocalRepositoryPort,
  LOCAL_REPOSITORY_LIMITS,
} from "../scripts/lib/local-repository.mjs";
import { buildTextHunks } from "../scripts/lib/local-commit-comparison.mjs";
import { repositoryCompareMain } from "../scripts/repository-compare.mjs";

const cli = path.resolve("scripts/repository-compare.mjs");
const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
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
      { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    )
    .trim();
}
async function fixture(t, algorithm = "sha1") {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zt-compare-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo");
  await fs.mkdir(root);
  git(
    root,
    "init",
    "--quiet",
    "--initial-branch=main",
    `--object-format=${algorithm}`,
  );
  const write = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  };
  const commit = () => {
    git(root, "add", ".");
    git(root, "commit", "--quiet", "--allow-empty", "-m", "synthetic fixture");
    return git(root, "rev-parse", "HEAD");
  };
  await write("file.txt", "first\nshared\nlast\n");
  await write("old.txt", "old\n");
  await write("unchanged.txt", "not disclosed\n");
  const base = commit();
  await write("file.txt", "second\nshared\nlast\n");
  await write("new.txt", "new\n");
  await fs.unlink(path.join(root, "old.txt"));
  const head = commit();
  return {
    root,
    parent,
    base,
    head,
    write,
    commit,
    port: createLocalRepositoryPort(root),
  };
}
function rejected(r, code) {
  assert.equal(r.status, "rejected");
  assert.equal(r.comparison, null);
  assert.equal(r.authorization, false);
  if (code) assert.equal(r.fault.code, code);
}
function compared(r) {
  assert.equal(r.status, "compared");
  assert.equal(r.authorization, false);
  assert.equal(r.fault, null);
  return r.comparison;
}
function intercept(t, handler) {
  const original = cp.spawn;
  t.mock.method(cp, "spawn", (...args) => handler(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}
const invoke = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [cli, ...args], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      err += b;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, out, err, report: JSON.parse(out) }),
    );
  });
const raw = (rows, side) =>
  rows
    .filter((r) => r.kind !== (side === "old" ? "insert" : "delete"))
    .map((r) => r.text + (r.newline ? "\n" : ""))
    .join("");

test("comparison factory, import and help do not read repositories or spawn", async (t) => {
  let calls = 0;
  intercept(t, () => {
    calls++;
    throw Error("no process expected");
  });
  const port = createLocalRepositoryPort("/not/read");
  assert.ok(Object.isFrozen(port));
  const help = await repositoryCompareMain(["--help"]);
  assert.equal(help.executed, false);
  assert.equal(help.exit_code, 0);
  assert.equal(calls, 0);
});
test("comparison binds two exact trees with metadata-only sorted changes", async (t) => {
  const f = await fixture(t);
  const c = compared(await f.port.compareCommits(f.base, f.head));
  assert.deepEqual(c.summary, {
    added: 1,
    deleted: 1,
    modified: 1,
    type_changed: 0,
    total: 3,
  });
  assert.deepEqual(
    c.entries.map((e) => [e.path, e.change]),
    [
      ["file.txt", "modified"],
      ["new.txt", "added"],
      ["old.txt", "deleted"],
    ],
  );
  assert.equal(c.base.commit_sha, f.base);
  assert.equal(c.head.commit_sha, f.head);
  assert.equal(c.base.tree_sha, git(f.root, "rev-parse", `${f.base}^{tree}`));
  assert.equal(c.head.tree_sha, git(f.root, "rev-parse", `${f.head}^{tree}`));
  assert.equal(c.selected, null);
  assert.equal(c.content_disclosed, false);
  assert.equal(c.index, "not_inspected");
  assert.equal(c.working_tree, "not_inspected");
  assert.ok(Object.isFrozen(c.entries[0].before));
  assert.ok(!JSON.stringify(c).includes("shared"));
});
test("comparison identical commits return an empty change set", async (t) => {
  const f = await fixture(t);
  const c = compared(await f.port.compareCommits(f.base, f.base));
  assert.equal(c.summary.total, 0);
  assert.deepEqual(c.entries, []);
});
test("comparison commits with identical trees need not have identical IDs", async (t) => {
  const f = await fixture(t);
  const next = f.commit();
  assert.notEqual(next, f.head);
  assert.equal(
    compared(await f.port.compareCommits(f.head, next)).summary.total,
    0,
  );
});
test("comparison reverse direction swaps additions deletions and blob identities", async (t) => {
  const f = await fixture(t);
  const forward = compared(await f.port.compareCommits(f.base, f.head));
  const reverse = compared(await f.port.compareCommits(f.head, f.base));
  assert.equal(reverse.entries[1].change, "deleted");
  assert.equal(reverse.entries[2].change, "added");
  assert.deepEqual(reverse.entries[0].before, forward.entries[0].after);
});
test("comparison divergent commits use direct trees not their merge base", async (t) => {
  const f = await fixture(t);
  git(f.root, "checkout", "--quiet", "-b", "side", f.base);
  await f.write("side.txt", "side\n");
  const side = f.commit();
  const c = compared(await f.port.compareCommits(f.head, side));
  assert.equal(c.semantics, "direct_trees_not_merge_base");
  assert.equal(c.entries.find((e) => e.path === "new.txt").change, "deleted");
  assert.equal(c.entries.find((e) => e.path === "old.txt").change, "added");
});
test("comparison ignores later HEAD index worktree and untracked content", async (t) => {
  const f = await fixture(t);
  await f.write("later.txt", "later\n");
  f.commit();
  await f.write("file.txt", "working tree must not appear");
  git(f.root, "add", "file.txt");
  await f.write("private-untracked.txt", "private");
  const c = compared(await f.port.readCommitDiff(f.base, f.head, "file.txt"));
  assert.equal(c.head.commit_sha, f.head);
  assert.ok(!JSON.stringify(c).includes("working tree must"));
  assert.ok(!JSON.stringify(c).includes("private-untracked"));
  assert.equal(c.summary.total, 3);
});
test("comparison does not require a current HEAD commit", async (t) => {
  const f = await fixture(t);
  git(f.root, "symbolic-ref", "HEAD", "refs/heads/unborn");
  assert.equal(
    compared(await f.port.compareCommits(f.base, f.head)).summary.total,
    3,
  );
});
test("comparison supports SHA256 exact IDs and verified text blobs", async (t) => {
  const f = await fixture(t, "sha256");
  const c = compared(await f.port.readCommitDiff(f.base, f.head, "file.txt"));
  assert.equal(c.object_format, "sha256");
  assert.equal(c.base.commit_sha.length, 64);
  assert.equal(c.selected.status, "text");
  assert.equal(c.selected.added_lines, 1);
});
test("comparison works in bare storage without an index", async (t) => {
  const f = await fixture(t);
  const bare = path.join(f.parent, "bare.git");
  git(f.root, "clone", "--quiet", "--bare", "--no-hardlinks", f.root, bare);
  const c = compared(
    await createLocalRepositoryPort(bare).readCommitDiff(
      f.base,
      f.head,
      "file.txt",
    ),
  );
  assert.equal(c.repository_kind, "bare");
  assert.equal(c.selected.status, "text");
});
test("comparison works in linked worktrees without checking out requested commits", async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.parent, "linked");
  git(f.root, "worktree", "add", "--quiet", "-b", "linked", linked, f.base);
  const c = compared(
    await createLocalRepositoryPort(linked).compareCommits(f.base, f.head),
  );
  assert.equal(c.head.commit_sha, f.head);
  assert.equal(git(linked, "rev-parse", "HEAD"), f.base);
});
test("comparison rename is explicit deletion and addition", async (t) => {
  const f = await fixture(t);
  git(f.root, "mv", "new.txt", "renamed.txt");
  const head = f.commit();
  const c = compared(await f.port.compareCommits(f.head, head));
  assert.equal(c.renames, "delete_add");
  assert.deepEqual(
    c.entries.map((e) => e.change),
    ["deleted", "added"],
  );
});
test("comparison executable-bit-only changes have zero text edits", async (t) => {
  const f = await fixture(t);
  await fs.chmod(path.join(f.root, "file.txt"), 0o755);
  const head = f.commit();
  const c = compared(await f.port.readCommitDiff(f.head, head, "file.txt"));
  assert.equal(c.entries[0].before.mode, "100644");
  assert.equal(c.entries[0].after.mode, "100755");
  assert.deepEqual(c.selected.hunks, []);
  assert.equal(c.selected.added_lines, 0);
});
test("comparison file-to-directory changes keep separate exact paths", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "new.txt"));
  await f.write("new.txt/child", "child");
  const c = compared(await f.port.compareCommits(f.head, f.commit()));
  assert.deepEqual(
    c.entries.map((e) => [e.path, e.change]),
    [
      ["new.txt", "deleted"],
      ["new.txt/child", "added"],
    ],
  );
});
test("comparison symlink changes are metadata-only and never follow target", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "file.txt"));
  await fs.symlink("/not/a/permitted/body", path.join(f.root, "file.txt"));
  const head = f.commit();
  const c = compared(await f.port.readCommitDiff(f.head, head, "file.txt"));
  assert.equal(c.entries[0].change, "type_changed");
  assert.equal(c.selected.reason, "non_regular_object");
  assert.equal(c.content_disclosed, false);
  assert.ok(!JSON.stringify(c).includes("/not/a/permitted"));
});
test("comparison gitlinks expose commit IDs without opening submodules", async (t) => {
  const f = await fixture(t);
  git(
    f.root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.base},module`,
  );
  git(f.root, "commit", "--quiet", "-m", "synthetic gitlink");
  const head = git(f.root, "rev-parse", "HEAD");
  const c = compared(await f.port.readCommitDiff(f.head, head, "module"));
  assert.equal(c.entries[0].after.kind, "gitlink");
  assert.equal(c.selected.reason, "non_regular_object");
});
test("comparison literal paths preserve Unicode newlines tabs and pathspec-looking text", async (t) => {
  const f = await fixture(t);
  const names = [
    "中文\n制表\t.txt",
    ":(glob)*",
    "--option",
    "__proto__",
    "back\\slash",
  ];
  for (const name of names)
    await f.write(name, `body for ${JSON.stringify(name)}\n`);
  const head = f.commit();
  for (const name of names) {
    const c = compared(await f.port.readCommitDiff(f.head, head, name));
    assert.equal(c.selected.path, name);
    assert.equal(c.selected.added_lines, 1);
  }
});
test("comparison default metadata never calls blob reads status diff or index commands", async (t) => {
  const f = await fixture(t);
  const seen = [];
  intercept(t, (original, command, args, options) => {
    seen.push(args);
    return original(command, args, options);
  });
  compared(await f.port.compareCommits(f.base, f.head));
  assert.ok(
    seen.every(
      (args) =>
        !["status", "diff", "diff-index", "ls-files", "blob"].some((v) =>
          args.includes(v),
        ),
    ),
  );
});
test("comparison selected text carries exact line numbers and newline flags", async (t) => {
  const f = await fixture(t);
  const c = compared(await f.port.readCommitDiff(f.base, f.head, "file.txt"));
  const h = c.selected.hunks[0];
  assert.equal(c.content_disclosed, true);
  assert.equal(h.old_start, 1);
  assert.equal(h.new_start, 1);
  assert.equal(raw(h.lines, "old"), "first\nshared\nlast\n");
  assert.equal(raw(h.lines, "new"), "second\nshared\nlast\n");
  assert.deepEqual(
    h.lines.map((r) => [r.old_line, r.new_line]),
    [
      [1, null],
      [null, 1],
      [2, 2],
      [3, 3],
    ],
  );
});
test("comparison selected addition and deletion reconstruct their full small sides", async (t) => {
  const f = await fixture(t);
  const added = compared(
    await f.port.readCommitDiff(f.base, f.head, "new.txt"),
  ).selected;
  const deleted = compared(
    await f.port.readCommitDiff(f.base, f.head, "old.txt"),
  ).selected;
  assert.equal(added.hunks[0].old_start, 0);
  assert.equal(added.hunks[0].old_lines, 0);
  assert.equal(deleted.hunks[0].new_start, 0);
  assert.equal(deleted.hunks[0].new_lines, 0);
  assert.equal(raw(added.hunks[0].lines, "new"), "new\n");
  assert.equal(raw(deleted.hunks[0].lines, "old"), "old\n");
});
test("comparison empty-file creation remains a change with zero hunks", async (t) => {
  const f = await fixture(t);
  await f.write("empty", "");
  const c = compared(await f.port.readCommitDiff(f.head, f.commit(), "empty"));
  assert.equal(c.summary.added, 1);
  assert.equal(c.entries[0].after.size_bytes, 0);
  assert.deepEqual(c.selected.hunks, []);
});
test("comparison preserves BOM CRLF whitespace and absent final newline", async (t) => {
  const f = await fixture(t);
  const a = "\ufeffold\r\nlast",
    b = "\ufeffold\nlast\n";
  await f.write("raw.txt", a);
  const base = f.commit();
  await f.write("raw.txt", b);
  const head = f.commit();
  const h = compared(await f.port.readCommitDiff(base, head, "raw.txt"))
    .selected.hunks[0];
  assert.equal(raw(h.lines, "old"), a);
  assert.equal(raw(h.lines, "new"), b);
  assert.ok(h.lines.some((line) => !line.newline));
});
test("comparison binary NUL and invalid UTF8 are not silently decoded as text", async (t) => {
  const f = await fixture(t);
  await f.write("nul.bin", Buffer.from([0, 65]));
  await f.write("bad.bin", Buffer.from([255]));
  const head = f.commit();
  for (const name of ["nul.bin", "bad.bin"]) {
    const c = compared(await f.port.readCommitDiff(f.head, head, name));
    assert.equal(c.selected.reason, "binary_or_non_utf8");
    assert.equal(c.content_disclosed, false);
    assert.equal(c.selected.hunks, undefined);
  }
});
test("comparison missing or unchanged selected path rejects rather than disclosing another file", async (t) => {
  const f = await fixture(t);
  for (const name of ["absent", "unchanged.txt"])
    rejected(
      await f.port.readCommitDiff(f.base, f.head, name),
      "path_not_changed",
    );
});
test("comparison invalid IDs and paths fail before starting Git", async (t) => {
  let calls = 0;
  intercept(t, () => {
    calls++;
    throw Error("must not start");
  });
  const port = createLocalRepositoryPort("/not/read");
  const sha = "a".repeat(40);
  for (const value of [
    "HEAD",
    "main",
    "abcd",
    "A".repeat(40),
    "--help",
    null,
    {},
    undefined,
  ])
    rejected(await port.compareCommits(value, sha), "invalid_arguments");
  for (const value of [
    "",
    "/abs",
    "../outside",
    "a/../b",
    "a//b",
    "nul\0path",
    undefined,
  ])
    rejected(await port.readCommitDiff(sha, sha, value), "invalid_arguments");
  assert.equal(calls, 0);
});
test("comparison blob tree and annotated-tag IDs are not commit IDs", async (t) => {
  const f = await fixture(t);
  git(f.root, "tag", "-a", "synthetic", "-m", "tag", f.head);
  for (const value of [
    git(f.root, "rev-parse", `${f.head}:file.txt`),
    git(f.root, "rev-parse", `${f.head}^{tree}`),
    git(f.root, "rev-parse", "synthetic"),
  ])
    rejected(await f.port.compareCommits(value, f.head), "not_commit_object");
});
test("comparison missing commit object is a failure not an empty change set", async (t) => {
  const f = await fixture(t);
  rejected(
    await f.port.compareCommits("0".repeat(40), f.head),
    "git_unavailable",
  );
});
test("comparison SHA length must match the repository object format", async (t) => {
  const f = await fixture(t);
  rejected(
    await f.port.compareCommits("a".repeat(64), f.head),
    "invalid_arguments",
  );
});
test("comparison rejects subdirectories and root symlinks", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "dir"));
  await fs.symlink(f.root, path.join(f.parent, "link"));
  for (const p of [path.join(f.root, "dir"), path.join(f.parent, "link")])
    rejected(
      await createLocalRepositoryPort(p).compareCommits(f.base, f.head),
      "invalid_repository_root",
    );
});
test("comparison inherited Git output and union entry limits are enforced", async (t) => {
  const f = await fixture(t);
  rejected(
    await createLocalRepositoryPort(f.root, {
      maxOutputBytes: 1,
    }).compareCommits(f.base, f.head),
    "output_limit",
  );
  // Each tree has three paths, but their union has four.
  rejected(
    await createLocalRepositoryPort(f.root, { maxEntries: 3 }).compareCommits(
      f.base,
      f.head,
    ),
    "entry_limit",
  );
});
test("comparison blob limit rejects content but does not block metadata-only use", async (t) => {
  const f = await fixture(t);
  const p = createLocalRepositoryPort(f.root, { maxBlobBytes: 1 });
  compared(await p.compareCommits(f.base, f.head));
  rejected(await p.readCommitDiff(f.base, f.head, "file.txt"), "blob_limit");
});
test("comparison combined line limit is enforced", async (t) => {
  const f = await fixture(t);
  rejected(
    await createLocalRepositoryPort(f.root, { maxDiffLines: 5 }).readCommitDiff(
      f.base,
      f.head,
      "file.txt",
    ),
    "diff_line_limit",
  );
});
test("comparison computation budget rejects expensive changed middles", async (t) => {
  const f = await fixture(t);
  rejected(
    await createLocalRepositoryPort(f.root, { maxDiffCells: 3 }).readCommitDiff(
      f.base,
      f.head,
      "file.txt",
    ),
    "diff_complexity_limit",
  );
});
test("comparison selected hunk JSON budget rejects without partial output", async (t) => {
  const f = await fixture(t);
  rejected(
    await createLocalRepositoryPort(f.root, {
      maxDiffBytes: 10,
    }).readCommitDiff(f.base, f.head, "file.txt"),
    "diff_output_limit",
  );
});
test("comparison new budgets cannot be raised disabled or supplied through accessors", () => {
  for (const key of ["maxDiffLines", "maxDiffCells", "maxDiffBytes"])
    for (const value of [
      0,
      -1,
      NaN,
      Infinity,
      LOCAL_REPOSITORY_LIMITS[key] + 1,
    ])
      assert.throws(() => createLocalRepositoryPort(".", { [key]: value }));
  let calls = 0;
  assert.throws(() =>
    createLocalRepositoryPort(".", {
      get maxDiffBytes() {
        calls++;
        return 1;
      },
    }),
  );
  assert.equal(calls, 0);
});
test("comparison pre-cancelled and malformed signals are rejected", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort("private reason");
  rejected(
    await f.port.compareCommits(f.base, f.head, controller.signal),
    "cancelled",
  );
  rejected(
    await f.port.compareCommits(f.base, f.head, {}),
    "invalid_arguments",
  );
});
test("comparison in-flight cancellation reaps the Git process and gives no partial report", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let child;
  intercept(t, (original, command, args, options) => {
    if (args.includes("ls-tree")) {
      child = original(command, args, options);
      controller.abort("private cancellation");
      return child;
    }
    return original(command, args, options);
  });
  const r = await f.port.compareCommits(f.base, f.head, controller.signal);
  rejected(r, "cancelled");
  assert.ok(child);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
  assert.ok(!JSON.stringify(r).includes("private cancellation"));
});
test("comparison deadline kills an unresponsive command instead of returning metadata", async (t) => {
  const f = await fixture(t);
  let child;
  intercept(t, (original, _command, _args, options) => {
    child = original(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      options,
    );
    return child;
  });
  rejected(
    await createLocalRepositoryPort(f.root, { timeoutMs: 80 }).compareCommits(
      f.base,
      f.head,
    ),
    "timeout",
  );
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});
test("comparison verifies selected blob digest and zeroes buffers after rejection", async (t) => {
  const f = await fixture(t);
  let retained;
  intercept(t, (original, command, args, options) => {
    if (args.includes("blob")) {
      const child = original(
        process.execPath,
        ["-e", "process.stdout.write('wrong\\nshared\\nlast\\n')"],
        options,
      );
      child.stdout.on("data", (chunk) => {
        retained = chunk;
      });
      return child;
    }
    return original(command, args, options);
  });
  rejected(
    await f.port.readCommitDiff(f.base, f.head, "file.txt"),
    "blob_integrity_mismatch",
  );
  assert.ok(retained);
  assert.ok(retained.every((v) => v === 0));
});
test("comparison rejects visible repository replacement after reading the fixed trees", async (t) => {
  const f = await fixture(t);
  let queries = 0;
  intercept(t, (original, command, args, options) => {
    if (args.includes("--absolute-git-dir") && ++queries === 2)
      return original(
        process.execPath,
        ["-e", "process.stdout.write('/different/repository\\n')"],
        options,
      );
    return original(command, args, options);
  });
  rejected(await f.port.compareCommits(f.base, f.head), "repository_changed");
});
test("comparison ignores replace refs and never runs hostile diff filter or monitor helpers", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.parent, "must-not-run");
  for (const key of [
    "diff.external",
    "diff.evil.textconv",
    "filter.evil.clean",
    "filter.evil.smudge",
    "core.fsmonitor",
  ])
    git(f.root, "config", key, `touch ${marker}`);
  await f.write(".gitattributes", "*.txt diff=evil filter=evil\n");
  // Avoid running configured filters while creating the fixture; only compare old commits.
  git(f.root, "replace", f.base, f.head);
  const c = compared(await f.port.readCommitDiff(f.base, f.head, "file.txt"));
  assert.equal(raw(c.selected.hunks[0].lines, "old"), "first\nshared\nlast\n");
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});
test("comparison leaves HEAD index and working bytes unchanged", async (t) => {
  const f = await fixture(t);
  const index = await fs.readFile(path.join(f.root, ".git/index"));
  const head = await fs.readFile(path.join(f.root, ".git/HEAD"));
  const body = await fs.readFile(path.join(f.root, "file.txt"));
  compared(await f.port.readCommitDiff(f.base, f.head, "file.txt"));
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index);
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/HEAD")), head);
  assert.deepEqual(await fs.readFile(path.join(f.root, "file.txt")), body);
});
test("comparison CLI defaults to metadata and only discloses explicitly selected text", async (t) => {
  const f = await fixture(t);
  const args = [f.root, "--base", f.base, "--head", f.head];
  const a = await invoke(args),
    b = await invoke([...args, "--path", "file.txt"]);
  assert.equal(a.code, 0);
  assert.equal(a.err, "");
  assert.equal(a.report.comparison.content_disclosed, false);
  assert.ok(!a.out.includes("shared"));
  assert.ok(b.out.includes("shared"));
  assert.equal(b.code, 0);
});
test("comparison CLI rejects duplicated flags arbitrary revisions and missing values", async () => {
  const sha = "a".repeat(40);
  for (const args of [
    [],
    ["."],
    [".", "--base", "HEAD", "--head", sha],
    [".", "--base", sha, "--head", sha, "--base", sha],
    [".", "--base", sha, "--head", sha, "--path"],
    [".", "--base", sha, "--head", sha, "--timeout-ms", "0"],
    [".", "--base", sha, "--head", sha, "--unknown", "v"],
  ])
    assert.equal((await repositoryCompareMain(args)).exit_code, 64);
});
test("comparison CLI maps timeout rejection and cancellation without body leakage", async (t) => {
  const f = await fixture(t);
  const args = [f.root, "--base", f.base, "--head", f.head];
  const c = new AbortController();
  c.abort("private");
  assert.equal((await repositoryCompareMain(args, c.signal)).exit_code, 130);
  assert.equal(
    (await repositoryCompareMain([...args, "--path", "missing"])).exit_code,
    2,
  );
  const timeout = await repositoryCompareMain([...args, "--timeout-ms", "1"]);
  assert.equal(timeout.exit_code, 124);
});

const fail = (code) => {
  throw new Error(code);
};
const pure = (a, b, options = {}, check = () => {}) =>
  buildTextHunks(a, b, { ...LOCAL_REPOSITORY_LIMITS, ...options }, check, fail);
const split = (value) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function verifyHunks(value, a, b) {
  const old = split(a),
    wanted = split(b);
  const rebuilt = [];
  let oldCursor = 0,
    newCursor = 0;
  for (const h of value.hunks) {
    const start = h.old_lines ? h.old_start - 1 : h.old_start;
    const target = h.new_lines ? h.new_start - 1 : h.new_start;
    assert.ok(start >= oldCursor);
    assert.equal(target - newCursor, start - oldCursor);
    rebuilt.push(...old.slice(oldCursor, start));
    assert.equal(
      raw(h.lines, "old"),
      old.slice(start, start + h.old_lines).join(""),
    );
    assert.equal(
      raw(h.lines, "new"),
      wanted.slice(target, target + h.new_lines).join(""),
    );
    let oldLine = start + 1,
      newLine = target + 1;
    for (const row of h.lines) {
      assert.equal(row.old_line, row.kind === "insert" ? null : oldLine++);
      assert.equal(row.new_line, row.kind === "delete" ? null : newLine++);
    }
    rebuilt.push(raw(h.lines, "new"));
    oldCursor = start + h.old_lines;
    newCursor = target + h.new_lines;
  }
  rebuilt.push(...old.slice(oldCursor));
  assert.equal(rebuilt.join(""), b);
}
test("text hunks preserve distant windows and exact gap offsets", async () => {
  const a = Array.from({ length: 40 }, (_, i) => `line-${i}\n`);
  const b = [...a];
  b[2] = "changed-a\n";
  b[30] = "changed-b\n";
  const r = await pure(a.join(""), b.join(""));
  assert.equal(r.hunks.length, 2);
  verifyHunks(r, a.join(""), b.join(""));
});
test("text hunks reconstruct deterministic repeated-line insertion deletion and newline cases", async () => {
  let seed = 918273;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = [
    "a\n",
    "a\n",
    "b\n",
    "\n",
    "中文\n",
    "\ufeffz\r\n",
    "<script>data</script>\n",
  ];
  for (let i = 0; i < 150; i++) {
    const make = () => {
      let s = Array.from(
        { length: next() % 25 },
        () => alphabet[next() % alphabet.length],
      ).join("");
      if (next() % 2) s = s.replace(/\n$/, "");
      return s;
    };
    const a = make(),
      b = make(),
      r = await pure(a, b);
    verifyHunks(r, a, b);
    assert.deepEqual(await pure(a, b), r);
  }
});
test("text hunks reject per-side line growth before matrix allocation", async () => {
  await assert.rejects(
    pure("a\n".repeat(5), "", { maxDiffLines: 4 }),
    /diff_line_limit/,
  );
});
test("text hunks strip common edges before spending the computation budget", async () => {
  const prefix = "same\n".repeat(100),
    suffix = "same-after\n".repeat(100);
  const a = `${prefix}old\n${suffix}`,
    b = `${prefix}new\n${suffix}`;
  const r = await pure(a, b, { maxDiffCells: 4 });
  verifyHunks(r, a, b);
  assert.equal(r.hunks[0].lines.length, 8);
});
test("text hunks observe cancellation while yielding inside the LCS loop", async () => {
  let cancelled = false;
  const timer = setImmediate(() => {
    cancelled = true;
  });
  try {
    await assert.rejects(
      pure("a\n".repeat(400), "b\n".repeat(400), {}, () => {
        if (cancelled) throw Error("cancelled");
      }),
      /cancelled/,
    );
  } finally {
    clearImmediate(timer);
  }
});
test("text hunks include JSON escaping in their output-byte budget", async () => {
  const a = "control\t\r\n",
    b = "replacement\t\r\n";
  const r = await pure(a, b);
  const bytes = Buffer.byteLength(JSON.stringify(r));
  await assert.rejects(
    pure(a, b, { maxDiffBytes: bytes - 1 }),
    /diff_output_limit/,
  );
  assert.deepEqual(await pure(a, b, { maxDiffBytes: bytes }), r);
});
test("comparison blob identities match Git's canonical object header hashing", async (t) => {
  const f = await fixture(t);
  const c = compared(await f.port.compareCommits(f.base, f.head));
  const bytes = Buffer.from("second\nshared\nlast\n");
  assert.equal(
    c.entries[0].after.object_id,
    createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
  );
});

test("comparison full object IDs cannot be redirected by hex-named branches", async (t) => {
  const f = await fixture(t);
  const tree = git(f.root, "rev-parse", `${f.base}^{tree}`);
  git(f.root, "update-ref", `refs/heads/${f.base}`, f.head);
  git(f.root, "update-ref", `refs/heads/${tree}`, f.head);
  const c = compared(await f.port.readCommitDiff(f.base, f.head, "file.txt"));
  assert.equal(c.base.tree_sha, tree);
  assert.equal(raw(c.selected.hunks[0].lines, "old"), "first\nshared\nlast\n");
});
test("comparison malformed tree metadata cannot be returned as a successful report", async (t) => {
  const f = await fixture(t);
  intercept(t, (original, command, args, options) =>
    args.includes("ls-tree")
      ? original(
          process.execPath,
          ["-e", "process.stdout.write('not-a-tree\\0')"],
          options,
        )
      : original(command, args, options),
  );
  rejected(await f.port.compareCommits(f.base, f.head), "invalid_git_output");
});
test("comparison final root identity failure discards already-generated text hunks", async (t) => {
  const f = await fixture(t);
  const original = fs.lstat;
  let calls = 0;
  t.mock.method(fs, "lstat", async (...args) => {
    const value = await original(...args);
    if (args[0] === f.root && ++calls === 2)
      return { ...value, isDirectory: () => true, ino: value.ino + 1n };
    return value;
  });
  rejected(
    await f.port.readCommitDiff(f.base, f.head, "file.txt"),
    "repository_changed",
  );
});
test("comparison CLI invalid selected path returns the argument-error exit code", async (t) => {
  const f = await fixture(t);
  const r = await repositoryCompareMain([
    f.root,
    "--base",
    f.base,
    "--head",
    f.head,
    "--path",
    "../outside",
  ]);
  assert.equal(r.exit_code, 64);
  assert.equal(r.comparison, null);
});
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`comparison CLI ${signal} clears output and reaps paused Git`, async (t) => {
    const f = await fixture(t);
    const preload = path.join(f.parent, "pause.mjs");
    await fs.writeFile(
      preload,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;cp.spawn=(command,args,options)=>{const child=original(command,args,options);if(args.includes('ls-tree')){process.kill(-child.pid,'SIGSTOP');process.send({pid:child.pid});}return child};syncBuiltinESMExports();`,
    );
    const child = cp.spawn(
      process.execPath,
      [
        "--import",
        preload,
        cli,
        f.root,
        "--base",
        f.base,
        "--head",
        f.head,
        "--path",
        "file.txt",
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let pid,
      output = "";
    child.stdout.on("data", (v) => {
      output += v;
    });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const ready = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(Error("CLI exited before pause")));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    t.after(() => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    });
    ({ pid } = await ready);
    child.kill(signal);
    assert.equal(await done, code);
    rejected(JSON.parse(output), "cancelled");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}
test("comparison borrowed blob buffers are zeroed after successful render and later failure", async () => {
  // Explicit synthetic host responses isolate ownership/cleanup, not a substitute for real Git tests.
  const { compareLocalCommits } = await import(
    "../scripts/lib/local-commit-comparison.mjs"
  );
  for (const corrupt of [false, true]) {
    const bytes = [Buffer.from("old\n"), Buffer.from("new\n")];
    const entry = (value) => ({
      path: "a",
      kind: "file",
      mode: "100644",
      size_bytes: value.length,
      object_id: createHash("sha1")
        .update(`blob ${value.length}\0`)
        .update(value)
        .digest("hex"),
    });
    const rows = bytes.map(entry);
    let treeRead = 0,
      blobRead = 0;
    if (corrupt) bytes[1][0] = 120;
    const call = compareLocalCommits({
      request: { base: "a".repeat(40), head: "b".repeat(40), path: "a" },
      algorithm: "sha1",
      bare: false,
      text: async (args) => ({
        value: args[0] === "cat-file" ? "commit" : "c".repeat(40),
      }),
      readTree: async () => [rows[treeRead++]],
      run: async () => ({ output: bytes[blobRead++] }),
      limits: LOCAL_REPOSITORY_LIMITS,
      check: () => {},
      fail,
    });
    if (corrupt) await assert.rejects(call, /blob_integrity_mismatch/);
    else assert.equal((await call).selected.status, "text");
    assert.ok(bytes.every((b) => b.every((v) => v === 0)));
  }
});
