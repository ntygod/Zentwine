import {
  TenantError,
  validateTenantScope,
  validateTenantIds,
  validateTenantKind,
  isIdentityId,
  type TenantScope,
  type TenantRepository,
  type TenantUnitOfWork,
  type TenantKey,
  type TenantLink,
} from "@zentwine/domain";
import type { IdentityPool, SqlConnection, SqlResult } from "./connection.js";

function safeError(error: unknown): TenantError {
  if (error instanceof TenantError) return error;
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  return new TenantError(
    code === "23505"
      ? "version_conflict"
      : code === "23503"
        ? "unavailable_resource"
        : code === "42501"
          ? "forbidden"
          : "unavailable",
  );
}
const uuid = (v: unknown): string => {
  if (!isIdentityId(v)) throw new TenantError("unavailable");
  return v;
};
function common(r: Record<string, unknown>, org: string) {
  if (
    r["org_id"] !== org ||
    typeof r["kind"] !== "string" ||
    !(r["created_at"] instanceof Date) ||
    !Number.isFinite(r["created_at"].getTime())
  )
    throw new TenantError("unavailable");
  return {
    org_id: org,
    kind: r["kind"],
    created_by: uuid(r["created_by"]),
    created_at: r["created_at"].toISOString(),
  };
}
const key = (r: Record<string, unknown>, org: string): TenantKey =>
  Object.freeze({ ...common(r, org), id: uuid(r["id"]) });

