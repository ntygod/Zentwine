/** ZT18-01-B: bounded raw-byte observations, never a writer lease or porcelain status. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

const indexArgs = [
  "ls-files",
  "--stage",
  "-v",
  "-z",
  "--full-name",
  "--sparse",
  "--",
];
const otherArgs = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "--directory",
  "--no-empty-directory",
  "-z",
  "--full-name",
  "--",
];
const identity = (s) => [s.dev, s.ino, s.mode].join(":");
const stamp = (s) => [identity(s), s.size, s.mtimeNs, s.ctimeNs].join(":");
const dirFlags =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;
const fileFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Internal to the local Git port: run/check/fail share its deadline and redaction. */
export async function observeLocalWorktree({
  root,
  rootStat,
  algorithm,
  headEntries,
  compareIndex,
  run,
  limits,
  check,
  fail,
}) {
  const readListing = async (args) => {
    const { output } = await run(args);
    try {
      let value;
      try {
        value = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(output);
      } catch {
        fail("invalid_git_output");
      }
      if (value && !value.endsWith("\0")) fail("invalid_git_output");
      return value;
    } finally {
      output.fill(0);
    }
  };
  const rows = (s) => (s ? s.slice(0, -1).split("\0") : []);
  const safeName = (name, directory = false) => {
    const value = directory && name.endsWith("/") ? name.slice(0, -1) : name;
    if (
      !value ||
      Buffer.byteLength(value) > 4096 ||
      value.includes("\0") ||
      value
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git",
        )
    )
      fail("unsafe_worktree_path");
    return value;
  };
  const indexText = await readListing(indexArgs);
  const index = new Map();
  const indexRows = rows(indexText);
  if (indexRows.length > limits.maxEntries) fail("entry_limit");
  for (const row of indexRows) {
    const tab = row.indexOf("\t");
    const match =
      /^([HhSsMm]) (100644|100755|120000|160000|040000) ([a-f0-9]+) ([0-3])$/.exec(
        row.slice(0, tab),
      );
    if (
      tab < 0 ||
      !match ||
      match[3].length !== (algorithm === "sha1" ? 40 : 64)
    )
      fail("invalid_git_output");
    const [, tag, mode, objectId, stageText] = match;
    const sparse = mode === "040000";
    const name = safeName(row.slice(tab + 1), sparse);
    if (
      sparse &&
      (!row.endsWith("/") || tag.toUpperCase() !== "S" || stageText !== "0")
    )
      fail("invalid_git_output");
    const item = { mode, object_id: objectId, stage: Number(stageText), tag };
    const list = index.get(name) ?? [];
    if (
      list.some((v) => v.stage === item.stage) ||
      (list.length && (item.stage === 0 || list[0].stage === 0))
    )
      fail("invalid_git_output");
    if (item.stage > 0 !== (tag.toUpperCase() === "M"))
      fail("invalid_git_output");
    list.push(item);
    index.set(name, list);
  }
  const otherText = await readListing(otherArgs);
  const seen = new Set();
  const untracked = rows(otherText).map((name) => {
    safeName(name, name.endsWith("/"));
    if (seen.has(name)) fail("invalid_git_output");
    seen.add(name);
    return { path: name, kind: name.endsWith("/") ? "directory" : "path" };
  });
  if (indexRows.length + untracked.length > limits.maxEntries)
    fail("entry_limit");
  const head = new Map(headEntries.map((e) => [safeName(e.path), e]));
  const sparseDirectories = [...index]
    .filter(([, list]) => list[0].mode === "040000")
    .map(([name]) => `${name}/`);
  const headNames = [...head.keys()].filter(
    (name) => !sparseDirectories.some((dir) => name.startsWith(dir)),
  );
  const names = [...new Set([...headNames, ...index.keys()])].sort();
  if (names.length + untracked.length > limits.maxEntries) fail("entry_limit");
  let totalBytes = 0;
  const charge = (count) => {
    check();
    totalBytes += count;
    if (totalBytes > limits.maxWorktreeBytes) fail("worktree_byte_limit");
  };
  const rootHandle = await fs.open(root, dirFlags);
  const fingerprints = new Map();
  const changes = [];
  try {
    if (
      identity(await rootHandle.stat({ bigint: true })) !== identity(rootStat)
    )
      fail("repository_changed");
    // /proc descriptor-relative traversal pins each parent and never follows a user symlink.
    const sample = async (name, entry, readContent) => {
      check();
      const opened = [];
      const signatures = [];
      let parent = `/proc/self/fd/${rootHandle.fd}`;
      const parts = name.split("/");
      try {
        for (const part of parts.slice(0, -1)) {
          let handle;
          try {
            handle = await fs.open(`${parent}/${part}`, dirFlags);
          } catch (error) {
            if (error.code === "ENOENT")
              return {
                signature: `${signatures}|missing-parent`,
                state: "deleted",
              };
            if (["ELOOP", "ENOTDIR"].includes(error.code)) {
              const blocked = await fs.lstat(`${parent}/${part}`, {
                bigint: true,
              });
              return {
                signature: `${signatures}|blocked-parent:${stamp(blocked)}`,
                state: "type_changed",
              };
            }
            throw error;
          }
          opened.push(handle);
          signatures.push(identity(await handle.stat({ bigint: true })));
          parent = `/proc/self/fd/${handle.fd}`;
          check();
        }
        const target = `${parent}/${parts.at(-1)}`;
        let before;
        try {
          before = await fs.lstat(target, { bigint: true });
        } catch (error) {
          if (error.code === "ENOENT")
            return { signature: `${signatures}|missing`, state: "deleted" };
          throw error;
        }
        const signature = `${signatures}|${stamp(before)}`;
        if (!readContent) return { signature };
        const expectsLink = entry.mode === "120000";
        if (expectsLink ? !before.isSymbolicLink() : !before.isFile())
          return { signature, state: "type_changed" };
        if (before.size > BigInt(limits.maxBlobBytes))
          fail("worktree_file_limit");
        if (before.size + BigInt(totalBytes) > BigInt(limits.maxWorktreeBytes))
          fail("worktree_byte_limit");
        const hash = createHash(algorithm).update(`blob ${before.size}\0`);
        if (expectsLink) {
          const bytes = await fs.readlink(target, { encoding: "buffer" });
          try {
            if (bytes.length > limits.maxBlobBytes) fail("worktree_file_limit");
            charge(bytes.length);
            hash.update(bytes);
            if (BigInt(bytes.length) !== before.size) fail("worktree_changed");
          } finally {
            bytes.fill(0);
          }
        } else {
          const handle = await fs.open(target, fileFlags);
          const buffer = Buffer.alloc(65536);
          try {
            if (stamp(await handle.stat({ bigint: true })) !== stamp(before))
              fail("worktree_changed");
            let count = 0;
            while (true) {
              check();
              const { bytesRead } = await handle.read(
                buffer,
                0,
                buffer.length,
                null,
              );
              if (!bytesRead) break;
              count += bytesRead;
              if (count > limits.maxBlobBytes) fail("worktree_file_limit");
              charge(bytesRead);
              hash.update(buffer.subarray(0, bytesRead));
              buffer.fill(0);
            }
            if (
              BigInt(count) !== before.size ||
              stamp(await handle.stat({ bigint: true })) !== stamp(before)
            )
              fail("worktree_changed");
          } finally {
            buffer.fill(0);
            await handle.close();
          }
        }
        check();
        if (stamp(await fs.lstat(target, { bigint: true })) !== stamp(before))
          fail("worktree_changed");
        const mode = expectsLink
          ? "120000"
          : before.mode & 0o100n
            ? "100755"
            : "100644";
        return {
          signature,
          state:
            hash.digest("hex") === entry.object_id && mode === entry.mode
              ? "matches_index"
              : "modified",
        };
      } finally {
        for (const handle of opened.reverse()) await handle.close();
      }
    };
    for (const name of names) {
      check();
      const entries = index.get(name) ?? [];
      const old = head.get(name);
      const entry = entries[0];
      const conflict = entries.some((v) => v.stage > 0);
      const indexChange =
        entry?.mode === "040000"
          ? "not_compared"
          : conflict
            ? "unmerged"
            : !entry
              ? "deleted"
              : !old
                ? "added"
                : entry.mode !== old.mode || entry.object_id !== old.object_id
                  ? "modified"
                  : "none";
      let observed;
      const reason = !entry
        ? "not_in_index"
        : conflict
          ? "unmerged_index"
          : entry.mode === "160000"
            ? "submodule"
            : entry.tag.toUpperCase() === "S"
              ? "skip_worktree"
              : null;
      if (reason) observed = { state: "not_inspected", reason };
      else {
        const value = await sample(name, entry, true);
        fingerprints.set(name, value.signature);
        observed = { state: value.state, reason: null };
      }
      changes.push({
        path: name,
        index_change: indexChange,
        index_stages: entries.map(({ mode, object_id, stage }) => ({
          mode,
          object_id,
          stage,
        })),
        assume_unchanged: Boolean(
          entry && entry.tag === entry.tag.toLowerCase(),
        ),
        worktree: observed,
      });
    }
    const indexState = await compareIndex();
    if ((await readListing(indexArgs)) !== indexText) fail("index_changed");
    if ((await readListing(otherArgs)) !== otherText) fail("worktree_changed");
    for (const [name, signature] of fingerprints) {
      if (
        (await sample(name, index.get(name)[0], false)).signature !== signature
      )
        fail("worktree_changed");
    }
    check();
    const summary = {
      index_changes: changes.filter(
        (v) => !["none", "not_compared"].includes(v.index_change),
      ).length,
      raw_worktree_changes: changes.filter((v) =>
        ["modified", "deleted", "type_changed"].includes(v.worktree.state),
      ).length,
      conflicts: changes.filter((v) => v.index_change === "unmerged").length,
      untracked_entries: untracked.length,
      uninspected_index_entries: changes.filter(
        (v) => v.index_stages.length && v.worktree.state === "not_inspected",
      ).length,
      bytes_read: totalBytes,
    };
    return {
      comparison: "raw_bytes_and_posix_mode_to_index",
      index_state: indexState,
      canonicalization: false,
      atomic: false,
      ignored: "not_listed",
      untracked_format: "paths_and_collapsed_directories",
      submodule_worktrees: "not_inspected",
      assessment: summary.conflicts
        ? "conflicted"
        : summary.index_changes ||
            summary.raw_worktree_changes ||
            summary.untracked_entries
          ? "changes_observed"
          : summary.uninspected_index_entries
            ? "incomplete"
            : "no_changes_observed",
      coverage: summary.uninspected_index_entries
        ? "partial"
        : "complete_for_reported_scope",
      summary,
      entries: changes,
      untracked,
    };
  } finally {
    await rootHandle.close();
  }
}
