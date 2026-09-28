/** Imported claims only: this reader never opens Git objects or grants review authority. */
import { readRepositoryComparisonJson } from "./runtime-stream-json.js";

export const REPOSITORY_COMPARISON_IMPORT_LIMITS = Object.freeze({
  bytes: 4194304,
  entries: 2000,
  lines: 4000,
  pathBytes: 4096,
});
export type ComparisonObject = Readonly<{
  path: string;
  mode: string;
  kind: "file" | "symlink" | "gitlink";
  object_id: string;
  size_bytes: number | null;
}>;
export type ComparisonEntry = Readonly<{
  path: string;
  change: "added" | "deleted" | "modified" | "type_changed";
  before: ComparisonObject | null;
  after: ComparisonObject | null;
}>;
export type ComparisonLine = Readonly<{
  kind: "equal" | "insert" | "delete";
  old_line: number | null;
  new_line: number | null;
  text: string;
  newline: boolean;
}>;
export type ComparisonHunk = Readonly<{
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: readonly ComparisonLine[];
}>;
export type ComparisonDetail =
  | Readonly<{ path: string; status: "not_rendered"; reason: string }>
  | Readonly<{
      path: string;
      status: "text";
      algorithm: "bounded_line_lcs";
      context_lines: 3;
      added_lines: number;
      deleted_lines: number;
      hunks: readonly ComparisonHunk[];
    }>;
