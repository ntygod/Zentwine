/** Explicit local reconciliation. A matching report/ID does not authenticate an author. */
import {
  parseRepositoryReviewNotes,
  serializeRepositoryReviewNotes,
  validateRepositoryReviewNotes,
  REPOSITORY_REVIEW_NOTES_LIMITS,
  type RepositoryReviewNote,
  type RepositoryReviewSession,
} from "./repository-review-notes.js";

export type RepositoryReviewMergeChoice = Readonly<{
  id: string;
  keep: "current" | "incoming";
}>;
export type RepositoryReviewMergePreview = Readonly<{
  current: readonly RepositoryReviewNote[];
  incoming: readonly RepositoryReviewNote[];
  additions: readonly RepositoryReviewNote[];
  duplicates: readonly string[];
  conflicts: readonly Readonly<{
    id: string;
    current: RepositoryReviewNote;
    incoming: RepositoryReviewNote;
  }>[];
  total: number;
}>;
const previews = new WeakMap<
  RepositoryReviewMergePreview,
  { session: RepositoryReviewSession; baseline: string }
>();
const fail = (): never => {
  throw new TypeError("Invalid, stale or oversized local review merge");
};
function equal(a: RepositoryReviewNote, b: RepositoryReviewNote): boolean {
  return (
    a.id === b.id &&
    a.path === b.path &&
    a.kind === b.kind &&
    a.author === b.author &&
    a.body === b.body
  );
}

/** Parse one existing v1 interchange; never change the current set while previewing. */
export function previewRepositoryReviewMerge(
  session: RepositoryReviewSession,
  current: unknown,
  incomingJson: string,
): RepositoryReviewMergePreview {
  try {
    const before = validateRepositoryReviewNotes(session, current);
    const baseline = serializeRepositoryReviewNotes(session, before);
    const incoming = parseRepositoryReviewNotes(session, incomingJson);
    const byId = new Map(before.map((note) => [note.id, note]));
    const additions: RepositoryReviewNote[] = [];
    const duplicates: string[] = [];
    const conflicts: {
      id: string;
      current: RepositoryReviewNote;
      incoming: RepositoryReviewNote;
    }[] = [];
    for (const note of incoming) {
      const existing = byId.get(note.id);
      if (!existing) additions.push(note);
      else if (equal(existing, note)) duplicates.push(note.id);
      else
        conflicts.push(
          Object.freeze({ id: note.id, current: existing, incoming: note }),
        );
    }
    const total = before.length + additions.length;
    if (total > REPOSITORY_REVIEW_NOTES_LIMITS.notes) return fail();
    const preview = Object.freeze({
      current: before,
      incoming,
      additions: Object.freeze(additions),
      duplicates: Object.freeze(duplicates),
      conflicts: Object.freeze(conflicts),
      total,
    });
    previews.set(preview, { session, baseline });
    return preview;
  } catch {
    return fail();
  }
}

/** Every conflict needs one own data-property choice, with no extra decisions. */
function decisions(input: unknown, preview: RepositoryReviewMergePreview) {
  if (
    !Array.isArray(input) ||
    input.length !== preview.conflicts.length ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    return fail();
  const expected = new Set(preview.conflicts.map((conflict) => conflict.id));
  const result = new Map<string, "current" | "incoming">();
  for (let i = 0; i < input.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail();
    const value: unknown = descriptor.value;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 2
    )
      return fail();
    const props = Object.getOwnPropertyDescriptors(value);
    if (
      !props.id ||
      !props.keep ||
      !Object.hasOwn(props.id, "value") ||
      !Object.hasOwn(props.keep, "value")
    )
      return fail();
    const id: unknown = props.id.value,
      keep: unknown = props.keep.value;
    if (
      typeof id !== "string" ||
      !expected.has(id) ||
      result.has(id) ||
      (keep !== "current" && keep !== "incoming")
    )
      return fail();
    result.set(id, keep);
  }
  return result;
}

/** Return a complete exportable snapshot or throw; neither input nor preview is mutated. */
export function applyRepositoryReviewMerge(
  session: RepositoryReviewSession,
  preview: RepositoryReviewMergePreview,
  current: unknown,
  choices: unknown,
): readonly RepositoryReviewNote[] {
  try {
    const owned = previews.get(preview);
    if (
      !owned ||
      owned.session !== session ||
      serializeRepositoryReviewNotes(session, current) !== owned.baseline
    )
      return fail();
    const chosen = decisions(choices, preview);
    const incomingById = new Map(
      preview.incoming.map((note) => [note.id, note]),
    );
    const combined = preview.current.map((note) =>
      chosen.get(note.id) === "incoming" ? incomingById.get(note.id)! : note,
    );
    combined.push(...preview.additions);
    const result = validateRepositoryReviewNotes(session, combined);
    // Combined escaping/path overhead can exceed the cap even when both inputs fit.
    serializeRepositoryReviewNotes(session, result);
    return result;
  } catch {
    return fail();
  }
}
