import { isIdentityId, isContextVersion } from "@zentwine/domain";
import { isAction, type Action, type Environment } from "./rules.js";
/** Only catalog calls are currently metered. Not tokens, money, or supplier settlement. */
export const DELEGATION_VERSION = "1.0.0" as const;
export const MAX_CHAIN_DEPTH = 8;
export const MAX_DELEGATION_MS = 8 * 60 * 60 * 1000;
export const MAX_TOOL_CALLS = 1000000;
export interface AgentIdentity {
  readonly id: string;
  readonly org_id: string;
  readonly accountable_owner_id: string;
  readonly display_name: string;
  readonly object_version: number;
  readonly disabled: boolean;
}
export interface ScopeEntry {
  readonly resource_id: string;
  readonly actions: readonly Action[];
  readonly environment: Environment;
}
export interface DelegationTerms {
  readonly scopes: readonly ScopeEntry[];
  readonly not_before: number;
  readonly expires_at: number;
  readonly max_calls: number;
  readonly max_depth: number;
}
export interface DelegationRequest {
  readonly request_id: string;
  readonly agent_id: string;
  readonly terms: DelegationTerms;
}
export type DelegationErrorCode =
  | "invalid_input"
  | "authentication_required"
  | "unavailable_resource"
  | "forbidden"
  | "version_conflict"
  | "approval_required"
  | "unavailable"
  | "budget_exhausted";
