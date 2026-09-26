SELECT (
 (SELECT count(*)=3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_versions' AND c.relkind='r')
 AND (SELECT count(*)=9 AND count(*) FILTER(WHERE NOT p.polpermissive AND p.polname='tenant_fence')=3 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_versions')
 AND (SELECT count(*)=3 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_versions' AND NOT t.tgisinternal)
 AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_versions' AND c.relname='snapshots' AND c.reloptions @> ARRAY['security_invoker=true'])
 AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='zentwine_versions' AND p.proname='apply' AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='zentwine_versions' AND a.grantee=0)
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname='zentwine_versions' AND a.grantee=0)
 AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='zentwine_versions.relations'::regclass AND contype='f' AND array_length(conkey,1)>=3)
) AS verified;
