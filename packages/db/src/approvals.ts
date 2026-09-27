import { ApprovalInboxCursor } from "./approval-inbox-cursor.js";
import { membershipAccess } from "./organization-guards.js";
import { appendApprovalEvent } from "./approval-events.js";
import { createHash, randomUUID } from "node:crypto";
import {
  isIdentityId,
  isContextVersion,
  type MemberRole,
} from "@zentwine/domain";
import {
  ApprovalError,
  normalizeApprovalInboxQuery,
  type ApprovalInboxQuery,
  type ApprovalInboxPage,
  type ApprovalInboxEntry,
  APPROVAL_VERSION,
  APPROVAL_LIFETIME_MS,
  ACTION_PERMIT_LIFETIME_MS,
  validateApprovalInput,
  validateApprovalGuard,
  validateApprovalExecution,
  approvalSource,
  requireIndependentReviewer,
  matchesApprovedOperation,
  validApprovalCursor,
  canonicalSnapshot,
  evaluatePolicy,
  validResource,
  validHash,
  type ApprovalInput,
  type ApprovalGuard,
  type ApprovalExecution,
  type ApprovalBinding,
  type ApprovalView,
  type ApprovalRepository,
  type PolicyScope,
  type PolicyFacts,
  type PolicyResource,
  type RoleBinding,
  type ResourceGrant,
  type PolicyDecision,
} from "@zentwine/policy";
import type { IdentityPool, SqlConnection } from "./connection.js";
import { authorizationLock } from "./authorization-locks.js";
const I = "zentwine_identity",
  P = "zentwine_policy",
  A = "zentwine_approvals";
