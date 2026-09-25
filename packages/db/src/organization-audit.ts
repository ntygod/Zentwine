import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { OrganizationError, ORGANIZATION_AUDIT_KINDS, isIdentityId,
  type OrganizationScope, type OrganizationAuditKind, type OrganizationAuditQuery,
  type OrganizationAuditPage, type OrganizationAuditEntry } from "@zentwine/domain";
import type { SqlConnection } from "./connection.js";
const TABLE = "zentwine_organizations.events";
const MAX_ID = 9223372036854775807n;
const CURSOR_TTL_MS = 15 * 60 * 1000;
interface Position { head: string; before: string; snapshot: string; expires: number }
const subjectKinds: Record<OrganizationAuditKind, OrganizationAuditEntry["subject_kind"]> = {
  "settings.updated": "organization", "member.updated": "membership", "sessions.revoked": "human",
  "invitation.created": "invitation", "invitation.accepted": "invitation", "invitation.revoked": "invitation",
  "connection.updated": "identity_connection", "identity.linked": "external_identity", "identity.provisioned": "external_identity",
};
function sequence(v: unknown): v is string {
  return typeof v === "string" && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= MAX_ID;
}
const key = (s: OrganizationScope, serverKey: Buffer): Buffer =>
  createHmac("sha256", serverKey).update("zentwine.organization-audit.cursor.v1\0" + s.session_digest).digest();
const aad = (s: OrganizationScope, q: OrganizationAuditQuery): Buffer =>
  Buffer.from(JSON.stringify([s.org_id, s.context_version, q.kind ?? "all", q.limit ?? 20]));
/** Opaque, session/context/filter-bound pagination only; never an authorization permit.
 * A random per-repository server key is combined with the session digest; knowing a cookie cannot forge a cursor.
 * Reconstructing the repository (including a service restart) invalidates pagination, not persisted records.
 * Possession of a cursor does not substitute for a fresh owner check on every page. */
export function encodeAuditCursor(s: OrganizationScope, q: OrganizationAuditQuery, p: Position, serverKey: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(s, serverKey), iv);
  cipher.setAAD(aad(s, q));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(p), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function decodeAuditCursor(s: OrganizationScope, q: OrganizationAuditQuery, now: number, serverKey: Buffer): Position {
  try {
    if (typeof q.cursor !== "string" || !/^[A-Za-z0-9_-]{40,1024}$/.test(q.cursor)) throw new Error();
    const raw = Buffer.from(q.cursor, "base64url");
    if (raw.toString("base64url") !== q.cursor || raw.length < 29) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key(s, serverKey), raw.subarray(0, 12));
    cipher.setAuthTag(raw.subarray(12, 28));
    cipher.setAAD(aad(s, q));
    const p = JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString("utf8")) as Position;
    if (!p || Object.keys(p).sort().join(",") !== "before,expires,head,snapshot" ||
        !sequence(p.head) || !sequence(p.before) || BigInt(p.before) < 1n || BigInt(p.before) > BigInt(p.head) ||
        typeof p.snapshot !== "string" || !Number.isFinite(Date.parse(p.snapshot)) ||
        new Date(p.snapshot).toISOString() !== p.snapshot || !Number.isSafeInteger(p.expires) ||
        p.expires !== Date.parse(p.snapshot) + CURSOR_TTL_MS || !Number.isFinite(now) ||
        Date.parse(p.snapshot) > now || p.expires <= now) throw new Error();
    return p;
  } catch { throw new OrganizationError("invalid_input"); }
}
/** Caller holds the shared organization lock and rechecks the owner/session before returning.
 * All existing lifecycle writers take its exclusive counterpart before inserting. Consequently
 * a snapshot cannot skip a lower uncommitted sequence for the same organization. Direct operator
 * SQL which ignores this protocol is outside the concurrency guarantee. */
export async function readOrganizationAudit(c: SqlConnection, s: OrganizationScope, q: OrganizationAuditQuery, serverKey: Buffer): Promise<OrganizationAuditPage> {
  const meta = (await c.query(`SELECT COALESCE(MAX(id),0)::text AS head,clock_timestamp() AS now FROM ${TABLE} WHERE org_id=$1`, [s.org_id])).rows[0];
  if (!meta || !sequence(meta["head"]) || !(meta["now"] instanceof Date) || !Number.isFinite(meta["now"].getTime()))
    throw new OrganizationError("unavailable");
  const now = meta["now"], limit = q.limit ?? 20;
  const p = q.cursor === undefined ? null : decodeAuditCursor(s, q, now.getTime(), serverKey);
  const head = p?.head ?? meta["head"], snapshot = p?.snapshot ?? now.toISOString();
  const rows = (await c.query(`SELECT id::text AS sequence,audit_ref,actor_id,kind,subject_id,created_at FROM ${TABLE}
    WHERE org_id=$1 AND id<=$2::bigint AND ($3::bigint IS NULL OR id<$3::bigint)
    AND ($4::text='all' OR kind=$4) ORDER BY id DESC LIMIT $5`,
    [s.org_id, head, p?.before ?? null, q.kind ?? "all", limit + 1])).rows;
  const entries: OrganizationAuditEntry[] = rows.slice(0, limit).map((r) => {
    const kind = r["kind"] as OrganizationAuditKind;
    if (!sequence(r["sequence"]) || !isIdentityId(r["audit_ref"]) || !isIdentityId(r["actor_id"]) ||
        !isIdentityId(r["subject_id"]) || !ORGANIZATION_AUDIT_KINDS.includes(kind) ||
        !(r["created_at"] instanceof Date) || !Number.isFinite(r["created_at"].getTime()))
      throw new OrganizationError("unavailable");
    return { reference: r["audit_ref"], occurred_at: r["created_at"].toISOString(), kind,
      actor_kind: kind === "identity.linked" || kind === "identity.provisioned" ? "identity_connection" : "human",
      actor_id: r["actor_id"], subject_kind: subjectKinds[kind], subject_id: r["subject_id"] };
  });
  const last = rows[limit - 1]?.["sequence"];
  const next = rows.length > limit && sequence(last) ? encodeAuditCursor(s, q, {
    head, before: last, snapshot, expires: p?.expires ?? now.getTime() + CURSOR_TTL_MS,
  }, serverKey) : null;
  return { schema_version: "1.0.0", org_id: s.org_id, scope: "organization-lifecycle-only", complete_ledger: false,
    snapshot_at: snapshot, entries, next_cursor: next };
}
