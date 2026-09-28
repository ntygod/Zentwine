/** ZT18-01-A: local, read-only Git port. No remote identity or execution authority. */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { observeLocalWorktree } from "./local-worktree.mjs";
import { compareLocalCommits } from "./local-commit-comparison.mjs";

export const LOCAL_REPOSITORY_LIMITS = Object.freeze({
  timeoutMs: 30000,
  maxEntries: 10000,
  maxOutputBytes: 2097152,
  maxBlobBytes: 4194304,
  maxWorktreeBytes: 16777216,
  maxDiffLines: 4000,
  maxDiffCells: 2000000,
  maxDiffBytes: 1048576,
});
class RepositoryFault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new RepositoryFault(code);
};
const utf8 = (bytes) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_git_output");
  }
};
const oid = (value, algorithm) =>
  typeof value === "string" &&
  new RegExp(`^[a-f0-9]{${algorithm === "sha256" ? 64 : 40}}$`).test(value);
const relativePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 4096 &&
  !value.includes("\0") &&
  !value.startsWith("/") &&
  value.split("/").every((v) => v && v !== "." && v !== "..");
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const environment = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "",
  GIT_ATTR_NOSYSTEM: "1",
});
const gitOptions = [
  "--no-pager",
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** Native Linux filesystem, Git and AbortSignal are trusted host dependencies. */
export function createLocalRepositoryPort(directory, options = {}) {
  if (
    typeof directory !== "string" ||
    !directory ||
    directory.includes("\0") ||
    Buffer.byteLength(directory) > 4096 ||
    !options ||
    typeof options !== "object" ||
    Object.getPrototypeOf(options) !== Object.prototype
  )
    fail("invalid_arguments");
  const limits = { ...LOCAL_REPOSITORY_LIMITS };
  for (const key of Reflect.ownKeys(options)) {
    const d = Object.getOwnPropertyDescriptor(options, key);
    if (
      !Object.hasOwn(limits, key) ||
      !d ||
      !d.enumerable ||
      !("value" in d) ||
      !Number.isSafeInteger(d.value) ||
      d.value < 1 ||
      d.value > limits[key]
    )
      fail("invalid_arguments");
    limits[key] = d.value;
  }
  const selected = path.resolve(directory);
  async function perform(
    file,
    signal,
    worktreeCommit = null,
    comparison = null,
  ) {
    const inspectWorktree = worktreeCommit !== null;
    const result = {
      report_version: "1.0.0",
      scope: comparison
        ? "local_git_commit_comparison"
        : inspectWorktree
          ? "local_git_worktree_observation"
          : "local_git_committed_snapshot",
      status: "rejected",
      authorization: false,
      source: "local_git",
      working_tree: inspectWorktree ? null : "not_inspected",
      snapshot: null,
      ...(comparison ? { comparison: null } : {}),
      fault: null,
    };
    let bytes = null;
    const deadline = performance.now() + limits.timeoutMs;
    const check = () => {
      if (signal?.aborted) fail("cancelled");
      if (performance.now() >= deadline) fail("timeout");
    };
    const run = async (
      args,
      maximum = limits.maxOutputBytes,
      accepted = [0],
    ) => {
      check();
      return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0,
          errors = 0,
          failure,
          done = false;
        const child = spawn(
          "/usr/bin/git",
          [...gitOptions, "-C", selected, ...args],
          {
            shell: false,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          },
        );
        const stop = (code) => {
          failure ??= code;
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        const onAbort = () => stop("cancelled");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const timer = setTimeout(
          () => stop("timeout"),
          Math.max(1, deadline - performance.now()),
        );
        const finish = (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          let output;
          try {
            check();
            if (failure) fail(failure);
            if (!accepted.includes(code)) fail("git_unavailable");
            output = Buffer.concat(chunks);
            resolve({ code, output });
          } catch (error) {
            output?.fill(0);
            reject(error);
          } finally {
            chunks.forEach((chunk) => chunk.fill(0));
          }
        };
        child.stdout.on("data", (chunk) => {
          size += chunk.length;
          if (failure || size > maximum) {
            chunk.fill(0);
            stop("output_limit");
          } else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
          errors += chunk.length;
          chunk.fill(0);
          if (errors > 65536) stop("output_limit");
        });
        child.on("error", () => {
          failure ??= "git_unavailable";
          finish(null);
        });
        child.on("close", finish);
      });
    };
    const text = async (args, accepted = [0]) => {
      const r = await run(
        args,
        Math.min(8192, limits.maxOutputBytes),
        accepted,
      );
      try {
        const value = utf8(r.output);
        if (r.code === 0 && !value.endsWith("\n")) fail("invalid_git_output");
        return {
          code: r.code,
          value: value.endsWith("\n") ? value.slice(0, -1) : value,
        };
      } finally {
        r.output.fill(0);
      }
    };
    const readTree = async (tree, algorithm) => {
      const raw = (
        await run(["ls-tree", "-r", "-l", "-z", "--full-tree", tree])
      ).output;
      let entries;
      try {
        const listing = utf8(raw);
        if (listing && !listing.endsWith("\0")) fail("invalid_git_output");
        const rows = listing ? listing.slice(0, -1).split("\0") : [];
        if (rows.length > limits.maxEntries) fail("entry_limit");
        const seen = new Set();
        entries = rows.map((row) => {
          const tab = row.indexOf("\t"),
            name = row.slice(tab + 1);
          const match =
            /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]+) +([0-9]+|-)$/.exec(
              row.slice(0, tab),
            );
          if (
            tab < 0 ||
            !match ||
            !relativePath(name) ||
            seen.has(name) ||
            !oid(match[3], algorithm)
          )
            fail("invalid_git_output");
          const gitlink = match[1] === "160000";
          if (
            (match[2] === "commit") !== gitlink ||
            (match[4] === "-") !== gitlink
          )
            fail("invalid_git_output");
          const size = gitlink ? null : Number(match[4]);
          if (!gitlink && (!Number.isSafeInteger(size) || size < 0))
            fail("invalid_git_output");
          seen.add(name);
          return {
            path: name,
            mode: match[1],
            kind: gitlink
              ? "gitlink"
              : match[1] === "120000"
                ? "symlink"
                : "file",
            object_id: match[3],
            size_bytes: size,
          };
        });
      } finally {
        raw.fill(0);
      }
      return entries;
    };
    try {
      if (process.platform !== "linux") fail("unsupported_platform");
      if (signal !== undefined && !(signal instanceof AbortSignal))
        fail("invalid_arguments");
      if (
        file &&
        (!relativePath(file.path) ||
          !(
            oid(file.expectedCommit, "sha1") ||
            oid(file.expectedCommit, "sha256")
          ))
      )
        fail("invalid_arguments");
      if (
        inspectWorktree &&
        !(oid(worktreeCommit, "sha1") || oid(worktreeCommit, "sha256"))
      )
        fail("invalid_arguments");
      if (
        comparison &&
        (!(oid(comparison.base, "sha1") || oid(comparison.base, "sha256")) ||
          !(oid(comparison.head, "sha1") || oid(comparison.head, "sha256")) ||
          (comparison.path !== null && !relativePath(comparison.path)))
      )
        fail("invalid_arguments");
      check();
      const rootStat = await fs.lstat(selected, { bigint: true });
      check();
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        fail("invalid_repository_root");
      const root = await fs.realpath(selected);
      check();
      const bareValue = (await text(["rev-parse", "--is-bare-repository"]))
        .value;
      if (!["true", "false"].includes(bareValue)) fail("invalid_git_output");
      const bare = bareValue === "true";
      if (inspectWorktree && bare) fail("worktree_not_applicable");
      const gitDirectory = (await text(["rev-parse", "--absolute-git-dir"]))
        .value;
      const gitRoot = await fs.realpath(gitDirectory);
      const gitStat = await fs.stat(gitRoot, { bigint: true });
      check();
      const actualRoot = bare
        ? gitRoot
        : await fs.realpath(
            (await text(["rev-parse", "--show-toplevel"])).value,
          );
      if (root !== actualRoot) fail("invalid_repository_root");
      const algorithm = (await text(["rev-parse", "--show-object-format"]))
        .value;
      if (!["sha1", "sha256"].includes(algorithm))
        fail("unsupported_object_format");
      const verifyIdentity = async () => {
        if (
          (await text(["rev-parse", "--absolute-git-dir"])).value !==
          gitDirectory
        )
          fail("repository_changed");
        const rootAfter = await fs.lstat(selected, { bigint: true });
        const gitAfter = await fs.stat(gitRoot, { bigint: true });
        check();
        if (
          !rootAfter.isDirectory() ||
          rootAfter.dev !== rootStat.dev ||
          rootAfter.ino !== rootStat.ino ||
          !gitAfter.isDirectory() ||
          gitAfter.dev !== gitStat.dev ||
          gitAfter.ino !== gitStat.ino
        )
          fail("repository_changed");
      };
      if (comparison) {
        if (
          !oid(comparison.base, algorithm) ||
          !oid(comparison.head, algorithm)
        )
          fail("invalid_arguments");
        const value = await compareLocalCommits({
          request: comparison,
          algorithm,
          bare,
          readTree,
          run,
          text,
          limits,
          check,
          fail,
        });
        await verifyIdentity();
        result.status = "compared";
        result.comparison = value;
        return { report: freeze(result), bytes: null };
      }
      const head = async () => {
        const r = await text(
          [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            "HEAD^{commit}",
          ],
          [0, 1],
        );
        if (r.code !== 0) fail("no_head_commit");
        if (!oid(r.value, algorithm)) fail("invalid_git_output");
        return r.value;
      };
      const commit = await head();
      if (file && file.expectedCommit !== commit) fail("stale_baseline");
      if (inspectWorktree && worktreeCommit !== commit) fail("stale_baseline");
      const branchValue = await text(
        ["symbolic-ref", "--quiet", "HEAD"],
        [0, 1],
      );
      const branch = branchValue.code === 1 ? null : branchValue.value;
      if (branch !== null && !/^refs\/heads\/[^\x00-\x20\x7f]+$/.test(branch))
        fail("invalid_git_output");
      const tree = (await text(["rev-parse", "--verify", `${commit}^{tree}`]))
        .value;
      if (!oid(tree, algorithm)) fail("invalid_git_output");
      const entries = await readTree(tree, algorithm);
      // Index-only comparison: never run worktree status/clean filters or textconv.
      let indexState = "not_applicable";
      const compareIndex = async () => {
        const diff = await run(
          [
            "diff-index",
            "--cached",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--ignore-submodules=none",
            commit,
            "--",
          ],
          256,
          [0, 1],
        );
        diff.output.fill(0);
        return diff.code === 0 ? "matches_head" : "differs_from_head";
      };
      if (!bare && !inspectWorktree) indexState = await compareIndex();
      let selectedFile = null;
      if (file) {
        const entry = entries.find((e) => e.path === file.path);
        if (!entry) fail("file_not_in_baseline");
        if (entry.kind !== "file") fail("not_regular_blob");
        if (entry.size_bytes > limits.maxBlobBytes) fail("blob_limit");
        bytes = (
          await run(["cat-file", "blob", entry.object_id], limits.maxBlobBytes)
        ).output;
        if (
          bytes.length !== entry.size_bytes ||
          createHash(algorithm)
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex") !== entry.object_id
        )
          fail("blob_integrity_mismatch");
        selectedFile = {
          ...entry,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
      const workingTree = inspectWorktree
        ? await observeLocalWorktree({
            root,
            rootStat,
            algorithm,
            headEntries: entries,
            compareIndex,
            run,
            limits,
            check,
            fail,
          })
        : "not_inspected";
      if (inspectWorktree) indexState = workingTree.index_state;
      // Re-observe identity and HEAD, not an atomic filesystem snapshot or writer lease.
      if ((await head()) !== commit) fail("stale_baseline");
      const branchAfter = await text(
        ["symbolic-ref", "--quiet", "HEAD"],
        [0, 1],
      );
      if (
        branchAfter.code !== branchValue.code ||
        branchAfter.value !== branchValue.value
      )
        fail("stale_baseline");
      await verifyIdentity();
      result.status = "inspected";
      result.working_tree = workingTree;
      result.snapshot = {
        object_format: algorithm,
        commit_sha: commit,
        tree_sha: tree,
        head:
          branch === null
            ? { kind: "detached", ref: null }
            : { kind: "branch", ref: branch },
        repository_kind: bare ? "bare" : "worktree",
        index_state: indexState,
        submodule_worktrees: "not_inspected",
        entries,
        selected_file: selectedFile,
      };
    } catch (error) {
      bytes?.fill(0);
      bytes = null;
      result.fault = {
        code:
          error instanceof RepositoryFault
            ? error.code
            : "repository_unavailable",
      };
    }
    return { report: freeze(result), bytes };
  }
  return Object.freeze({
    async inspect(signal) {
      return (await perform(null, signal)).report;
    },
    async inspectWorktree(expectedCommit, signal) {
      return (await perform(null, signal, expectedCommit ?? false)).report;
    },
    async compareCommits(baseCommit, headCommit, signal) {
      return (
        await perform(null, signal, null, {
          base: baseCommit,
          head: headCommit,
          path: null,
        })
      ).report;
    },
    async readCommitDiff(baseCommit, headCommit, filePath, signal) {
      return (
        await perform(null, signal, null, {
          base: baseCommit,
          head: headCommit,
          path: filePath ?? false,
        })
      ).report;
    },
    async readFile(expectedCommit, filePath, signal) {
      return perform({ expectedCommit, path: filePath }, signal);
    },
  });
}
