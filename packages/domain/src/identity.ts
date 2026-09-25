/** Identity facts and ports. No transport, database, clock globals or provider SDK. */
export type MemberRole = "owner" | "member" | "viewer";
export interface HumanIdentity {
  readonly id: string;
  readonly display_name: string;
}
export interface OrganizationIdentity {
  readonly id: string;
  readonly display_name: string;
}
export interface MembershipIdentity {
  readonly id: string;
  readonly org_id: string;
  readonly human_id: string;
  readonly display_number: string;
  readonly role: MemberRole;
  readonly object_version: number;
}
export interface SessionIdentity {
  readonly id: string;
  readonly human: HumanIdentity;
  readonly expires_at: string;
  readonly context_version: number;
  readonly active_org_id: string | null;
  readonly organizations: readonly OrganizationIdentity[];
}
export interface TenantContext {
  readonly principal_kind: "human";
  readonly session_id: string;
  readonly context_version: number;
  readonly human: HumanIdentity;
  readonly organization: OrganizationIdentity;
  readonly membership: MembershipIdentity;
}
export type IdentityErrorCode =
  | "invalid_input"
  | "invalid_login"
  | "authentication_required"
  | "unavailable_resource"
  | "version_conflict"
  | "rate_limited"
  | "unavailable";
export class IdentityError extends Error {
  constructor(readonly code: IdentityErrorCode) {
    super(code);
    this.name = "IdentityError";
  }
}
/** Only digests reach storage. Never accepts an unvalidated caller-supplied identity. */
export interface IdentityRepository {
  consumeTicket(
    ticketDigest: string,
    sessionDigest: string,
    priorSessionDigest?: string,
  ): Promise<SessionIdentity>;
  readSession(sessionDigest: string): Promise<SessionIdentity>;
  selectOrganization(
    sessionDigest: string,
    orgId: string,
    expectedVersion: number,
  ): Promise<SessionIdentity>;
  tenantContext(
    sessionDigest: string,
    orgId: string,
    contextVersion: number,
  ): Promise<TenantContext>;
  rotateSession(
    sessionDigest: string,
    nextDigest: string,
    expectedVersion: number,
  ): Promise<SessionIdentity>;
  revokeSession(sessionDigest: string): Promise<void>;
}
export function isIdentityId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  );
}
export function isContextVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= 2147483646
  );
}
