import { TenantError, validateTenantKind } from "./tenant.js";
import { isIdentityId } from "./identity.js";
/** A bounded, versioned JSON subset. Not a claim of full RFC8785 support. */
export const CANONICALIZATION_VERSION = "zt-json-v1" as const;
export interface ContentDigest {
  readonly algorithm: "sha256";
  readonly canonicalization_version: typeof CANONICALIZATION_VERSION;
  readonly schema_id: string;
  readonly content_hash: string;
  readonly content_bytes: number;
}
export type RevisionStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "superseded"
  | "retired";
export type RevisionAction =
  | "submit"
  | "approve"
  | "reject"
  | "supersede"
  | "retire";
export interface RevisionRelation {
  readonly kind: string;
  readonly source: "declared" | "derived";
  readonly target_object_id: string;
  readonly target_revision_id: string;
  readonly target_hash: string;
}
export interface RevisionHead extends ContentDigest {
  readonly org_id: string;
  readonly object_id: string;
  readonly object_version: number;
  readonly revision_id: string;
  readonly revision_number: number;
  readonly parent_revision_id: string | null;
  readonly status: RevisionStatus;
  readonly created_by: string;
  readonly created_at: string;
  readonly changed_by: string;
  readonly changed_at: string;
}
export type RevisionCommand = {
  readonly object_id: string;
  readonly expected_version: number;
} & (
  | {
      readonly action: "revise";
      readonly content: ContentDigest;
      readonly relations: readonly RevisionRelation[];
    }
  | {
      readonly action: RevisionAction;
      readonly revision_id: string;
      readonly content_hash: string;
    }
);
/** Conflict is data, returned only AFTER the enclosing transaction's final authorization check. */
export interface RevisionResult {
  readonly outcome: "applied" | "conflict" | "invalid_transition";
  readonly expected_version: number;
  readonly current: RevisionHead | null;
}
export interface RevisionUnitOfWork {
  command(command: RevisionCommand): Promise<RevisionResult>;
  head(objectId: string): Promise<RevisionHead | null>;
  snapshot(
    objectId: string,
    objectVersion: number,
  ): Promise<RevisionHead | null>;
  relations(
    objectId: string,
    revisionId: string,
  ): Promise<readonly RevisionRelation[]>;
}
function fail(): never {
  throw new TenantError("invalid_input");
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function exact(
  v: unknown,
  keys: readonly string[],
): asserts v is Record<string, unknown> {
  if (
    !record(v) ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    fail();
}
export const isContentHash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validateVersion(v: unknown, minimum = 0): void {
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < minimum ||
    v > 2147483646
  )
    fail();
}
export function validateContentDigest(v: ContentDigest): void {
  exact(v, [
    "algorithm",
    "canonicalization_version",
    "schema_id",
    "content_hash",
    "content_bytes",
  ]);
  if (
    v.algorithm !== "sha256" ||
    v.canonicalization_version !== CANONICALIZATION_VERSION ||
    !isContentHash(v.content_hash) ||
    !Number.isInteger(v.content_bytes) ||
    v.content_bytes < 1 ||
    v.content_bytes > 65536
  )
    fail();
  validateTenantKind(v.schema_id);
}
export function validateRevisionRelation(r: RevisionRelation): void {
  exact(r, [
    "kind",
    "source",
    "target_object_id",
    "target_revision_id",
    "target_hash",
  ]);
  validateTenantKind(r.kind);
  if (
    !["declared", "derived"].includes(r.source) ||
    !isIdentityId(r.target_object_id) ||
    !isIdentityId(r.target_revision_id) ||
    !isContentHash(r.target_hash)
  )
    fail();
}
export function validateRevisionCommand(c: RevisionCommand): void {
  if (!record(c)) fail();
  exact(
    c,
    c.action === "revise"
      ? ["object_id", "expected_version", "action", "content", "relations"]
      : [
          "object_id",
          "expected_version",
          "action",
          "revision_id",
          "content_hash",
        ],
  );
  if (!isIdentityId(c.object_id)) fail();
  validateVersion(c.expected_version);
  if (c.expected_version === 2147483646) fail();
  if (c.action === "revise") {
    validateContentDigest(c.content);
    if (!Array.isArray(c.relations) || c.relations.length > 32) fail();
    const seen = new Set<string>();
    for (const r of c.relations) {
      validateRevisionRelation(r);
      const key = JSON.stringify([
        r.kind,
        r.source,
        r.target_object_id,
        r.target_revision_id,
      ]);
      if (seen.has(key)) fail();
      seen.add(key);
    }
  } else if (
    !["submit", "approve", "reject", "supersede", "retire"].includes(
      c.action,
    ) ||
    !isIdentityId(c.revision_id) ||
    !isContentHash(c.content_hash)
  )
    fail();
}
/** Pure reference rule; database independently enforces the same finite transitions. */
export function nextRevisionStatus(
  status: RevisionStatus | null,
  action: RevisionCommand["action"],
): RevisionStatus | null {
  if (action === "revise")
    return status === null || status === "draft" || status === "superseded"
      ? "draft"
      : null;
  if (action === "submit" && status === "draft") return "in_review";
  if (action === "reject" && status === "in_review") return "draft";
  if (action === "approve" && status === "in_review") return "approved";
  if (action === "supersede" && status === "approved") return "superseded";
  if (action === "retire" && (status === "approved" || status === "superseded"))
    return "retired";
  return null;
}
/** Sorted UTF-16 object keys, no Unicode normalization, integers only, no accessors/toJSON/symbols.
 * Accept parsed/trusted in-memory JSON; duplicate raw JSON keys must be rejected by the domain parser.
 * The limits bound canonical bytes, depth and visited nodes. No content is persisted by this function. */
export function canonicalizeContent(value: unknown): string {
  let nodes = 0,
    bytes = 0;
  const visiting = new Set<object>(),
    encoder = new TextEncoder();
  const emit = (s: string): string => {
    bytes += encoder.encode(s).byteLength;
    if (bytes > 65536) fail();
    return s;
  };
  const string = (s: string): string => {
    if (
      s.length > 65536 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        s,
      )
    )
      fail();
    return emit(JSON.stringify(s));
  };
  const visit = (v: unknown, depth: number): string => {
    if (++nodes > 4096 || depth > 32) fail();
    if (v === null) return emit("null");
    if (typeof v === "string") return string(v);
    if (typeof v === "boolean") return emit(String(v));
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) fail();
      return emit(String(v));
    }
    if (!v || typeof v !== "object" || visiting.has(v)) fail();
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (!array && proto !== Object.prototype && proto !== null) fail();
    if (Object.getOwnPropertySymbols(v).length) fail();
    const props = Object.getOwnPropertyDescriptors(v);
    const names = Object.keys(props).filter((k) => !array || k !== "length");
    if (
      names.length > 4096 ||
      names.some((k) => !props[k]?.enumerable || !("value" in props[k]!))
    )
      fail();
    visiting.add(v);
    let result: string;
    if (array) {
      if (
        v.length > 4096 ||
        names.length !== v.length ||
        names.some((k, i) => k !== String(i))
      )
        fail();
      result =
        emit("[") +
        names
          .map(
            (k, i) => (i ? emit(",") : "") + visit(props[k]!.value, depth + 1),
          )
          .join("") +
        emit("]");
    } else {
      result =
        emit("{") +
        names
          .sort()
          .map(
            (k, i) =>
              (i ? emit(",") : "") +
              string(k) +
              emit(":") +
              visit(props[k]!.value, depth + 1),
          )
          .join("") +
        emit("}");
    }
    visiting.delete(v);
    return result;
  };
  return visit(value, 0);
}