export class DelegationError extends Error {
  constructor(readonly code: DelegationErrorCode) {
    super(code);
    this.name = "DelegationError";
  }
}
export function remainingCalls(
  limit: number,
  reserved: number,
  used: number,
): number {
  if (
    ![limit, reserved, used].every(
      (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOOL_CALLS,
    ) ||
    limit < 1 ||
    reserved + used > limit
  )
    throw new DelegationError("invalid_input");
  return limit - reserved - used;
}
export function validTerms(t: DelegationTerms): boolean {
  return (
    !!t &&
    Object.keys(t).length === 5 &&
    Array.isArray(t.scopes) &&
    t.scopes.length > 0 &&
    t.scopes.length <= 16 &&
    new Set(t.scopes.map((s) => s?.resource_id)).size === t.scopes.length &&
    t.scopes.every(
      (s) =>
        !!s &&
        Object.keys(s).length === 3 &&
        isIdentityId(s.resource_id) &&
        ["development", "staging", "production"].includes(s.environment) &&
        Array.isArray(s.actions) &&
        s.actions.length > 0 &&
        s.actions.length <= 6 &&
        s.actions.every(isAction) &&
        new Set(s.actions).size === s.actions.length &&
        s.actions.includes("resource.read"),
    ) &&
    Number.isSafeInteger(t.not_before) &&
    t.not_before >= 0 &&
    Number.isSafeInteger(t.expires_at) &&
    t.expires_at <= 8.64e15 &&
    t.expires_at > t.not_before &&
    t.expires_at - t.not_before <= MAX_DELEGATION_MS &&
    Number.isSafeInteger(t.max_calls) &&
    t.max_calls >= 1 &&
    t.max_calls <= MAX_TOOL_CALLS &&
    Number.isSafeInteger(t.max_depth) &&
    t.max_depth >= 1 &&
    t.max_depth <= MAX_CHAIN_DEPTH
  );
}
export function validateRequest(r: DelegationRequest): void {
  if (
    !r ||
    Object.keys(r).length !== 3 ||
    !isIdentityId(r.request_id) ||
    !isIdentityId(r.agent_id) ||
    !validTerms(r.terms)
  )
    throw new DelegationError("invalid_input");
}
/** Attenuation is an intersection, never a union of grants from different roots. */
export function isAttenuation(
  parent: DelegationTerms,
  child: DelegationTerms,
): boolean {
  return (
    validTerms(parent) &&
    validTerms(child) &&
    child.not_before >= parent.not_before &&
    child.expires_at <= parent.expires_at &&
    child.max_calls <= parent.max_calls &&
    child.max_depth < parent.max_depth &&
    child.scopes.every((c) =>
      parent.scopes.some(
        (p) =>
          p.resource_id === c.resource_id &&
          p.environment === c.environment &&
          c.actions.every((a) => p.actions.includes(a)),
      ),
    )
  );
}
export function allowsScope(
  t: DelegationTerms,
  rid: string,
  action: string,
  environment: Environment,
  now: number,
): boolean {
  return (
    validTerms(t) &&
    Number.isFinite(now) &&
    now >= t.not_before &&
    now < t.expires_at &&
    isAction(action) &&
    t.scopes.some(
      (s) =>
        s.resource_id === rid &&
        s.environment === environment &&
        s.actions.includes(action),
    )
  );
}
export interface PolicySnapshot {
  readonly schema_version: typeof DELEGATION_VERSION;
  readonly canonicalization_version: "sorted-json-v1";
  readonly delegation_id: string;
  readonly parent_id: string | null;
  readonly agent_id: string;
  readonly agent_version: number;
  readonly org_id: string;
  readonly accountable_owner_id: string;
  readonly owner_auth_version: number;
  readonly membership_version: number;
  readonly organization_version: number;
  readonly owner_role: import("@zentwine/domain").MemberRole;
  readonly resource_versions: readonly {
    readonly resource_id: string;
    readonly object_version: number;
  }[];
  readonly policy_revision: number;
  readonly terms: DelegationTerms;
  readonly created_at: string;
  readonly reusable: false;
}
export interface DelegationView {
  readonly id: string;
  readonly parent_id: string | null;
  readonly root_id: string;
  readonly agent: AgentIdentity;
  readonly terms: DelegationTerms;
  readonly reserved_calls: number;
  readonly used_calls: number;
  readonly remaining_calls: number;
  readonly revoked: boolean;
  readonly object_version: number;
  readonly snapshot: PolicySnapshot;
  readonly snapshot_sha256: string;
}
export interface IssuedDelegation {
  readonly created: boolean;
  readonly delegation: DelegationView;
}
export interface AgentCredentialScope {
  readonly credential_digest: string;
}
export interface AgentToolRequest {
  readonly request_id: string;
  readonly resource_id: string;
  readonly operation: "catalog.read" | "catalog.rename";
  readonly display_name?: string;
  readonly expected_version?: number;
  readonly expected_policy_revision?: number;
}
export function validateToolRequest(r: AgentToolRequest): void {
  if (!r || !isIdentityId(r.request_id) || !isIdentityId(r.resource_id))
    throw new DelegationError("invalid_input");
  const keys =
    r.operation === "catalog.read"
      ? ["request_id", "resource_id", "operation"]
      : r.operation === "catalog.rename"
        ? [
            "request_id",
            "resource_id",
            "operation",
            "display_name",
            "expected_version",
            "expected_policy_revision",
          ]
        : [];
  if (
    !keys.length ||
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    throw new DelegationError("invalid_input");
  if (
    r.operation === "catalog.rename" &&
    (typeof r.display_name !== "string" ||
      !r.display_name.trim() ||
      r.display_name.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(r.display_name) ||
      !isContextVersion(r.expected_version) ||
      !isContextVersion(r.expected_policy_revision))
  )
    throw new DelegationError("invalid_input");
}
/** For bounded, validated JSON data only; neither a signature nor an input sanitizer. */
export function canonicalSnapshot(value: unknown): string {
  function walk(v: unknown, depth: number): string {
    if (depth > 16) throw new DelegationError("invalid_input");
    if (v === null || typeof v === "string" || typeof v === "boolean")
      return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v))
      return "[" + v.map((x) => walk(x, depth + 1)).join(",") + "]";
    if (
      v &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    )
      return (
        "{" +
        Object.keys(v)
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) +
              ":" +
              walk((v as Record<string, unknown>)[k], depth + 1),
          )
          .join(",") +
        "}"
      );
    throw new DelegationError("invalid_input");
  }
  return walk(value, 0);
}
export interface AgentToolResult {
  readonly delegation_id: string;
  readonly accountable_owner_id: string;
  readonly snapshot_sha256: string;
  readonly resource: import("./rules.js").PolicyResource;
  readonly decision: import("./rules.js").PolicyDecision;
  readonly replayed: boolean;
}
export interface AgentRepository {
  register(
    scope: import("./rules.js").PolicyScope,
    requestId: string,
    name: string,
  ): Promise<AgentIdentity>;
  disable(
    scope: import("./rules.js").PolicyScope,
    agentId: string,
    expected: number,
  ): Promise<AgentIdentity>;
  issueRoot(
    scope: import("./rules.js").PolicyScope,
    request: DelegationRequest,
    digest: string,
  ): Promise<IssuedDelegation>;
  delegate(
    scope: AgentCredentialScope,
    request: DelegationRequest,
    digest: string,
  ): Promise<IssuedDelegation>;
  inspect(scope: AgentCredentialScope): Promise<DelegationView>;
  inspectOwned(
    scope: import("./rules.js").PolicyScope,
    id: string,
  ): Promise<DelegationView>;
  revoke(
    scope: import("./rules.js").PolicyScope,
    id: string,
    expected: number,
  ): Promise<DelegationView>;
  invoke(
    scope: AgentCredentialScope,
    request: AgentToolRequest,
  ): Promise<AgentToolResult>;
}
