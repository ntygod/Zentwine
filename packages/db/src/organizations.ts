import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  OrganizationError,
  validateAuditQuery,
  type OrganizationAuditQuery,
  type OrganizationAuditPage,
  isIdentityId,
  isContextVersion,
  validateSettings,
  validateInvitation,
  validateConnection,
  validExternalId,
  type OrganizationRepository,
  type OrganizationScope,
  type OrganizationSettings,
  type SettingsInput,
  type ManagedMember,
  type InvitationInput,
  type InvitationView,
  type ConnectionInput,
  type FederationConnection,
  type ProvisioningInput,
  type ExternalIdentityView,
  type MemberRole,
} from "@zentwine/domain";
import {
  evaluatePolicy,
  type PolicyFacts,
  type PolicyResource,
  type RoleBinding,
  type ResourceGrant,
} from "@zentwine/policy";
import type { IdentityPool, SqlConnection } from "./connection.js";
import { readOrganizationAudit } from "./organization-audit.js";
import { authorizationLock } from "./authorization-locks.js";
import { invalidateApprovals } from "./approval-events.js";
import {
  membershipAccess,
  federationTicketValid,
} from "./organization-guards.js";
const I = "zentwine_identity",
  P = "zentwine_policy",
  O = "zentwine_organizations";