export type ImportedRepositoryComparison = Readonly<{
  trust: "unverified_import";
  object_format: "sha1" | "sha256";
  base: Readonly<{ commit_sha: string; tree_sha: string }>;
  head: Readonly<{ commit_sha: string; tree_sha: string }>;
  entries: readonly ComparisonEntry[];
  selected: ComparisonDetail | null;
}>;
const invalid = (): never => {
  throw new TypeError("Invalid local comparison report");
};
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const names = Object.keys(value);
  if (
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  )
    return invalid();
  return value as number;
}
function text(value: unknown): string {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value))
    return invalid();
  return value;
}
function path(value: unknown): string {
  const s = text(value);
  if (
    !s ||
    s.includes("\0") ||
    s.startsWith("/") ||
    new TextEncoder().encode(s).length >
      REPOSITORY_COMPARISON_IMPORT_LIMITS.pathBytes ||
    s.split("/").some((p) => !p || p === "." || p === "..")
  )
    return invalid();
  return s;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Accept only the current CLI's successful report; discard transport claims from the projection. */
export function parseRepositoryComparisonReport(
  input: string,
): ImportedRepositoryComparison {
  try {
    if (
      typeof input !== "string" ||
      input.length > REPOSITORY_COMPARISON_IMPORT_LIMITS.bytes ||
      new TextEncoder().encode(input).length >
        REPOSITORY_COMPARISON_IMPORT_LIMITS.bytes
    )
      return invalid();
    const parsedInput = readRepositoryComparisonJson(input);
    const hasExit =
      !!parsedInput &&
      typeof parsedInput === "object" &&
      Object.hasOwn(parsedInput, "exit_code");
    const report = exact(parsedInput, [
      "report_version",
      "scope",
      "status",
      "authorization",
      "source",
      "working_tree",
      "snapshot",
      "comparison",
      "fault",
      ...(hasExit ? ["exit_code"] : []),
    ]);
    if (hasExit && report.exit_code !== 0) return invalid();
    if (
      report.report_version !== "1.0.0" ||
      report.scope !== "local_git_commit_comparison" ||
      report.status !== "compared" ||
      report.authorization !== false ||
      report.source !== "local_git" ||
      report.working_tree !== "not_inspected" ||
      report.snapshot !== null ||
      report.fault !== null
    )
      return invalid();
    const c = exact(report.comparison, [
      "object_format",
      "repository_kind",
      "semantics",
      "base",
      "head",
      "renames",
      "index",
      "working_tree",
      "submodule_contents",
      "content_disclosed",
      "summary",
      "entries",
      "selected",
    ]);
    if (
      !["sha1", "sha256"].includes(c.object_format as string) ||
      !["bare", "worktree"].includes(c.repository_kind as string) ||
      c.semantics !== "direct_trees_not_merge_base" ||
      c.renames !== "delete_add" ||
      c.index !== "not_inspected" ||
      c.working_tree !== "not_inspected" ||
      c.submodule_contents !== "not_inspected"
    )
      return invalid();
    const oid = (value: unknown) => {
      const s = text(value);
      if (
        !new RegExp(`^[a-f0-9]{${c.object_format === "sha1" ? 40 : 64}}$`).test(
          s,
        )
      )
        return invalid();
      return s;
    };
    const commit = (v: unknown) => {
      const obj = exact(v, ["commit_sha", "tree_sha"]);
      return { commit_sha: oid(obj.commit_sha), tree_sha: oid(obj.tree_sha) };
    };
    const base = commit(c.base),
      head = commit(c.head);
    if (base.commit_sha === head.commit_sha && base.tree_sha !== head.tree_sha)
      return invalid();
    const object = (v: unknown, name: string): ComparisonObject | null => {
      if (v === null) return null;
      const obj = exact(v, ["path", "mode", "kind", "object_id", "size_bytes"]);
      if (path(obj.path) !== name) return invalid();
      const kind =
        obj.mode === "160000"
          ? "gitlink"
          : obj.mode === "120000"
            ? "symlink"
            : ["100644", "100755"].includes(obj.mode as string)
              ? "file"
              : invalid();
      if (obj.kind !== kind || (kind === "gitlink" && obj.size_bytes !== null))
        return invalid();
      return {
        path: name,
        mode: obj.mode as string,
        kind,
        object_id: oid(obj.object_id),
        size_bytes: kind === "gitlink" ? null : integer(obj.size_bytes),
      };
    };
    if (
      !Array.isArray(c.entries) ||
      c.entries.length > REPOSITORY_COMPARISON_IMPORT_LIMITS.entries
    )
      return invalid();
    const seen = new Set<string>();
    const counts = {
      added: 0,
      deleted: 0,
      modified: 0,
      type_changed: 0,
      total: c.entries.length,
    };
    const entries = c.entries.map((value): ComparisonEntry => {
      const e = exact(value, ["path", "change", "before", "after"]),
        name = path(e.path);
      if (seen.has(name)) return invalid();
      seen.add(name);
      const before = object(e.before, name),
        after = object(e.after, name);
      if (!before && !after) return invalid();
      if (
        before &&
        after &&
        before.object_id === after.object_id &&
        (before.size_bytes !== after.size_bytes || before.mode === after.mode)
      )
        return invalid();
      const change = !before
        ? "added"
        : !after
          ? "deleted"
          : before.kind !== after.kind
            ? "type_changed"
            : "modified";
      if (e.change !== change) return invalid();
      counts[change]++;
      return { path: name, change, before, after };
    });
    const summary = exact(c.summary, Object.keys(counts));
    for (const key of Object.keys(counts) as (keyof typeof counts)[])
      if (summary[key] !== counts[key]) return invalid();
    if (base.tree_sha === head.tree_sha && entries.length) return invalid();
    let selected: ComparisonDetail | null = null;
    if (c.selected !== null) {
      const raw = c.selected as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return invalid();
      const name = path(raw.path),
        entry = entries.find((e) => e.path === name);
      if (!entry) return invalid();
      const regular = [entry.before, entry.after].every(
        (e) => !e || e.kind === "file",
      );
      if (raw.status === "not_rendered") {
        exact(raw, ["path", "status", "reason"]);
        if (
          raw.reason !== (regular ? "binary_or_non_utf8" : "non_regular_object")
        )
          return invalid();
        selected = {
          path: name,
          status: "not_rendered",
          reason: raw.reason as string,
        };
      } else {
        exact(raw, [
          "path",
          "status",
          "algorithm",
          "context_lines",
          "added_lines",
          "deleted_lines",
          "hunks",
        ]);
        if (
          !regular ||
          raw.status !== "text" ||
          raw.algorithm !== "bounded_line_lcs" ||
          raw.context_lines !== 3 ||
          !Array.isArray(raw.hunks) ||
          raw.hunks.length > REPOSITORY_COMPARISON_IMPORT_LIMITS.lines
        )
          return invalid();
        let added = 0,
          deleted = 0,
          lines = 0,
          oldEnd = 0,
          newEnd = 0,
          oldFinal = false,
          newFinal = false;
        const hunks: ComparisonHunk[] = raw.hunks.map((value) => {
          const h = exact(value, [
            "old_start",
            "old_lines",
            "new_start",
            "new_lines",
            "lines",
          ]);
          const oldStart = integer(h.old_start, 4000),
            newStart = integer(h.new_start, 4000),
            oldCount = integer(h.old_lines, 4000),
            newCount = integer(h.new_lines, 4000);
          const oldOffset = oldCount ? oldStart - 1 : oldStart,
            newOffset = newCount ? newStart - 1 : newStart;
          if (
            oldOffset < oldEnd ||
            newOffset < newEnd ||
            oldOffset - oldEnd !== newOffset - newEnd ||
            !Array.isArray(h.lines) ||
            !h.lines.length
          )
            return invalid();
          if (
            (lines += h.lines.length) >
            REPOSITORY_COMPARISON_IMPORT_LIMITS.lines
          )
            return invalid();
          let a = oldOffset,
            b = newOffset,
            changes = 0;
          const rows: ComparisonLine[] = h.lines.map((value) => {
            const l = exact(value, [
              "kind",
              "old_line",
              "new_line",
              "text",
              "newline",
            ]);
            if (
              !["equal", "insert", "delete"].includes(l.kind as string) ||
              typeof l.newline !== "boolean"
            )
              return invalid();
            const kind = l.kind as ComparisonLine["kind"],
              content = text(l.text);
            if (content.includes("\n") || content.includes("\0"))
              return invalid();
            if (kind !== "insert" && (oldFinal || l.old_line !== ++a))
              return invalid();
            if (kind !== "delete" && (newFinal || l.new_line !== ++b))
              return invalid();
            if (
              (kind === "insert" && l.old_line !== null) ||
              (kind === "delete" && l.new_line !== null)
            )
              return invalid();
            if (kind !== "insert" && !l.newline) oldFinal = true;
            if (kind !== "delete" && !l.newline) newFinal = true;
            if (kind === "insert") {
              added++;
              changes++;
            }
            if (kind === "delete") {
              deleted++;
              changes++;
            }
            return {
              kind,
              old_line: l.old_line as number | null,
              new_line: l.new_line as number | null,
              text: content,
              newline: l.newline,
            };
          });
          if (
            !changes ||
            a - oldOffset !== oldCount ||
            b - newOffset !== newCount ||
            a > 4000 ||
            b > 4000 ||
            (!entry.before && a) ||
            (!entry.after && b)
          )
            return invalid();
          oldEnd = a;
          newEnd = b;
          return {
            old_start: oldStart,
            old_lines: oldCount,
            new_start: newStart,
            new_lines: newCount,
            lines: rows,
          };
        });
        if (
          !hunks.length &&
          entry.before?.object_id !== entry.after?.object_id &&
          (entry.before?.size_bytes || entry.after?.size_bytes)
        )
          return invalid();
        if (
          [entry.before, entry.after].some((e) => e && e.size_bytes! > 4194304)
        )
          return invalid();
        const { path: ignoredPath, ...payload } = raw;
        void ignoredPath;
        if (new TextEncoder().encode(JSON.stringify(payload)).length > 1048576)
          return invalid();
        if (
          raw.added_lines !== added ||
          raw.deleted_lines !== deleted ||
          (entry.before &&
            entry.after &&
            entry.before.object_id === entry.after.object_id &&
            hunks.length)
        )
          return invalid();
        selected = {
          path: name,
          status: "text",
          algorithm: "bounded_line_lcs",
          context_lines: 3,
          added_lines: added,
          deleted_lines: deleted,
          hunks,
        };
      }
    }
    if (c.content_disclosed !== (selected?.status === "text")) return invalid();
    return freeze({
      trust: "unverified_import",
      object_format: c.object_format as "sha1" | "sha256",
      base,
      head,
      entries,
      selected,
    });
  } catch {
    return invalid();
  }
}

/** Visible code-point escapes are presentation-only; never normalize the stored path/content. */
export function comparisonDisplayText(value: string): string {
  return value.replace(
    /[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
    (c) =>
      `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`,
  );
}
