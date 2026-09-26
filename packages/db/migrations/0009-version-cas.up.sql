-- Immutable content descriptors and state snapshots; domain content stays in domain-owned stores.
CREATE SCHEMA zentwine_versions;
REVOKE ALL ON SCHEMA zentwine_versions FROM PUBLIC;
CREATE TABLE zentwine_versions.revisions (
 org_id uuid NOT NULL,
 object_id uuid NOT NULL,
 revision_id uuid NOT NULL,
 revision_number integer NOT NULL CHECK(revision_number BETWEEN 1 AND 2147483646),
 parent_revision_id uuid,
 algorithm text NOT NULL CHECK(algorithm='sha256'),
 canonicalization_version text NOT NULL CHECK(canonicalization_version='zt-json-v1'),
 schema_id text NOT NULL CHECK(schema_id ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 65536),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,object_id,revision_id),
 UNIQUE(org_id,object_id,revision_number),
 UNIQUE(org_id,object_id,revision_id,content_hash),
 FOREIGN KEY(org_id,object_id) REFERENCES zentwine_tenant.object_keys(org_id,id),
 FOREIGN KEY(org_id,object_id,parent_revision_id) REFERENCES zentwine_versions.revisions(org_id,object_id,revision_id)
);
CREATE TABLE zentwine_versions.states (
 org_id uuid NOT NULL,
 object_id uuid NOT NULL,
 object_version integer NOT NULL CHECK(object_version BETWEEN 1 AND 2147483646),
 revision_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('draft','in_review','approved','superseded','retired')),
 changed_by uuid NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,object_id,object_version),
 FOREIGN KEY(org_id,object_id,revision_id) REFERENCES zentwine_versions.revisions(org_id,object_id,revision_id)
);
CREATE TABLE zentwine_versions.relations (
 org_id uuid NOT NULL,
 object_id uuid NOT NULL,
 revision_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 source text NOT NULL CHECK(source IN ('declared','derived')),
 target_object_id uuid NOT NULL,
 target_revision_id uuid NOT NULL,
 target_hash text NOT NULL,
 created_by uuid NOT NULL,
 PRIMARY KEY(org_id,object_id,revision_id,kind,source,target_object_id,target_revision_id),
 FOREIGN KEY(org_id,object_id,revision_id) REFERENCES zentwine_versions.revisions(org_id,object_id,revision_id),
 FOREIGN KEY(org_id,target_object_id,target_revision_id,target_hash) REFERENCES zentwine_versions.revisions(org_id,object_id,revision_id,content_hash)
);
CREATE INDEX relations_target ON zentwine_versions.relations(org_id,target_object_id,target_revision_id);
ALTER TABLE zentwine_versions.revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE zentwine_versions.revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE zentwine_versions.states ENABLE ROW LEVEL SECURITY;
ALTER TABLE zentwine_versions.states FORCE ROW LEVEL SECURITY;
ALTER TABLE zentwine_versions.relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE zentwine_versions.relations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON zentwine_versions.revisions AS RESTRICTIVE FOR ALL
 USING(org_id=(SELECT zentwine_tenant.current_org()))
 WITH CHECK(org_id=(SELECT zentwine_tenant.writable_org()) AND created_by=(SELECT zentwine_tenant.current_actor()));
CREATE POLICY tenant_read ON zentwine_versions.revisions FOR SELECT USING(true);
CREATE POLICY tenant_append ON zentwine_versions.revisions FOR INSERT WITH CHECK(true);
CREATE POLICY tenant_fence ON zentwine_versions.states AS RESTRICTIVE FOR ALL
 USING(org_id=(SELECT zentwine_tenant.current_org()))
 WITH CHECK(org_id=(SELECT zentwine_tenant.writable_org()) AND changed_by=(SELECT zentwine_tenant.current_actor()));
CREATE POLICY tenant_read ON zentwine_versions.states FOR SELECT USING(true);
CREATE POLICY tenant_append ON zentwine_versions.states FOR INSERT WITH CHECK(true);
CREATE POLICY tenant_fence ON zentwine_versions.relations AS RESTRICTIVE FOR ALL
 USING(org_id=(SELECT zentwine_tenant.current_org()))
 WITH CHECK(org_id=(SELECT zentwine_tenant.writable_org()) AND created_by=(SELECT zentwine_tenant.current_actor()));
