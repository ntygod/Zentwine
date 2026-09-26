SELECT (
 (SELECT count(*)=2 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='zentwine_tenant' AND c.relkind='r' AND c.relname IN ('object_keys','object_links'))
 AND (SELECT count(*)=6 AND count(*) FILTER(WHERE NOT p.polpermissive AND p.polname='tenant_fence')=2
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_tenant')
 AND (SELECT count(*)=6 AND bool_and(p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
  AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('zentwine_tenant','zentwine_tenant_private'))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
  WHERE n.nspname IN ('zentwine_tenant','zentwine_tenant_private') AND a.grantee=0)
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
  WHERE n.nspname IN ('zentwine_tenant','zentwine_tenant_private') AND c.relkind='r' AND a.grantee=0)
 AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='zentwine_tenant.object_links'::regclass AND contype='f' AND array_length(conkey,1)=2)
) AS verified;
