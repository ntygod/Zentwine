import type { SqlConnection } from "./connection.js";
/** Additive schema guard: pre-0005 fixture databases have no lifecycle restrictions. Query failures never allow access. */
export async function membershipAccess(
  c: SqlConnection,
  org: string,
  human: string,
  sessionDigest?: string,
): Promise<{ allowed: boolean; guest: boolean }> {
  const m = (
    await c.query(
      `SELECT COALESCE(to_jsonb(m)->>'access_kind','member') AS kind,
 COALESCE((to_jsonb(m)->>'access_expires_at')::timestamptz>clock_timestamp(),true) AS unexpired
 FROM zentwine_identity.memberships m WHERE org_id=$1 AND human_id=$2 AND status='active'`,
      [org, human],
    )
  ).rows[0];
  if (!m || m["unexpired"] !== true)
    return { allowed: false, guest: m?.["kind"] === "guest" };
  if (sessionDigest !== undefined) {
    const exists = (
      await c.query(
        "SELECT to_regclass('zentwine_organizations.session_cutoffs') AS relation",
      )
    ).rows[0]?.["relation"];
    if (exists) {
      const ok = (
        await c.query(
          `SELECT EXISTS(SELECT 1 FROM zentwine_identity.sessions s WHERE s.digest=$3 AND s.human_id=$2 AND NOT EXISTS(SELECT 1 FROM zentwine_organizations.session_cutoffs c WHERE c.org_id=$1 AND c.human_id=$2 AND c.invalid_before>=s.created_at)) AS allowed`,
          [org, human, sessionDigest],
        )
      ).rows[0]?.["allowed"];
      if (ok !== true) return { allowed: false, guest: m["kind"] === "guest" };
    }
  }
  return { allowed: true, guest: m["kind"] === "guest" };
}
export async function federationTicketValid(
  c: SqlConnection,
  digest: string,
): Promise<boolean> {
  const exists = (
    await c.query(
      "SELECT to_regclass('zentwine_organizations.federated_tickets') AS relation",
    )
  ).rows[0]?.["relation"];
  if (!exists) return true;
  const b = (
    await c.query(
      `SELECT t.*,x.human_id,x.org_id,x.active,x.object_version AS mapping_current,c.enabled,c.object_version AS connection_current,o.status AS org_status FROM zentwine_organizations.federated_tickets t JOIN zentwine_organizations.external_identities x ON x.id=t.external_identity_id JOIN zentwine_organizations.connections c ON c.id=t.connection_id JOIN zentwine_identity.organizations o ON o.id=x.org_id WHERE t.digest=$1`,
      [digest],
    )
  ).rows[0];
  if (!b) return true;
  if (
    b["org_status"] !== "active" ||
    b["active"] !== true ||
    b["enabled"] !== true ||
    b["mapping_version"] !== b["mapping_current"] ||
    b["connection_version"] !== b["connection_current"]
  )
    return false;
  const cutoff = (
    await c.query(
      `SELECT EXISTS(SELECT 1 FROM zentwine_organizations.session_cutoffs c JOIN zentwine_organizations.federated_tickets t ON t.digest=$3 WHERE c.org_id=$1 AND c.human_id=$2 AND c.invalid_before>=t.created_at) AS stale`,
      [b["org_id"], b["human_id"], digest],
    )
  ).rows[0]?.["stale"];
  return (
    cutoff === false &&
    (await membershipAccess(c, String(b["org_id"]), String(b["human_id"])))
      .allowed
  );
}
