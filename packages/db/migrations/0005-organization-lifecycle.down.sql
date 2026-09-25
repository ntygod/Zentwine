-- Explicit destructive development removal only. Revoke guests before removing their constraints: never turn them into ordinary viewers.
UPDATE zentwine_identity.memberships SET status='revoked',object_version=object_version+1 WHERE access_kind='guest';
UPDATE zentwine_identity.sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp());
UPDATE zentwine_identity.login_tickets SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE digest IN(SELECT digest FROM zentwine_organizations.federated_tickets);
DROP TABLE zentwine_organizations.federated_tickets,zentwine_organizations.provisioning_receipts,zentwine_organizations.external_identities;
DROP TABLE zentwine_organizations.connections,zentwine_organizations.invitations,zentwine_organizations.session_cutoffs,zentwine_organizations.settings,zentwine_organizations.events;
DROP SCHEMA zentwine_organizations;
ALTER TABLE zentwine_identity.memberships DROP CONSTRAINT membership_access_boundary;
ALTER TABLE zentwine_identity.memberships DROP COLUMN access_kind,DROP COLUMN access_expires_at;
