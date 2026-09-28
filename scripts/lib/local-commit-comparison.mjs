/** Fixed trees only. Paths are compared in memory, never interpreted as Git pathspecs. */
import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";

const classify = (before, after) =>
  !before
    ? "added"
    : !after
      ? "deleted"
      : before.kind !== after.kind
        ? "type_changed"
        : "modified";
const decodeText = (bytes) => {
  if (bytes.includes(0)) return null;
  try {
    // Preserve BOM, CR and final-newline differences; do not normalize file content.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
};
function lines(value, limit, fail) {
  const result = [];
  let start = 0;
  while (start < value.length) {
    if (result.length >= limit) fail("diff_line_limit");
    const end = value.indexOf("\n", start);
    result.push(value.slice(start, end === -1 ? value.length : end + 1));
    start = end === -1 ? value.length : end + 1;
  }
  return result;
}

/** Bounded line LCS; yields so cancellation/deadline can be observed during CPU work. */
export async function buildTextHunks(before, after, limits, check, fail) {
  const a = lines(before, limits.maxDiffLines, fail);
  const b = lines(after, limits.maxDiffLines, fail);
  if (a.length + b.length > limits.maxDiffLines) fail("diff_line_limit");
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const n = a.length - prefix - suffix,
    m = b.length - prefix - suffix;
  const cells = n && m ? (n + 1) * (m + 1) : 0;
  if (cells > limits.maxDiffCells) fail("diff_complexity_limit");
  check();
  const table = new Uint32Array(cells);
  const width = m + 1;
  for (let i = n - 1; i >= 0 && m; i--) {
    if (i % 32 === 0) {
      await yieldTurn();
      check();
    }
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[prefix + i] === b[prefix + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const operations = [];
  let oldLine = 1,
    newLine = 1,
    added = 0,
    deleted = 0;
  const emit = (kind, raw) => {
    operations.push({
      kind,
      old_line: kind === "insert" ? null : oldLine++,
      new_line: kind === "delete" ? null : newLine++,
      text: raw.endsWith("\n") ? raw.slice(0, -1) : raw,
      newline: raw.endsWith("\n"),
    });
    if (kind === "insert") added++;
    if (kind === "delete") deleted++;
  };
  for (let i = 0; i < prefix; i++) emit("equal", a[i]);
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
      emit("equal", a[prefix + i]);
      i++;
      j++;
    } else if (
      i < n &&
      (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])
    ) {
      emit("delete", a[prefix + i++]);
    } else emit("insert", b[prefix + j++]);
  }
  for (let k = a.length - suffix; k < a.length; k++) emit("equal", a[k]);
  // Three context lines per side. Overlapping/adjacent windows form one hunk.
  const windows = [];
  for (let k = 0; k < operations.length; k++) {
    if (operations[k].kind === "equal") continue;
    const start = Math.max(0, k - 3),
      end = Math.min(operations.length, k + 4);
    const last = windows.at(-1);
    if (last && start <= last.end) last.end = end;
    else windows.push({ start, end });
  }
  let oldOffset = 0,
    newOffset = 0,
    cursor = 0;
  const hunks = windows.map(({ start, end }) => {
    for (; cursor < start; cursor++) {
      if (operations[cursor].kind !== "insert") oldOffset++;
      if (operations[cursor].kind !== "delete") newOffset++;
    }
    const selected = operations.slice(start, end);
    const oldCount = selected.filter((op) => op.kind !== "insert").length;
    const newCount = selected.filter((op) => op.kind !== "delete").length;
    return {
      old_start: oldCount ? oldOffset + 1 : oldOffset,
      old_lines: oldCount,
      new_start: newCount ? newOffset + 1 : newOffset,
      new_lines: newCount,
      lines: selected,
    };
  });
  await yieldTurn();
  check();
  const value = {
    status: "text",
    algorithm: "bounded_line_lcs",
    context_lines: 3,
    added_lines: added,
    deleted_lines: deleted,
    hunks,
  };
  if (Buffer.byteLength(JSON.stringify(value)) > limits.maxDiffBytes)
    fail("diff_output_limit");
  return value;
}

export async function compareLocalCommits({
  request,
  algorithm,
  bare,
  readTree,
  run,
  text,
  limits,
  check,
  fail,
}) {
  const snapshot = async (commit) => {
    if ((await text(["cat-file", "-t", commit])).value !== "commit")
      fail("not_commit_object");
    const tree = (await text(["rev-parse", "--verify", `${commit}^{tree}`]))
      .value;
    if (
      !new RegExp(`^[a-f0-9]{${algorithm === "sha256" ? 64 : 40}}$`).test(tree)
    )
      fail("invalid_git_output");
    return { commit_sha: commit, tree_sha: tree };
  };
  const base = await snapshot(request.base),
    head = await snapshot(request.head);
  const before = new Map(
    (await readTree(base.tree_sha, algorithm)).map((e) => [e.path, e]),
  );
  const after = new Map(
    (await readTree(head.tree_sha, algorithm)).map((e) => [e.path, e]),
  );
  const names = [...new Set([...before.keys(), ...after.keys()])];
  if (names.length > limits.maxEntries) fail("entry_limit");
  names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const entries = [];
  const summary = {
    added: 0,
    deleted: 0,
    modified: 0,
    type_changed: 0,
    total: 0,
  };
  for (const name of names) {
    const a = before.get(name) ?? null,
      b = after.get(name) ?? null;
    if (a && b && a.object_id === b.object_id && a.mode === b.mode) continue;
    const change = classify(a, b);
    entries.push({ path: name, change, before: a, after: b });
    summary[change]++;
    summary.total++;
  }
  check();
  let selected = null;
  if (request.path !== null) {
    const entry = entries.find((e) => e.path === request.path);
    if (!entry) fail("path_not_changed");
    selected = {
      path: request.path,
      status: "not_rendered",
      reason: "non_regular_object",
    };
    if ([entry.before, entry.after].every((e) => !e || e.kind === "file")) {
      const buffers = [];
      try {
        const read = async (e) => {
          if (!e) return "";
          if (e.size_bytes > limits.maxBlobBytes) fail("blob_limit");
          const bytes = (
            await run(["cat-file", "blob", e.object_id], limits.maxBlobBytes)
          ).output;
          buffers.push(bytes);
          if (
            bytes.length !== e.size_bytes ||
            createHash(algorithm)
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest("hex") !== e.object_id
          )
            fail("blob_integrity_mismatch");
          return decodeText(bytes);
        };
        const a = await read(entry.before),
          b = await read(entry.after);
        selected =
          a === null || b === null
            ? {
                path: request.path,
                status: "not_rendered",
                reason: "binary_or_non_utf8",
              }
            : {
                path: request.path,
                ...(await buildTextHunks(a, b, limits, check, fail)),
              };
      } finally {
        buffers.forEach((bytes) => bytes.fill(0));
      }
    }
  }
  check();
  return {
    object_format: algorithm,
    repository_kind: bare ? "bare" : "worktree",
    semantics: "direct_trees_not_merge_base",
    base,
    head,
    renames: "delete_add",
    index: "not_inspected",
    working_tree: "not_inspected",
    submodule_contents: "not_inspected",
    content_disclosed: selected?.status === "text",
    summary,
    entries,
    selected,
  };
}
