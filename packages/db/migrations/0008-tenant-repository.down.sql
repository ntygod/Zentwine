-- Owner-only reversal of an unused registry. Any registered domain keys require forward recovery.
LOCK TABLE zentwine_tenant.object_keys,zentwine_tenant.object_links,zentwine_tenant_private.contexts IN ACCESS EXCLUSIVE MODE;
ALTER TABLE zentwine_tenant.object_links NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zentwine_tenant.object_keys NO FORCE ROW LEVEL SECURITY;
CREATE TABLE zentwine_tenant_private.downgrade_guard(allowed boolean NOT NULL CHECK(allowed));
INSERT INTO zentwine_tenant_private.downgrade_guard(allowed)
 SELECT NOT EXISTS(SELECT 1 FROM zentwine_tenant.object_keys) AND NOT EXISTS(SELECT 1 FROM zentwine_tenant.object_links);
DROP TABLE zentwine_tenant_private.downgrade_guard;
DROP TABLE zentwine_tenant.object_links;
DROP TABLE zentwine_tenant.object_keys;
DROP FUNCTION zentwine_tenant.finish_context();
DROP FUNCTION zentwine_tenant.bind_context(text,uuid,integer);
DROP FUNCTION zentwine_tenant.writable_org();
DROP FUNCTION zentwine_tenant.current_actor();
DROP FUNCTION zentwine_tenant.current_org();
DROP FUNCTION zentwine_tenant_private.verified_scope();
DROP TABLE zentwine_tenant_private.contexts;
DROP SCHEMA zentwine_tenant_private;
DROP SCHEMA zentwine_tenant;
