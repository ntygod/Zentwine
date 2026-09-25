import {
  isIdentityId,
  isContextVersion,
  type MemberRole,
} from "@zentwine/domain";

/** Policy results are diagnostic facts, NOT portable execution capabilities. */
export const POLICY_VERSION = "1.0.0" as const;
export const RESOURCE_KINDS = [
  "project",
  "work_package",
  "workspace",
  "repository",
  "artifact",
  "release",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type Environment = "development" | "staging" | "production";
export type ScopedRole = "reader" | "editor";
export const ACTIONS = Object.freeze({
  "resource.read": Object.freeze({ mutation: false, kind: null }),
  "resource.update": Object.freeze({ mutation: true, kind: null }),
  "resource.export": Object.freeze({ mutation: false, kind: null }),
  "workspace.write": Object.freeze({ mutation: true, kind: "workspace" }),
  "repository.write": Object.freeze({ mutation: true, kind: "repository" }),
  "release.deploy": Object.freeze({ mutation: true, kind: "release" }),
});
export type Action = keyof typeof ACTIONS;
export function isAction(v: unknown): v is Action {
  return typeof v === "string" && Object.hasOwn(ACTIONS, v);
}
export interface PolicyResource {
  readonly id: string;
  readonly org_id: string;
  readonly kind: ResourceKind;
  readonly display_name: string;
  readonly visibility: "organization" | "restricted";
  readonly environment: Environment;
  readonly sensitivity: "internal" | "confidential";
  readonly owner_human_id: string | null;
  readonly status: "active" | "archived";
  readonly object_version: number;
}
export interface ScopedRule {
  readonly id: string;
  readonly org_id: string;
  readonly human_id: string;
  readonly resource_id: string;
  readonly valid_from: number;
  readonly expires_at: number | null;
  readonly revoked: boolean;
}
export interface RoleBinding extends ScopedRule {
  readonly role: ScopedRole;
}
export interface ResourceGrant extends ScopedRule {
  readonly action: Action;
  readonly effect: "allow" | "deny";
}
export interface PolicyFacts {
  readonly principal_kind: "human";
  readonly human_id: string;
  readonly org_id: string;
  readonly membership_role: MemberRole;
  readonly membership_kind?: "member" | "guest";
  readonly membership_version: number;
  readonly session_valid_until: number;
  readonly observed_at: number;
  readonly resource: PolicyResource;
  readonly policy_revision: number;
  readonly write_mode: "active" | "read_only";
  readonly bindings: readonly RoleBinding[];
  readonly grants: readonly ResourceGrant[];
}
export type PolicyReason =
  | "allowed"
  | "invalid_facts"
  | "unknown_action"
  | "resource_unavailable"
  | "stale_facts"
  | "action_resource_mismatch"
  | "explicit_deny"
  | "no_permission"
  | "restricted_resource"
  | "read_only_environment"
  | "approval_required";
export interface PolicyDecision {
  readonly schema_version: typeof POLICY_VERSION;
  readonly outcome: "allow" | "deny" | "needs_approval";
  readonly reason: PolicyReason;
  readonly policy_version: typeof POLICY_VERSION;
  readonly policy_revision: number;
  readonly membership_version: number;
  readonly resource_version: number;
  readonly evaluated_at: string;
  readonly expires_at: string;
  readonly reusable: false;
}
const epoch = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
const memberRoles = ["owner", "member", "viewer"];
function validRule(r: ScopedRule): boolean {
  return (
    !!r &&
    isIdentityId(r.id) &&
    isIdentityId(r.org_id) &&
    isIdentityId(r.human_id) &&
    isIdentityId(r.resource_id) &&
    epoch(r.valid_from) &&
    typeof r.revoked === "boolean" &&
    (r.expires_at === null ||
      (epoch(r.expires_at) && r.expires_at > r.valid_from))
  );
}
export function validResource(r: PolicyResource): boolean {
  return (
    !!r &&
    isIdentityId(r.id) &&
    isIdentityId(r.org_id) &&
    RESOURCE_KINDS.includes(r.kind) &&
    isContextVersion(r.object_version) &&
    typeof r.display_name === "string" &&
    r.display_name.trim().length > 0 &&
    r.display_name.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(r.display_name) &&
    ["organization", "restricted"].includes(r.visibility) &&
    ["development", "staging", "production"].includes(r.environment) &&
    ["internal", "confidential"].includes(r.sensitivity) &&
    ["active", "archived"].includes(r.status) &&
    (r.owner_human_id === null || isIdentityId(r.owner_human_id))
  );
}
function validFacts(f: PolicyFacts): boolean {
  return (
    !!f &&
    f.principal_kind === "human" &&
    isIdentityId(f.human_id) &&
    isIdentityId(f.org_id) &&
    memberRoles.includes(f.membership_role) &&
    (f.membership_kind === undefined ||
      ["member", "guest"].includes(f.membership_kind)) &&
    isContextVersion(f.membership_version) &&
    isContextVersion(f.policy_revision) &&
    epoch(f.observed_at) &&
    epoch(f.session_valid_until) &&
    ["active", "read_only"].includes(f.write_mode) &&
    validResource(f.resource) &&
    Array.isArray(f.bindings) &&
    f.bindings.length <= 100 &&
    Array.isArray(f.grants) &&
    f.grants.length <= 100 &&
    f.bindings.every(
      (b) => validRule(b) && ["reader", "editor"].includes(b.role),
    ) &&
    f.grants.every(
      (g) =>
        validRule(g) &&
        isAction(g.action) &&
        ["allow", "deny"].includes(g.effect),
    )
  );
}
/** Pure deterministic RBAC + exact resource relationships + server-owned attributes. */
export function evaluatePolicy(
  f: PolicyFacts,
  action: string,
  now: number,
): PolicyDecision {
  const time = epoch(now) ? now : 0;
  const valid = validFacts(f) && epoch(now);
  let deadline = time;
  if (valid) deadline = Math.min(time + 15000, f.session_valid_until);
  const result = (
    outcome: PolicyDecision["outcome"],
    reason: PolicyReason,
  ): PolicyDecision =>
    Object.freeze({
      schema_version: POLICY_VERSION,
      outcome,
      reason,
      policy_version: POLICY_VERSION,
      policy_revision: valid ? f.policy_revision : 0,
      membership_version: valid ? f.membership_version : 0,
      resource_version: valid ? f.resource.object_version : 0,
      evaluated_at: new Date(time).toISOString(),
      expires_at: new Date(Math.max(time, deadline)).toISOString(),
      reusable: false,
    });
  if (!valid) return result("deny", "invalid_facts");
  if (!isAction(action)) return result("deny", "unknown_action");
  if (f.org_id !== f.resource.org_id || f.resource.status !== "active")
    return result("deny", "resource_unavailable");
  if (
    now < f.observed_at ||
    now - f.observed_at > 30000 ||
    now >= f.session_valid_until
  )
    return result("deny", "stale_facts");
  const definition = ACTIONS[action];
  if (definition.kind !== null && definition.kind !== f.resource.kind)
    return result("deny", "action_resource_mismatch");
  const matches = (r: ScopedRule): boolean =>
    r.org_id === f.org_id &&
    r.resource_id === f.resource.id &&
    r.human_id === f.human_id &&
    !r.revoked;
  // Include both expiry and future activation boundaries. Still never cache the decision as a permit.
  for (const rule of [...f.bindings, ...f.grants].filter(matches)) {
    if (rule.valid_from > now) deadline = Math.min(deadline, rule.valid_from);
    if (rule.expires_at !== null && rule.expires_at > now)
      deadline = Math.min(deadline, rule.expires_at);
  }
  const active = (r: ScopedRule): boolean =>
    matches(r) &&
    r.valid_from <= now &&
    (r.expires_at === null || now < r.expires_at);
  const grants = f.grants.filter((g) => active(g) && g.action === action);
  const bindings = f.bindings.filter(active);
  if (grants.some((g) => g.effect === "deny"))
    return result("deny", "explicit_deny");
  const explicit = grants.some((g) => g.effect === "allow");
  // A guest never inherits organization visibility or owner/writer privileges.
  if (f.membership_kind === "guest") {
    if (action !== "resource.read" || (!explicit && !bindings.length))
      return result("deny", "no_permission");
    return result("allow", "allowed");
  }
  const owned = f.resource.owner_human_id === f.human_id;
  if (
    f.resource.visibility === "restricted" &&
    !owned &&
    !bindings.length &&
    !explicit
  )
    return result("deny", "restricted_resource");
  const orgWriter =
    f.membership_role === "owner" || f.membership_role === "member";
  const baseline =
    (f.resource.visibility === "organization" || owned) &&
    (action === "resource.read" ||
      (["resource.update", "workspace.write", "repository.write"].includes(
        action,
      ) &&
        orgWriter) ||
      (["resource.export", "release.deploy"].includes(action) &&
        f.membership_role === "owner"));
  const scoped = bindings.some(
    (b) =>
      action === "resource.read" ||
      (b.role === "editor" &&
        ["resource.update", "workspace.write", "repository.write"].includes(
          action,
        )),
  );
  if (!baseline && !scoped && !explicit) return result("deny", "no_permission");
  if (definition.mutation && f.write_mode === "read_only")
    return result("deny", "read_only_environment");
  if (
    action === "release.deploy" ||
    (definition.mutation && f.resource.environment === "production") ||
    (definition.mutation &&
      f.resource.environment === "staging" &&
      f.membership_role !== "owner") ||
    (action === "resource.export" && f.resource.sensitivity === "confidential")
  )
    return result("needs_approval", "approval_required");
  return result("allow", "allowed");
}
export interface PolicyScope {
  readonly session_digest: string;
  readonly org_id: string;
  readonly context_version: number;
}
export interface PolicyRead {
  readonly resource: PolicyResource;
  readonly decision: PolicyDecision;
}
export type PolicyErrorCode =
  | "invalid_input"
  | "authentication_required"
  | "unavailable_resource"
  | "version_conflict"
  | "forbidden"
  | "approval_required"
  | "unavailable";
export class PolicyError extends Error {
  constructor(readonly code: PolicyErrorCode) {
    super(code);
    this.name = "PolicyError";
  }
}
/** Bound server-side ports. No generic execute-callback or caller-defined principal/environment. */
export interface PolicyRepository {
  validateScope(scope: PolicyScope): Promise<void>;
  evaluate(
    scope: PolicyScope,
    resourceId: string,
    action: string,
  ): Promise<PolicyDecision>;
  readResource(scope: PolicyScope, resourceId: string): Promise<PolicyRead>;
  renameResource(
    scope: PolicyScope,
    resourceId: string,
    name: string,
    expectedVersion: number,
    expectedPolicyRevision: number,
  ): Promise<PolicyRead>;
}
