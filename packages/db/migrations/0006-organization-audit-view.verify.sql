SELECT (
 EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='zentwine_organizations' AND table_name='events' AND column_name='audit_ref' AND data_type='uuid' AND is_nullable='NO')
 AND (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zentwine_organizations' AND c.relname IN ('organization_audit_reference','organization_audit_page','organization_audit_kind_page') AND i.indisvalid)=3
) AS verified;
