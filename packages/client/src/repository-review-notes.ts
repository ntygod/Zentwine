/** Local file-level feedback. Content binding is not authentication or approval. */
import {
  parseRepositoryComparisonReport,
  type ImportedRepositoryComparison,
} from "./repository-comparison.js";
import { readRepositoryComparisonJson } from "./runtime-stream-json.js";

export const REPOSITORY_REVIEW_NOTES_LIMITS = Object.freeze({
  bytes: 524288,
  notes: 100,
  bodyBytes: 4000,
  authorBytes: 120,
});
export type RepositoryReviewNote = Readonly<{
  id: string;
  path: string;
  kind: "issue" | "suggestion" | "question";
  author: string;
  body: string;
}>;
export type RepositoryReviewSession = Readonly<{
  report: ImportedRepositoryComparison;
  report_sha256: string;
}>;
const sessions = new WeakSet<RepositoryReviewSession>();
const fail = (): never => {
  throw new TypeError("Invalid or mismatched local review notes");
};
function source(session: RepositoryReviewSession) {
  if (!sessions.has(session)) return fail();
  return {
    report_sha256: session.report_sha256,
    object_format: session.report.object_format,
    base: session.report.base,
    head: session.report.head,
  };
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\uD800-\uDFFF\0]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > maximum
  )
    return fail();
  return value;
}

/** The input is the exact original UTF-8 JSON, including whitespace; no normalization. */
export async function createRepositoryReviewSession(
  input: string,
): Promise<RepositoryReviewSession> {
  const report = parseRepositoryComparisonReport(input);
  // Reject lone surrogates anywhere, rather than silently hashing replacement characters.
  if (/[\uD800-\uDFFF]/u.test(input)) return fail();
  const bytes = new TextEncoder().encode(input);
  try {
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", bytes),
    );
    const session = Object.freeze({
      report,
      report_sha256: Array.from(digest, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    });
    sessions.add(session);
    return session;
  } catch {
    return fail();
  } finally {
    bytes.fill(0);
  }
}

/** Snapshot exact data properties. A file path must belong to this session's change list. */
export function validateRepositoryReviewNotes(
  session: RepositoryReviewSession,
  input: unknown,
): readonly RepositoryReviewNote[] {
  try {
    source(session);
    if (
      !Array.isArray(input) ||
      input.length > REPOSITORY_REVIEW_NOTES_LIMITS.notes
    )
      return fail();
    if (Reflect.ownKeys(input).length !== input.length + 1) return fail();
    const paths = new Set(session.report.entries.map((entry) => entry.path));
    const ids = new Set<string>();
    const result: RepositoryReviewNote[] = [];
    for (let i = 0; i < input.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail();
      const note = exact(descriptor.value, [
        "id",
        "path",
        "kind",
        "author",
        "body",
      ]);
      const id = text(note.id, 64),
        path = text(note.path, 4096);
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || ids.has(id) || !paths.has(path))
        return fail();
      if (!["issue", "suggestion", "question"].includes(note.kind as string))
        return fail();
      ids.add(id);
      result.push(
        Object.freeze({
          id,
          path,
          kind: note.kind as RepositoryReviewNote["kind"],
          author: text(note.author, REPOSITORY_REVIEW_NOTES_LIMITS.authorBytes),
          body: text(note.body, REPOSITORY_REVIEW_NOTES_LIMITS.bodyBytes),
        }),
      );
    }
    return Object.freeze(result);
  } catch {
    return fail();
  }
}

export function serializeRepositoryReviewNotes(
  session: RepositoryReviewSession,
  input: unknown,
): string {
  const notes = validateRepositoryReviewNotes(session, input);
  const output =
    JSON.stringify(
      {
        schema_version: "1.0.0",
        scope: "local_repository_review_notes",
        trust: "unverified_local_notes",
        authorization: false,
        binding: source(session),
        notes,
      },
      null,
      2,
    ) + "\n";
  if (
    new TextEncoder().encode(output).byteLength >
    REPOSITORY_REVIEW_NOTES_LIMITS.bytes
  )
    return fail();
  return output;
}

export function parseRepositoryReviewNotes(
  session: RepositoryReviewSession,
  input: string,
): readonly RepositoryReviewNote[] {
  try {
    const expected = source(session);
    if (
      typeof input !== "string" ||
      input.length > REPOSITORY_REVIEW_NOTES_LIMITS.bytes ||
      new TextEncoder().encode(input).byteLength >
        REPOSITORY_REVIEW_NOTES_LIMITS.bytes
    )
      return fail();
    const value = exact(readRepositoryComparisonJson(input), [
      "schema_version",
      "scope",
      "trust",
      "authorization",
      "binding",
      "notes",
    ]);
    if (
      value.schema_version !== "1.0.0" ||
      value.scope !== "local_repository_review_notes" ||
      value.trust !== "unverified_local_notes" ||
      value.authorization !== false
    )
      return fail();
    const binding = exact(value.binding, [
      "report_sha256",
      "object_format",
      "base",
      "head",
    ]);
    if (
      binding.report_sha256 !== expected.report_sha256 ||
      binding.object_format !== expected.object_format
    )
      return fail();
    for (const side of ["base", "head"] as const) {
      const commit = exact(binding[side], ["commit_sha", "tree_sha"]);
      if (
        commit.commit_sha !== expected[side].commit_sha ||
        commit.tree_sha !== expected[side].tree_sha
      )
        return fail();
    }
    const notes = validateRepositoryReviewNotes(session, value.notes);
    serializeRepositoryReviewNotes(session, notes);
    return notes;
  } catch {
    return fail();
  }
}
