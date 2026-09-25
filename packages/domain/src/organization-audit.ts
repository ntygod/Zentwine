import { OrganizationError } from "./organizations.js";
/** This is a projection of recorded organization lifecycle facts, not a complete security ledger. */
export const ORGANIZATION_AUDIT_KINDS = [
  "settings.updated",
  "member.updated",
  "sessions.revoked",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "connection.updated",
  "identity.linked",
  "identity.provisioned",
  "member.emergency_held",
  "member.emergency_released",
] as const;
export type OrganizationAuditKind = (typeof ORGANIZATION_AUDIT_KINDS)[number];
export interface OrganizationAuditQuery {
  readonly kind?: OrganizationAuditKind | "all";
  readonly limit?: number;
  readonly cursor?: string;
}
export interface OrganizationAuditEntry {
  readonly reference: string;
  readonly occurred_at: string;
  readonly kind: OrganizationAuditKind;
  readonly actor_kind: "human" | "identity_connection";
  readonly actor_id: string;
  readonly subject_kind:
    | "organization"
    | "membership"
    | "human"
    | "invitation"
    | "identity_connection"
    | "external_identity";
  readonly subject_id: string;
}
export interface OrganizationAuditPage {
  readonly schema_version: "1.0.0";
  readonly org_id: string;
  readonly scope: "organization-lifecycle-only";
  readonly complete_ledger: false;
  readonly snapshot_at: string;
  readonly entries: readonly OrganizationAuditEntry[];
  readonly next_cursor: string | null;
}
export function validateAuditQuery(input: OrganizationAuditQuery): void {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !["kind", "limit", "cursor"].includes(k)) ||
    (input.kind !== undefined &&
      input.kind !== "all" &&
      !ORGANIZATION_AUDIT_KINDS.includes(input.kind)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50)) ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{40,1024}$/.test(input.cursor)))
  )
    throw new OrganizationError("invalid_input");
}