type Row = Record<string, unknown>;
const str = (r: Row, k: string): string => {
  if (typeof r[k] !== "string") throw new ApprovalError("unavailable");
  return r[k];
};
const num = (r: Row, k: string): number => {
  if (!Number.isSafeInteger(r[k])) throw new ApprovalError("unavailable");
  return Number(r[k]);
};
const ms = (r: Row, k: string): number => {
  const x = r[k];
  if (!(x instanceof Date) || !Number.isFinite(x.getTime()))
    throw new ApprovalError("unavailable");
  return x.getTime();
};
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalSnapshot(v)).digest("hex");
const copy = <T>(v: T): T => JSON.parse(canonicalSnapshot(v)) as T;
const id = (v: unknown): void => {
  if (!isIdentityId(v)) throw new ApprovalError("invalid_input");
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
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    if (c)
      try {
        await c.query("ROLLBACK");
      } catch {
        broken = true;
      }
    if (e instanceof ApprovalError) throw e;
    throw new ApprovalError("unavailable");
  } finally {
    c?.release(broken);
  }
}
async function now(c: SqlConnection): Promise<number> {
  const r = (await c.query("SELECT clock_timestamp() AS now")).rows[0];
  if (!r) throw new ApprovalError("unavailable");
  return ms(r, "now");
}
interface Authority {
  human: string;
  role: MemberRole;
  auth_version: number;
  membership_version: number;
  organization_version: number;
  policy_revision: number;
  write_mode: PolicyFacts["write_mode"];
}
interface Context {
  c: SqlConnection;
  scope: PolicyScope;
  actor: Authority;
  sessionDeadline: number;
  row: Row | null;
  resource: PolicyResource | null;
}
const stamp = (a: Authority) => ({
  human_id: a.human,
  auth_version: a.auth_version,
  membership_version: a.membership_version,
  organization_version: a.organization_version,
  policy_revision: a.policy_revision,
});
/** Trusted control-plane only. No model-supplied callback or generic command execution. */
export class PostgresApprovalRepository implements ApprovalRepository {
  private readonly inboxCursor = new ApprovalInboxCursor();
  constructor(private readonly pool: IdentityPool) {}
  async assertRuntimeRole(): Promise<void> {
    await tx(this.pool, async (c) => {
      const r = (
        await c.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits,
        EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='${A}' AND t.relowner=r.oid) AS owns,
        has_schema_privilege(current_user,'${A}','CREATE') AS can_create,
        has_column_privilege(current_user,'${A}.requests','binding','UPDATE') AS rebind,
        has_column_privilege(current_user,'${A}.permits','digest','UPDATE') AS change_secret,
        has_table_privilege(current_user,'${A}.decisions','UPDATE,DELETE,TRUNCATE,TRIGGER') AS decisions_mutable,
        has_table_privilege(current_user,'${A}.receipts','UPDATE,DELETE,TRUNCATE,TRIGGER') AS receipts_mutable,
        has_table_privilege(current_user,'${A}.events','UPDATE,DELETE,TRUNCATE,TRIGGER') AS events_mutable
        FROM pg_roles r WHERE r.rolname=current_user`)
      ).rows[0];
      if (!r || Object.values(r).some((x) => x !== false))
        throw new ApprovalError("unavailable");
      await c.query(`SELECT id FROM ${A}.requests LIMIT 0`);
    });
  }
  private async authority(
    c: SqlConnection,
    human: string,
    org: string,
  ): Promise<Authority> {
    const r = (
      await c.query(
        `SELECT h.auth_version,m.role,m.object_version AS membership_version,o.object_version AS organization_version,p.revision AS policy_revision,p.write_mode
      FROM ${I}.humans h JOIN ${I}.memberships m ON m.human_id=h.id JOIN ${I}.organizations o ON o.id=m.org_id
      JOIN ${P}.organization_policies p ON p.org_id=o.id WHERE h.id=$1 AND o.id=$2 AND h.status='active' AND m.status='active' AND o.status='active'`,
        [human, org],
      )
    ).rows[0];
    const access = await membershipAccess(c, org, human);
    if (!r || !access.allowed || access.guest)
      throw new ApprovalError("unavailable_resource");
    return {
      human,
      role: str(r, "role") as MemberRole,
      auth_version: num(r, "auth_version"),
      membership_version: num(r, "membership_version"),
      organization_version: num(r, "organization_version"),
      policy_revision: num(r, "policy_revision"),
      write_mode: str(r, "write_mode") as Authority["write_mode"],
    };
  }
  private async session(c: SqlConnection, s: PolicyScope): Promise<Row> {
    const r = (
      await c.query(
        `SELECT s.* FROM ${I}.sessions s JOIN ${I}.humans h ON h.id=s.human_id
      WHERE s.digest=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()
      AND h.status='active' AND h.auth_version=s.auth_version`,
        [s.session_digest],
      )
    ).rows[0];
    if (!r) throw new ApprovalError("authentication_required");
    if (num(r, "context_version") !== s.context_version)
      throw new ApprovalError("version_conflict");
    if (
      r["active_org_id"] !== s.org_id ||
      !(
        await membershipAccess(
          c,
          s.org_id,
          str(r, "human_id"),
          s.session_digest,
        )
      ).allowed
    )
      throw new ApprovalError("unavailable_resource");
    return r;
  }
  /** Session -> sorted humans -> organization -> sorted memberships -> policy -> event stream -> request -> resource.
   * Event stream lock also serializes sequence allocation/commit for each org; polling never skips an uncommitted event. */
  private async context(
    c: SqlConnection,
    s: PolicyScope,
    approvalId?: string,
    rid?: string,
  ): Promise<Context> {
    if (!validHash(s?.session_digest))
      throw new ApprovalError("authentication_required");
    id(s?.org_id);
    if (!isContextVersion(s.context_version))
      throw new ApprovalError("invalid_input");
    const seed = (
      await c.query(
        `SELECT human_id FROM ${I}.sessions WHERE digest=$1 FOR SHARE`,
        [s.session_digest],
      )
    ).rows[0];
    if (!seed) throw new ApprovalError("authentication_required");
    let preliminary: Row | null = null;
    if (approvalId) {
      id(approvalId);
      preliminary =
        (
          await c.query(
            `SELECT r.*,d.actor_id FROM ${A}.requests r LEFT JOIN ${A}.decisions d ON d.approval_id=r.id WHERE r.id=$1 AND r.org_id=$2`,
            [approvalId, s.org_id],
          )
        ).rows[0] ?? null;
    }
    const people = [str(seed, "human_id")];
    if (preliminary) {
      people.push(str(preliminary, "requester_id"));
      if (preliminary["actor_id"]) people.push(str(preliminary, "actor_id"));
    }
    const sorted = [...new Set(people)].sort();
    for (const h of sorted) await authorizationLock(c, `human:${h}`, true);
    await authorizationLock(c, `organization:${s.org_id}`, true);
    for (const h of sorted)
      await authorizationLock(c, `membership:${s.org_id}:${h}`, true);
    await authorizationLock(c, `policy:${s.org_id}`, true);
    await authorizationLock(c, `approval-events:${s.org_id}`, false);
    let row: Row | null = null;
    if (approvalId) {
      row =
        (
          await c.query(
            `SELECT * FROM ${A}.requests WHERE id=$1 AND org_id=$2 FOR UPDATE`,
            [approvalId, s.org_id],
          )
        ).rows[0] ?? null;
      if (!row) throw new ApprovalError("unavailable_resource");
      // A decision could have committed during the wait. Never use an approver whose locks were not acquired.
      const d = (
        await c.query(
          `SELECT actor_id FROM ${A}.decisions WHERE approval_id=$1`,
          [approvalId],
        )
      ).rows[0];
      if (d && !sorted.includes(str(d, "actor_id")))
        throw new ApprovalError("version_conflict");
      rid = str(row, "resource_id");
    }
    let resource: PolicyResource | null = null;
    if (rid) {
      id(rid);
      const r = (
        await c.query(
          `SELECT * FROM ${P}.resources WHERE id=$1 AND org_id=$2 FOR UPDATE`,
          [rid, s.org_id],
        )
      ).rows[0];
      if (
        !r ||
        !validResource(r as unknown as PolicyResource) ||
        r["status"] !== "active"
      )
        throw new ApprovalError("unavailable_resource");
      resource = r as unknown as PolicyResource;
    }
    const session = await this.session(c, s),
      actor = await this.authority(c, str(session, "human_id"), s.org_id);
    return {
      c,
      scope: s,
      actor,
      sessionDeadline: Math.min(
        ms(session, "expires_at"),
        ms(session, "idle_expires_at"),
      ),
      row,
      resource,
    };
  }
  private async facts(ctx: Context, a: Authority): Promise<PolicyFacts> {
    if (!ctx.resource) throw new ApprovalError("unavailable");
    const rules = async (table: "role_bindings" | "resource_grants") => {
      const rows = (
        await ctx.c.query(
          `SELECT * FROM ${P}.${table} WHERE org_id=$1 AND human_id=$2 AND resource_id=$3 AND revoked_at IS NULL ORDER BY id LIMIT 101`,
          [ctx.scope.org_id, a.human, ctx.resource!.id],
        )
      ).rows;
      if (rows.length > 100) throw new ApprovalError("unavailable");
      return rows.map((r) => ({
        ...r,
        valid_from: ms(r, "valid_from"),
        expires_at: r["expires_at"] === null ? null : ms(r, "expires_at"),
        revoked: false,
      }));
    };
    const bindings = await rules("role_bindings"),
      grants = await rules("resource_grants"),
      t = await now(ctx.c);
    return {
      principal_kind: "human",
      human_id: a.human,
      org_id: ctx.scope.org_id,
      membership_role: a.role,
      membership_version: a.membership_version,
      session_valid_until: Math.min(
        ctx.sessionDeadline,
        t + APPROVAL_LIFETIME_MS,
      ),
      observed_at: t,
      resource: ctx.resource,
      policy_revision: a.policy_revision,
      write_mode: a.write_mode,
      bindings: bindings as unknown as RoleBinding[],
      grants: grants as unknown as ResourceGrant[],
    };
  }
  private async decisions(
    ctx: Context,
    a: Authority,
  ): Promise<{ read: PolicyDecision; write: PolicyDecision }> {
    const f = await this.facts(ctx, a);
    return {
      read: evaluatePolicy(f, "resource.read", f.observed_at),
      write: evaluatePolicy(f, "resource.update", f.observed_at),
    };
  }
  private binding(ctx: Context, r: ApprovalInput): ApprovalBinding {
    if (!ctx.resource) throw new ApprovalError("unavailable");
    const a = ctx.actor;
    return {
      schema_version: APPROVAL_VERSION,
      canonicalization_version: "sorted-json-v1",
      org_id: ctx.scope.org_id,
      requester_id: a.human,
      operation: "catalog.rename",
      action: "resource.update",
      resource_id: r.resource_id,
      resource_version: r.expected_version,
      environment: ctx.resource.environment,
      display_name: r.display_name,
      policy_revision: r.expected_policy_revision,
      auth_version: a.auth_version,
      membership_version: a.membership_version,
      organization_version: a.organization_version,
    };
  }
  private stored(row: Row): ApprovalBinding {
    const b = copy(row["binding"]) as ApprovalBinding;
    if (
      !b ||
      b.schema_version !== APPROVAL_VERSION ||
      b.canonicalization_version !== "sorted-json-v1" ||
      b.operation !== "catalog.rename" ||
      b.action !== "resource.update" ||
      hash(b) !== row["content_hash"] ||
      b.org_id !== row["org_id"] ||
      b.requester_id !== row["requester_id"] ||
      b.resource_id !== row["resource_id"]
    )
      throw new ApprovalError("unavailable");
    return b;
  }
  private async view(ctx: Context): Promise<ApprovalView> {
    const r = ctx.row;
    if (!r) throw new ApprovalError("unavailable");
    const d = (
      await ctx.c.query(
        `SELECT actor_id,source,outcome FROM ${A}.decisions WHERE approval_id=$1`,
        [r["id"]],
      )
    ).rows[0];
    const receipt = (
      await ctx.c.query(
        `SELECT result FROM ${A}.receipts WHERE approval_id=$1`,
        [r["id"]],
      )
    ).rows[0];
    return {
      id: str(r, "id"),
      org_id: str(r, "org_id"),
      requester_id: str(r, "requester_id"),
      object_version: num(r, "object_version"),
      state: str(r, "state") as ApprovalView["state"],
      content_hash: str(r, "content_hash"),
      binding: this.stored(r),
      expires_at: new Date(ms(r, "expires_at")).toISOString(),
      decision: d
        ? {
            actor_id: str(d, "actor_id"),
            source: str(d, "source") as "human" | "preauthorized_policy",
            outcome: str(d, "outcome") as "approve" | "reject",
          }
        : null,
      receipt: receipt
        ? (copy(receipt["result"]) as ApprovalView["receipt"])
        : null,
      reusable: false,
    };
  }
  /** Reads of the response can themselves wait on storage. Authorization must still
   * be valid at the final pre-commit check, not just before writing the decision. */
  private async finish(ctx: Context, deadline?: number): Promise<ApprovalView> {
    const result = await this.view(ctx);
    if (
      deadline !== undefined &&
      (!Number.isFinite(deadline) || (await now(ctx.c)) >= deadline)
    )
      throw new ApprovalError("forbidden");
    await this.session(ctx.c, ctx.scope);
    return result;
  }
  private guard(ctx: Context, g: ApprovalGuard): void {
    validateApprovalGuard(g);
    if (
      !ctx.row ||
      ctx.row["object_version"] !== g.expected_version ||
      ctx.row["content_hash"] !== g.content_hash
    )
      throw new ApprovalError("version_conflict");
  }
  private async transition(
    ctx: Context,
    state: ApprovalView["state"],
    reason: string,
  ): Promise<void> {
    const r = (
      await ctx.c.query(
        `UPDATE ${A}.requests SET state=$1,reason=$2,object_version=object_version+1 WHERE id=$3 AND object_version=$4 RETURNING *`,
        [state, reason, ctx.row?.["id"], ctx.row?.["object_version"]],
      )
    ).rows[0];
    if (!r) throw new ApprovalError("version_conflict");
    ctx.row = r;
    await appendApprovalEvent(ctx.c, r);
  }
  private async visible(ctx: Context): Promise<void> {
    if (!ctx.row) throw new ApprovalError("unavailable_resource");
    const d = await this.decisions(ctx, ctx.actor);
    if (
      d.read.outcome !== "allow" ||
      (ctx.row["requester_id"] !== ctx.actor.human &&
        ctx.actor.role !== "owner")
    )
      throw new ApprovalError("unavailable_resource");
  }
  private async current(
    ctx: Context,
  ): Promise<{ owner: Authority; decision: PolicyDecision; deadline: number }> {
    const r = ctx.row;
    if (!r || !ctx.resource) throw new ApprovalError("unavailable");
    if (
      ["rejected", "revoked", "consumed"].includes(str(r, "state")) ||
      (await now(ctx.c)) >= ms(r, "expires_at")
    )
      throw new ApprovalError("forbidden");
    const b = this.stored(r),
      owner = await this.authority(ctx.c, b.requester_id, b.org_id);
    if (
      b.resource_version !== ctx.resource.object_version ||
      b.environment !== ctx.resource.environment ||
      b.policy_revision !== owner.policy_revision ||
      b.auth_version !== owner.auth_version ||
      b.membership_version !== owner.membership_version ||
      b.organization_version !== owner.organization_version
    )
      throw new ApprovalError("version_conflict");
    const d = await this.decisions(ctx, owner);
    if (d.read.outcome !== "allow" || d.write.outcome === "deny")
      throw new ApprovalError("forbidden");
    let deadline = Math.min(
      Date.parse(d.read.expires_at),
      Date.parse(d.write.expires_at),
      ctx.sessionDeadline,
      ms(r, "expires_at"),
    );
    const decision = (
      await ctx.c.query(`SELECT * FROM ${A}.decisions WHERE approval_id=$1`, [
        r["id"],
      ])
    ).rows[0];
    if (decision) {
      if (
        decision["content_hash"] !== r["content_hash"] ||
        decision["outcome"] !== "approve"
      )
        throw new ApprovalError("forbidden");
      const a = await this.authority(
        ctx.c,
        str(decision, "actor_id"),
        b.org_id,
      );
      if (
        canonicalSnapshot(stamp(a)) !== canonicalSnapshot(decision["authority"])
      )
        throw new ApprovalError("forbidden");
      if (decision["source"] === "human") {
        const p = await this.decisions(ctx, a);
        requireIndependentReviewer(
          owner.human,
          a.human,
          a.role,
          p.read,
          p.write,
        );
        deadline = Math.min(
          deadline,
          Date.parse(p.read.expires_at),
          Date.parse(p.write.expires_at),
        );
      } else if (
        decision["source"] !== "preauthorized_policy" ||
        a.human !== owner.human ||
        d.write.outcome !== "allow"
      )
        throw new ApprovalError("forbidden");
    }
    await this.session(ctx.c, ctx.scope);
    return { owner, decision: d.write, deadline };
  }
  async request(s: PolicyScope, input: ApprovalInput): Promise<ApprovalView> {
    validateApprovalInput(input);
    const r = copy(input);
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s, undefined, r.resource_id),
        d = await this.decisions(ctx, ctx.actor);
      if (d.read.outcome !== "allow")
        throw new ApprovalError("unavailable_resource");
      const source = approvalSource(d.write, r.review);
      if (
        ctx.resource!.object_version !== r.expected_version ||
        ctx.actor.policy_revision !== r.expected_policy_revision
      )
        throw new ApprovalError("version_conflict");
      const previous = (
        await c.query(
          `SELECT * FROM ${A}.requests WHERE org_id=$1 AND requester_id=$2 AND request_id=$3`,
          [s.org_id, ctx.actor.human, r.request_id],
        )
      ).rows[0];
      if (previous) {
        if (previous["request_sha256"] !== hash(r))
          throw new ApprovalError("version_conflict");
        ctx.row = previous;
        return this.finish(ctx);
      }
      const binding = this.binding(ctx, r),
        t = await now(c);
      ctx.row =
        (
          await c.query(
            `INSERT INTO ${A}.requests(id,org_id,requester_id,resource_id,request_id,request_sha256,binding,content_hash,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
              randomUUID(),
              s.org_id,
              ctx.actor.human,
              r.resource_id,
              r.request_id,
              hash(r),
              JSON.stringify(binding),
              hash(binding),
              new Date(t),
              new Date(t + APPROVAL_LIFETIME_MS),
            ],
          )
        ).rows[0] ?? null;
      if (!ctx.row) throw new ApprovalError("unavailable");
      await appendApprovalEvent(c, ctx.row);
      if (source === "preauthorized_policy") {
        await c.query(
          `INSERT INTO ${A}.decisions(approval_id,actor_id,source,outcome,authority,content_hash) VALUES($1,$2,'preauthorized_policy','approve',$3,$4)`,
          [
            ctx.row?.["id"],
            ctx.actor.human,
            JSON.stringify(stamp(ctx.actor)),
            hash(binding),
          ],
        );
        await this.transition(ctx, "approved", "preauthorized_policy");
      }
      const final = await this.current(ctx);
      return this.finish(ctx, final.deadline);
    });
  }
  async inspect(s: PolicyScope, rid: string): Promise<ApprovalView> {
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s, rid);
      await this.visible(ctx);
      return this.finish(ctx);
    });
  }
  async decide(
    s: PolicyScope,
    rid: string,
    g: ApprovalGuard,
    outcome: "approve" | "reject",
  ): Promise<ApprovalView> {
    validateApprovalGuard(g);
    if (!["approve", "reject"].includes(outcome))
      throw new ApprovalError("invalid_input");
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s, rid);
      await this.visible(ctx);
      this.guard(ctx, g);
      if (ctx.row!["state"] !== "pending")
        throw new ApprovalError("version_conflict");
      const initial = await this.current(ctx);
      const d = await this.decisions(ctx, ctx.actor);
      requireIndependentReviewer(
        str(ctx.row!, "requester_id"),
        ctx.actor.human,
        ctx.actor.role,
        d.read,
        d.write,
      );
      await c.query(
        `INSERT INTO ${A}.decisions(approval_id,actor_id,source,outcome,authority,content_hash) VALUES($1,$2,'human',$3,$4,$5)`,
        [
          rid,
          ctx.actor.human,
          outcome,
          JSON.stringify(stamp(ctx.actor)),
          g.content_hash,
        ],
      );
      await this.transition(
        ctx,
        outcome === "approve" ? "approved" : "rejected",
        "human",
      );
      const deadline = Math.min(
        initial.deadline,
        Date.parse(d.read.expires_at),
        Date.parse(d.write.expires_at),
      );
      if (outcome === "approve") {
        const final = await this.current(ctx);
        return this.finish(ctx, Math.min(deadline, final.deadline));
      }
      return this.finish(ctx, deadline);
    });
  }
  async issuePermit(
    s: PolicyScope,
    rid: string,
    g: ApprovalGuard,
    digest: string,
  ): Promise<{ approval: ApprovalView; expires_at: string }> {
    validateApprovalGuard(g);
    if (!validHash(digest)) throw new ApprovalError("invalid_input");
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s, rid);
      await this.visible(ctx);
      this.guard(ctx, g);
      if (ctx.row!["requester_id"] !== ctx.actor.human)
        throw new ApprovalError("forbidden");
      if (ctx.row!["state"] !== "approved")
        throw new ApprovalError("approval_required");
      await this.current(ctx);
      const t = await now(c),
        end = Math.min(
          t + ACTION_PERMIT_LIFETIME_MS,
          ms(ctx.row!, "expires_at"),
        );
      if (end <= t) throw new ApprovalError("forbidden");
      await c.query(
        `INSERT INTO ${A}.permits(approval_id,digest,created_at,expires_at) VALUES($1,$2,$3,$4)`,
        [rid, digest, new Date(t), new Date(end)],
      );
      await this.transition(ctx, "issued", "permit_issued");
      const final = await this.current(ctx);
      return {
        approval: await this.finish(ctx, Math.min(end, final.deadline)),
        expires_at: new Date(end).toISOString(),
      };
    });
  }
  async execute(
    s: PolicyScope,
    rid: string,
    input: ApprovalExecution,
    digest: string,
  ): Promise<ApprovalView> {
    validateApprovalExecution(input);
    if (!validHash(digest)) throw new ApprovalError("invalid_input");
    const r = copy(input);
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s, rid);
      await this.visible(ctx);
      this.guard(ctx, {
        expected_version: r.expected_version,
        content_hash: r.content_hash,
      });
      if (
        ctx.row!["requester_id"] !== ctx.actor.human ||
        ctx.row!["state"] !== "issued"
      )
        throw new ApprovalError("forbidden");
      if (!matchesApprovedOperation(this.stored(ctx.row!), r))
        throw new ApprovalError("version_conflict");
      const initial = await this.current(ctx);
      const permit = (
        await c.query(
          `SELECT * FROM ${A}.permits WHERE approval_id=$1 AND digest=$2 AND consumed_at IS NULL FOR UPDATE`,
          [rid, digest],
        )
      ).rows[0];
      if (!permit) throw new ApprovalError("forbidden");
      // All waits including permit-row contention have finished. Recheck identities, policy and expiry.
      const fresh = await this.current(ctx),
        deadline = Math.min(
          ms(permit, "expires_at"),
          ms(ctx.row!, "expires_at"),
          initial.deadline,
          fresh.deadline,
        );
      const paid = (
        await c.query(
          `UPDATE ${A}.permits SET consumed_at=clock_timestamp() WHERE approval_id=$1 AND consumed_at IS NULL AND clock_timestamp()<$2::timestamptz RETURNING approval_id`,
          [rid, new Date(deadline)],
        )
      ).rows[0];
      if (!paid) throw new ApprovalError("forbidden");
      const updated = (
        await c.query(
          `UPDATE ${P}.resources SET display_name=$1,object_version=object_version+1 WHERE id=$2 AND org_id=$3 AND object_version=$4 AND clock_timestamp()<$5::timestamptz RETURNING *`,
          [
            r.display_name,
            r.resource_id,
            s.org_id,
            r.expected_resource_version,
            new Date(deadline),
          ],
        )
      ).rows[0];
      if (!updated) throw new ApprovalError("version_conflict");
      const receipt = {
        approval_id: rid,
        content_hash: r.content_hash,
        resource: updated,
      };
      await c.query(
        `INSERT INTO ${A}.receipts(approval_id,result) VALUES($1,$2)`,
        [rid, JSON.stringify(receipt)],
      );
      // Failure here rolls back the mutation, consumption and receipt as one unit.
      if ((await now(c)) >= deadline) throw new ApprovalError("forbidden");
      await this.session(c, s);
      await this.transition(ctx, "consumed", "executed");
      const result = await this.view(ctx);
      // Bookkeeping can also wait; abort if authorization expired before the last pre-commit check.
      if ((await now(c)) >= deadline) throw new ApprovalError("forbidden");
      await this.session(c, s);
      return result;
    });
  }
  async revoke(
    s: PolicyScope,
    rid: string,
    g: ApprovalGuard,
  ): Promise<ApprovalView> {
    validateApprovalGuard(g);
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s, rid);
      await this.visible(ctx);
      this.guard(ctx, g);
      if (!["pending", "approved", "issued"].includes(str(ctx.row!, "state")))
        throw new ApprovalError("version_conflict");
      if (
        ctx.row!["requester_id"] !== ctx.actor.human &&
        ctx.actor.role !== "owner"
      )
        throw new ApprovalError("forbidden");
      await this.transition(ctx, "revoked", "revoked");
      return this.finish(ctx);
    });
  }
  /** Discovery uses the same human/resource visibility as inspect, never approval authority.
   * The event-stream lock orders creation with readers; current status/visibility are rechecked per page.
   * Permissions are filtered before LIMIT. No global sequence or hidden count escapes the encrypted cursor. */
  async list(
    s: PolicyScope,
    input: ApprovalInboxQuery,
  ): Promise<ApprovalInboxPage> {
    const q = normalizeApprovalInboxQuery(input);
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s);
      if (q.lane === "review" && ctx.actor.role !== "owner")
        throw new ApprovalError("forbidden");
      const observed = await now(c);
      const binding = JSON.stringify([
        "approval-inbox-v1",
        s.session_digest,
        s.org_id,
        s.context_version,
        stamp(ctx.actor),
        q.lane,
        q.state,
        q.limit,
      ]);
      const position =
        q.cursor === undefined
          ? null
          : this.inboxCursor.decode(q.cursor, binding, observed);
      const head =
        position?.head ??
        (
          await c.query(
            `SELECT COALESCE(MAX(sequence),0)::text AS head FROM ${A}.events WHERE org_id=$1`,
            [s.org_id],
          )
        ).rows[0]?.["head"];
      if (!validApprovalCursor(head)) throw new ApprovalError("unavailable");
      const rows = (
        await c.query(
          `SELECT r.*,e.sequence::text AS position FROM ${A}.requests r
        JOIN ${A}.events e ON e.org_id=r.org_id AND e.approval_id=r.id AND e.object_version=1
        JOIN ${P}.resources p ON p.org_id=r.org_id AND p.id=r.resource_id
        WHERE r.org_id=$1 AND e.sequence<=$2::bigint AND ($3::bigint IS NULL OR e.sequence<$3::bigint)
        AND (($4='mine' AND r.requester_id=$5) OR ($4='review' AND r.requester_id<>$5))
        AND ($6='all' OR ($6='expired' AND r.state IN ('pending','approved','issued') AND r.expires_at<=$7::timestamptz)
          OR (r.state=$6 AND (r.state NOT IN ('pending','approved','issued') OR r.expires_at>$7::timestamptz)))
        AND p.status='active'
        AND (p.visibility='organization' OR p.owner_human_id=$5
          OR EXISTS(SELECT 1 FROM ${P}.role_bindings b WHERE b.org_id=p.org_id AND b.resource_id=p.id AND b.human_id=$5
            AND b.revoked_at IS NULL AND b.valid_from<=$7::timestamptz AND (b.expires_at IS NULL OR b.expires_at>$7::timestamptz))
          OR EXISTS(SELECT 1 FROM ${P}.resource_grants g WHERE g.org_id=p.org_id AND g.resource_id=p.id AND g.human_id=$5
            AND g.action='resource.read' AND g.effect='allow' AND g.revoked_at IS NULL AND g.valid_from<=$7::timestamptz AND (g.expires_at IS NULL OR g.expires_at>$7::timestamptz)))
        AND NOT EXISTS(SELECT 1 FROM ${P}.resource_grants g WHERE g.org_id=p.org_id AND g.resource_id=p.id AND g.human_id=$5
          AND g.action='resource.read' AND g.effect='deny' AND g.revoked_at IS NULL AND g.valid_from<=$7::timestamptz AND (g.expires_at IS NULL OR g.expires_at>$7::timestamptz))
        ORDER BY e.sequence DESC LIMIT $8`,
          [
            s.org_id,
            head,
            position?.before ?? null,
            q.lane,
            ctx.actor.human,
            q.state,
            new Date(observed).toISOString(),
            q.limit + 1,
          ],
        )
      ).rows;
      // Lock resources in deterministic order after the existing stream lock. Direct rename cannot change them mid-page.
      const resources = (
        await c.query(
          `SELECT * FROM ${P}.resources WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
          [
            s.org_id,
            [...new Set(rows.map((r) => str(r, "resource_id")))].sort(),
          ],
        )
      ).rows;
      let deadline = ctx.sessionDeadline;
      const entries: ApprovalInboxEntry[] = [];
      for (const r of rows) {
        const resource = resources.find(
          (p) => p["id"] === r["resource_id"],
        ) as unknown as PolicyResource | undefined;
        if (!resource || !validResource(resource))
          throw new ApprovalError("unavailable");
        const item = { ...ctx, row: r, resource };
        await this.visible(item);
        const read = (await this.decisions(item, ctx.actor)).read;
        if (read.outcome !== "allow")
          throw new ApprovalError("unavailable_resource");
        deadline = Math.min(deadline, Date.parse(read.expires_at));
        const b = this.stored(r),
          state = str(r, "state") as ApprovalInboxEntry["state"];
        if (!validApprovalCursor(r["position"]))
          throw new ApprovalError("unavailable");
        entries.push({
          id: str(r, "id"),
          resource_id: b.resource_id,
          requester_id: b.requester_id,
          requested_name: b.display_name,
          state,
          object_version: num(r, "object_version"),
          resource_version: b.resource_version,
          expires_at: new Date(ms(r, "expires_at")).toISOString(),
          expired:
            ["pending", "approved", "issued"].includes(state) &&
            ms(r, "expires_at") <= observed,
        });
      }
      await this.session(c, s);
      if ((await now(c)) >= deadline)
        throw new ApprovalError("unavailable_resource");
      const last = rows[q.limit - 1];
      const cursor =
        entries.length > q.limit && last
          ? this.inboxCursor.encode(
              {
                head,
                before: str(last, "position"),
                started: position?.started ?? observed,
              },
              binding,
            )
          : null;
      return {
        schema_version: "1.0.0",
        org_id: s.org_id,
        lane: q.lane,
        state_filter: q.state,
        observed_at: new Date(observed).toISOString(),
        authorization: false,
        consistency: "creation-boundary-current-visibility",
        entries: entries.slice(0, q.limit),
        next_cursor: cursor,
      };
    });
  }
  async events(s: PolicyScope, after: string, limit: number) {
    if (
      !validApprovalCursor(after) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new ApprovalError("invalid_input");
    return tx(this.pool, async (c) => {
      const ctx = await this.context(c, s);
      const rows = (
        await c.query(
          `SELECT e.* FROM ${A}.events e JOIN ${A}.requests r ON r.id=e.approval_id
        LEFT JOIN ${A}.decisions d ON d.approval_id=r.id WHERE e.org_id=$1 AND e.sequence>$2::bigint AND (r.requester_id=$3 OR d.actor_id=$3) ORDER BY e.sequence LIMIT $4`,
          [s.org_id, after, ctx.actor.human, limit],
        )
      ).rows;
      const events = rows.map((r) => ({
        cursor: str(r, "sequence"),
        event_id: str(r, "event_id"),
        approval_id: str(r, "approval_id"),
        kind: str(r, "kind"),
        version: num(r, "object_version"),
        reason: str(r, "reason"),
        occurred_at: new Date(ms(r, "occurred_at")).toISOString(),
      }));
      // A slow notification query must not return data under an expired session.
      await this.session(c, s);
      return {
        events,
        next_cursor: events.at(-1)?.cursor ?? after,
        authorization: false as const,
      };
    });
  }
}
