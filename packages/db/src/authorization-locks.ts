import type { SqlConnection } from "./connection.js";
/** Cooperative control-plane locks. Direct SQL by a DB administrator is outside this boundary.
 * Hash collisions can only add contention. All membership/status/policy mutators must use these keys.
 * Order: session row, human, organization, membership, policy, resource row. */
export async function authorizationLock(
  c: SqlConnection,
  key: string,
  shared: boolean,
): Promise<void> {
  await c.query(
    shared
      ? "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))"
      : "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    ["zentwine.authz.v1:" + key],
  );
}
