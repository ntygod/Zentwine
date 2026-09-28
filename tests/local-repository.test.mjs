import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { createLocalRepositoryPort, LOCAL_REPOSITORY_LIMITS } from "../scripts/lib/local-repository.mjs";
import { repositoryInspectMain } from "../scripts/repository-inspect.mjs";

const cli = path.resolve("scripts/repository-inspect.mjs");
function git(root, ...args) {
  return cp.execFileSync("/usr/bin/git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@zentwine.invalid", "-c", "commit.gpgsign=false", ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
async function fixture(t, algorithm = "sha1") {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zt-repository-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo"); await fs.mkdir(root);
  git(root, "init", "--quiet", "--initial-branch=main", `--object-format=${algorithm}`);
  const content = Buffer.from([0, 255, 10, 65, 128]);
  await fs.writeFile(path.join(root, "input.bin"), content);
  await fs.writeFile(path.join(root, "readme.txt"), "committed body not CLI output\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "baseline");
  return { root, parent, content, head: git(root, "rev-parse", "HEAD"), port: createLocalRepositoryPort(root) };
}
const fault = (r, code) => {
  assert.equal(r.status, "rejected"); assert.equal(r.snapshot, null); assert.equal(r.authorization, false);
  if (code) assert.equal(r.fault.code, code);
};
const intercept = (t, handler) => {
  const original = cp.spawn;
  t.mock.method(cp, "spawn", (...args) => handler(original, ...args)); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
};
const invoke = (args, options = {}) => new Promise((resolve, reject) => {
  const child = cp.spawn(process.execPath, [cli, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, out, err, report: JSON.parse(out) }));
});

test("repository factory and CLI help do not spawn or inspect", async (t) => {
  let calls = 0; intercept(t, () => { calls++; throw Error("must not start"); });
  const port = createLocalRepositoryPort("/not/opened"); assert.ok(Object.isFrozen(port));
  const help = await repositoryInspectMain(["--help"]); assert.equal(help.executed, false);
  assert.equal(help.status, "help"); assert.equal(calls, 0);
});
test("repository inspection binds actual HEAD tree and index metadata", async t => {
  const f = await fixture(t); const r = await f.port.inspect(); assert.equal(r.status, "inspected");
  assert.equal(r.snapshot.commit_sha, f.head); assert.equal(r.snapshot.tree_sha, git(f.root, "rev-parse", "HEAD^{tree}"));
  assert.equal(r.snapshot.head.ref, "refs/heads/main"); assert.equal(r.snapshot.object_format, "sha1");
  assert.equal(r.snapshot.index_state, "matches_head"); assert.equal(r.working_tree, "not_inspected");
  assert.equal(r.snapshot.entries.length, 2); assert.ok(Object.isFrozen(r.snapshot.entries[0]));
});
test("repository index divergence is not a clean-worktree assertion", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, "new.txt"), "staged"); git(f.root, "add", "new.txt");
  await fs.writeFile(path.join(f.root, "readme.txt"), "unstaged");
  const r = await f.port.inspect(); assert.equal(r.snapshot.index_state, "differs_from_head");
  assert.equal(r.working_tree, "not_inspected"); assert.equal(r.snapshot.entries.length, 2);
});
test("repository unstaged and untracked files never enter committed listing", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, "secret-untracked"), "local only");
  await fs.writeFile(path.join(f.root, "readme.txt"), "changed");
  const r = await f.port.inspect(); assert.equal(r.snapshot.index_state, "matches_head");
  assert.equal(r.working_tree, "not_inspected"); assert.ok(!JSON.stringify(r).includes("secret-untracked"));
});
test("repository returns exact committed binary not mutable worktree bytes", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, "input.bin"), "replacement");
  const r = await f.port.readFile(f.head, "input.bin"); assert.deepEqual(r.bytes, f.content);
  assert.equal(r.report.snapshot.selected_file.sha256, createHash("sha256").update(f.content).digest("hex"));
  assert.equal(r.report.authorization, false); r.bytes.fill(0);
});
test("repository supports SHA256 Git object IDs and independently verifies blob", async t => {
  const f = await fixture(t, "sha256"); const r = await f.port.readFile(f.head, "input.bin");
  assert.equal(r.report.status, "inspected"); assert.equal(r.report.snapshot.object_format, "sha256");
  assert.equal(f.head.length, 64); assert.deepEqual(r.bytes, f.content);
});
test("repository detached HEAD is distinct from an attached branch", async t => {
  const f = await fixture(t); git(f.root, "checkout", "--detach", "--quiet");
  const r = await f.port.inspect(); assert.deepEqual(r.snapshot.head, { kind: "detached", ref: null });
});
test("repository linked worktree resolves its own HEAD without altering index", async t => {
  const f = await fixture(t); const other = path.join(f.parent, "linked");
  git(f.root, "worktree", "add", "--quiet", "-b", "other", other);
  const r = await createLocalRepositoryPort(other).inspect();
  assert.equal(r.status, "inspected"); assert.equal(r.snapshot.head.ref, "refs/heads/other");
  assert.equal(r.snapshot.commit_sha, f.head);
});
test("repository bare storage is readable with index marked not applicable", async t => {
  const f = await fixture(t); const bare = path.join(f.parent, "bare.git");
  git(f.root, "clone", "--quiet", "--bare", "--no-hardlinks", f.root, bare);
  const r = await createLocalRepositoryPort(bare).readFile(f.head, "input.bin");
  assert.equal(r.report.snapshot.repository_kind, "bare"); assert.equal(r.report.snapshot.index_state, "not_applicable");
  assert.deepEqual(r.bytes, f.content);
});
test("repository exact root refuses accidental discovery from a subdirectory", async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, "sub"));
  fault(await createLocalRepositoryPort(path.join(f.root, "sub")).inspect(), "invalid_repository_root");
});
test("repository symlink root including trailing separator is rejected", async t => {
  const f = await fixture(t); const link = path.join(f.parent, "link"); await fs.symlink(f.root, link);
  fault(await createLocalRepositoryPort(link + "/").inspect(), "invalid_repository_root");
});
test("repository non-Git and missing directories return redacted rejection", async t => {
  const f = await fixture(t);
  for (const name of [f.parent, path.join(f.parent, "missing-private-path")]) {
    const r = await createLocalRepositoryPort(name).inspect(); fault(r); assert.ok(!JSON.stringify(r).includes(f.parent));
  }
});
test("repository unborn branch is not mistaken for an empty committed tree", async t => {
  const f = await fixture(t); git(f.root, "symbolic-ref", "HEAD", "refs/heads/unborn");
  fault(await f.port.inspect(), "no_head_commit");
});
test("repository actual empty commit tree has an empty complete listing", async t => {
  const f = await fixture(t); git(f.root, "rm", "--quiet", "input.bin", "readme.txt"); git(f.root, "commit", "--quiet", "-m", "empty");
  const r = await f.port.inspect(); assert.equal(r.status, "inspected"); assert.deepEqual(r.snapshot.entries, []);
});
test("repository NUL listing preserves Unicode tabs newlines and option-like names", async t => {
  const f = await fixture(t); const names = ["中文文件.txt", "line\nname.txt", "tab\tname.txt", "-option.txt", "colon:name.txt", "[literal].txt"];
  for (const name of names) await fs.writeFile(path.join(f.root, name), name);
  git(f.root, "add", "."); git(f.root, "commit", "--quiet", "-m", "names"); const head = git(f.root, "rev-parse", "HEAD");
  for (const name of names) {
    const r = await f.port.readFile(head, name); assert.equal(r.report.status, "inspected"); assert.equal(r.bytes.toString(), name);
  }
});
test("repository labels symlink and gitlink but refuses reading them as files", async t => {
  const f = await fixture(t); await fs.symlink("readme.txt", path.join(f.root, "link")); git(f.root, "add", "link");
  git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.head},module`); git(f.root, "commit", "--quiet", "-m", "special");
  const head = git(f.root, "rev-parse", "HEAD"), r = await f.port.inspect();
  assert.equal(r.snapshot.entries.find(e => e.path === "module").kind, "gitlink");
  assert.equal(r.snapshot.entries.find(e => e.path === "link").kind, "symlink");
  for (const name of ["link", "module"]) { const v = await f.port.readFile(head, name); fault(v.report, "not_regular_blob"); assert.equal(v.bytes, null); }
});
test("repository staged gitlink change is not ignored by index comparison", async t => {
  const f = await fixture(t); git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.head},module`);
  assert.equal((await f.port.inspect()).snapshot.index_state, "differs_from_head");
});
test("repository executable regular blob preserves mode without executing", async t => {
  const f = await fixture(t); await fs.chmod(path.join(f.root, "readme.txt"), 0o755); git(f.root, "add", "readme.txt"); git(f.root, "commit", "--quiet", "-m", "mode");
  const r = await f.port.readFile(git(f.root, "rev-parse", "HEAD"), "readme.txt"); assert.equal(r.report.snapshot.selected_file.mode, "100755");
});
test("repository stale expected commit rejects before any blob delivery", async t => {
  const f = await fixture(t); const r = await f.port.readFile("0".repeat(40), "input.bin"); fault(r.report, "stale_baseline"); assert.equal(r.bytes, null);
});
test("repository missing path has no fallback to untracked or other object", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, "not-tracked"), "private");
  const r = await f.port.readFile(f.head, "not-tracked"); fault(r.report, "file_not_in_baseline"); assert.equal(r.bytes, null);
});
test("repository file arguments reject traversal absolute paths and symbolic commits", async t => {
  const f = await fixture(t);
  for (const name of ["../input.bin", "/input.bin", "a//b", "a/./b", "", "input.bin\0", "a/../b"]) fault((await f.port.readFile(f.head, name)).report, "invalid_arguments");
  for (const ref of ["HEAD", "--help", "a".repeat(39), "b".repeat(65)]) fault((await f.port.readFile(ref, "input.bin")).report, "invalid_arguments");
});
test("repository entry budget accepts exact boundary and never truncates success", async t => {
  const f = await fixture(t); assert.equal((await createLocalRepositoryPort(f.root, { maxEntries: 2 }).inspect()).status, "inspected");
  fault(await createLocalRepositoryPort(f.root, { maxEntries: 1 }).inspect(), "entry_limit");
});
test("repository raw output budget fails closed instead of partial listing", async t => {
  const f = await fixture(t); fault(await createLocalRepositoryPort(f.root, { maxOutputBytes: 1 }).inspect(), "output_limit");
});
test("repository blob budget accepts exact bytes and rejects one less", async t => {
  const f = await fixture(t); const okay = await createLocalRepositoryPort(f.root, { maxBlobBytes: 5 }).readFile(f.head, "input.bin");
  assert.deepEqual(okay.bytes, f.content); const bad = await createLocalRepositoryPort(f.root, { maxBlobBytes: 4 }).readFile(f.head, "input.bin"); fault(bad.report, "blob_limit"); assert.equal(bad.bytes, null);
});
test("repository budget objects reject unknown inherited accessor and inflated values", () => {
  for (const options of [{ maxEntries: 10001 }, { timeoutMs: 0 }, { timeoutMs: NaN }, { toString: 1 }, Object.create(null), { [Symbol("x")]: 1 }]) assert.throws(() => createLocalRepositoryPort(".", options), /invalid_arguments/);
  let reads = 0; const options = { get maxEntries() { reads++; return 2; } };
  assert.throws(() => createLocalRepositoryPort(".", options)); assert.equal(reads, 0); assert.ok(Object.isFrozen(LOCAL_REPOSITORY_LIMITS));
});
test("repository snapshots caller budget values at construction", async t => {
  const f = await fixture(t); const options = { maxEntries: 1 }; const port = createLocalRepositoryPort(f.root, options); options.maxEntries = 10000;
  fault(await port.inspect(), "entry_limit");
});
test("repository ignores inherited GIT directory object and config injection", async t => {
  const f = await fixture(t); const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  process.env.GIT_DIR = "/missing"; process.env.GIT_OBJECT_DIRECTORY = "/missing"; process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.bare"; process.env.GIT_CONFIG_VALUE_0 = "true";
  const r = await f.port.inspect(); assert.equal(r.status, "inspected"); assert.equal(r.snapshot.commit_sha, f.head);
});
test("repository never runs configured fsmonitor clean textconv or diff commands", async t => {
  const f = await fixture(t); const marker = path.join(f.parent, "executed"); const command = `touch '${marker}'`;
  git(f.root, "config", "core.fsmonitor", command); git(f.root, "config", "filter.hostile.clean", command);
  git(f.root, "config", "filter.hostile.process", command); git(f.root, "config", "diff.hostile.textconv", command); git(f.root, "config", "diff.external", command);
  await fs.writeFile(path.join(f.root, ".gitattributes"), "* filter=hostile diff=hostile\n"); await fs.writeFile(path.join(f.root, "input.bin"), "dirty");
  const r = await f.port.readFile(f.head, "input.bin"); assert.equal(r.report.status, "inspected"); assert.deepEqual(r.bytes, f.content);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});
