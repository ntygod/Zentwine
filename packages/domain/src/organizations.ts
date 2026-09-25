import { isIdentityId, isContextVersion, type MemberRole } from "./identity.js";
import type {
  OrganizationAuditQuery,
  OrganizationAuditPage,
} from "./organization-audit.js";
/** Organization application ports. Provider verifiers are trusted server adapters, never browser claims. */
export const ORGANIZATION_VERSION = "1.0.0" as const;
export type OrganizationErrorCode =
  | "invalid_input"
  | "authentication_required"
  | "unavailable_resource"
  | "version_conflict"
  | "forbidden"
  | "unavailable";
export class OrganizationError extends Error {
  constructor(readonly code: OrganizationErrorCode) {
    super(code);
    this.name = "OrganizationError";
  }
}
export interface OrganizationScope {
  readonly session_digest: string;
  readonly org_id: string;
  readonly context_version: number;
}
export interface OrganizationSettings {
  readonly org_id: string;
  readonly display_name: string;
  readonly locale: "zh-CN" | "en";
  readonly time_zone: string;
  readonly invitations_enabled: boolean;
  readonly invite_ttl_hours: number;
  readonly guest_ttl_days: number;
  readonly object_version: number;
}
export interface SettingsInput {
  readonly display_name: string;
  readonly locale: "zh-CN" | "en";
  readonly time_zone: string;
  readonly invitations_enabled: boolean;
  readonly invite_ttl_hours: number;
  readonly guest_ttl_days: number;
  readonly expected_version: number;
}
export interface ManagedMember {
  readonly id: string;
  readonly human_id: string;
  readonly display_name: string;
  readonly display_number: string;
  readonly role: MemberRole;
  readonly access_kind: "member" | "guest";
  readonly access_expires_at: string | null;
  readonly status: "active" | "revoked";
  readonly object_version: number;
  readonly managed_by_connection: boolean;
}
export interface InvitationInput {
  readonly request_id: string;
  readonly human_id: string;
  readonly role: "member" | "viewer";
  readonly access_kind: "member" | "guest";
  readonly resource_ids: readonly string[];
  readonly expected_settings_version: number;
}
export interface InvitationView {
  readonly id: string;
  readonly org_id: string;
  readonly human_id: string;
  readonly role: "member" | "viewer";
  readonly access_kind: "member" | "guest";
  readonly resource_ids: readonly string[];
  readonly state: "pending" | "accepted" | "revoked" | "expired";
  readonly expires_at: string;
  readonly access_expires_at: string | null;
  readonly object_version: number;
}
export interface ConnectionInput {
  readonly display_name: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly enabled: boolean;
  readonly expected_version: number;
}
export interface FederationConnection {
  readonly id: string;
  readonly org_id: string;
  readonly display_name: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly enabled: boolean;
  readonly object_version: number;
  readonly protocol: "oidc-adapter-port";
}
export interface ProvisioningInput {
  readonly request_id: string;
  readonly external_id: string;
  readonly active: boolean;
  readonly expected_version: number;
}
export interface ExternalIdentityView {
  readonly id: string;
  readonly connection_id: string;
  readonly external_id: string;
  readonly active: boolean;
  readonly object_version: number;
}
export interface LoginProof {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
}
/** A production adapter MUST perform signature, issuer/audience, state/nonce/PKCE, expiry and replay verification.
 * No raw proof or "verified:true" endpoint is exposed. Tests use an explicitly synthetic adapter. */
