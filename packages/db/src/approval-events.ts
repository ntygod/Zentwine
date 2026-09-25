import type { SqlConnection } from "./connection.js";
import { authorizationLock } from "./authorization-locks.js";
/** Internal transactional outbox. Caller holds authority locks, then this org stream lock before request rows.
 * NOT a security boundary against DB administrators or arbitrary SQL. */
export async function appendApprovalEvent(
  c: SqlConnection,
  r: Record<string, unknown>,
): Promise<void> {
  await authorizationLock(c, `approval-events:${String(r["org_id"])}`, false);
  await c.query(
    `INSERT INTO zentwine_approvals.events(org_id,approval_id,kind,object_version,reason) VALUES($1,$2,$3,$4,$5)`,
    [
      r["org_id"],
      r["id"],
      "approval." + String(r["state"]),
      r["object_version"],
      r["reason"],
    ],
  );
}
/** Identity/policy mutators use this in their existing transaction, never an after-commit best effort.
 * Older development databases without migration 0004 have no approvals to invalidate. */
export async function invalidateApprovals(
  c: SqlConnection,
  org: string | null,
  human: string | null,
): Promise<void> {
  const present = (
    await c.query(
      "SELECT to_regclass('zentwine_approvals.requests') AS relation",
    )
  ).rows[0];
  if (!present?.["relation"]) return;
  const orgs = (
    await c.query(
      `SELECT DISTINCT r.org_id FROM zentwine_approvals.requests r LEFT JOIN zentwine_approvals.decisions d ON d.approval_id=r.id
    WHERE r.state IN ('pending','approved','issued') AND ($1::uuid IS NULL OR r.org_id=$1)
    AND ($2::uuid IS NULL OR r.requester_id=$2 OR d.actor_id=$2) ORDER BY r.org_id`,
      [org, human],
    )
  ).rows;
  for (const item of orgs) {
    await authorizationLock(
      c,
      `approval-events:${String(item["org_id"])}`,
      false,
    );
    const rows = (
      await c.query(
        `UPDATE zentwine_approvals.requests r SET state='revoked',reason='authority_changed',object_version=object_version+1
      WHERE r.org_id=$1 AND r.state IN ('pending','approved','issued') AND ($2::uuid IS NULL OR r.requester_id=$2 OR EXISTS(SELECT 1 FROM zentwine_approvals.decisions d WHERE d.approval_id=r.id AND d.actor_id=$2)) RETURNING r.*`,
        [item["org_id"], human],
      )
    ).rows;
    for (const row of rows) await appendApprovalEvent(c, row);
  }
}
