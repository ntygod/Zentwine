-- New data-plane only. Existing identity/control-plane repositories retain their own authority checks.
CREATE SCHEMA zentwine_tenant;
CREATE SCHEMA zentwine_tenant_private;
REVOKE ALL ON SCHEMA zentwine_tenant,zentwine_tenant_private FROM PUBLIC;
-- One transaction marker per backend. Only definer functions can access it; no caller-controlled GUC.
CREATE TABLE zentwine_tenant_private.contexts (
 backend_pid integer PRIMARY KEY,
 transaction_id xid8 NOT NULL,
 login_role name NOT NULL,
 session_digest text,
 org_id uuid,
 context_version integer,
 CHECK ((session_digest IS NULL AND org_id IS NULL AND context_version IS NULL)
   OR (session_digest ~ '^[a-f0-9]{64}$' AND org_id IS NOT NULL AND context_version BETWEEN 1 AND 2147483646))
);
REVOKE ALL ON zentwine_tenant_private.contexts FROM PUBLIC;
CREATE FUNCTION zentwine_tenant_private.verified_scope()
RETURNS TABLE(org_id uuid,human_id uuid,member_role text)
LANGUAGE sql VOLATILE SECURITY DEFINER PARALLEL UNSAFE
SET search_path = pg_catalog,pg_temp AS $scope$
 SELECT c.org_id,s.human_id,m.role FROM zentwine_tenant_private.contexts c
 JOIN zentwine_identity.sessions s ON s.digest=c.session_digest
 JOIN zentwine_identity.humans h ON h.id=s.human_id
 JOIN zentwine_identity.memberships m ON m.human_id=h.id AND m.org_id=c.org_id
 JOIN zentwine_identity.organizations o ON o.id=c.org_id
 WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=pg_current_xact_id()
 AND c.login_role=session_user AND c.context_version=s.context_version AND s.active_org_id=c.org_id
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()
 AND h.status='active' AND h.auth_version=s.auth_version AND o.status='active'
 AND m.status='active' AND m.access_kind='member' AND NOT m.emergency_held
 AND NOT EXISTS(SELECT 1 FROM zentwine_organizations.session_cutoffs x
   WHERE x.org_id=c.org_id AND x.human_id=h.id AND x.invalid_before>=s.created_at)
$scope$;
REVOKE ALL ON FUNCTION zentwine_tenant_private.verified_scope() FROM PUBLIC;
CREATE FUNCTION zentwine_tenant.current_org() RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER PARALLEL UNSAFE
SET search_path = pg_catalog,pg_temp AS $org$
 SELECT s.org_id FROM zentwine_tenant_private.verified_scope() s
$org$;
CREATE FUNCTION zentwine_tenant.current_actor() RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER PARALLEL UNSAFE
SET search_path = pg_catalog,pg_temp AS $actor$
 SELECT s.human_id FROM zentwine_tenant_private.verified_scope() s
$actor$;
CREATE FUNCTION zentwine_tenant.writable_org() RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER PARALLEL UNSAFE
SET search_path = pg_catalog,pg_temp AS $write$
 SELECT s.org_id FROM zentwine_tenant_private.verified_scope() s WHERE s.member_role IN ('owner','member')
