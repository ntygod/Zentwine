-- Transactional owner-only downgrade of unused version infrastructure. Never erase approved history.
LOCK TABLE zentwine_versions.relations,zentwine_versions.states,zentwine_versions.revisions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE zentwine_versions.relations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zentwine_versions.states NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zentwine_versions.revisions NO FORCE ROW LEVEL SECURITY;
CREATE TABLE zentwine_versions.downgrade_guard(allowed boolean NOT NULL CONSTRAINT version_history_requires_forward_recovery CHECK(allowed));
INSERT INTO zentwine_versions.downgrade_guard SELECT
 NOT EXISTS(SELECT 1 FROM zentwine_versions.revisions) AND NOT EXISTS(SELECT 1 FROM zentwine_versions.states) AND NOT EXISTS(SELECT 1 FROM zentwine_versions.relations);
DROP TABLE zentwine_versions.downgrade_guard;
DROP FUNCTION zentwine_versions.apply(jsonb);
DROP VIEW zentwine_versions.snapshots;
DROP TABLE zentwine_versions.relations;
DROP TABLE zentwine_versions.states;
DROP TABLE zentwine_versions.revisions;
DROP FUNCTION zentwine_versions.immutable_row();
DROP SCHEMA zentwine_versions;
