-- Refuse to erase containment history or silently remove an active security control.
-- After any emergency action this migration is forward-only; dispose of a test database instead.
LOCK TABLE zentwine_identity.memberships,zentwine_organizations.emergency_receipts,zentwine_organizations.events IN ACCESS EXCLUSIVE MODE;
CREATE TABLE zentwine_organizations.emergency_downgrade_guard (
 allowed boolean NOT NULL CONSTRAINT emergency_history_requires_forward_recovery CHECK(allowed)
);
INSERT INTO zentwine_organizations.emergency_downgrade_guard(allowed)
SELECT NOT EXISTS(SELECT 1 FROM zentwine_identity.memberships WHERE emergency_held OR emergency_version > 0)
 AND NOT EXISTS(SELECT 1 FROM zentwine_organizations.emergency_receipts)
 AND NOT EXISTS(SELECT 1 FROM zentwine_organizations.events WHERE kind IN ('member.emergency_held','member.emergency_released'));
DROP TABLE zentwine_organizations.emergency_downgrade_guard;
DROP TABLE zentwine_organizations.emergency_receipts;
ALTER TABLE zentwine_identity.memberships DROP CONSTRAINT emergency_hold_version;
ALTER TABLE zentwine_identity.memberships DROP COLUMN emergency_held;
ALTER TABLE zentwine_identity.memberships DROP COLUMN emergency_version;
ALTER TABLE zentwine_organizations.events DROP CONSTRAINT events_kind_check;
ALTER TABLE zentwine_organizations.events ADD CONSTRAINT events_kind_check CHECK(kind IN ('settings.updated', 'member.updated', 'sessions.revoked', 'invitation.created', 'invitation.accepted', 'invitation.revoked', 'connection.updated', 'identity.linked', 'identity.provisioned'));
