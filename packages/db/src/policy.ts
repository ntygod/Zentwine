import {
  isIdentityId,
  isContextVersion,
  type MemberRole,
} from "@zentwine/domain";
import {
  PolicyError,
  evaluatePolicy,
  validResource,
  isAction,
  type PolicyFacts,
  type PolicyScope,
  type PolicyRepository,
  type PolicyResource,
  type PolicyRead,
  type PolicyDecision,
  type RoleBinding,
  type ResourceGrant,
} from "@zentwine/policy";
import type { IdentityPool, SqlConnection } from "./connection.js";
import { authorizationLock } from "./authorization-locks.js";
const I = "zentwine_identity",
  P = "zentwine_policy";
type Row = Record<string, unknown>;
const text = (r: Row, k: string): string => {
  if (typeof r[k] !== "string") throw new PolicyError("unavailable");
  return r[k];
};
const integer = (r: Row, k: string): number => {
  if (!isContextVersion(r[k])) throw new PolicyError("unavailable");
  return r[k];
};
const millis = (r: Row, k: string): number => {
  const v = r[k];
  if (!(v instanceof Date) || !Number.isFinite(v.getTime()))
    throw new PolicyError("unavailable");
  return v.getTime();
};
const id = (s: unknown): void => {
  if (!isIdentityId(s)) throw new PolicyError("invalid_input");
};
function checkScope(s: PolicyScope): void {
  if (
    !s ||
    typeof s.session_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(s.session_digest) ||
    !isIdentityId(s.org_id) ||
    !isContextVersion(s.context_version)
  )
    throw new PolicyError("invalid_input");
}
function resource(r: Row): PolicyResource {
  const value = {
    id: text(r, "id"),
    org_id: text(r, "org_id"),
    kind: text(r, "kind"),
    display_name: text(r, "display_name"),
    environment: text(r, "environment"),
    visibility: text(r, "visibility"),
    sensitivity: text(r, "sensitivity"),
    owner_human_id: r["owner_human_id"],
    status: text(r, "status"),
    object_version: integer(r, "object_version"),
  } as PolicyResource;
  if (!validResource(value)) throw new PolicyError("unavailable");
  return Object.freeze(value);
}
async function transaction<T>(
  pool: IdentityPool,
  fn: (c: SqlConnection) => Promise<T>,
): Promise<T> {
  let c: SqlConnection | undefined,
    broken = false;
  try {
    c = await pool.connect();
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    if (c) {
      try {
        await c.query("ROLLBACK");
      } catch {
        broken = true;
      }
    }
    if (e instanceof PolicyError) throw e;
    throw new PolicyError("unavailable");
  } finally {
    c?.release(broken);
  }
}
function enforce(d: PolicyDecision, reading = false): void {
  if (d.outcome === "needs_approval")
    throw new PolicyError("approval_required");
  if (d.outcome !== "allow")
    throw new PolicyError(reading ? "unavailable_resource" : "forbidden");
}
/** Server-controlled authoritative facts, held through the catalog mutation; no public arbitrary SQL callback. */
export class PostgresPolicyRepository implements PolicyRepository {
  constructor(private readonly pool: IdentityPool) {}
  async assertRuntimeRole(): Promise<void> {
    await transaction(this.pool, async (c) => {
      const r = (
        await c.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits_role,
        EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ('${I}','${P}') AND t.relowner=r.oid) AS owns_table,
        EXISTS(SELECT 1 FROM (VALUES ('role_bindings'),('resource_grants'),('organization_policies')) t(name)
          WHERE has_table_privilege(current_user,'${P}.'||name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS can_grant,
        has_schema_privilege(current_user,'${P}','CREATE') AS can_create,
        has_table_privilege(current_user,'${P}.resources','INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_rebuild,
        has_column_privilege(current_user,'${I}.humans','status','UPDATE') AS can_disable,
        has_column_privilege(current_user,'${P}.resources','visibility','UPDATE') AS can_reclassify
        FROM pg_roles r WHERE r.rolname=current_user`)
      ).rows[0];
      if (!r || Object.values(r).some((v) => v !== false))
        throw new PolicyError("unavailable");
      await c.query(`SELECT id FROM ${P}.resources LIMIT 0`);
    });
  }
  private async lockScope(c: SqlConnection, s: PolicyScope): Promise<void> {
    checkScope(s);
    const session = (
      await c.query(
        `SELECT human_id FROM ${I}.sessions WHERE digest=$1 FOR SHARE`,
        [s.session_digest],
      )
    ).rows[0];
    if (!session) throw new PolicyError("authentication_required");
    const human = text(session, "human_id");
    await authorizationLock(c, `human:${human}`, true);
    await authorizationLock(c, `organization:${s.org_id}`, true);
    await authorizationLock(c, `membership:${s.org_id}:${human}`, true);
  }
  private async currentScope(c: SqlConnection, s: PolicyScope): Promise<Row> {
    // This statement is issued AFTER all lock waits, with a fresh READ COMMITTED snapshot.
    const session = (
      await c.query(
        `SELECT s.*,clock_timestamp() AS observed_at FROM ${I}.sessions s JOIN ${I}.humans h ON h.id=s.human_id
      WHERE s.digest=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()
      AND h.status='active' AND h.auth_version=s.auth_version`,
        [s.session_digest],
      )
    ).rows[0];
    if (!session) throw new PolicyError("authentication_required");
    if (integer(session, "context_version") !== s.context_version)
      throw new PolicyError("version_conflict");
    if (session["active_org_id"] !== s.org_id)
      throw new PolicyError("unavailable_resource");
    const m = (
      await c.query(
        `SELECT m.role,m.object_version AS membership_version FROM ${I}.memberships m
      JOIN ${I}.organizations o ON o.id=m.org_id WHERE m.org_id=$1 AND m.human_id=$2 AND m.status='active' AND o.status='active'`,
        [s.org_id, text(session, "human_id")],
      )
    ).rows[0];
    if (!m) throw new PolicyError("unavailable_resource");
    return { ...session, ...m };
  }
  async validateScope(s: PolicyScope): Promise<void> {
    await transaction(this.pool, async (c) => {
      await this.lockScope(c, s);
      await this.currentScope(c, s);
    });
  }
  private async facts(
    c: SqlConnection,
    s: PolicyScope,
    rid: string,
    write: boolean,
  ): Promise<PolicyFacts> {
    id(rid);
    await this.lockScope(c, s);
    await authorizationLock(c, `policy:${s.org_id}`, true);
    if (write)
      await c.query(
        `SELECT id FROM ${P}.resources WHERE org_id=$1 AND id=$2 FOR UPDATE`,
        [s.org_id, rid],
      );
    const actor = await this.currentScope(c, s);
    const r = (
      await c.query(
        `SELECT * FROM ${P}.resources WHERE org_id=$1 AND id=$2 AND status='active'`,
        [s.org_id, rid],
      )
    ).rows[0];
    if (!r) throw new PolicyError("unavailable_resource");
    const p = (
      await c.query(
        `SELECT * FROM ${P}.organization_policies WHERE org_id=$1`,
        [s.org_id],
      )
    ).rows[0];
    if (!p) throw new PolicyError("unavailable");
    const rules = async (table: "role_bindings" | "resource_grants") => {
      const rows = (
        await c.query(
          `SELECT * FROM ${P}.${table} WHERE org_id=$1 AND human_id=$2 AND resource_id=$3 AND revoked_at IS NULL ORDER BY id LIMIT 101`,
          [s.org_id, text(actor, "human_id"), rid],
        )
      ).rows;
      if (rows.length > 100) throw new PolicyError("unavailable");
      return rows.map((x) => ({
        ...x,
        valid_from: millis(x, "valid_from"),
        expires_at: x["expires_at"] === null ? null : millis(x, "expires_at"),
        revoked: false,
      }));
    };
    const bindings = await rules("role_bindings"),
      grants = await rules("resource_grants");
    const now = (await c.query("SELECT clock_timestamp() AS now")).rows[0];
    if (!now) throw new PolicyError("unavailable");
    return {
      principal_kind: "human",
      human_id: text(actor, "human_id"),
      org_id: s.org_id,
      membership_role: text(actor, "role") as MemberRole,
      membership_version: integer(actor, "membership_version"),
      session_valid_until: Math.min(
        millis(actor, "expires_at"),
        millis(actor, "idle_expires_at"),
      ),
      observed_at: millis(now, "now"),
      resource: resource(r),
      policy_revision: integer(p, "revision"),
      write_mode: text(p, "write_mode") as PolicyFacts["write_mode"],
      bindings: bindings as unknown as RoleBinding[],
      grants: grants as unknown as ResourceGrant[],
    };
  }
  async evaluate(
    s: PolicyScope,
    rid: string,
    action: string,
  ): Promise<PolicyDecision> {
    if (typeof action !== "string" || action.length > 80)
      throw new PolicyError("invalid_input");
    return transaction(this.pool, async (c) => {
      const f = await this.facts(c, s, rid, false);
      enforce(evaluatePolicy(f, "resource.read", f.observed_at), true);
      return evaluatePolicy(f, action, f.observed_at);
    });
  }
  async readResource(s: PolicyScope, rid: string): Promise<PolicyRead> {
    return transaction(this.pool, async (c) => {
      const f = await this.facts(c, s, rid, false),
        d = evaluatePolicy(f, "resource.read", f.observed_at);
      enforce(d, true);
      return Object.freeze({ resource: f.resource, decision: d });
    });
  }
  async renameResource(
    s: PolicyScope,
    rid: string,
    name: string,
    expectedVersion: number,
    expectedPolicyRevision: number,
  ): Promise<PolicyRead> {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !isContextVersion(expectedVersion) ||
      !isContextVersion(expectedPolicyRevision)
    )
      throw new PolicyError("invalid_input");
    return transaction(this.pool, async (c) => {
      const f = await this.facts(c, s, rid, true);
      enforce(evaluatePolicy(f, "resource.read", f.observed_at), true);
      const d = evaluatePolicy(f, "resource.update", f.observed_at);
      enforce(d);
      if (
        expectedVersion !== f.resource.object_version ||
        expectedPolicyRevision !== f.policy_revision
      )
        throw new PolicyError("version_conflict");
      const row = (
        await c.query(
          `UPDATE ${P}.resources SET display_name=$1,object_version=object_version+1
        WHERE org_id=$2 AND id=$3 AND object_version=$4 AND clock_timestamp()<$5::timestamptz RETURNING *`,
          [name, s.org_id, rid, expectedVersion, d.expires_at],
        )
      ).rows[0];
      if (!row) throw new PolicyError("version_conflict");
      return Object.freeze({ resource: resource(row), decision: d });
    });
  }
}

/** Operator-only administration. Never exposed as model tools or ordinary HTTP routes. */
export class PostgresPolicyAdmin {
  constructor(private readonly pool: IdentityPool) {}
  async registerResource(r: PolicyResource): Promise<void> {
    if (!validResource(r) || r.object_version !== 1)
      throw new PolicyError("invalid_input");
    await transaction(this.pool, async (c) => {
      await authorizationLock(c, `policy:${r.org_id}`, false);
      await c.query(
        `INSERT INTO ${P}.organization_policies(org_id) VALUES($1) ON CONFLICT(org_id) DO NOTHING`,
        [r.org_id],
      );
      await c.query(
        `INSERT INTO ${P}.resources(id,org_id,kind,display_name,visibility,environment,sensitivity,owner_human_id,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          r.id,
          r.org_id,
          r.kind,
          r.display_name,
          r.visibility,
          r.environment,
          r.sensitivity,
          r.owner_human_id,
          r.status,
        ],
      );
      await c.query(
        `UPDATE ${P}.organization_policies SET revision=revision+1 WHERE org_id=$1`,
        [r.org_id],
      );
    });
  }
  private async change(
    org: string,
    expected: number,
    fn: (c: SqlConnection) => Promise<void>,
  ): Promise<void> {
    id(org);
    if (!isContextVersion(expected)) throw new PolicyError("invalid_input");
    await transaction(this.pool, async (c) => {
      await authorizationLock(c, `policy:${org}`, false);
      const r = (
        await c.query(
          `UPDATE ${P}.organization_policies SET revision=revision+1 WHERE org_id=$1 AND revision=$2 RETURNING revision`,
          [org, expected],
        )
      ).rows[0];
      if (!r) throw new PolicyError("version_conflict");
      await fn(c);
    });
  }
  async addRule(
    r: RoleBinding | ResourceGrant,
    expected: number,
  ): Promise<void> {
    id(r.id);
    id(r.org_id);
    id(r.human_id);
    id(r.resource_id);
    if (
      !Number.isFinite(r.valid_from) ||
      r.valid_from < 0 ||
      r.valid_from > 8.64e15 ||
      r.revoked !== false ||
      (r.expires_at !== null &&
        (!Number.isFinite(r.expires_at) ||
          r.expires_at <= r.valid_from ||
          r.expires_at > 8.64e15))
    )
      throw new PolicyError("invalid_input");
    const values = [
      r.id,
      r.org_id,
      r.human_id,
      r.resource_id,
      new Date(r.valid_from),
      r.expires_at === null ? null : new Date(r.expires_at),
    ];
    if ("role" in r) {
      if (!["reader", "editor"].includes(r.role))
        throw new PolicyError("invalid_input");
      await this.change(r.org_id, expected, async (c) => {
        await c.query(
          `INSERT INTO ${P}.role_bindings(id,org_id,human_id,resource_id,valid_from,expires_at,role) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [...values, r.role],
        );
      });
    } else {
      if (!isAction(r.action) || !["allow", "deny"].includes(r.effect))
        throw new PolicyError("invalid_input");
      await this.change(r.org_id, expected, async (c) => {
        await c.query(
          `INSERT INTO ${P}.resource_grants(id,org_id,human_id,resource_id,valid_from,expires_at,action,effect) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [...values, r.action, r.effect],
        );
      });
    }
  }
  async revokeRule(
    org: string,
    ruleId: string,
    kind: "binding" | "grant",
    expected: number,
  ): Promise<void> {
    id(ruleId);
    if (!["binding", "grant"].includes(kind))
      throw new PolicyError("invalid_input");
    const table = kind === "binding" ? "role_bindings" : "resource_grants";
    await this.change(org, expected, async (c) => {
      const r = (
        await c.query(
          `UPDATE ${P}.${table} SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE org_id=$1 AND id=$2 RETURNING id`,
          [org, ruleId],
        )
      ).rows[0];
      if (!r) throw new PolicyError("unavailable_resource");
    });
  }
  async setWriteMode(
    org: string,
    mode: "active" | "read_only",
    expected: number,
  ): Promise<void> {
    if (!["active", "read_only"].includes(mode))
      throw new PolicyError("invalid_input");
    await this.change(org, expected, async (c) => {
      await c.query(
        `UPDATE ${P}.organization_policies SET write_mode=$1 WHERE org_id=$2`,
        [mode, org],
      );
    });
  }
}