test("repository replace refs do not substitute the committed blob", async t => {
  const f = await fixture(t); const original = git(f.root, "rev-parse", "HEAD:input.bin");
  const alternate = git(f.root, "rev-parse", "HEAD:readme.txt"); git(f.root, "replace", original, alternate);
  const r = await f.port.readFile(f.head, "input.bin"); assert.deepEqual(r.bytes, f.content);
});
test("repository reading preserves actual index config and HEAD bytes", async t => {
  const f = await fixture(t); const names = ["index", "config", "HEAD", "logs/HEAD"];
  const before = await Promise.all(names.map(n => fs.readFile(path.join(f.root, ".git", n))));
  await f.port.inspect(); await f.port.readFile(f.head, "input.bin");
  const after = await Promise.all(names.map(n => fs.readFile(path.join(f.root, ".git", n)))); assert.deepEqual(after, before);
});
test("repository corrupt blob refuses a snapshot and partial content", async t => {
  const f = await fixture(t); const blob = git(f.root, "rev-parse", "HEAD:input.bin");
  await fs.writeFile(path.join(f.root, ".git", "objects", blob.slice(0, 2), blob.slice(2)), "corrupt");
  const r = await f.port.readFile(f.head, "input.bin"); fault(r.report); assert.equal(r.bytes, null);
});
test("repository pre-aborted inspection acquires no Git process", async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort("private reason");
  let calls = 0; intercept(t, () => { calls++; throw Error(); });
  const r = await f.port.inspect(controller.signal); fault(r, "cancelled"); assert.equal(calls, 0); assert.ok(!JSON.stringify(r).includes("private reason"));
});
test("repository cancels a real stopped Git child and reaps it before returning", async t => {
  const f = await fixture(t); const controller = new AbortController(); let pid;
  intercept(t, (original, ...args) => { const child = original(...args); pid = child.pid; process.kill(-pid, "SIGSTOP"); setTimeout(() => controller.abort(), 20); return child; });
  fault(await f.port.inspect(controller.signal), "cancelled"); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("repository deadline kills a real stopped Git child and returns timeout", async t => {
  const f = await fixture(t); let pid;
  intercept(t, (original, ...args) => { const child = original(...args); pid = child.pid; process.kill(-pid, "SIGSTOP"); return child; });
  fault(await createLocalRepositoryPort(f.root, { timeoutMs: 100 }).inspect(), "timeout"); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("repository HEAD moving during blob acquisition discards read bytes", async t => {
  const f = await fixture(t); git(f.root, "commit", "--quiet", "--allow-empty", "-m", "second"); const second = git(f.root, "rev-parse", "HEAD"); git(f.root, "reset", "--quiet", "--hard", f.head);
  intercept(t, (original, command, args, options) => { if (args.includes("cat-file")) git(f.root, "update-ref", "HEAD", second); return original(command, args, options); });
  const r = await f.port.readFile(f.head, "input.bin"); fault(r.report, "stale_baseline"); assert.equal(r.bytes, null);
});
test("repository branch switching at the same commit is a stale baseline", async t => {
  const f = await fixture(t); git(f.root, "branch", "other"); let count = 0;
  intercept(t, (original, command, args, options) => { if (args.includes("symbolic-ref") && ++count === 2) git(f.root, "symbolic-ref", "HEAD", "refs/heads/other"); return original(command, args, options); });
  fault(await f.port.inspect(), "stale_baseline");
});
test("repository CLI returns one JSON line of metadata without body or remote URL", async t => {
  const f = await fixture(t); git(f.root, "remote", "add", "origin", "ssh://fixture@example.invalid/code");
  const r = await invoke([f.root, "--file", "readme.txt", "--expected-commit", f.head]);
  assert.equal(r.code, 0); assert.equal(r.report.status, "inspected"); assert.equal(r.out.trim().split("\n").length, 1); assert.equal(r.err, "");
  for (const hidden of ["committed body", f.root, "placeholder", "example.invalid"]) assert.ok(!r.out.includes(hidden));
});
test("repository CLI stale missing and argument failures are not success", async t => {
  const f = await fixture(t); assert.equal((await invoke([f.root, "--file", "input.bin", "--expected-commit", "0".repeat(40)])).code, 2);
  for (const args of [[], [f.root, "--file", "x"], [f.root, "--timeout-ms", "1e2"], [f.root, "--timeout-ms", "30001"], [f.root, "--other", "x"], [f.root, "--timeout-ms", "5", "--timeout-ms", "6"]]) assert.equal((await repositoryInspectMain(args)).exit_code, 64);
});
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`repository real CLI ${signal} emits cancellation after Git cleanup`, async t => {
    const f = await fixture(t); const preload = path.join(f.parent, "pause.mjs");
    await fs.writeFile(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;cp.spawn=(...args)=>{const child=original(...args);process.kill(-child.pid,'SIGSTOP');process.send({pid:child.pid});return child};syncBuiltinESMExports();`);
    const child = cp.spawn(process.execPath, ["--import", preload, cli, f.root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let output = "", errors = "", pid; child.stdout.on("data", b => output += b); child.stderr.on("data", b => errors += b);
    child.once("message", message => { pid = message.pid; child.kill(signal); });
    const exit = await new Promise(resolve => child.once("close", resolve)); assert.equal(exit, code); assert.equal(errors, "");
    const r = JSON.parse(output); fault(r, "cancelled"); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("repository independently rejects wrong bytes from a faulty Git process", async t => {
  const f = await fixture(t);
  intercept(t, (original, command, args, options) => args.includes("cat-file") ? original(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(5))"], options) : original(command, args, options));
  const r = await f.port.readFile(f.head, "input.bin"); fault(r.report, "blob_integrity_mismatch"); assert.equal(r.bytes, null);
});
test("repository never lazily fetches a missing promised object", async t => {
  const f = await fixture(t); const marker = path.join(f.parent, "network-helper"); const blob = git(f.root, "rev-parse", "HEAD:input.bin");
  git(f.root, "config", "extensions.partialClone", "origin"); git(f.root, "config", "remote.origin.promisor", "true");
  git(f.root, "config", "remote.origin.url", "ssh://example.invalid/project"); git(f.root, "config", "core.sshCommand", `touch '${marker}'`);
  await fs.rm(path.join(f.root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const r = await f.port.readFile(f.head, "input.bin"); fault(r.report); assert.equal(r.bytes, null); await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});
test("repository root replacement is detected before returning file bytes", async t => {
  const f = await fixture(t); const renamed = path.join(f.parent, "original"); let count = 0;
  intercept(t, (original, command, args, options) => {
    if (args.includes("--absolute-git-dir") && ++count === 2) {
      cp.execFileSync("/bin/mv", [f.root, renamed]); cp.execFileSync("/bin/ln", ["-s", renamed, f.root]);
    }
    return original(command, args, options);
  });
  const r = await f.port.readFile(f.head, "input.bin"); fault(r.report, "repository_changed"); assert.equal(r.bytes, null);
});
test("repository file ownership transfer cannot change a later pinned read", async t => {
  const f = await fixture(t); const first = await f.port.readFile(f.head, "input.bin"); first.bytes.fill(0);
  const second = await f.port.readFile(f.head, "input.bin"); assert.deepEqual(second.bytes, f.content);
});
test("repository CLI output failure is nonzero without an uncaught error", async t => {
  const f = await fixture(t); const preload = path.join(f.parent, "output-failure.mjs");
  await fs.writeFile(preload, `process.stdout.write=(data,callback)=>{queueMicrotask(()=>{callback(new Error('injected output failure'));process.stdout.emit('error',new Error('injected output failure'))});return false};`);
  const child = cp.spawn(process.execPath, ["--import", preload, cli, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", b => errors += b);
  const code = await new Promise(resolve => child.once("close", resolve)); assert.equal(code, 3); assert.equal(errors, "");
});