export interface SsoVerifier {
  verify(input: unknown, connection: FederationConnection): Promise<LoginProof>;
}
export interface SsoPortRepository {
  connection(id: string): Promise<FederationConnection>;
  federatedTicket(
    connectionId: string,
    version: number,
    subject: string,
    ticketDigest: string,
  ): Promise<void>;
}
export interface OrganizationRepository extends SsoPortRepository {
  audit(
    s: OrganizationScope,
    input: OrganizationAuditQuery,
  ): Promise<OrganizationAuditPage>;
  self(s: OrganizationScope): Promise<ManagedMember>;
  settings(s: OrganizationScope): Promise<OrganizationSettings>;
  updateSettings(
    s: OrganizationScope,
    i: SettingsInput,
  ): Promise<OrganizationSettings>;
  members(s: OrganizationScope): Promise<readonly ManagedMember[]>;
  updateMember(
    s: OrganizationScope,
    id: string,
    role: MemberRole,
    status: "active" | "revoked",
    version: number,
  ): Promise<ManagedMember>;
  revokeOrganizationSessions(
    s: OrganizationScope,
    human: string,
  ): Promise<void>;
  invitations(s: OrganizationScope): Promise<readonly InvitationView[]>;
  invite(
    s: OrganizationScope,
    i: InvitationInput,
    digest: string,
  ): Promise<{ invitation: InvitationView; credential_issued: boolean }>;
  revokeInvitation(
    s: OrganizationScope,
    id: string,
    version: number,
  ): Promise<InvitationView>;
  acceptInvitation(
    sessionDigest: string,
    invitationDigest: string,
    nextSessionDigest: string,
  ): Promise<{ org_id: string; membership_id: string }>;
  search(
    s: OrganizationScope,
    query: string,
  ): Promise<readonly { id: string; display_name: string; kind: string }[]>;
  connections(s: OrganizationScope): Promise<readonly FederationConnection[]>;
  configureConnection(
    s: OrganizationScope,
    id: string,
    i: ConnectionInput,
  ): Promise<FederationConnection>;
  provision(
    connectionId: string,
    credentialDigest: string,
    i: ProvisioningInput,
  ): Promise<ExternalIdentityView>;
}
export function validLabel(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.trim() === v &&
    v.length > 0 &&
    v.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(v)
  );
}
export function validExternalId(v: unknown): v is string {
  return typeof v === "string" && /^[\x21-\x7e]{1,255}$/.test(v);
}
const keys = (v: object, names: readonly string[]): boolean =>
  Object.keys(v).length === names.length &&
  Object.keys(v).every((k) => names.includes(k));
export function validateSettings(i: SettingsInput): void {
  if (
    !i ||
    !keys(i, [
      "display_name",
      "locale",
      "time_zone",
      "invitations_enabled",
      "invite_ttl_hours",
      "guest_ttl_days",
      "expected_version",
    ]) ||
    !validLabel(i.display_name) ||
    !["zh-CN", "en"].includes(i.locale) ||
    typeof i.time_zone !== "string" ||
    i.time_zone.length > 80 ||
    typeof i.invitations_enabled !== "boolean" ||
    !Number.isInteger(i.invite_ttl_hours) ||
    i.invite_ttl_hours < 1 ||
    i.invite_ttl_hours > 168 ||
    !Number.isInteger(i.guest_ttl_days) ||
    i.guest_ttl_days < 1 ||
    i.guest_ttl_days > 30 ||
    !isContextVersion(i.expected_version)
  )
    throw new OrganizationError("invalid_input");
  try {
    new Intl.DateTimeFormat("en", { timeZone: i.time_zone }).format(0);
  } catch {
    throw new OrganizationError("invalid_input");
  }
}
export function validateInvitation(i: InvitationInput): void {
  if (
    !i ||
    !keys(i, [
      "request_id",
      "human_id",
      "role",
      "access_kind",
      "resource_ids",
      "expected_settings_version",
    ]) ||
    !isIdentityId(i.request_id) ||
    !isIdentityId(i.human_id) ||
    !["member", "viewer"].includes(i.role) ||
    !["member", "guest"].includes(i.access_kind) ||
    !isContextVersion(i.expected_settings_version) ||
    !Array.isArray(i.resource_ids) ||
    i.resource_ids.length > 16 ||
    !i.resource_ids.every(isIdentityId) ||
    new Set(i.resource_ids).size !== i.resource_ids.length ||
    (i.access_kind === "guest" &&
      (i.role !== "viewer" || i.resource_ids.length === 0)) ||
    (i.access_kind === "member" && i.resource_ids.length !== 0)
  )
    throw new OrganizationError("invalid_input");
}
export function validateConnection(i: ConnectionInput): void {
  if (
    !i ||
    !keys(i, [
      "display_name",
      "issuer",
      "client_id",
      "enabled",
      "expected_version",
    ]) ||
    !validLabel(i.display_name) ||
    !validExternalId(i.client_id) ||
    typeof i.enabled !== "boolean" ||
    !Number.isInteger(i.expected_version) ||
    i.expected_version < 0 ||
    i.expected_version > 2147483646 ||
    typeof i.issuer !== "string" ||
    i.issuer.length > 512
  )
    throw new OrganizationError("invalid_input");
  try {
    const u = new URL(i.issuer);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.href !== i.issuer
    )
      throw new Error();
  } catch {
    throw new OrganizationError("invalid_input");
  }
}