CREATE POLICY tenant_read ON zentwine_versions.relations FOR SELECT USING(true);
CREATE POLICY tenant_append ON zentwine_versions.relations FOR INSERT WITH CHECK(true);
CREATE VIEW zentwine_versions.snapshots WITH(security_invoker=true) AS
 SELECT s.org_id,s.object_id,s.object_version,s.revision_id,s.status,s.changed_by,s.changed_at,
 r.revision_number,r.parent_revision_id,r.algorithm,r.canonicalization_version,r.schema_id,r.content_hash,r.content_bytes,r.created_by,r.created_at
 FROM zentwine_versions.states s JOIN zentwine_versions.revisions r USING(org_id,object_id,revision_id);
CREATE FUNCTION zentwine_versions.immutable_row() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $immutable$
 BEGIN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='immutable_revision'; END;
$immutable$;
CREATE TRIGGER immutable_revision BEFORE UPDATE OR DELETE ON zentwine_versions.revisions FOR EACH ROW EXECUTE FUNCTION zentwine_versions.immutable_row();
CREATE TRIGGER immutable_state BEFORE UPDATE OR DELETE ON zentwine_versions.states FOR EACH ROW EXECUTE FUNCTION zentwine_versions.immutable_row();
CREATE TRIGGER immutable_relation BEFORE UPDATE OR DELETE ON zentwine_versions.relations FOR EACH ROW EXECUTE FUNCTION zentwine_versions.immutable_row();
-- Execute-only command: no caller-supplied org/actor, no SQL fragments, no arbitrary state UPDATE.
CREATE FUNCTION zentwine_versions.apply(c jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER PARALLEL UNSAFE
SET search_path=pg_catalog,pg_temp AS $command$
DECLARE
 org uuid; actor uuid; role_name text; oid uuid; expected integer; action text;
 content jsonb; rel jsonb; current_row zentwine_versions.snapshots%ROWTYPE;
 current_json jsonb; current_version integer; new_revision uuid; new_number integer; next_status text;
 uuid_pattern CONSTANT text := '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
BEGIN
 IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
 action := c->>'action';
 IF NOT COALESCE(jsonb_typeof(c->'object_id')='string' AND c->>'object_id' ~ uuid_pattern
 AND jsonb_typeof(c->'expected_version')='number' AND c->>'expected_version' ~ '^(0|[1-9][0-9]{0,9})$'
 AND (c->>'expected_version')::numeric <= 2147483645, false)
 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
 oid := (c->>'object_id')::uuid; expected := (c->>'expected_version')::integer;
 IF action='revise' THEN
  IF c - ARRAY['object_id','expected_version','action','content','relations'] <> '{}'::jsonb
   OR NOT(c ?& ARRAY['object_id','expected_version','action','content','relations'])
   OR jsonb_typeof(c->'content') IS DISTINCT FROM 'object'
   OR jsonb_typeof(c->'relations') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
  content := c->'content';
  IF content - ARRAY['algorithm','canonicalization_version','schema_id','content_hash','content_bytes'] <> '{}'::jsonb
   OR NOT COALESCE(content->>'algorithm'='sha256' AND content->>'canonicalization_version'='zt-json-v1'
    AND jsonb_typeof(content->'schema_id')='string' AND content->>'schema_id' ~ '^[a-z][a-z0-9_.-]{0,63}$'
    AND jsonb_typeof(content->'content_hash')='string' AND content->>'content_hash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(content->'content_bytes')='number' AND content->>'content_bytes' ~ '^[1-9][0-9]{0,4}$'
    AND (content->>'content_bytes')::numeric <= 65536, false)
   OR jsonb_array_length(c->'relations') > 32
  THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
  FOR rel IN SELECT value FROM jsonb_array_elements(c->'relations') LOOP
   IF jsonb_typeof(rel) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
   IF rel - ARRAY['kind','source','target_object_id','target_revision_id','target_hash'] <> '{}'::jsonb
    OR NOT COALESCE(jsonb_typeof(rel->'kind')='string' AND rel->>'kind' ~ '^[a-z][a-z0-9_.-]{0,63}$'
     AND rel->>'source' IN ('declared','derived') AND rel->>'target_object_id' ~ uuid_pattern
     AND rel->>'target_revision_id' ~ uuid_pattern AND rel->>'target_hash' ~ '^[a-f0-9]{64}$',false)
   THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'relations') r GROUP BY r->>'kind',r->>'source',r->>'target_object_id',r->>'target_revision_id' HAVING count(*)>1)
  THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
 ELSE
  IF NOT COALESCE(action IN ('submit','approve','reject','supersede','retire')
    AND c->>'revision_id' ~ uuid_pattern AND c->>'content_hash' ~ '^[a-f0-9]{64}$',false)
    OR c - ARRAY['object_id','expected_version','action','revision_id','content_hash'] <> '{}'::jsonb
  THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_input'; END IF;
 END IF;
 SELECT s.org_id,s.human_id,s.member_role INTO org,actor,role_name FROM zentwine_tenant_private.verified_scope() s;
 IF org IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='unavailable_resource'; END IF;
 IF role_name NOT IN ('owner','member') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='forbidden'; END IF;
 -- Organization authority is already locked by bind_context. Append-only head has no mutable row to lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('zentwine.versions.v1:'||org::text||':'||oid::text,0));
 SELECT s.org_id,s.human_id,s.member_role INTO org,actor,role_name FROM zentwine_tenant_private.verified_scope() s;
 IF org IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='unavailable_resource'; END IF;
 IF NOT EXISTS(SELECT 1 FROM zentwine_tenant.object_keys k WHERE k.org_id=org AND k.id=oid)
 THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='unavailable_resource'; END IF;
 SELECT s.* INTO current_row FROM zentwine_versions.snapshots s WHERE s.org_id=org AND s.object_id=oid ORDER BY s.object_version DESC LIMIT 1;
 current_version := COALESCE(current_row.object_version,0);
 current_json := CASE WHEN current_version=0 THEN NULL ELSE to_jsonb(current_row) END;
 IF expected <> current_version OR (action <> 'revise' AND current_version>0 AND
  (c->>'revision_id' <> current_row.revision_id::text OR c->>'content_hash' <> current_row.content_hash))
 THEN RETURN jsonb_build_object('outcome','conflict','expected_version',expected,'current',current_json); END IF;
 next_status := CASE
  WHEN action='revise' AND (current_version=0 OR current_row.status IN ('draft','superseded')) THEN 'draft'
  WHEN action='submit' AND current_row.status='draft' THEN 'in_review'
  WHEN action='approve' AND current_row.status='in_review' THEN 'approved'
  WHEN action='reject' AND current_row.status='in_review' THEN 'draft'
  WHEN action='supersede' AND current_row.status='approved' THEN 'superseded'
  WHEN action='retire' AND current_row.status IN ('approved','superseded') THEN 'retired'
  ELSE NULL END;
 IF next_status IS NULL THEN RETURN jsonb_build_object('outcome','invalid_transition','expected_version',expected,'current',current_json); END IF;
 IF (action IN ('approve','reject','supersede','retire') AND role_name <> 'owner') OR
  (action='approve' AND actor=current_row.created_by)
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='forbidden'; END IF;
 IF action='revise' THEN
  -- Resolve all foreign references in this authorized tenant BEFORE any write; no FK error leaks another tenant.
  FOR rel IN SELECT value FROM jsonb_array_elements(c->'relations') LOOP
   IF NOT EXISTS(SELECT 1 FROM zentwine_versions.revisions r WHERE r.org_id=org
    AND r.object_id=(rel->>'target_object_id')::uuid AND r.revision_id=(rel->>'target_revision_id')::uuid AND r.content_hash=rel->>'target_hash')
   THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='unavailable_resource'; END IF;
  END LOOP;
  new_revision := gen_random_uuid(); new_number := COALESCE(current_row.revision_number,0)+1;
  INSERT INTO zentwine_versions.revisions(org_id,object_id,revision_id,revision_number,parent_revision_id,algorithm,canonicalization_version,schema_id,content_hash,content_bytes,created_by)
  VALUES(org,oid,new_revision,new_number,current_row.revision_id,content->>'algorithm',content->>'canonicalization_version',content->>'schema_id',content->>'content_hash',(content->>'content_bytes')::integer,actor);
  INSERT INTO zentwine_versions.relations(org_id,object_id,revision_id,kind,source,target_object_id,target_revision_id,target_hash,created_by)
   SELECT org,oid,new_revision,r->>'kind',r->>'source',(r->>'target_object_id')::uuid,(r->>'target_revision_id')::uuid,r->>'target_hash',actor FROM jsonb_array_elements(c->'relations') r;
 ELSE new_revision := current_row.revision_id; END IF;
 INSERT INTO zentwine_versions.states(org_id,object_id,object_version,revision_id,status,changed_by)
 VALUES(org,oid,current_version+1,new_revision,next_status,actor);
 IF zentwine_tenant.current_org() IS DISTINCT FROM org THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='unavailable_resource'; END IF;
 SELECT to_jsonb(s) INTO current_json FROM zentwine_versions.snapshots s WHERE s.org_id=org AND s.object_id=oid AND s.object_version=current_version+1;
 IF current_json IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='unavailable_resource'; END IF;
 RETURN jsonb_build_object('outcome','applied','expected_version',expected,'current',current_json);
END;
$command$;
REVOKE ALL ON ALL TABLES IN SCHEMA zentwine_versions FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA zentwine_versions FROM PUBLIC;