$write$;
CREATE FUNCTION zentwine_tenant.bind_context(p_digest text,p_org uuid,p_version integer) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER PARALLEL UNSAFE
SET search_path = pg_catalog,pg_temp AS $bind$
 -- Allocate an unprivileged marker first. A second binding in the same transaction conflicts, even after closure.
 DELETE FROM zentwine_tenant_private.contexts c WHERE c.transaction_id<>pg_current_xact_id()
   AND (c.backend_pid=pg_backend_pid() OR NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid=c.backend_pid));
 INSERT INTO zentwine_tenant_private.contexts(backend_pid,transaction_id,login_role)
 VALUES(pg_backend_pid(),pg_current_xact_id(),session_user);
 -- Same ordering as the existing control-plane protocol: session, human, organization, membership, policy.
 SELECT s.id FROM zentwine_identity.sessions s WHERE s.digest=p_digest FOR SHARE OF s;
 SELECT pg_advisory_xact_lock_shared(hashtextextended('zentwine.authz.v1:human:'||s.human_id::text,0))
 FROM zentwine_identity.sessions s WHERE s.digest=p_digest;
 SELECT pg_advisory_xact_lock_shared(hashtextextended('zentwine.authz.v1:organization:'||p_org::text,0));
 SELECT pg_advisory_xact_lock_shared(hashtextextended('zentwine.authz.v1:membership:'||p_org::text||':'||s.human_id::text,0))
 FROM zentwine_identity.sessions s WHERE s.digest=p_digest;
 SELECT pg_advisory_xact_lock_shared(hashtextextended('zentwine.authz.v1:policy:'||p_org::text,0));
 UPDATE zentwine_tenant_private.contexts c SET session_digest=p_digest,org_id=p_org,context_version=p_version
 WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=pg_current_xact_id()
 AND p_digest ~ '^[a-f0-9]{64}$' AND p_org IS NOT NULL AND p_version BETWEEN 1 AND 2147483646;
 -- Re-evaluate time and authorization after locks are acquired, never trust the initial statement snapshot.
 SELECT zentwine_tenant.current_org()
$bind$;
CREATE FUNCTION zentwine_tenant.finish_context() RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER PARALLEL UNSAFE
SET search_path = pg_catalog,pg_temp AS $finish$
 WITH permitted AS MATERIALIZED (SELECT zentwine_tenant.current_org() AS org_id)
 UPDATE zentwine_tenant_private.contexts c SET session_digest=NULL,org_id=NULL,context_version=NULL
 FROM permitted p WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=pg_current_xact_id()
 AND c.login_role=session_user RETURNING p.org_id
$finish$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA zentwine_tenant FROM PUBLIC;
-- Only typed registration metadata. Domain content, revisions, CAS and semantic relationships come later.
CREATE TABLE zentwine_tenant.object_keys (
 org_id uuid NOT NULL DEFAULT zentwine_tenant.current_org() REFERENCES zentwine_identity.organizations(id),
 id uuid NOT NULL,
 kind text NOT NULL CHECK(kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 created_by uuid NOT NULL DEFAULT zentwine_tenant.current_actor() REFERENCES zentwine_identity.humans(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,id)
);
CREATE TABLE zentwine_tenant.object_links (
 org_id uuid NOT NULL DEFAULT zentwine_tenant.current_org(),
 source_id uuid NOT NULL,
 target_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 created_by uuid NOT NULL DEFAULT zentwine_tenant.current_actor() REFERENCES zentwine_identity.humans(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,source_id,target_id,kind),
 FOREIGN KEY(org_id,source_id) REFERENCES zentwine_tenant.object_keys(org_id,id),
 FOREIGN KEY(org_id,target_id) REFERENCES zentwine_tenant.object_keys(org_id,id)
);
CREATE INDEX object_links_target ON zentwine_tenant.object_links(org_id,target_id,source_id);
ALTER TABLE zentwine_tenant.object_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE zentwine_tenant.object_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE zentwine_tenant.object_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE zentwine_tenant.object_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON zentwine_tenant.object_keys AS RESTRICTIVE FOR ALL
 USING(org_id=(SELECT zentwine_tenant.current_org()))
 WITH CHECK(org_id=(SELECT zentwine_tenant.writable_org()) AND created_by=(SELECT zentwine_tenant.current_actor()));
CREATE POLICY tenant_read ON zentwine_tenant.object_keys FOR SELECT USING(true);
CREATE POLICY tenant_insert ON zentwine_tenant.object_keys FOR INSERT WITH CHECK(true);
CREATE POLICY tenant_fence ON zentwine_tenant.object_links AS RESTRICTIVE FOR ALL
 USING(org_id=(SELECT zentwine_tenant.current_org()))
 WITH CHECK(org_id=(SELECT zentwine_tenant.writable_org()) AND created_by=(SELECT zentwine_tenant.current_actor()));
CREATE POLICY tenant_read ON zentwine_tenant.object_links FOR SELECT USING(true);
CREATE POLICY tenant_insert ON zentwine_tenant.object_links FOR INSERT WITH CHECK(true);
REVOKE ALL ON ALL TABLES IN SCHEMA zentwine_tenant FROM PUBLIC;
