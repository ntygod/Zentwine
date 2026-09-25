import { isIdentityId, isContextVersion } from "@zentwine/domain";
import type {
  PolicyScope,
  PolicyResource,
  PolicyDecision,
  Environment,
} from "./rules.js";

export const APPROVAL_VERSION = "1.0.0" as const;
export const APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
export const ACTION_PERMIT_LIFETIME_MS = 2 * 60 * 1000;
export type ApprovalState =
  | "pending"
  | "approved"
  | "issued"
  | "rejected"
  | "revoked"
  | "consumed";
export type ApprovalErrorCode =
  | "invalid_input"
  | "authentication_required"
  | "forbidden"
  | "unavailable_resource"
  | "version_conflict"
  | "approval_required"
  | "unavailable";
export class ApprovalError extends Error {
  constructor(readonly code: ApprovalErrorCode) {
    super(code);
    this.name = "ApprovalError";
  }
}
export interface ApprovalInput {
  readonly request_id: string;
  readonly resource_id: string;
  readonly operation: "catalog.rename";
  readonly display_name: string;
  readonly expected_version: number;
  readonly expected_policy_revision: number;
  readonly review: "required" | "policy";
}
export interface ApprovalGuard {
  readonly expected_version: number;
  readonly content_hash: string;
}
export interface ApprovalExecution extends ApprovalGuard {
  readonly resource_id: string;
  readonly operation: "catalog.rename";
  readonly display_name: string;
  readonly expected_resource_version: number;
  readonly expected_policy_revision: number;
}
export interface ApprovalBinding {
  readonly schema_version: typeof APPROVAL_VERSION;
  readonly canonicalization_version: "sorted-json-v1";
  readonly org_id: string;
  readonly requester_id: string;
  readonly operation: "catalog.rename";
  readonly action: "resource.update";
  readonly resource_id: string;
  readonly resource_version: number;
  readonly environment: Environment;
  readonly display_name: string;
  readonly policy_revision: number;
  readonly auth_version: number;
  readonly membership_version: number;
  readonly organization_version: number;
}
export interface ApprovalView {
  readonly id: string;
  readonly org_id: string;
  readonly requester_id: string;
  readonly object_version: number;
  readonly state: ApprovalState;
  readonly content_hash: string;
  readonly binding: ApprovalBinding;
  readonly expires_at: string;
  readonly decision: null | {
    readonly actor_id: string;
    readonly source: "human" | "preauthorized_policy";
    readonly outcome: "approve" | "reject";
  };
  readonly receipt: null | {
    readonly resource: PolicyResource;
    readonly content_hash: string;
    readonly approval_id: string;
  };
  readonly reusable: false;
}
export interface ApprovalEvent {
  readonly cursor: string;
  readonly event_id: string;
  readonly approval_id: string;
  readonly kind: string;
  readonly version: number;
  readonly reason: string;
  readonly occurred_at: string;
}
export const validHash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validApprovalName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    !!v.trim() &&
    v.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(v)
  );
}
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    Object.getPrototypeOf(v) === Object.prototype &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
export function validateApprovalInput(v: unknown): asserts v is ApprovalInput {
  if (
    !exact(v, [
      "request_id",
      "resource_id",
      "operation",
      "display_name",
      "expected_version",
      "expected_policy_revision",
      "review",
    ]) ||
    !isIdentityId(v["request_id"]) ||
    !isIdentityId(v["resource_id"]) ||
    v["operation"] !== "catalog.rename" ||
    !validApprovalName(v["display_name"]) ||
    !isContextVersion(v["expected_version"]) ||
    !isContextVersion(v["expected_policy_revision"]) ||
    !["required", "policy"].includes(String(v["review"]))
  )
    throw new ApprovalError("invalid_input");
}
export function validateApprovalGuard(v: unknown): asserts v is ApprovalGuard {
  if (
    !exact(v, ["expected_version", "content_hash"]) ||
    !isContextVersion(v["expected_version"]) ||
    !validHash(v["content_hash"])
  )
    throw new ApprovalError("invalid_input");
}
export function validateApprovalExecution(
  v: unknown,
): asserts v is ApprovalExecution {
  if (
    !exact(v, [
      "expected_version",
      "content_hash",
      "resource_id",
      "operation",
      "display_name",
      "expected_resource_version",
      "expected_policy_revision",
    ]) ||
    !isContextVersion(v["expected_version"]) ||
    !validHash(v["content_hash"]) ||
    !isIdentityId(v["resource_id"]) ||
    v["operation"] !== "catalog.rename" ||
    !validApprovalName(v["display_name"]) ||
    !isContextVersion(v["expected_resource_version"]) ||
    !isContextVersion(v["expected_policy_revision"])
  )
    throw new ApprovalError("invalid_input");
}
/** A policy allow can be recorded as preauthorization; never label it as a human approval. */
export function approvalSource(
  d: PolicyDecision,
  review: ApprovalInput["review"],
): "pending" | "preauthorized_policy" {
  if (d.outcome === "deny") throw new ApprovalError("forbidden");
  return d.outcome === "allow" && review === "policy"
    ? "preauthorized_policy"
    : "pending";
}
export function requireIndependentReviewer(
  requester: string,
  actor: string,
  role: string,
  readable: PolicyDecision,
  writable: PolicyDecision,
): void {
  if (
    requester === actor ||
    role !== "owner" ||
    readable.outcome !== "allow" ||
    writable.outcome === "deny"
  )
    throw new ApprovalError("forbidden");
}
export function matchesApprovedOperation(
  b: ApprovalBinding,
  v: ApprovalExecution,
): boolean {
  return (
    b.operation === v.operation &&
    b.resource_id === v.resource_id &&
    b.display_name === v.display_name &&
    b.resource_version === v.expected_resource_version &&
    b.policy_revision === v.expected_policy_revision
  );
}
export function validApprovalCursor(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(v) &&
    BigInt(v) <= 9223372036854775807n
  );
}
/** These ports require trusted server-bound human scope. They do not mint Agent delegations. */
export interface ApprovalRepository {
  request(scope: PolicyScope, input: ApprovalInput): Promise<ApprovalView>;
  inspect(scope: PolicyScope, id: string): Promise<ApprovalView>;
  decide(
    scope: PolicyScope,
    id: string,
    guard: ApprovalGuard,
    outcome: "approve" | "reject",
  ): Promise<ApprovalView>;
  issuePermit(
    scope: PolicyScope,
    id: string,
    guard: ApprovalGuard,
    digest: string,
  ): Promise<{ approval: ApprovalView; expires_at: string }>;
  execute(
    scope: PolicyScope,
    id: string,
    input: ApprovalExecution,
    digest: string,
  ): Promise<ApprovalView>;
  revoke(
    scope: PolicyScope,
    id: string,
    guard: ApprovalGuard,
  ): Promise<ApprovalView>;
  events(
    scope: PolicyScope,
    after: string,
    limit: number,
  ): Promise<{
    events: readonly ApprovalEvent[];
    next_cursor: string;
    authorization: false;
  }>;
}