/** Only fixed, parameterized domain operations escape this module. A unit of work cannot outlive its transaction. */
class Unit implements TenantUnitOfWork {
  #open = true;
  #pending = new Set<Promise<unknown>>();
  #failed: TenantError | undefined;
  constructor(
    private readonly connection: SqlConnection,
    private readonly org: string,
  ) {}
  close() {
    this.#open = false;
  }
  hasPending(): boolean {
    return this.#pending.size > 0;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
  assertHealthy(): void {
    if (this.#failed) throw this.#failed;
  }
  private operation<T>(work: () => Promise<T>): Promise<T> {
    if (!this.#open)
      return Promise.reject(new TenantError("transaction_closed"));
    const pending = Promise.resolve()
      .then(work)
      .catch((e: unknown) => {
        throw safeError(e);
      });
    this.#pending.add(pending);
    // Observe every operation, including accidentally unawaited ones, before releasing the connection.
    void pending.then(
      () => this.#pending.delete(pending),
      (e: unknown) => {
        this.#failed = safeError(e);
        this.#pending.delete(pending);
      },
    );
    return pending;
  }
  private query(sql: string, values: unknown[] = []): Promise<SqlResult> {
    return this.connection.query(sql, values);
  }
  register(id: string, kind: string): Promise<TenantKey> {
    return this.operation(async () => {
      validateTenantIds([id]);
      validateTenantKind(kind);
      await this.query(
        "INSERT INTO zentwine_tenant.object_keys(id,kind) VALUES($1,$2) ON CONFLICT(org_id,id) DO NOTHING",
        [id, kind],
      );
      const row = (
        await this.query(
          "SELECT * FROM zentwine_tenant.object_keys WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!row) throw new TenantError("unavailable_resource");
      if (row["kind"] !== kind) throw new TenantError("version_conflict");
      return key(row, this.org);
    });
  }
  getMany(ids: readonly string[]): Promise<readonly TenantKey[]> {
    return this.operation(async () => {
      validateTenantIds(ids);
      // Intentionally no application org filter. The database must enforce it even for batch queries.
      const rows = (
        await this.query(
          "SELECT * FROM zentwine_tenant.object_keys WHERE id=ANY($1::uuid[]) ORDER BY id",
          [[...ids]],
        )
      ).rows;
      return Object.freeze(rows.map((r) => key(r, this.org)));
    });
  }
  link(source: string, target: string, kind: string): Promise<TenantLink> {
    return this.operation(async () => {
      validateTenantIds([source]);
      validateTenantIds([target]);
      validateTenantKind(kind);
      await this.query(
        "INSERT INTO zentwine_tenant.object_links(source_id,target_id,kind) VALUES($1,$2,$3) ON CONFLICT(org_id,source_id,target_id,kind) DO NOTHING",
        [source, target, kind],
      );
      const row = (
        await this.query(
          "SELECT * FROM zentwine_tenant.object_links WHERE source_id=$1 AND target_id=$2 AND kind=$3",
          [source, target, kind],
        )
      ).rows[0];
      if (!row) throw new TenantError("unavailable_resource");
      return Object.freeze({
        ...common(row, this.org),
        source_id: uuid(row["source_id"]),
        target_id: uuid(row["target_id"]),
      });
    });
  }
  linked(source: string): Promise<readonly TenantKey[]> {
    return this.operation(async () => {
      validateTenantIds([source]);
      const rows = (
        await this.query(
          "SELECT DISTINCT k.* FROM zentwine_tenant.object_keys k JOIN zentwine_tenant.object_links l ON l.org_id=k.org_id AND l.target_id=k.id WHERE l.source_id=$1 ORDER BY k.id LIMIT 101",
          [source],
        )
      ).rows;
      if (rows.length > 100) throw new TenantError("unavailable");
      return Object.freeze(rows.map((r) => key(r, this.org)));
    });
  }
}

/** Dedicated data-plane pool; never the identity/organization/migration pool. No global tenant or GUC scope. */
export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly pool: IdentityPool) {}
  private async runtime(c: SqlConnection): Promise<void> {
    const r = (
      await c.query(`SELECT
      current_user=session_user AS direct_login,
      NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AS safe_role,
      NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS no_memberships,
      NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid AND nspname IN ('zentwine_tenant','zentwine_tenant_private')) AS no_schema_ownership,
      NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid AND n.nspname IN ('zentwine_tenant','zentwine_tenant_private')) AS no_table_ownership,
      NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid AND n.nspname IN ('zentwine_tenant','zentwine_tenant_private')) AS no_function_ownership,
      NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP') AS no_database_ddl,
      NOT has_schema_privilege(current_user,'zentwine_tenant','CREATE') AS no_schema_ddl,
      NOT has_schema_privilege(current_user,'zentwine_tenant_private','USAGE,CREATE') AS no_private_access,
      NOT has_schema_privilege(current_user,'zentwine_identity','USAGE,CREATE') AS no_identity_schema,
      NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_identity' AND c.relname IN ('sessions','login_tickets') AND has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) AS no_credential_columns,
      NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_tenant' AND c.relkind='r' AND has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS no_mutating_privileges,
      NOT has_table_privilege(current_user,(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_identity' AND c.relname='sessions'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS no_sessions,
      NOT has_table_privilege(current_user,(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_identity' AND c.relname='login_tickets'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS no_tickets,
      (SELECT count(*)=2 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_tenant' AND c.relname IN ('object_keys','object_links') AND c.relkind='r') AS forced_rls
      FROM pg_roles r WHERE r.rolname=current_user`)
    ).rows[0];
    if (!r || Object.values(r).some((v) => v !== true))
      throw new TenantError("unavailable");
  }
  async assertRuntimeRole(): Promise<void> {
    let c: SqlConnection | undefined;
    try {
      c = await this.pool.connect();
      await this.runtime(c);
    } catch (error) {
      throw safeError(error);
    } finally {
      c?.release();
    }
  }
  async transaction<T>(
    scope: TenantScope,
    work: (repo: TenantUnitOfWork) => Promise<T>,
  ): Promise<T> {
    validateTenantScope(scope);
    if (typeof work !== "function") throw new TenantError("invalid_input");
    const s = Object.freeze({ ...scope });
    let c: SqlConnection | undefined,
      unit: Unit | undefined,
      broken = false;
    try {
      c = await this.pool.connect();
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await this.runtime(c);
      const bound = (
        await c.query(
          "SELECT zentwine_tenant.bind_context($1,$2,$3) AS org_id",
          [s.session_digest, s.org_id, s.context_version],
        )
      ).rows[0];
      if (bound?.["org_id"] !== s.org_id)
        throw new TenantError("unavailable_resource");
      unit = new Unit(c, s.org_id);
      const result = await work(unit);
      if (unit.hasPending()) throw new TenantError("unavailable");
      unit.close();
      await unit.drain();
      unit.assertHealthy();
      const finished = (
        await c.query("SELECT zentwine_tenant.finish_context() AS org_id")
      ).rows[0];
      if (finished?.["org_id"] !== s.org_id)
        throw new TenantError("unavailable_resource");
      await c.query("COMMIT");
      return result;
    } catch (error) {
      unit?.close();
      await unit?.drain();
      if (c)
        try {
          await c.query("ROLLBACK");
        } catch {
          broken = true;
        }
      throw safeError(error);
    } finally {
      unit?.close();
      c?.release(broken);
    }
  }
}
