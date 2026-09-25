import { membershipAccess } from "./organization-guards.js";
import { createHash, randomUUID } from "node:crypto";
import {
  isIdentityId,
  isContextVersion,
  type MemberRole,
} from "@zentwine/domain";
import {
  DelegationError,
  DELEGATION_VERSION,
  MAX_CHAIN_DEPTH,
  MAX_DELEGATION_MS,
  canonicalSnapshot,
  validateRequest,
  validTerms,
  isAttenuation,
  allowsScope,
  remainingCalls,
  validateToolRequest,
  evaluatePolicy,
  validResource,
  type DelegationRequest,
  type DelegationView,
  type IssuedDelegation,
  type AgentIdentity,
  type AgentCredentialScope,
  type AgentToolRequest,
  type PolicySnapshot,
  type PolicyScope,
  type PolicyFacts,
  type PolicyResource,
  type AgentToolResult,
  type AgentRepository,
  type PolicyDecision,
  type RoleBinding,
  type ResourceGrant,
  type DelegationTerms,
} from "@zentwine/policy";
import type { IdentityPool, SqlConnection } from "./connection.js";
import { authorizationLock } from "./authorization-locks.js";
const I = "zentwine_identity",
  P = "zentwine_policy",
  A = "zentwine_agents";
type Row = Record<string, unknown>;
const str = (r: Row, k: string): string => {
  if (typeof r[k] !== "string") throw new DelegationError("unavailable");
  return r[k];
};
const num = (r: Row, k: string): number => {
  if (!Number.isSafeInteger(r[k])) throw new DelegationError("unavailable");
  return Number(r[k]);
};
const date = (r: Row, k: string): number => {
  const v = r[k];
  if (!(v instanceof Date) || !Number.isFinite(v.getTime()))
    throw new DelegationError("unavailable");
  return v.getTime();
};
const checkId = (v: unknown): void => {
  if (!isIdentityId(v)) throw new DelegationError("invalid_input");
};
const checkDigest = (v: unknown): void => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw new DelegationError("authentication_required");
};
const hash = (v: unknown): string =>
  createHash("sha256").update(canonicalSnapshot(v)).digest("hex");
