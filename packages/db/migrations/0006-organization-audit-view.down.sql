-- Removes read-view references/indexes only; original lifecycle facts remain intact.
DROP INDEX zentwine_organizations.organization_audit_kind_page;
DROP INDEX zentwine_organizations.organization_audit_page;
DROP INDEX zentwine_organizations.organization_audit_reference;
ALTER TABLE zentwine_organizations.events DROP COLUMN audit_ref;
