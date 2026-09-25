-- Stable opaque references preserve historical source IDs and timestamps. No credentials or event payloads added.
ALTER TABLE zentwine_organizations.events ADD COLUMN audit_ref uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX organization_audit_reference ON zentwine_organizations.events(audit_ref);
CREATE INDEX organization_audit_page ON zentwine_organizations.events(org_id,id DESC);
CREATE INDEX organization_audit_kind_page ON zentwine_organizations.events(org_id,kind,id DESC);
