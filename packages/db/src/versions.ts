import {
  TenantError,
  snapshotRevisionCommand,
  validateContentDigest,
  validateRevisionRelation,
  validateTenantIds,
  validateVersion,
  isIdentityId,
  type ContentDigest,
  type RevisionHead,
  type RevisionCommand,
  type RevisionResult,
  type RevisionRelation,
  type RevisionUnitOfWork,
} from "@zentwine/domain";
import type { SqlConnection } from "./connection.js";
// Preserve the draft module's imports without retaining a second implementation.
export { digestContent, verifyContentDigest } from "./content-digest.js";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown): string => {
  if (!(v instanceof Date) && typeof v !== "string") throw new Error();
  const d = v instanceof Date ? v : new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error();
  return d.toISOString();
};
function head(v: unknown, org: string, id: string): RevisionHead | null {
  if (v === null) return null;
  // Invalid database output is a service failure, not invalid caller input.
  try {
    if (
      !object(v) ||
      Object.keys(v).length !== 16 ||
      v["org_id"] !== org ||
      v["object_id"] !== id ||
      !isIdentityId(v["revision_id"]) ||
      !isIdentityId(v["created_by"]) ||
      !isIdentityId(v["changed_by"]) ||
      (v["parent_revision_id"] !== null &&
        !isIdentityId(v["parent_revision_id"])) ||
      !["draft", "in_review", "approved", "superseded", "retired"].includes(
        String(v["status"]),
      )
    )
      throw new Error();
    validateVersion(v["object_version"], 1);
    validateVersion(v["revision_number"], 1);
    if (
      Number(v["revision_number"]) > Number(v["object_version"]) ||
      (v["revision_number"] === 1) !== (v["parent_revision_id"] === null) ||
      v["parent_revision_id"] === v["revision_id"]
    )
      throw new Error();
    validateContentDigest({
      algorithm: v["algorithm"],
      canonicalization_version: v["canonicalization_version"],
      schema_id: v["schema_id"],
      content_hash: v["content_hash"],
      content_bytes: v["content_bytes"],
    } as ContentDigest);
    return Object.freeze({
      ...v,
      created_at: date(v["created_at"]),
      changed_at: date(v["changed_at"]),
    }) as unknown as RevisionHead;
  } catch {
    throw new Error("Invalid revision snapshot");
  }
}
function appliedMatches(
  command: RevisionCommand,
  current: RevisionHead,
): boolean {
  if (current.object_version !== command.expected_version + 1) return false;
  if (command.action === "revise") {
    return (
      current.status === "draft" &&
      current.created_by === current.changed_by &&
      current.algorithm === command.content.algorithm &&
      current.canonicalization_version ===
        command.content.canonicalization_version &&
      current.schema_id === command.content.schema_id &&
      current.content_hash === command.content.content_hash &&
      current.content_bytes === command.content.content_bytes
    );
  }
  const target = {
    submit: "in_review",
    approve: "approved",
    reject: "draft",
    supersede: "superseded",
    retire: "retired",
  } as const;
  return (
    current.revision_id === command.revision_id &&
    current.content_hash === command.content_hash &&
    current.status === target[command.action]
  );
}
/** No raw connection escapes. Operations use the enclosing unit's failure/drain lifecycle.
 * Output agreement is not a substitute for the database's authorization and CAS checks. */