const copy = <T>(v: T): T => JSON.parse(canonicalSnapshot(v)) as T;
const checkName = (v: unknown): void => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(v)
  )
    throw new DelegationError("invalid_input");
};
async function tx<T>(
  pool: IdentityPool,
  fn: (c: SqlConnection) => Promise<T>,
): Promise<T> {
  let c: SqlConnection | undefined,
    broken = false;
  try {
    c = await pool.connect();
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    if (c)
      try {
        await c.query("ROLLBACK");
      } catch {
        broken = true;
      }
    if (e instanceof DelegationError) throw e;
    throw new DelegationError("unavailable");
  } finally {
    c?.release(broken);
  }
}
async function now(c: SqlConnection): Promise<number> {
  const r = (await c.query("SELECT clock_timestamp() AS now")).rows[0];
  if (!r) throw new DelegationError("unavailable");
  return date(r, "now");
}
function agent(r: Row): AgentIdentity {
  return Object.freeze({
    id: str(r, "id"),
    org_id: str(r, "org_id"),
    accountable_owner_id: str(r, "accountable_owner_id"),
    display_name: str(r, "display_name"),
    object_version: num(r, "object_version"),
    disabled: r["disabled_at"] !== null,
  });
}
interface Authority {
  human: string;
  org: string;
  auth: number;
  membership: number;
  orgVersion: number;
  role: MemberRole;
  revision: number;
  writeMode: PolicyFacts["write_mode"];
}
interface Chain {
  rows: Row[];
  views: DelegationView[];
  authority: Authority;
}
/** Control-plane repository only. Never provide this pool or arbitrary callbacks to agent code. */
export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly pool: IdentityPool) {}
  async assertRuntimeRole(): Promise<void> {
    await tx(this.pool, async (c) => {
      const r = (
        await c.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits_role,
      EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='${A}' AND t.relowner=r.oid) AS owns,
      has_schema_privilege(current_user,'${A}','CREATE') AS can_create,
      has_table_privilege(current_user,'${A}.snapshots','UPDATE,DELETE,TRUNCATE,TRIGGER') AS can_rewrite_snapshot,
      has_table_privilege(current_user,'${A}.operations','UPDATE,DELETE,TRUNCATE,TRIGGER') AS can_rewrite_operation,
      has_column_privilege(current_user,'${A}.delegations','credential_digest','UPDATE') AS can_rebind,
      has_column_privilege(current_user,'${A}.identities','accountable_owner_id','UPDATE') AS can_reassign
      FROM pg_roles r WHERE r.rolname=current_user`)
      ).rows[0];
      if (!r || Object.values(r).some((v) => v !== false))
        throw new DelegationError("unavailable");
      await c.query(`SELECT id FROM ${A}.delegations LIMIT 0`);
    });
  }
  /** Shared order with ZT02-01/02: session(if human), human, organization, membership, policy, agent tree, resource. */
  private async locks(
    c: SqlConnection,
    human: string,
    org: string,
  ): Promise<void> {
    await authorizationLock(c, `human:${human}`, true);
    await authorizationLock(c, `organization:${org}`, true);
    await authorizationLock(c, `membership:${org}:${human}`, true);
    await authorizationLock(c, `policy:${org}`, true);
    // Intentionally serialize delegation mutation/consumption within an organization for correctness.
    await authorizationLock(c, `agent-tree:${org}`, false);
  }
  private async authority(
    c: SqlConnection,
    human: string,
    org: string,
  ): Promise<Authority> {
    const r = (
      await c.query(
        `SELECT h.auth_version,m.object_version AS membership_version,m.role,o.object_version AS org_version,p.revision,p.write_mode
      FROM ${I}.humans h JOIN ${I}.memberships m ON m.human_id=h.id
      JOIN ${I}.organizations o ON o.id=m.org_id JOIN ${P}.organization_policies p ON p.org_id=o.id
      WHERE h.id=$1 AND o.id=$2 AND h.status='active' AND m.status='active' AND o.status='active'`,
        [human, org],
      )
    ).rows[0];
    const access = await membershipAccess(c, org, human);
    if (!r || !access.allowed || access.guest)
      throw new DelegationError("unavailable_resource");
    return {
      human,
      org,
      auth: num(r, "auth_version"),
      membership: num(r, "membership_version"),
      orgVersion: num(r, "org_version"),
      role: str(r, "role") as MemberRole,
      revision: num(r, "revision"),
      writeMode: str(r, "write_mode") as Authority["writeMode"],
    };
  }
  private async human(c: SqlConnection, s: PolicyScope): Promise<Authority> {
    checkDigest(s?.session_digest);
    checkId(s?.org_id);
    if (!isContextVersion(s.context_version))
      throw new DelegationError("invalid_input");
    const seed = (
      await c.query(
        `SELECT human_id FROM ${I}.sessions WHERE digest=$1 FOR SHARE`,
        [s.session_digest],
      )
    ).rows[0];
    if (!seed) throw new DelegationError("authentication_required");
    const human = str(seed, "human_id");
    await this.locks(c, human, s.org_id);
    const row = (
      await c.query(
        `SELECT s.context_version,s.active_org_id,s.created_at FROM ${I}.sessions s JOIN ${I}.humans h ON h.id=s.human_id
      WHERE s.digest=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()
      AND h.status='active' AND h.auth_version=s.auth_version`,
        [s.session_digest],
      )
    ).rows[0];
    if (!row) throw new DelegationError("authentication_required");
    if (num(row, "context_version") !== s.context_version)
      throw new DelegationError("version_conflict");
    if (
      row["active_org_id"] !== s.org_id ||
      !(await membershipAccess(c, s.org_id, human, s.session_digest)).allowed
    )
      throw new DelegationError("unavailable_resource");
    return this.authority(c, human, s.org_id);
  }
  private async findAgent(
    c: SqlConnection,
    a: Authority,
    id: string,
    active = true,
  ): Promise<AgentIdentity> {
    checkId(id);
    const r = (
      await c.query(
        `SELECT * FROM ${A}.identities WHERE id=$1 AND org_id=$2 AND accountable_owner_id=$3`,
        [id, a.org, a.human],
      )
    ).rows[0];
    if (!r || (active && r["disabled_at"] !== null))
      throw new DelegationError("unavailable_resource");
    return agent(r);
  }
  async register(
    s: PolicyScope,
    requestId: string,
    name: string,
  ): Promise<AgentIdentity> {
    checkId(requestId);
    checkName(name);
    return tx(this.pool, async (c) => {
      const a = await this.human(c, s);
      const old = (
        await c.query(
          `SELECT * FROM ${A}.identities WHERE org_id=$1 AND accountable_owner_id=$2 AND request_id=$3`,
          [a.org, a.human, requestId],
        )
      ).rows[0];
      if (old) {
        if (old["display_name"] !== name)
          throw new DelegationError("version_conflict");
        return agent(old);
      }
      const row = (
        await c.query(
          `INSERT INTO ${A}.identities(id,org_id,accountable_owner_id,display_name,request_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [randomUUID(), a.org, a.human, name, requestId],
        )
      ).rows[0];
      if (!row) throw new DelegationError("unavailable");
      return agent(row);
    });
  }
  async disable(
    s: PolicyScope,
    agentId: string,
    expected: number,
  ): Promise<AgentIdentity> {
    if (!isContextVersion(expected)) throw new DelegationError("invalid_input");
    return tx(this.pool, async (c) => {
      const a = await this.human(c, s),
        v = await this.findAgent(c, a, agentId, false);
      if (v.disabled) return v;
      if (v.object_version !== expected)
        throw new DelegationError("version_conflict");
      const r = (
        await c.query(
          `UPDATE ${A}.identities SET disabled_at=clock_timestamp(),object_version=object_version+1 WHERE id=$1 AND object_version=$2 RETURNING *`,
          [agentId, expected],
        )
      ).rows[0];
      if (!r) throw new DelegationError("version_conflict");
      return agent(r);
    });
  }
  private async view(c: SqlConnection, row: Row): Promise<DelegationView> {
    const sr = (
      await c.query(`SELECT * FROM ${A}.snapshots WHERE id=$1 AND org_id=$2`, [
        row["snapshot_id"],
        row["org_id"],
      ])
    ).rows[0];
    if (!sr) throw new DelegationError("unavailable");
    const snapshot = copy(sr["content"]) as PolicySnapshot;
    if (
      !snapshot ||
      snapshot.schema_version !== DELEGATION_VERSION ||
      snapshot.canonicalization_version !== "sorted-json-v1" ||
      snapshot.reusable !== false ||
      hash(snapshot) !== sr["content_sha256"] ||
      !validTerms(snapshot.terms) ||
      snapshot.delegation_id !== row["id"] ||
      snapshot.agent_id !== row["agent_id"] ||
      snapshot.org_id !== row["org_id"] ||
      snapshot.accountable_owner_id !== row["accountable_owner_id"] ||
      snapshot.parent_id !== row["parent_id"] ||
      snapshot.terms.max_calls !== row["max_calls"] ||
      snapshot.terms.not_before !== date(row, "not_before") ||
      snapshot.terms.expires_at !== date(row, "expires_at")
    )
      throw new DelegationError("unavailable");
    const ar = (
      await c.query(`SELECT * FROM ${A}.identities WHERE id=$1`, [
        row["agent_id"],
      ])
    ).rows[0];
    if (
      !ar ||
      ar["org_id"] !== row["org_id"] ||
      ar["accountable_owner_id"] !== row["accountable_owner_id"]
    )
      throw new DelegationError("unavailable");
    return Object.freeze({
      id: str(row, "id"),
      parent_id: row["parent_id"] as string | null,
      root_id: str(row, "root_id"),
      agent: agent(ar),
      terms: snapshot.terms,
      reserved_calls: num(row, "reserved_calls"),
      used_calls: num(row, "used_calls"),
      remaining_calls: remainingCalls(
        num(row, "max_calls"),
        num(row, "reserved_calls"),
        num(row, "used_calls"),
      ),
      revoked: row["revoked_at"] !== null,
      object_version: num(row, "object_version"),
      snapshot,
      snapshot_sha256: str(sr, "content_sha256"),
    });
  }
  private async chain(
    c: SqlConnection,
    s: AgentCredentialScope,
  ): Promise<Chain> {
    checkDigest(s?.credential_digest);
    const seed = (
      await c.query(
        `SELECT accountable_owner_id,org_id FROM ${A}.delegations WHERE credential_digest=$1`,
        [s.credential_digest],
      )
    ).rows[0];
    if (!seed) throw new DelegationError("authentication_required");
    await this.locks(c, str(seed, "accountable_owner_id"), str(seed, "org_id"));
    let row = (
      await c.query(
        `SELECT * FROM ${A}.delegations WHERE credential_digest=$1`,
        [s.credential_digest],
      )
    ).rows[0];
    const a = await this.authority(
      c,
      str(seed, "accountable_owner_id"),
      str(seed, "org_id"),
    );
    const rows: Row[] = [],
      views: DelegationView[] = [],
      seen = new Set<string>();
    while (row) {
      if (
        rows.length >= MAX_CHAIN_DEPTH ||
        seen.has(str(row, "id")) ||
        row["org_id"] !== a.org ||
        row["accountable_owner_id"] !== a.human
      )
        throw new DelegationError("forbidden");
      seen.add(str(row, "id"));
      rows.push(row);
      views.push(await this.view(c, row));
      if (row["parent_id"] === null) break;
      row = (
        await c.query(`SELECT * FROM ${A}.delegations WHERE id=$1`, [
          row["parent_id"],
        ])
      ).rows[0];
      if (!row) throw new DelegationError("forbidden");
    }
    if (
      !views.length ||
      views.at(-1)?.parent_id !== null ||
      views.some((v) => v.root_id !== views.at(-1)?.id) ||
      new Set(views.map((v) => v.agent.id)).size !== views.length
    )
      throw new DelegationError("forbidden");
    const time = await now(c);
    for (let i = 0; i < views.length; i++) {
      const v = views[i]!;
      if (
        v.revoked ||
        v.agent.disabled ||
        v.agent.object_version !== v.snapshot.agent_version ||
        time < v.terms.not_before ||
        time >= v.terms.expires_at ||
        v.snapshot.owner_auth_version !== a.auth ||
        v.snapshot.membership_version !== a.membership ||
        v.snapshot.policy_revision !== a.revision ||
        v.snapshot.organization_version !== a.orgVersion
      )
        throw new DelegationError("forbidden");
      if (i + 1 < views.length && !isAttenuation(views[i + 1]!.terms, v.terms))
        throw new DelegationError("forbidden");
    }
    return { rows, views, authority: a };
  }
  private async facts(
    c: SqlConnection,
    a: Authority,
    rid: string,
    lock: "SHARE" | "UPDATE" = "SHARE",
  ): Promise<PolicyFacts> {
    checkId(rid);
    const r = (
      await c.query(
        `SELECT * FROM ${P}.resources WHERE id=$1 AND org_id=$2 FOR ${lock}`,
        [rid, a.org],
      )
    ).rows[0];
    if (!r || !validResource(r as unknown as PolicyResource))
      throw new DelegationError("unavailable_resource");
    const rules = async (table: "role_bindings" | "resource_grants") => {
      const rows = (
        await c.query(
          `SELECT * FROM ${P}.${table} WHERE org_id=$1 AND human_id=$2 AND resource_id=$3 AND revoked_at IS NULL ORDER BY id LIMIT 101`,
          [a.org, a.human, rid],
        )
      ).rows;
      if (rows.length > 100) throw new DelegationError("unavailable");
      return rows.map((r) => ({
        ...r,
        valid_from: date(r, "valid_from"),
        expires_at: r["expires_at"] === null ? null : date(r, "expires_at"),
        revoked: false,
      }));
    };
    const bindings = await rules("role_bindings"),
      grants = await rules("resource_grants"),
      time = await now(c);
    return {
      principal_kind: "human",
      human_id: a.human,
      org_id: a.org,
      membership_role: a.role,
      membership_version: a.membership,
      session_valid_until: time + MAX_DELEGATION_MS,
      observed_at: time,
      resource: r as unknown as PolicyResource,
      policy_revision: a.revision,
      write_mode: a.writeMode,
      bindings: bindings as unknown as RoleBinding[],
      grants: grants as unknown as ResourceGrant[],
    };
  }
  private permit(f: PolicyFacts, action: string): PolicyDecision {
    const d = evaluatePolicy(f, action, f.observed_at);
    if (d.outcome === "needs_approval")
      throw new DelegationError("approval_required");
    if (d.outcome !== "allow")
      throw new DelegationError(
        action === "resource.read" ? "unavailable_resource" : "forbidden",
      );
    return d;
  }
  private async checkTerms(
    c: SqlConnection,
    a: Authority,
    terms: DelegationTerms,
  ): Promise<{ resource_id: string; object_version: number }[]> {
    const versions: { resource_id: string; object_version: number }[] = [];
    const time = await now(c);
    if (
      !validTerms(terms) ||
      terms.expires_at <= time ||
      terms.expires_at > time + MAX_DELEGATION_MS ||
      terms.not_before < time - 60000
    )
      throw new DelegationError("invalid_input");
    // Sort resources for a stable lock order. Human authority must allow every requested action now.
    for (const entry of [...terms.scopes].sort((x, y) =>
      x.resource_id.localeCompare(y.resource_id),
    )) {
      const f = await this.facts(c, a, entry.resource_id);
      if (f.resource.environment !== entry.environment)
        throw new DelegationError("forbidden");
      for (const action of entry.actions) this.permit(f, action);
      versions.push({
        resource_id: entry.resource_id,
        object_version: f.resource.object_version,
      });
    }
    return versions;
  }
  private async issue(
    c: SqlConnection,
    a: Authority,
    request: DelegationRequest,
    digest: string,
    parent: Chain | null,
  ): Promise<IssuedDelegation> {
    const target = await this.findAgent(c, a, request.agent_id),
      p = parent?.views[0];
    const issuer = p ? "delegation:" + p.id : "human:" + a.human;
    const previous = (
      await c.query(
        `SELECT * FROM ${A}.delegations WHERE org_id=$1 AND issuer_key=$2 AND request_id=$3`,
        [a.org, issuer, request.request_id],
      )
    ).rows[0];
    if (previous) {
      if (previous["request_sha256"] !== hash(request))
        throw new DelegationError("version_conflict");
      return { created: false, delegation: await this.view(c, previous) };
    }
    if (p) {
      if (
        !isAttenuation(p.terms, request.terms) ||
        parent!.views.some((v) => v.agent.id === target.id)
      )
        throw new DelegationError("forbidden");
      if (request.terms.max_calls > p.remaining_calls)
        throw new DelegationError("budget_exhausted");
      const count = (
        await c.query(
          `SELECT count(*)::integer AS count FROM ${A}.delegations WHERE root_id=$1`,
          [p.root_id],
        )
      ).rows[0];
      if (!count || num(count, "count") >= 128)
        throw new DelegationError("forbidden");
    }
    const resourceVersions = await this.checkTerms(c, a, request.terms);
    // Lock waits can consume the parent lifetime; recheck after resource locks, before allocation.
    const time = await now(c);
    if (
      request.terms.expires_at <= time ||
      parent?.views.some((v) => time >= v.terms.expires_at)
    )
      throw new DelegationError("forbidden");
    const id = randomUUID(),
      snapshotId = randomUUID();
    const snapshot: PolicySnapshot = {
      schema_version: DELEGATION_VERSION,
      canonicalization_version: "sorted-json-v1",
      delegation_id: id,
      parent_id: p?.id ?? null,
      agent_id: target.id,
      agent_version: target.object_version,
      org_id: a.org,
      accountable_owner_id: a.human,
      owner_auth_version: a.auth,
      membership_version: a.membership,
      organization_version: a.orgVersion,
      owner_role: a.role,
      resource_versions: resourceVersions,
      policy_revision: a.revision,
      terms: request.terms,
      created_at: new Date(time).toISOString(),
      reusable: false,
    };
    await c.query(
      `INSERT INTO ${A}.snapshots(id,org_id,content,content_sha256) VALUES($1,$2,$3,$4)`,
      [snapshotId, a.org, JSON.stringify(snapshot), hash(snapshot)],
    );
    const r = (
      await c.query(
        `INSERT INTO ${A}.delegations(id,org_id,accountable_owner_id,agent_id,parent_id,root_id,credential_digest,issuer_key,request_id,request_sha256,snapshot_id,max_calls,not_before,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          id,
          a.org,
          a.human,
          target.id,
          p?.id ?? null,
          p?.root_id ?? id,
          digest,
          issuer,
          request.request_id,
          hash(request),
          snapshotId,
          request.terms.max_calls,
          new Date(request.terms.not_before),
          new Date(request.terms.expires_at),
        ],
      )
    ).rows[0];
    if (!r) throw new DelegationError("unavailable");
    if (p) {
      const allocated = (
        await c.query(
          `UPDATE ${A}.delegations SET reserved_calls=reserved_calls+$1,object_version=object_version+1 WHERE id=$2 AND max_calls-used_calls-reserved_calls>=$1 AND expires_at>clock_timestamp() RETURNING id`,
          [request.terms.max_calls, p.id],
        )
      ).rows[0];
      if (!allocated) throw new DelegationError("budget_exhausted");
    }
    // Revalidate after all resource locks and inserts. Earlier grants may have
    // naturally expired while another resource or uniqueness check was waiting.
    await this.checkTerms(c, a, request.terms);
    const completedAt = await now(c);
    if (
      request.terms.expires_at <= completedAt ||
      parent?.views.some((v) => completedAt >= v.terms.expires_at)
    )
      throw new DelegationError("forbidden");
    return { created: true, delegation: await this.view(c, r) };
  }
  async issueRoot(
    s: PolicyScope,
    r: DelegationRequest,
    digest: string,
  ): Promise<IssuedDelegation> {
    validateRequest(r);
    checkDigest(digest);
    const input = copy(r);
    return tx(this.pool, async (c) => {
      const a = await this.human(c, s);
      const issued = await this.issue(c, a, input, digest, null);
      if (issued.created) await this.human(c, s);
      return issued;
    });
  }
  async delegate(
    s: AgentCredentialScope,
    r: DelegationRequest,
    digest: string,
  ): Promise<IssuedDelegation> {
    validateRequest(r);
    checkDigest(digest);
    const input = copy(r);
    return tx(this.pool, async (c) => {
      const chain = await this.chain(c, s);
      const issued = await this.issue(c, chain.authority, input, digest, chain);
      if (issued.created) await this.chain(c, s);
      return issued;
    });
  }
  async inspect(s: AgentCredentialScope): Promise<DelegationView> {
    return tx(this.pool, async (c) => (await this.chain(c, s)).views[0]!);
  }
  async inspectOwned(s: PolicyScope, id: string): Promise<DelegationView> {
    checkId(id);
    return tx(this.pool, async (c) => {
      const a = await this.human(c, s),
        r = (
          await c.query(
            `SELECT * FROM ${A}.delegations WHERE id=$1 AND org_id=$2 AND accountable_owner_id=$3`,
            [id, a.org, a.human],
          )
        ).rows[0];
      if (!r) throw new DelegationError("unavailable_resource");
      return this.view(c, r);
    });
  }
  async revoke(
    s: PolicyScope,
    id: string,
    expected: number,
  ): Promise<DelegationView> {
    checkId(id);
    if (!isContextVersion(expected)) throw new DelegationError("invalid_input");
    return tx(this.pool, async (c) => {
      const a = await this.human(c, s),
        r = (
          await c.query(
            `SELECT * FROM ${A}.delegations WHERE id=$1 AND org_id=$2 AND accountable_owner_id=$3`,
            [id, a.org, a.human],
          )
        ).rows[0];
      if (!r) throw new DelegationError("unavailable_resource");
      if (r["revoked_at"] !== null) return this.view(c, r);
      if (r["object_version"] !== expected)
        throw new DelegationError("version_conflict");
      const next = (
        await c.query(
          `UPDATE ${A}.delegations SET revoked_at=clock_timestamp(),object_version=object_version+1 WHERE id=$1 RETURNING *`,
          [id],
        )
      ).rows[0];
      if (!next) throw new DelegationError("unavailable");
      return this.view(c, next);
    });
  }
  async invoke(
    s: AgentCredentialScope,
    r: AgentToolRequest,
  ): Promise<AgentToolResult> {
    validateToolRequest(r);
    const input = copy(r);
    return tx(this.pool, async (c) => {
      const chain = await this.chain(c, s),
        leaf = chain.views[0]!,
        a = chain.authority;
      const f = await this.facts(
        c,
        a,
        input.resource_id,
        input.operation === "catalog.rename" ? "UPDATE" : "SHARE",
      );
      const action =
        input.operation === "catalog.read"
          ? "resource.read"
          : "resource.update";
      for (const v of chain.views)
        if (
          !allowsScope(
            v.terms,
            input.resource_id,
            action,
            f.resource.environment,
            f.observed_at,
          )
        )
          throw new DelegationError("forbidden");
      this.permit(f, "resource.read");
      const decision = this.permit(f, action);
      const previous = (
        await c.query(
          `SELECT request_sha256,result FROM ${A}.operations WHERE delegation_id=$1 AND request_id=$2`,
          [leaf.id, input.request_id],
        )
      ).rows[0];
      if (previous) {
        if (previous["request_sha256"] !== hash(input))
          throw new DelegationError("version_conflict");
        return {
          ...(copy(previous["result"]) as AgentToolResult),
          replayed: true,
        };
      }
      if (leaf.remaining_calls < 1)
        throw new DelegationError("budget_exhausted");
      if (
        input.operation === "catalog.rename" &&
        (input.expected_version !== f.resource.object_version ||
          input.expected_policy_revision !== a.revision)
      )
        throw new DelegationError("version_conflict");
      const deadline = Math.min(
        Date.parse(decision.expires_at),
        ...chain.views.map((v) => v.terms.expires_at),
      );
      const paid = (
        await c.query(
          `UPDATE ${A}.delegations SET used_calls=used_calls+1,object_version=object_version+1 WHERE id=$1 AND max_calls-used_calls-reserved_calls>=1 AND clock_timestamp()<$2::timestamptz RETURNING id`,
          [leaf.id, new Date(deadline)],
        )
      ).rows[0];
      if (!paid) throw new DelegationError("forbidden");
      let resource = f.resource;
      if (input.operation === "catalog.rename") {
        const updated = (
          await c.query(
            `UPDATE ${P}.resources SET display_name=$1,object_version=object_version+1 WHERE id=$2 AND org_id=$3 AND object_version=$4 AND clock_timestamp()<$5::timestamptz RETURNING *`,
            [
              input.display_name,
              input.resource_id,
              a.org,
              input.expected_version,
              new Date(deadline),
            ],
          )
        ).rows[0];
        if (!updated) throw new DelegationError("version_conflict");
        resource = updated as unknown as PolicyResource;
      }
      const result: AgentToolResult = {
        delegation_id: leaf.id,
        accountable_owner_id: a.human,
        snapshot_sha256: leaf.snapshot_sha256,
        resource,
        decision,
        replayed: false,
      };
      await c.query(
        `INSERT INTO ${A}.operations(delegation_id,request_id,request_sha256,resource_id,result) VALUES($1,$2,$3,$4,$5)`,
        [
          leaf.id,
          input.request_id,
          hash(input),
          input.resource_id,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }
}
