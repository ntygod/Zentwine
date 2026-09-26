/** Operator-only installation helper. Never hand migration credentials or this helper to an Agent. */
export function tenantRuntimeGrantSql(role: string): string {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    role === "public" ||
    role.startsWith("pg_")
  )
    throw new TypeError("Invalid tenant runtime role");
  return `DO $tenant_connect$ BEGIN
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${role}');
 END; $tenant_connect$;
 GRANT USAGE ON SCHEMA zentwine_tenant TO "${role}";
 GRANT SELECT,INSERT ON zentwine_tenant.object_keys,zentwine_tenant.object_links TO "${role}";
 GRANT EXECUTE ON FUNCTION zentwine_tenant.bind_context(text,uuid,integer),zentwine_tenant.finish_context(),zentwine_tenant.current_org(),zentwine_tenant.current_actor(),zentwine_tenant.writable_org() TO "${role}";`;
}
