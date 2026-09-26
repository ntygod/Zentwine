import type { RevisionUnitOfWork } from "./versions.js";
import { isIdentityId, isContextVersion } from "./identity.js";
/** Internal server port; a session digest is a credential, not a public tenant selector. */
export interface TenantScope {
  readonly session_digest: string;
  readonly org_id: string;
  readonly context_version: number;
}
export type TenantErrorCode =
  | "invalid_input"
  | "unavailable_resource"
  | "version_conflict"
  | "forbidden"
  | "unavailable"
  | "transaction_closed";
export class TenantError extends Error {
  constructor(readonly code: TenantErrorCode) {
    super(code);
    this.name = "TenantError";
  }
}
export interface TenantKey {
  readonly org_id: string;
  readonly id: string;
  readonly kind: string;
  readonly created_by: string;
  readonly created_at: string;
}
export interface TenantLink {
  readonly org_id: string;
  readonly source_id: string;
  readonly target_id: string;
  readonly kind: string;
  readonly created_by: string;
  readonly created_at: string;
}
/** Registration metadata only, not arbitrary JSON, business content, revisions or authorization grants. */
export interface TenantUnitOfWork {
  readonly versions: RevisionUnitOfWork;
  register(id: string, kind: string): Promise<TenantKey>;
  getMany(ids: readonly string[]): Promise<readonly TenantKey[]>;
  link(source: string, target: string, kind: string): Promise<TenantLink>;
  linked(source: string): Promise<readonly TenantKey[]>;
}
export interface TenantRepository {
  transaction<T>(
    scope: TenantScope,
    work: (repo: TenantUnitOfWork) => Promise<T>,
  ): Promise<T>;
}
export function validateTenantScope(s: TenantScope): void {
  if (
    !s ||
    typeof s !== "object" ||
    Array.isArray(s) ||
    Object.keys(s).length !== 3 ||
    Object.keys(s).some(
      (k) => !["org_id", "session_digest", "context_version"].includes(k),
    ) ||
    !isIdentityId(s.org_id) ||
    typeof s.session_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(s.session_digest) ||
    !isContextVersion(s.context_version)
  )
    throw new TenantError("invalid_input");
}
export function validateTenantIds(ids: readonly string[]): void {
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    !ids.every(isIdentityId) ||
    new Set(ids).size !== ids.length
  )
    throw new TenantError("invalid_input");
}
export function validateTenantKind(kind: string): void {
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(kind))
    throw new TenantError("invalid_input");
}