type Row = Record<string, unknown>;
const str = (r: Row, k: string): string => {
  if (typeof r[k] !== "string") throw new OrganizationError("unavailable");
  return r[k];
};
const num = (r: Row, k: string): number => {
  if (!Number.isSafeInteger(r[k])) throw new OrganizationError("unavailable");
  return Number(r[k]);
};
const at = (r: Row, k: string): Date => {
  if (!(r[k] instanceof Date) || !Number.isFinite(r[k].getTime()))
    throw new OrganizationError("unavailable");
  return r[k];
};
const id = (v: unknown): void => {
  if (!isIdentityId(v)) throw new OrganizationError("invalid_input");
};
const digest = (v: unknown): void => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw new OrganizationError("authentication_required");
};
const version = (v: unknown): void => {
  if (!isContextVersion(v)) throw new OrganizationError("invalid_input");
};
const hash = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function tx<T>(
  pool: IdentityPool,
  work: (c: SqlConnection) => Promise<T>,
): Promise<T> {
  let c: SqlConnection | undefined,
    broken = false;
  try {
    c = await pool.connect();
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await work(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    if (c)
      try {
        await c.query("ROLLBACK");
      } catch {
        broken = true;
      }
    if (e instanceof OrganizationError) throw e;
    throw new OrganizationError("unavailable");
  } finally {
    c?.release(broken);
  }
}
function settingsView(r: Row): OrganizationSettings {
  return {
    org_id: str(r, "org_id"),
    display_name: str(r, "display_name"),
    locale: str(r, "locale") as "zh-CN" | "en",
    time_zone: str(r, "time_zone"),
    invitations_enabled: r["invitations_enabled"] === true,
    invite_ttl_hours: num(r, "invite_ttl_hours"),
    guest_ttl_days: num(r, "guest_ttl_days"),
    object_version: num(r, "object_version"),
  };
}
function memberView(r: Row): ManagedMember {
  return {
    id: str(r, "id"),
    human_id: str(r, "human_id"),
    display_name: str(r, "display_name"),
    display_number: str(r, "display_number"),
    role: str(r, "role") as MemberRole,
    access_kind: str(r, "access_kind") as "member" | "guest",
    access_expires_at:
      r["access_expires_at"] === null
        ? null
        : at(r, "access_expires_at").toISOString(),
    status: str(r, "status") as "active" | "revoked",
    object_version: num(r, "object_version"),
    managed_by_connection: r["managed"] === true,
  };
}
function invitationView(r: Row): InvitationView {
  return {
    id: str(r, "id"),
    org_id: str(r, "org_id"),
    human_id: str(r, "human_id"),
    role: str(r, "role") as "member" | "viewer",
    access_kind: str(r, "access_kind") as "member" | "guest",
    resource_ids: r["resource_ids"] as string[],
    state:
      r["state"] === "pending" && r["expired"] === true
        ? "expired"
        : (str(r, "state") as InvitationView["state"]),
    expires_at: at(r, "expires_at").toISOString(),
    access_expires_at:
      r["access_expires_at"] === null
        ? null
        : at(r, "access_expires_at").toISOString(),
    object_version: num(r, "object_version"),
  };
}
function connectionView(r: Row): FederationConnection {
  return {
    id: str(r, "id"),
    org_id: str(r, "org_id"),
    display_name: str(r, "display_name"),
    issuer: str(r, "issuer"),
    client_id: str(r, "client_id"),
    enabled: r["enabled"] === true,
    object_version: num(r, "object_version"),
    protocol: "oidc-adapter-port",
  };
}
const externalView = (r: Row): ExternalIdentityView => ({
  id: str(r, "id"),
  connection_id: str(r, "connection_id"),
  external_id: str(r, "external_id"),
  active: r["active"] === true,
  object_version: num(r, "object_version"),
});
/** Separate trusted organization-control connection, never handed to model tools or untrusted extensions. */
export class PostgresOrganizationRepository implements OrganizationRepository {
  private readonly auditCursorKey = randomBytes(32);
  constructor(private readonly pool: IdentityPool) {}
  async assertRuntimeRole(): Promise<void> {
    return tx(this.pool, async (c) => {
      const r = (
        await c.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
  EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits,
  EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ('${I}','${P}','${O}') AND t.relowner=r.oid) AS owns,
  has_schema_privilege(current_user,'${O}','CREATE') AS ddl,
  has_table_privilege(current_user,'${I}.humans','INSERT,UPDATE,DELETE,TRUNCATE') AS mutates_humans,
  has_table_privilege(current_user,'${O}.events','UPDATE,DELETE,TRUNCATE') AS rewrites_events,
  has_table_privilege(current_user,'${O}.provisioning_receipts','UPDATE,DELETE,TRUNCATE') AS rewrites_receipts,
  has_column_privilege(current_user,'${O}.connections','credential_digest','UPDATE') AS issues_machine_credential,
  has_table_privilege(current_user,'${O}.external_identities','INSERT,DELETE') AS links_identity
  FROM pg_roles r WHERE r.rolname=current_user`)
      ).rows[0];
      if (!r || Object.values(r).some((x) => x !== false))
        throw new OrganizationError("unavailable");
      await c.query(`SELECT org_id FROM ${O}.settings LIMIT 0`);
    });
  }
  private async session(c: SqlConnection, secret: string): Promise<Row> {
    digest(secret);
    const r = (
      await c.query(
        `SELECT s.*,h.display_name AS human_name FROM ${I}.sessions s JOIN ${I}.humans h ON h.id=s.human_id WHERE s.digest=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp() AND h.status='active' AND h.auth_version=s.auth_version`,
        [secret],
      )
    ).rows[0];
    if (!r) throw new OrganizationError("authentication_required");
    return r;
  }
  private async lockSession(
    c: SqlConnection,
    secret: string,
    write = false,
  ): Promise<Row> {
    digest(secret);
    const r = (
      await c.query(
        `SELECT human_id FROM ${I}.sessions WHERE digest=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
        [secret],
      )
    ).rows[0];
    if (!r) throw new OrganizationError("authentication_required");
    return r;
  }
  private async locks(
    c: SqlConnection,
    org: string,
    humans: readonly string[],
    write = true,
  ): Promise<void> {
    id(org);
    const sorted = [...new Set(humans)].sort();
    for (const h of sorted) {
      id(h);
      await authorizationLock(c, `human:${h}`, true);
    }
    // Exclusive org lock serializes managed member/settings changes; ordinary resource operations hold shared org locks.
    await authorizationLock(c, `organization:${org}`, !write);
    for (const h of sorted)
      await authorizationLock(c, `membership:${org}:${h}`, write === false);
    await authorizationLock(c, `policy:${org}`, write === false);
  }
  private async current(
    c: SqlConnection,
    s: OrganizationScope,
    owner = false,
  ): Promise<Row> {
    const a = await this.session(c, s.session_digest);
    if (a["context_version"] !== s.context_version)
      throw new OrganizationError("version_conflict");
    if (a["active_org_id"] !== s.org_id)
      throw new OrganizationError("unavailable_resource");
    const m = (
      await c.query(
        `SELECT m.*,o.object_version AS org_version FROM ${I}.memberships m JOIN ${I}.organizations o ON o.id=m.org_id WHERE m.org_id=$1 AND m.human_id=$2 AND m.status='active' AND o.status='active'`,
        [s.org_id, a["human_id"]],
      )
    ).rows[0];
    if (
      !m ||
      !(
        await membershipAccess(
          c,
          s.org_id,
          str(a, "human_id"),
          s.session_digest,
        )
      ).allowed
    )
      throw new OrganizationError("unavailable_resource");
    if (owner && (m["role"] !== "owner" || m["access_kind"] !== "member"))
      throw new OrganizationError("forbidden");
    return { ...a, member: m };
  }
  private async begin(
    c: SqlConnection,
    s: OrganizationScope,
    others: readonly string[] = [],
    owner = false,
    write = true,
  ): Promise<Row> {
    id(s?.org_id);
    version(s?.context_version);
    const seed = await this.lockSession(c, s?.session_digest);
    await this.locks(c, s.org_id, [str(seed, "human_id"), ...others], write);
    return this.current(c, s, owner);
  }
  private async setting(
    c: SqlConnection,
    org: string,
  ): Promise<OrganizationSettings> {
    const r = (
      await c.query(
        `SELECT s.*,o.display_name FROM ${O}.settings s JOIN ${I}.organizations o ON o.id=s.org_id WHERE s.org_id=$1`,
        [org],
      )
    ).rows[0];
    if (!r) throw new OrganizationError("unavailable");
    return settingsView(r);
  }
  private async event(
    c: SqlConnection,
    org: string,
    actor: string,
    kind: string,
    subject: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO ${O}.events(org_id,actor_id,kind,subject_id) VALUES($1,$2,$3,$4)`,
      [org, actor, kind, subject],
    );
  }
  private async cutoff(
    c: SqlConnection,
    org: string,
    human: string,
  ): Promise<void> {
    // No target session row updates while holding authority locks: avoid lock inversion with in-flight requests.
    await c.query(
      `INSERT INTO ${O}.session_cutoffs(org_id,human_id,invalid_before) VALUES($1,$2,clock_timestamp()) ON CONFLICT(org_id,human_id) DO UPDATE SET invalid_before=GREATEST(${O}.session_cutoffs.invalid_before,EXCLUDED.invalid_before)`,
      [org, human],
    );
  }
  async audit(s: OrganizationScope, input: OrganizationAuditQuery): Promise<OrganizationAuditPage> {
    validateAuditQuery(input);
    return tx(this.pool, async (c) => {
      await this.begin(c, s, [], true, false);
      const page = await readOrganizationAudit(c, s, input, this.auditCursorKey);
      await this.current(c, s, true);
      return page;
    });
  }
  async settings(s: OrganizationScope): Promise<OrganizationSettings> {
    return tx(this.pool, async (c) => {
      await this.begin(c, s, [], true, false);
      const r = await this.setting(c, s.org_id);
      await this.current(c, s, true);
      return r;
    });
  }
  async updateSettings(
    s: OrganizationScope,
    i: SettingsInput,
  ): Promise<OrganizationSettings> {
    validateSettings(i);
    return tx(this.pool, async (c) => {
      const a = await this.begin(c, s, [], true);
      const old = await this.setting(c, s.org_id);
      if (old.object_version !== i.expected_version)
        throw new OrganizationError("version_conflict");
      await c.query(
        `UPDATE ${O}.settings SET locale=$2,time_zone=$3,invitations_enabled=$4,invite_ttl_hours=$5,guest_ttl_days=$6,object_version=object_version+1 WHERE org_id=$1`,
        [
          s.org_id,
          i.locale,
          i.time_zone,
          i.invitations_enabled,
          i.invite_ttl_hours,
          i.guest_ttl_days,
        ],
      );
      await c.query(
        `UPDATE ${I}.organizations SET display_name=$2,object_version=object_version+1 WHERE id=$1`,
        [s.org_id, i.display_name],
      );
      await c.query(
        `UPDATE ${O}.invitations SET state='revoked',object_version=object_version+1 WHERE org_id=$1 AND state='pending'`,
        [s.org_id],
      );
      await invalidateApprovals(c, s.org_id, null);
      await this.event(
        c,
        s.org_id,
        str(a, "human_id"),
        "settings.updated",
        s.org_id,
      );
      const result = await this.setting(c, s.org_id);
      await this.current(c, s, true);
      return result;
    });
  }
  private async member(
    c: SqlConnection,
    org: string,
    mid: string,
  ): Promise<Row> {
    const r = (
      await c.query(
        `SELECT m.*,h.display_name,EXISTS(SELECT 1 FROM ${O}.external_identities x WHERE x.org_id=m.org_id AND x.human_id=m.human_id) AS managed FROM ${I}.memberships m JOIN ${I}.humans h ON h.id=m.human_id WHERE m.org_id=$1 AND m.id=$2`,
        [org, mid],
      )
    ).rows[0];
    if (!r) throw new OrganizationError("unavailable_resource");
    return r;
  }
  async self(s: OrganizationScope): Promise<ManagedMember> {
    return tx(this.pool, async (c) => {
      const a = await this.begin(c, s, [], false, false);
      const result = memberView(
        await this.member(c, s.org_id, str(a["member"] as Row, "id")),
      );
      await this.current(c, s);
      return result;
    });
  }
  async members(s: OrganizationScope): Promise<readonly ManagedMember[]> {
    return tx(this.pool, async (c) => {
      await this.begin(c, s, [], true, false);
      const rows = (
        await c.query(
          `SELECT m.*,h.display_name,EXISTS(SELECT 1 FROM ${O}.external_identities x WHERE x.org_id=m.org_id AND x.human_id=m.human_id) AS managed FROM ${I}.memberships m JOIN ${I}.humans h ON h.id=m.human_id WHERE m.org_id=$1 ORDER BY m.created_at,m.id LIMIT 201`,
          [s.org_id],
        )
      ).rows;
      if (rows.length > 200) throw new OrganizationError("unavailable");
      const result = rows.map(memberView);
      await this.current(c, s, true);
      return result;
    });
  }
  async updateMember(
    s: OrganizationScope,
    mid: string,
    role: MemberRole,
    status: "active" | "revoked",
    v: number,
  ): Promise<ManagedMember> {
    id(mid);
    version(v);
    if (
      !["owner", "member", "viewer"].includes(role) ||
      !["active", "revoked"].includes(status)
    )
      throw new OrganizationError("invalid_input");
    return tx(this.pool, async (c) => {
      // Reject unauthorized callers before resolving another member identifier.
      id(s?.org_id);
      version(s?.context_version);
      await this.current(c, s, true);
      const seed = await this.member(c, s.org_id, mid),
        human = str(seed, "human_id");
      const a = await this.begin(c, s, [human], true);
      const m = await this.member(c, s.org_id, mid);
      if (m["object_version"] !== v)
        throw new OrganizationError("version_conflict");
      if (
        m["managed"] === true ||
        (m["access_kind"] === "guest" && role !== "viewer") ||
        (m["status"] === "revoked" && status === "active")
      )
        throw new OrganizationError("forbidden");
      if (
        m["role"] === "owner" &&
        m["status"] === "active" &&
        (role !== "owner" || status !== "active")
      ) {
        const count = (
          await c.query(
            `SELECT count(*)::integer AS n FROM ${I}.memberships m JOIN ${I}.humans h ON h.id=m.human_id WHERE m.org_id=$1 AND m.role='owner' AND m.status='active' AND h.status='active'`,
            [s.org_id],
          )
        ).rows[0];
        if (Number(count?.["n"]) <= 1) throw new OrganizationError("forbidden");
      }
      await c.query(
        `UPDATE ${I}.memberships SET role=$2,status=$3,object_version=object_version+1 WHERE id=$1`,
        [mid, role, status],
      );
      await this.cutoff(c, s.org_id, human);
      await invalidateApprovals(c, s.org_id, human);
      await c.query(
        `UPDATE ${O}.invitations SET state='revoked',object_version=object_version+1 WHERE org_id=$1 AND (inviter_id=$2 OR human_id=$2) AND state='pending'`,
        [s.org_id, human],
      );
      await this.event(c, s.org_id, str(a, "human_id"), "member.updated", mid);
      const result = memberView(await this.member(c, s.org_id, mid));
      await this.session(c, s.session_digest);
      return result;
    });
  }
  async revokeOrganizationSessions(
    s: OrganizationScope,
    human: string,
  ): Promise<void> {
    id(human);
    return tx(this.pool, async (c) => {
      const a = await this.begin(c, s, [human]);
      if (
        str(a, "human_id") !== human &&
        (a["member"] as Row)["role"] !== "owner"
      )
        throw new OrganizationError("forbidden");
      const target = (
        await c.query(
          `SELECT id FROM ${I}.memberships WHERE org_id=$1 AND human_id=$2`,
          [s.org_id, human],
        )
      ).rows[0];
      if (!target) throw new OrganizationError("unavailable_resource");
      await this.cutoff(c, s.org_id, human);
      await this.event(
        c,
        s.org_id,
        str(a, "human_id"),
        "sessions.revoked",
        human,
      );
      await this.session(c, s.session_digest);
    });
  }
  private async canRead(
    c: SqlConnection,
    org: string,
    human: string,
    rid: string,
  ): Promise<boolean> {
    const r = (
      await c.query(
        `SELECT * FROM ${P}.resources WHERE org_id=$1 AND id=$2 AND status='active'`,
        [org, rid],
      )
    ).rows[0];
    if (!r) return false;
    const m = (
      await c.query(
        `SELECT * FROM ${I}.memberships WHERE org_id=$1 AND human_id=$2 AND status='active'`,
        [org, human],
      )
    ).rows[0];
    if (!m) return false;
    const access = await membershipAccess(c, org, human);
    if (!access.allowed) return false;
    const p = (
      await c.query(
        `SELECT * FROM ${P}.organization_policies WHERE org_id=$1`,
        [org],
      )
    ).rows[0];
    if (!p) return false;
    const rules = async (table: "role_bindings" | "resource_grants") => {
      const rows = (
        await c.query(
          `SELECT * FROM ${P}.${table} WHERE org_id=$1 AND human_id=$2 AND resource_id=$3 AND revoked_at IS NULL LIMIT 101`,
          [org, human, rid],
        )
      ).rows;
      if (rows.length > 100) throw new OrganizationError("unavailable");
      return rows.map((x) => ({
        ...x,
        valid_from: at(x, "valid_from").getTime(),
        expires_at:
          x["expires_at"] === null ? null : at(x, "expires_at").getTime(),
        revoked: false,
      }));
    };
    const bindings = await rules("role_bindings"),
      grants = await rules("resource_grants");
    const time = (await c.query("SELECT clock_timestamp() AS now")).rows[0];
    if (!time) throw new OrganizationError("unavailable");
    const now = at(time, "now").getTime();
    const f: PolicyFacts = {
      principal_kind: "human",
      human_id: human,
      org_id: org,
      membership_role: str(m, "role") as MemberRole,
      membership_kind: access.guest ? "guest" : "member",
      membership_version: num(m, "object_version"),
      session_valid_until: now + 1000,
      observed_at: now,
      resource: r as unknown as PolicyResource,
      policy_revision: num(p, "revision"),
      write_mode: str(p, "write_mode") as PolicyFacts["write_mode"],
      bindings: bindings as unknown as RoleBinding[],
      grants: grants as unknown as ResourceGrant[],
    };
    return evaluatePolicy(f, "resource.read", now).outcome === "allow";
  }
  async invitations(s: OrganizationScope): Promise<readonly InvitationView[]> {
    return tx(this.pool, async (c) => {
      await this.begin(c, s, [], true, false);
      const rows = (
        await c.query(
          `SELECT *,expires_at<=clock_timestamp() AS expired FROM ${O}.invitations WHERE org_id=$1 ORDER BY created_at DESC,id LIMIT 100`,
          [s.org_id],
        )
      ).rows;
      const result = rows.map(invitationView);
      await this.current(c, s, true);
      return result;
    });
  }
  async invite(
    s: OrganizationScope,
    i: InvitationInput,
    secretHash: string,
  ): Promise<{ invitation: InvitationView; credential_issued: boolean }> {
    validateInvitation(i);
    digest(secretHash);
    return tx(this.pool, async (c) => {
      const a = await this.begin(c, s, [i.human_id], true),
        m = a["member"] as Row;
      const content = hash([
        i.human_id,
        i.role,
        i.access_kind,
        [...i.resource_ids].sort(),
        i.expected_settings_version,
      ]);
      const old = (
        await c.query(
          `SELECT *,expires_at<=clock_timestamp() AS expired FROM ${O}.invitations WHERE org_id=$1 AND inviter_id=$2 AND request_id=$3`,
          [s.org_id, a["human_id"], i.request_id],
        )
      ).rows[0];
      if (old) {
        if (old["content_hash"] !== content)
          throw new OrganizationError("version_conflict");
        await this.current(c, s, true);
        return { invitation: invitationView(old), credential_issued: false };
      }
      const settings = await this.setting(c, s.org_id);
      if (settings.object_version !== i.expected_settings_version)
        throw new OrganizationError("version_conflict");
      if (!settings.invitations_enabled)
        throw new OrganizationError("forbidden");
      if (
        !(
          await c.query(
            `SELECT id FROM ${I}.humans WHERE id=$1 AND status='active'`,
            [i.human_id],
          )
        ).rows.length
      )
        throw new OrganizationError("unavailable_resource");
      if (
        (
          await c.query(
            `SELECT id FROM ${I}.memberships WHERE org_id=$1 AND human_id=$2 AND status='active' UNION ALL SELECT id FROM ${O}.external_identities WHERE org_id=$1 AND human_id=$2`,
            [s.org_id, i.human_id],
          )
        ).rows.length
      )
        throw new OrganizationError("version_conflict");
      for (const rid of [...i.resource_ids].sort())
        if (!(await this.canRead(c, s.org_id, str(a, "human_id"), rid)))
          throw new OrganizationError("unavailable_resource");
      const created = (
        await c.query(
          `INSERT INTO ${O}.invitations(id,org_id,human_id,inviter_id,request_id,content_hash,digest,role,access_kind,resource_ids,inviter_version,settings_version,org_version,expires_at,access_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+$14*interval '1 hour',CASE WHEN $9='guest' THEN clock_timestamp()+$14*interval '1 hour'+$15*interval '1 day' ELSE NULL END) RETURNING *,false AS expired`,
          [
            randomUUID(),
            s.org_id,
            i.human_id,
            a["human_id"],
            i.request_id,
            content,
            secretHash,
            i.role,
            i.access_kind,
            i.resource_ids,
            m["object_version"],
            settings.object_version,
            m["org_version"],
            settings.invite_ttl_hours,
            settings.guest_ttl_days,
          ],
        )
      ).rows[0];
      if (!created) throw new OrganizationError("unavailable");
      await this.event(
        c,
        s.org_id,
        str(a, "human_id"),
        "invitation.created",
        str(created, "id"),
      );
      await this.current(c, s, true);
      for (const rid of i.resource_ids)
        if (!(await this.canRead(c, s.org_id, str(a, "human_id"), rid)))
          throw new OrganizationError("unavailable_resource");
      return { invitation: invitationView(created), credential_issued: true };
    });
  }
  async revokeInvitation(
    s: OrganizationScope,
    iid: string,
    v: number,
  ): Promise<InvitationView> {
    id(iid);
    version(v);
    return tx(this.pool, async (c) => {
      const a = await this.begin(c, s, [], true);
      const row = (
        await c.query(
          `UPDATE ${O}.invitations SET state='revoked',object_version=object_version+1 WHERE org_id=$1 AND id=$2 AND state='pending' AND object_version=$3 RETURNING *,expires_at<=clock_timestamp() AS expired`,
          [s.org_id, iid, v],
        )
      ).rows[0];
      if (!row) throw new OrganizationError("version_conflict");
      await this.event(
        c,
        s.org_id,
        str(a, "human_id"),
        "invitation.revoked",
        iid,
      );
      await this.current(c, s, true);
      return invitationView(row);
    });
  }
  async acceptInvitation(
    sessionHash: string,
    inviteHash: string,
    nextHash: string,
  ): Promise<{ org_id: string; membership_id: string }> {
    digest(sessionHash);
    digest(inviteHash);
    digest(nextHash);
    return tx(this.pool, async (c) => {
      const seed = await this.lockSession(c, sessionHash, true);
      const invitation = (
        await c.query(
          `SELECT org_id,inviter_id,human_id FROM ${O}.invitations WHERE digest=$1`,
          [inviteHash],
        )
      ).rows[0];
      if (!invitation || invitation["human_id"] !== seed["human_id"])
        throw new OrganizationError("unavailable_resource");
      const org = str(invitation, "org_id"),
        human = str(seed, "human_id"),
        inviter = str(invitation, "inviter_id");
      await this.locks(c, org, [human, inviter]);
      const session = await this.session(c, sessionHash);
      const load = async () => {
        const r = (
          await c.query(
            `SELECT i.* FROM ${O}.invitations i JOIN ${I}.memberships m ON m.org_id=i.org_id AND m.human_id=i.inviter_id JOIN ${I}.humans h ON h.id=m.human_id JOIN ${I}.organizations o ON o.id=m.org_id JOIN ${O}.settings s ON s.org_id=o.id WHERE i.digest=$1 AND i.state='pending' AND i.expires_at>clock_timestamp() AND m.status='active' AND m.role='owner' AND h.status='active' AND o.status='active' AND m.object_version=i.inviter_version AND o.object_version=i.org_version AND s.object_version=i.settings_version AND s.invitations_enabled`,
            [inviteHash],
          )
        ).rows[0];
        if (!r) throw new OrganizationError("unavailable_resource");
        return r;
      };
      const i = await load();
      const resources = i["resource_ids"] as string[];
      for (const rid of resources)
        if (!(await this.canRead(c, org, inviter, rid)))
          throw new OrganizationError("unavailable_resource");
      if (
        (
          await c.query(
            `SELECT id FROM ${I}.memberships WHERE org_id=$1 AND human_id=$2 AND status='active' UNION ALL SELECT id FROM ${O}.external_identities WHERE org_id=$1 AND human_id=$2`,
            [org, human],
          )
        ).rows.length
      )
        throw new OrganizationError("version_conflict");
      const settings = await this.setting(c, org);
      const membership = (
        await c.query(
          `INSERT INTO ${I}.memberships(id,org_id,human_id,display_number,role,status,access_kind,access_expires_at) SELECT $1,$2,$3,'MEM-'||(COALESCE(MAX(substring(display_number FROM 5)::integer),0)+1),$4,'active',$5,CASE WHEN $5='guest' THEN LEAST($6::timestamptz,clock_timestamp()+$7*interval '1 day') ELSE NULL END FROM ${I}.memberships WHERE org_id=$2 ON CONFLICT(org_id,human_id) DO UPDATE SET role=EXCLUDED.role,status='active',access_kind=EXCLUDED.access_kind,access_expires_at=EXCLUDED.access_expires_at,object_version=${I}.memberships.object_version+1 RETURNING *`,
          [
            randomUUID(),
            org,
            human,
            i["role"],
            i["access_kind"],
            i["access_expires_at"],
            settings.guest_ttl_days,
          ],
        )
      ).rows[0];
      if (!membership) throw new OrganizationError("unavailable");
      await c.query(
        `UPDATE ${P}.role_bindings SET revoked_at=clock_timestamp() WHERE org_id=$1 AND human_id=$2 AND revoked_at IS NULL`,
        [org, human],
      );
      await c.query(
        `UPDATE ${P}.resource_grants SET revoked_at=clock_timestamp() WHERE org_id=$1 AND human_id=$2 AND effect='allow' AND revoked_at IS NULL`,
        [org, human],
      );
      for (const rid of resources)
        await c.query(
          `INSERT INTO ${P}.role_bindings(id,org_id,human_id,resource_id,role,valid_from,expires_at) VALUES($1,$2,$3,$4,'reader',clock_timestamp(),$5)`,
          [randomUUID(), org, human, rid, membership["access_expires_at"]],
        );
      await this.cutoff(c, org, human);
      await invalidateApprovals(c, org, human);
      await c.query(
        `UPDATE ${O}.invitations SET state='accepted',object_version=object_version+1 WHERE id=$1`,
        [i["id"]],
      );
      await this.event(c, org, human, "invitation.accepted", str(i, "id"));
      // Privilege change rotates the browser credential atomically; no organization authority from a copied link alone.
      await this.session(c, sessionHash);
      for (const rid of resources)
        if (
          !(await this.canRead(c, org, inviter, rid)) ||
          !(await this.canRead(c, org, human, rid))
        )
          throw new OrganizationError("unavailable_resource");
      // The request was changed to accepted above; verify its time and current inviter/settings again without relying on cached facts.
      const valid = (
        await c.query(
          `SELECT i.id FROM ${O}.invitations i JOIN ${I}.memberships m ON m.org_id=i.org_id AND m.human_id=i.inviter_id JOIN ${I}.humans h ON h.id=m.human_id JOIN ${I}.organizations o ON o.id=i.org_id JOIN ${O}.settings s ON s.org_id=i.org_id WHERE i.id=$1 AND i.expires_at>clock_timestamp() AND m.object_version=i.inviter_version AND m.status='active' AND m.role='owner' AND h.status='active' AND o.status='active' AND o.object_version=i.org_version AND s.object_version=i.settings_version AND s.invitations_enabled`,
          [i["id"]],
        )
      ).rows[0];
      if (!valid) throw new OrganizationError("unavailable_resource");
      const newId = randomUUID();
      await c.query(
        `INSERT INTO ${I}.sessions(id,digest,human_id,auth_version,active_org_id,created_at,expires_at,idle_expires_at) VALUES($1,$2,$3,$4,$5,GREATEST(clock_timestamp(),(SELECT invalid_before+interval '1 microsecond' FROM ${O}.session_cutoffs WHERE org_id=$5 AND human_id=$3)),$6,LEAST($6::timestamptz,clock_timestamp()+interval '30 minutes'))`,
        [
          newId,
          nextHash,
          human,
          session["auth_version"],
          org,
          session["expires_at"],
        ],
      );
      await c.query(
        `UPDATE ${I}.sessions SET revoked_at=clock_timestamp() WHERE digest=$1`,
        [sessionHash],
      );
      await this.session(c, nextHash);
      return { org_id: org, membership_id: str(membership, "id") };
    });
  }
  async search(
    s: OrganizationScope,
    q: string,
  ): Promise<readonly { id: string; display_name: string; kind: string }[]> {
    if (typeof q !== "string" || q.length > 120 || /[\u0000-\u001f]/.test(q))
      throw new OrganizationError("invalid_input");
    return tx(this.pool, async (c) => {
      const a = await this.begin(c, s, [], false, false);
      const guest = (a["member"] as Row)["access_kind"] === "guest";
      // Filter all visibility and deny conditions before LIMIT. No hidden count/cursor/facets are returned.
      const rows = (
        await c.query(
          `SELECT r.* FROM ${P}.resources r WHERE r.org_id=$1 AND r.status='active' AND position(lower($3) in lower(r.display_name))>0
   AND (($4=false AND (r.visibility='organization' OR r.owner_human_id=$2)) OR EXISTS(SELECT 1 FROM ${P}.role_bindings b WHERE b.org_id=r.org_id AND b.resource_id=r.id AND b.human_id=$2 AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())) OR EXISTS(SELECT 1 FROM ${P}.resource_grants g WHERE g.org_id=r.org_id AND g.resource_id=r.id AND g.human_id=$2 AND g.action='resource.read' AND g.effect='allow' AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())))
   AND NOT EXISTS(SELECT 1 FROM ${P}.resource_grants g WHERE g.org_id=r.org_id AND g.resource_id=r.id AND g.human_id=$2 AND g.action='resource.read' AND g.effect='deny' AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())) ORDER BY r.id LIMIT 20`,
          [s.org_id, a["human_id"], q, guest],
        )
      ).rows;
      const results = [];
      for (const r of rows)
        if (await this.canRead(c, s.org_id, str(a, "human_id"), str(r, "id")))
          results.push({
            id: str(r, "id"),
            display_name: str(r, "display_name"),
            kind: str(r, "kind"),
          });
      await this.current(c, s);
      return results;
    });
  }
  async connections(
    s: OrganizationScope,
  ): Promise<readonly FederationConnection[]> {
    return tx(this.pool, async (c) => {
      await this.begin(c, s, [], true, false);
      const rows = (
        await c.query(
          `SELECT * FROM ${O}.connections WHERE org_id=$1 ORDER BY id LIMIT 21`,
          [s.org_id],
        )
      ).rows;
      if (rows.length > 20) throw new OrganizationError("unavailable");
      const results = rows.map(connectionView);
      await this.current(c, s, true);
      return results;
    });
  }
  async configureConnection(
    s: OrganizationScope,
    cid: string,
    i: ConnectionInput,
  ): Promise<FederationConnection> {
    id(cid);
    validateConnection(i);
    return tx(this.pool, async (c) => {
      const maps = (
        await c.query(
          `SELECT human_id FROM ${O}.external_identities WHERE connection_id=$1 AND org_id=$2 ORDER BY human_id LIMIT 101`,
          [cid, s.org_id],
        )
      ).rows;
      if (maps.length > 100) throw new OrganizationError("unavailable");
      const people = maps.map((r) => str(r, "human_id"));
      const a = await this.begin(c, s, people, true);
      const currentMaps = (
        await c.query(
          `SELECT * FROM ${O}.external_identities WHERE connection_id=$1 AND org_id=$2 ORDER BY human_id`,
          [cid, s.org_id],
        )
      ).rows;
      if (
        JSON.stringify(currentMaps.map((r) => str(r, "human_id"))) !==
        JSON.stringify(people)
      )
        throw new OrganizationError("version_conflict");
      const old = (
        await c.query(
          `SELECT * FROM ${O}.connections WHERE id=$1 AND org_id=$2`,
          [cid, s.org_id],
        )
      ).rows[0];
      if ((old ? num(old, "object_version") : 0) !== i.expected_version)
        throw new OrganizationError("version_conflict");
      if (
        old &&
        currentMaps.length &&
        (old["issuer"] !== i.issuer || old["client_id"] !== i.client_id)
      )
        throw new OrganizationError("forbidden");
      if (!old) {
        const count = (
          await c.query(
            `SELECT count(*)::integer AS n FROM ${O}.connections WHERE org_id=$1`,
            [s.org_id],
          )
        ).rows[0];
        if (Number(count?.["n"]) >= 20)
          throw new OrganizationError("forbidden");
        await c.query(
          `INSERT INTO ${O}.connections(id,org_id,display_name,issuer,client_id,enabled) VALUES($1,$2,$3,$4,$5,$6)`,
          [cid, s.org_id, i.display_name, i.issuer, i.client_id, i.enabled],
        );
      } else
        await c.query(
          `UPDATE ${O}.connections SET display_name=$3,issuer=$4,client_id=$5,enabled=$6,object_version=object_version+1 WHERE id=$1 AND org_id=$2`,
          [cid, s.org_id, i.display_name, i.issuer, i.client_id, i.enabled],
        );
      // Credential binding includes the exact configuration revision; rotating config invalidates old machine credentials below.
      for (const m of currentMaps) {
        await c.query(
          `UPDATE ${O}.external_identities SET active=CASE WHEN $2 THEN active ELSE false END,object_version=object_version+1 WHERE id=$1`,
          [m["id"], i.enabled],
        );
        await c.query(
          `UPDATE ${I}.memberships SET status=CASE WHEN $3 THEN status ELSE 'revoked' END,object_version=object_version+1 WHERE org_id=$1 AND human_id=$2`,
          [s.org_id, m["human_id"], i.enabled],
        );
        await this.cutoff(c, s.org_id, str(m, "human_id"));
        await invalidateApprovals(c, s.org_id, str(m, "human_id"));
      }
      await this.event(
        c,
        s.org_id,
        str(a, "human_id"),
        "connection.updated",
        cid,
      );
      const row = (
        await c.query(`SELECT * FROM ${O}.connections WHERE id=$1`, [cid])
      ).rows[0];
      if (!row) throw new OrganizationError("unavailable");
      await this.session(c, s.session_digest);
      return connectionView(row);
    });
  }
  /** Adapter-only metadata. Not exposed as an unauthenticated HTTP endpoint. */
  async connection(cid: string): Promise<FederationConnection> {
    id(cid);
    return tx(this.pool, async (c) => {
      const r = (
        await c.query(
          `SELECT c.* FROM ${O}.connections c JOIN ${I}.organizations o ON o.id=c.org_id WHERE c.id=$1 AND c.enabled AND o.status='active'`,
          [cid],
        )
      ).rows[0];
      if (!r) throw new OrganizationError("unavailable_resource");
      return connectionView(r);
    });
  }
  async federatedTicket(
    cid: string,
    v: number,
    subject: string,
    ticketHash: string,
  ): Promise<void> {
    id(cid);
    version(v);
    digest(ticketHash);
    if (!validExternalId(subject)) throw new OrganizationError("invalid_input");
    return tx(this.pool, async (c) => {
      const seed = (
        await c.query(
          `SELECT org_id,human_id FROM ${O}.external_identities WHERE connection_id=$1 AND subject=$2`,
          [cid, subject],
        )
      ).rows[0];
      if (!seed) throw new OrganizationError("unavailable_resource");
      const org = str(seed, "org_id"),
        human = str(seed, "human_id");
      await this.locks(c, org, [human]);
      const r = (
        await c.query(
          `SELECT x.*,h.auth_version FROM ${O}.external_identities x JOIN ${O}.connections c ON c.id=x.connection_id JOIN ${I}.humans h ON h.id=x.human_id JOIN ${I}.memberships m ON m.org_id=x.org_id AND m.human_id=x.human_id JOIN ${I}.organizations o ON o.id=x.org_id WHERE x.connection_id=$1 AND x.subject=$2 AND x.active AND c.enabled AND c.object_version=$3 AND h.status='active' AND m.status='active' AND m.access_kind='member' AND o.status='active'`,
          [cid, subject, v],
        )
      ).rows[0];
      if (!r) throw new OrganizationError("unavailable_resource");
      await c.query(
        `INSERT INTO ${I}.login_tickets(digest,human_id,auth_version,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '5 minutes')`,
        [ticketHash, human, r["auth_version"]],
      );
      await c.query(
        `INSERT INTO ${O}.federated_tickets(digest,connection_id,connection_version,external_identity_id,mapping_version) VALUES($1,$2,$3,$4,$5)`,
        [ticketHash, cid, v, r["id"], r["object_version"]],
      );
      if (!(await federationTicketValid(c, ticketHash)))
        throw new OrganizationError("unavailable_resource");
    });
  }
  async provision(
    cid: string,
    credential: string,
    i: ProvisioningInput,
  ): Promise<ExternalIdentityView> {
    id(cid);
    digest(credential);
    if (
      !i ||
      !isIdentityId(i.request_id) ||
      !validExternalId(i.external_id) ||
      typeof i.active !== "boolean" ||
      !isContextVersion(i.expected_version)
    )
      throw new OrganizationError("invalid_input");
    return tx(this.pool, async (c) => {
      const allowed = (
        await c.query(
          `SELECT id FROM ${O}.connections WHERE id=$1 AND enabled AND credential_digest=$2 AND credential_expires_at>clock_timestamp() AND credential_version=object_version`,
          [cid, credential],
        )
      ).rows[0];
      if (!allowed) throw new OrganizationError("authentication_required");
      const seed = (
        await c.query(
          `SELECT org_id,human_id FROM ${O}.external_identities WHERE connection_id=$1 AND external_id=$2`,
          [cid, i.external_id],
        )
      ).rows[0];
      if (!seed) throw new OrganizationError("unavailable_resource");
      const org = str(seed, "org_id"),
        human = str(seed, "human_id");
      await this.locks(c, org, [human]);
      const authenticate = async () => {
        const ok = (
          await c.query(
            `SELECT id FROM ${O}.connections WHERE id=$1 AND enabled AND credential_digest=$2 AND credential_expires_at>clock_timestamp() AND credential_version=object_version`,
            [cid, credential],
          )
        ).rows[0];
        if (!ok) throw new OrganizationError("authentication_required");
      };
      await authenticate();
      const content = hash([i.external_id, i.active, i.expected_version]);
      const old = (
        await c.query(
          `SELECT * FROM ${O}.provisioning_receipts WHERE connection_id=$1 AND request_id=$2`,
          [cid, i.request_id],
        )
      ).rows[0];
      if (old) {
        if (old["content_hash"] !== content)
          throw new OrganizationError("version_conflict");
        await authenticate();
        return old["result"] as ExternalIdentityView;
      }
      const m = (
        await c.query(
          `SELECT * FROM ${O}.external_identities WHERE connection_id=$1 AND external_id=$2`,
          [cid, i.external_id],
        )
      ).rows[0];
      if (!m) throw new OrganizationError("unavailable_resource");
      if (m["object_version"] !== i.expected_version)
        throw new OrganizationError("version_conflict");
      if (
        !(
          await c.query(
            `SELECT h.id FROM ${I}.humans h JOIN ${I}.organizations o ON o.id=$2 WHERE h.id=$1 AND h.status='active' AND o.status='active'`,
            [human, org],
          )
        ).rows.length
      )
        throw new OrganizationError("unavailable_resource");
      const updated = (
        await c.query(
          `UPDATE ${O}.external_identities SET active=$2,object_version=object_version+1 WHERE id=$1 RETURNING *`,
          [m["id"], i.active],
        )
      ).rows[0];
      if (!updated) throw new OrganizationError("unavailable");
      // Authoritative IdP disable fails closed even for the last owner; local operator recovery is explicit, not silent bypass.
      await c.query(
        `UPDATE ${I}.memberships SET status=$3,object_version=object_version+1 WHERE org_id=$1 AND human_id=$2`,
        [org, human, i.active ? "active" : "revoked"],
      );
      await this.cutoff(c, org, human);
      await invalidateApprovals(c, org, human);
      await c.query(
        `UPDATE ${O}.invitations SET state='revoked',object_version=object_version+1 WHERE org_id=$1 AND (human_id=$2 OR inviter_id=$2) AND state='pending'`,
        [org, human],
      );
      await this.event(c, org, cid, "identity.provisioned", str(m, "id"));
      const result = externalView(updated);
      await c.query(
        `INSERT INTO ${O}.provisioning_receipts(connection_id,request_id,content_hash,result) VALUES($1,$2,$3,$4::jsonb)`,
        [cid, i.request_id, content, JSON.stringify(result)],
      );
      await authenticate();
      return result;
    });
  }
}
/** Local operator only: establish an explicit provider mapping and credential. No HTTP route. */
export class PostgresFederationAdmin {
  constructor(private readonly pool: IdentityPool) {}
  async link(
    cid: string,
    human: string,
    subject: string,
    externalId: string,
  ): Promise<void> {
    id(cid);
    id(human);
    if (!validExternalId(subject) || !validExternalId(externalId))
      throw new OrganizationError("invalid_input");
    return tx(this.pool, async (c) => {
      await authorizationLock(c, `human:${human}`, true);
      const con = (
        await c.query(`SELECT org_id FROM ${O}.connections WHERE id=$1`, [cid])
      ).rows[0];
      if (!con) throw new OrganizationError("unavailable_resource");
      const org = str(con, "org_id");
      await authorizationLock(c, `organization:${org}`, false);
      await authorizationLock(c, `membership:${org}:${human}`, false);
      await authorizationLock(c, `policy:${org}`, false);
      const m = (
        await c.query(
          `SELECT m.id FROM ${I}.memberships m JOIN ${I}.humans h ON h.id=m.human_id JOIN ${I}.organizations o ON o.id=m.org_id JOIN ${O}.connections c ON c.org_id=o.id AND c.id=$3 WHERE m.org_id=$1 AND m.human_id=$2 AND m.status='active' AND m.access_kind='member' AND h.status='active' AND o.status='active' AND c.enabled`,
          [org, human, cid],
        )
      ).rows[0];
      if (!m) throw new OrganizationError("unavailable_resource");
      const count = (
        await c.query(
          `SELECT count(*)::integer AS n FROM ${O}.external_identities WHERE connection_id=$1`,
          [cid],
        )
      ).rows[0];
      if (Number(count?.["n"]) >= 100) throw new OrganizationError("forbidden");
      const mid = randomUUID();
      await c.query(
        `INSERT INTO ${O}.external_identities(id,org_id,connection_id,human_id,subject,external_id) VALUES($1,$2,$3,$4,$5,$6)`,
        [mid, org, cid, human, subject, externalId],
      );
      await c.query(
        `UPDATE ${I}.memberships SET object_version=object_version+1 WHERE id=$1`,
        [m["id"]],
      );
      await c.query(
        `INSERT INTO ${O}.session_cutoffs(org_id,human_id,invalid_before) VALUES($1,$2,clock_timestamp()) ON CONFLICT(org_id,human_id) DO UPDATE SET invalid_before=EXCLUDED.invalid_before`,
        [org, human],
      );
      await invalidateApprovals(c, org, human);
      await c.query(
        `INSERT INTO ${O}.events(org_id,actor_id,kind,subject_id) VALUES($1,$2,'identity.linked',$3)`,
        [org, cid, mid],
      );
    });
  }
  async credential(cid: string, secretHash: string, v: number): Promise<void> {
    id(cid);
    digest(secretHash);
    version(v);
    return tx(this.pool, async (c) => {
      const row = (
        await c.query(`SELECT org_id FROM ${O}.connections WHERE id=$1`, [cid])
      ).rows[0];
      if (!row) throw new OrganizationError("unavailable_resource");
      await authorizationLock(c, `organization:${str(row, "org_id")}`, false);
      const r = (
        await c.query(
          `UPDATE ${O}.connections SET credential_digest=$2,credential_expires_at=clock_timestamp()+interval '1 day',credential_version=object_version WHERE id=$1 AND enabled AND object_version=$3 RETURNING id`,
          [cid, secretHash, v],
        )
      ).rows[0];
      if (!r) throw new OrganizationError("version_conflict");
    });
  }
}
