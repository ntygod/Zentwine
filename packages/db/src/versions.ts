import { createHash } from "node:crypto";
import {
  TenantError,
  canonicalizeContent,
  CANONICALIZATION_VERSION,
  validateTenantKind,
  validateContentDigest,
  validateRevisionCommand,
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
export function digestContent(schemaId: string, value: unknown): ContentDigest {
  validateTenantKind(schemaId);
  const canonical = canonicalizeContent(value);
  return Object.freeze({
    algorithm: "sha256",
    canonicalization_version: CANONICALIZATION_VERSION,
    schema_id: schemaId,
    content_hash: createHash("sha256")
      .update(
        "zentwine.content-digest.v1\0" +
          schemaId +
          "\0" +
          CANONICALIZATION_VERSION +
          "\0" +
          canonical,
      )
      .digest("hex"),
    content_bytes: Buffer.byteLength(canonical, "utf8"),
  });
}
export function verifyContentDigest(
  digest: ContentDigest,
  value: unknown,
): boolean {
  validateContentDigest(digest);
  const actual = digestContent(digest.schema_id, value);
  return (
    actual.content_hash === digest.content_hash &&
    actual.content_bytes === digest.content_bytes
  );
}
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
  if (Number(v["revision_number"]) > Number(v["object_version"]))
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
}
/** No raw connection escapes. Every operation participates in the original unit's failure/drain lifecycle. */
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
    // Snapshot validated input synchronously: callers cannot mutate authority or content while waiting for a query.
    let command: RevisionCommand;
    try {
      command = JSON.parse(canonicalizeContent(input)) as RevisionCommand;
      validateRevisionCommand(command);
    } catch (e) {
      return this.run(async () => {
        throw e;
      });
    }
    return this.operate(async (c) => {
      const result = (
        await c.query("SELECT zentwine_versions.apply($1::jsonb) AS result", [
          JSON.stringify(command),
        ])
      ).rows[0]?.["result"];
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
        (!current || current.object_version !== command.expected_version + 1)
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
      const row = (
        await c.query(
          "SELECT * FROM zentwine_versions.snapshots WHERE object_id=$1 AND ($2::integer IS NULL OR object_version=$2) ORDER BY object_version DESC LIMIT 1",
          [id, version],
        )
      ).rows[0];
      return head(row ?? null, this.org, id);
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
      return Object.freeze(
        rows.map((r) => {
          validateRevisionRelation(r as unknown as RevisionRelation);
          return Object.freeze(r) as unknown as RevisionRelation;
        }),
      );
    });
  }
}
