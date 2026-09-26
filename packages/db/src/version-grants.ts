import { tenantRuntimeGrantSql } from "./tenant-grants.js";
/** Operator-only extension for the same dedicated runtime; no direct append/update/delete privilege. */
export function versionRuntimeGrantSql(role: string): string {
  return (
    tenantRuntimeGrantSql(role) +
    `
 GRANT USAGE ON SCHEMA zentwine_versions TO "${role}";
 GRANT SELECT ON zentwine_versions.revisions,zentwine_versions.states,zentwine_versions.relations,zentwine_versions.snapshots TO "${role}";
 GRANT EXECUTE ON FUNCTION zentwine_versions.apply(jsonb) TO "${role}";`
  );
}