export class PostgresRevisionUnit implements RevisionUnitOfWork {
  constructor(
    private readonly run: <T>(
      work: (c: SqlConnection) => Promise<T>,
    ) => Promise<T>,
    private readonly org: string,
  ) {}
  private operate<T>(work: (c: SqlConnection) => Promise<T>): Promise<T> {
    return this.run(async (c) => {
      try {
        const row = (
          await c.query(`SELECT
          NOT has_schema_privilege(current_user,'zentwine_versions','CREATE') AS no_ddl,
          NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='zentwine_versions' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS no_schema_ownership,
          (SELECT count(*)=3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
            AND NOT has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            AND NOT has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_versions' AND c.relkind='r') AS safe_tables,
          (SELECT count(*)=2 AND bool_and(NOT(r.rolsuper OR r.rolbypassrls OR r.rolcanlogin) AND p.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
            AND p.proowner=(SELECT nspowner FROM pg_namespace WHERE nspname='zentwine_tenant_private'))
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='zentwine_versions') AS safe_definers,
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_versions' AND c.relname='snapshots' AND c.reloptions @> ARRAY['security_invoker=true']) AS safe_view`)
        ).rows[0];
        if (!row || Object.values(row).some((v) => v !== true))
          throw new TenantError("unavailable");
        return await work(c);
      } catch (e) {
        if (e instanceof TenantError) throw e;
        const code = object(e) ? e["code"] : undefined;
        throw new TenantError(
          code === "22023"
            ? "invalid_input"
            : code === "P0002" || code === "23503"
              ? "unavailable_resource"
              : code === "42501"
                ? "forbidden"
                : "unavailable",
        );
      }
    });
  }
  command(input: RevisionCommand): Promise<RevisionResult> {
    let command: RevisionCommand;
    try {
      command = snapshotRevisionCommand(input);
    } catch (e) {
      return this.run(async () => {
        throw e;
      });
    }
    return this.operate(async (c) => {
      const rows = (
        await c.query("SELECT zentwine_versions.apply($1::jsonb) AS result", [
          JSON.stringify(command),
        ])
      ).rows;
      if (rows.length !== 1) throw new Error();
      const result = rows[0]?.["result"];
      if (
        !object(result) ||
        Object.keys(result).length !== 3 ||
        result["expected_version"] !== command.expected_version ||
        !["applied", "conflict", "invalid_transition"].includes(
          String(result["outcome"]),
        )
      )
        throw new Error();
      const current = head(result["current"], this.org, command.object_id);
      if (
        result["outcome"] === "applied" &&
        (!current || !appliedMatches(command, current))
      )
        throw new Error();
      return Object.freeze({
        outcome: result["outcome"],
        expected_version: command.expected_version,
        current,
      }) as RevisionResult;
    });
  }
  head(id: string): Promise<RevisionHead | null> {
    return this.read(id, null);
  }
  snapshot(id: string, version: number): Promise<RevisionHead | null> {
    return this.read(id, version);
  }
  private read(
    id: string,
    version: number | null,
  ): Promise<RevisionHead | null> {
    return this.operate(async (c) => {
      validateTenantIds([id]);
      if (version !== null) validateVersion(version, 1);
      const rows = (
        await c.query(
          "SELECT * FROM zentwine_versions.snapshots WHERE object_id=$1 AND ($2::integer IS NULL OR object_version=$2) ORDER BY object_version DESC LIMIT 1",
          [id, version],
        )
      ).rows;
      if (rows.length > 1) throw new Error();
      const current = head(rows[0] ?? null, this.org, id);
      if (current && version !== null && current.object_version !== version)
        throw new Error();
      return current;
    });
  }
  relations(
    id: string,
    revision: string,
  ): Promise<readonly RevisionRelation[]> {
    return this.operate(async (c) => {
      validateTenantIds([id]);
      validateTenantIds([revision]);
      const rows = (
        await c.query(
          "SELECT kind,source,target_object_id,target_revision_id,target_hash FROM zentwine_versions.relations WHERE object_id=$1 AND revision_id=$2 ORDER BY kind,source,target_object_id,target_revision_id LIMIT 33",
          [id, revision],
        )
      ).rows;
      if (rows.length > 32) throw new Error();
      try {
        return Object.freeze(
          rows.map((r) => {
            validateRevisionRelation(r as unknown as RevisionRelation);
            return Object.freeze(r) as unknown as RevisionRelation;
          }),
        );
      } catch {
        throw new Error("Invalid revision relationship");
      }
    });
  }
}
