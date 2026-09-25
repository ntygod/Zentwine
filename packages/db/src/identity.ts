import { randomUUID } from "node:crypto";
import {
  IdentityError,
  isIdentityId,
  isContextVersion,
  type IdentityRepository,
  type SessionIdentity,
  type TenantContext,
  type MemberRole,
} from "@zentwine/domain";
import type { IdentityPool, SqlConnection } from "./connection.js";
const S = "zentwine_identity";
const text = (row: Record<string, unknown>, key: string): string => {
  const v = row[key];
  if (typeof v !== "string") throw new IdentityError("unavailable");
  return v;
};
const number = (row: Record<string, unknown>, key: string): number => {
  const v = row[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v))
    throw new IdentityError("unavailable");
  return v;
};
const iso = (row: Record<string, unknown>, key: string): string => {
  const v = row[key];
  if (!(v instanceof Date) || !Number.isFinite(v.getTime()))
    throw new IdentityError("unavailable");
  return v.toISOString();
};
const digest = (s: string): void => {
  if (!/^[a-f0-9]{64}$/.test(s)) throw new IdentityError("invalid_input");
};
const id = (s: string): void => {
  if (!isIdentityId(s)) throw new IdentityError("invalid_input");
};
const display = (s: string): void => {
  if (
    typeof s !== "string" ||
    s.trim().length === 0 ||
    s.length > 120 ||
    /[\u0000-\u001f]/.test(s)
  )
    throw new IdentityError("invalid_input");
};
/** Control-plane identity store. No caller-controlled SQL or global cached tenant. */
export class PostgresIdentityRepository implements IdentityRepository {
  constructor(readonly pool: IdentityPool) {}
  private async transaction<T>(
    work: (c: SqlConnection) => Promise<T>,
  ): Promise<T> {
    let c: SqlConnection | undefined;
    let broken = false;
    try {
      c = await this.pool.connect();
      await c.query("BEGIN");
      const result = await work(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      if (c) {
        try {
          await c.query("ROLLBACK");
        } catch {
          broken = true;
        }
      }
      if (error instanceof IdentityError) throw error;
      // Driver errors can contain DSNs, SQL and identifying values.
      throw new IdentityError("unavailable");
    } finally {
      c?.release(broken);
    }
  }
  async assertRuntimeRole(): Promise<void> {
    await this.transaction(async (c) => {
      const r = (
        await c.query(`SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits_role,
        EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE n.nspname='${S}' AND t.relowner=r.oid) AS owns_table
        FROM pg_roles r WHERE r.rolname=current_user`)
      ).rows[0];
      if (
        !r ||
        [
          "rolsuper",
          "rolbypassrls",
          "rolcreaterole",
          "rolcreatedb",
          "owns_table",
          "inherits_role",
        ].some((k) => r[k] !== false)
      )
        throw new IdentityError("unavailable");
      await c.query(`SELECT id FROM ${S}.sessions LIMIT 0`);
    });
  }
  private async lockedSession(
    c: SqlConnection,
    secretDigest: string,
  ): Promise<Record<string, unknown>> {
    digest(secretDigest);
    const r = (
      await c.query(
        `SELECT s.*, h.display_name AS human_name FROM ${S}.sessions s
      JOIN ${S}.humans h ON h.id=s.human_id WHERE s.digest=$1 AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()
      AND h.status='active' AND h.auth_version=s.auth_version FOR UPDATE OF s`,
        [secretDigest],
      )
    ).rows[0];
    if (!r) throw new IdentityError("authentication_required");
    return r;
  }
  private async view(
    c: SqlConnection,
    row: Record<string, unknown>,
  ): Promise<SessionIdentity> {
    const orgs = (
      await c.query(
        `SELECT o.id,o.display_name FROM ${S}.organizations o
      JOIN ${S}.memberships m ON m.org_id=o.id WHERE m.human_id=$1 AND m.status='active'
      AND o.status='active' ORDER BY o.id LIMIT 101`,
        [text(row, "human_id")],
      )
    ).rows;
    // Bound payloads without silently hiding a granted organization.
    if (orgs.length > 100) throw new IdentityError("unavailable");
    const organizations = Object.freeze(
      orgs.map((o) =>
        Object.freeze({
          id: text(o, "id"),
          display_name: text(o, "display_name"),
        }),
      ),
    );
    return Object.freeze({
      id: text(row, "id"),
      human: Object.freeze({
        id: text(row, "human_id"),
        display_name: text(row, "human_name"),
      }),
      expires_at: iso(row, "expires_at"),
      context_version: number(row, "context_version"),
      active_org_id: organizations.some((o) => o.id === row["active_org_id"])
        ? text(row, "active_org_id")
        : null,
      organizations,
    });
  }
  private async touch(
    c: SqlConnection,
    row: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `UPDATE ${S}.sessions SET idle_expires_at=LEAST(expires_at,clock_timestamp()+interval '30 minutes') WHERE id=$1`,
      [text(row, "id")],
    );
  }
  private async membership(
    c: SqlConnection,
    human: string,
    org: string,
  ): Promise<Record<string, unknown>> {
    const r = (
      await c.query(
        `SELECT m.*,o.display_name AS org_name FROM ${S}.memberships m
      JOIN ${S}.organizations o ON o.id=m.org_id WHERE m.human_id=$1 AND m.org_id=$2
      AND m.status='active' AND o.status='active'`,
        [human, org],
      )
    ).rows[0];
    if (!r) throw new IdentityError("unavailable_resource");
    return r;
  }
  async consumeTicket(
    ticketDigest: string,
    sessionDigest: string,
    priorSessionDigest?: string,
  ): Promise<SessionIdentity> {
    digest(ticketDigest);
    digest(sessionDigest);
    if (priorSessionDigest) digest(priorSessionDigest);
    return this.transaction(async (c) => {
      const t = (
        await c.query(
          `SELECT t.*,h.display_name AS human_name FROM ${S}.login_tickets t
        JOIN ${S}.humans h ON h.id=t.human_id WHERE t.digest=$1 AND t.consumed_at IS NULL
        AND t.expires_at>clock_timestamp() AND h.status='active' AND h.auth_version=t.auth_version
        FOR UPDATE OF t`,
          [ticketDigest],
        )
      ).rows[0];
      if (!t) throw new IdentityError("invalid_login");
      await c.query(
        `UPDATE ${S}.login_tickets SET consumed_at=clock_timestamp() WHERE digest=$1`,
        [ticketDigest],
      );
      const s = (
        await c.query(
          `INSERT INTO ${S}.sessions(id,digest,human_id,auth_version,expires_at,idle_expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '8 hours',clock_timestamp()+interval '30 minutes') RETURNING *`,
          [
            randomUUID(),
            sessionDigest,
            text(t, "human_id"),
            number(t, "auth_version"),
          ],
        )
      ).rows[0];
      if (!s) throw new IdentityError("unavailable");
      if (priorSessionDigest)
        await c.query(
          `UPDATE ${S}.sessions SET revoked_at=clock_timestamp() WHERE digest=$1`,
          [priorSessionDigest],
        );
      return this.view(c, { ...s, human_name: text(t, "human_name") });
    });
  }
  async readSession(secretDigest: string): Promise<SessionIdentity> {
    return this.transaction(async (c) => {
      const s = await this.lockedSession(c, secretDigest);
      await this.touch(c, s);
      return this.view(c, s);
    });
  }
  async selectOrganization(
    secretDigest: string,
    org: string,
    version: number,
  ): Promise<SessionIdentity> {
    id(org);
    if (!isContextVersion(version)) throw new IdentityError("invalid_input");
    return this.transaction(async (c) => {
      const s = await this.lockedSession(c, secretDigest);
      if (number(s, "context_version") !== version || version >= 2147483646)
        throw new IdentityError("version_conflict");
      await this.membership(c, text(s, "human_id"), org);
      await c.query(
        `UPDATE ${S}.sessions SET active_org_id=$1,context_version=context_version+1 WHERE id=$2`,
        [org, text(s, "id")],
      );
      await this.touch(c, s);
      return this.view(c, {
        ...s,
        active_org_id: org,
        context_version: version + 1,
      });
    });
  }
  async tenantContext(
    secretDigest: string,
    org: string,
    version: number,
  ): Promise<TenantContext> {
    id(org);
    if (!isContextVersion(version)) throw new IdentityError("invalid_input");
    return this.transaction(async (c) => {
      const s = await this.lockedSession(c, secretDigest);
      if (number(s, "context_version") !== version)
        throw new IdentityError("version_conflict");
      if (s["active_org_id"] !== org)
        throw new IdentityError("unavailable_resource");
      const m = await this.membership(c, text(s, "human_id"), org);
      await this.touch(c, s);
      const role = text(m, "role");
      if (!["owner", "member", "viewer"].includes(role))
        throw new IdentityError("unavailable");
      return Object.freeze({
        principal_kind: "human",
        session_id: text(s, "id"),
        context_version: version,
        human: Object.freeze({
          id: text(s, "human_id"),
          display_name: text(s, "human_name"),
        }),
        organization: Object.freeze({
          id: org,
          display_name: text(m, "org_name"),
        }),
        membership: Object.freeze({
          id: text(m, "id"),
          org_id: org,
          human_id: text(s, "human_id"),
          display_number: text(m, "display_number"),
          role: role as MemberRole,
          object_version: number(m, "object_version"),
        }),
      });
    });
  }
  async rotateSession(
    secretDigest: string,
    nextDigest: string,
    version: number,
  ): Promise<SessionIdentity> {
    digest(nextDigest);
    if (!isContextVersion(version)) throw new IdentityError("invalid_input");
    return this.transaction(async (c) => {
      const s = await this.lockedSession(c, secretDigest);
      if (number(s, "context_version") !== version || version >= 2147483646)
        throw new IdentityError("version_conflict");
      // Preserve the original absolute expiry. Rotation cannot grant an unlimited session.
      await c.query(
        `UPDATE ${S}.sessions SET revoked_at=clock_timestamp() WHERE id=$1`,
        [text(s, "id")],
      );
      const row = (
        await c.query(
          `INSERT INTO ${S}.sessions(id,digest,human_id,auth_version,active_org_id,context_version,created_at,expires_at,idle_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,LEAST($8::timestamptz,clock_timestamp()+interval '30 minutes')) RETURNING *`,
          [
            randomUUID(),
            nextDigest,
            text(s, "human_id"),
            number(s, "auth_version"),
            s["active_org_id"],
            version + 1,
            s["created_at"],
            s["expires_at"],
          ],
        )
      ).rows[0];
      if (!row) throw new IdentityError("unavailable");
      return this.view(c, { ...row, human_name: text(s, "human_name") });
    });
  }
  async revokeSession(secretDigest: string): Promise<void> {
    digest(secretDigest);
    await this.transaction(async (c) => {
      await c.query(
        `UPDATE ${S}.sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE digest=$1`,
        [secretDigest],
      );
    });
  }
  /** Administrative methods have NO HTTP route; a separate operator DB role grants access. */
  async createHuman(human: string, name: string): Promise<void> {
    id(human);
    display(name);
    await this.transaction(async (c) => {
      await c.query(`INSERT INTO ${S}.humans(id,display_name) VALUES($1,$2)`, [
        human,
        name,
      ]);
    });
  }
  async createOrganization(org: string, name: string): Promise<void> {
    id(org);
    display(name);
    await this.transaction(async (c) => {
      await c.query(
        `INSERT INTO ${S}.organizations(id,display_name) VALUES($1,$2)`,
        [org, name],
      );
    });
  }
  async setMembership(
    member: string,
    org: string,
    human: string,
    displayNumber: string,
    role: MemberRole,
    status: "active" | "revoked",
  ): Promise<void> {
    id(member);
    id(org);
    id(human);
    if (
      !/^MEM-[1-9][0-9]{0,8}$/.test(displayNumber) ||
      !["owner", "member", "viewer"].includes(role) ||
      !["active", "revoked"].includes(status)
    )
      throw new IdentityError("invalid_input");
    await this.transaction(async (c) => {
      await c.query(
        `INSERT INTO ${S}.memberships(id,org_id,human_id,display_number,role,status) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(org_id,human_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status,object_version=${S}.memberships.object_version+1`,
        [member, org, human, displayNumber, role, status],
      );
    });
  }
  async issueTicket(human: string, ticketDigest: string): Promise<void> {
    id(human);
    digest(ticketDigest);
    await this.transaction(async (c) => {
      const h = (
        await c.query(
          `SELECT auth_version FROM ${S}.humans WHERE id=$1 AND status='active'`,
          [human],
        )
      ).rows[0];
      if (!h) throw new IdentityError("unavailable_resource");
      await c.query(
        `INSERT INTO ${S}.login_tickets(digest,human_id,auth_version,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '5 minutes')`,
        [ticketDigest, human, number(h, "auth_version")],
      );
    });
  }
  async setHumanStatus(
    human: string,
    status: "active" | "disabled",
  ): Promise<void> {
    id(human);
    if (!["active", "disabled"].includes(status))
      throw new IdentityError("invalid_input");
    await this.transaction(async (c) => {
      await c.query(
        `UPDATE ${S}.humans SET status=$1,auth_version=auth_version+1 WHERE id=$2`,
        [status, human],
      );
    });
  }
  async setOrganizationStatus(
    org: string,
    status: "active" | "disabled",
  ): Promise<void> {
    id(org);
    if (!["active", "disabled"].includes(status))
      throw new IdentityError("invalid_input");
    await this.transaction(async (c) => {
      await c.query(
        `UPDATE ${S}.organizations SET status=$1,object_version=object_version+1 WHERE id=$2`,
        [status, org],
      );
    });
  }
}
