ALTER TABLE zentwine_identity.memberships ADD COLUMN emergency_held boolean NOT NULL DEFAULT false;
ALTER TABLE zentwine_identity.memberships ADD COLUMN emergency_version integer NOT NULL DEFAULT 0 CHECK(emergency_version BETWEEN 0 AND 2147483646);
ALTER TABLE zentwine_identity.memberships ADD CONSTRAINT emergency_hold_version CHECK(NOT emergency_held OR emergency_version > 0);
CREATE TABLE zentwine_organizations.emergency_receipts (
 org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),
 actor_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
 request_id uuid NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 PRIMARY KEY(org_id,actor_id,request_id)
);
REVOKE ALL ON zentwine_organizations.emergency_receipts FROM PUBLIC;
ALTER TABLE zentwine_organizations.events DROP CONSTRAINT events_kind_check;
ALTER TABLE zentwine_organizations.events ADD CONSTRAINT events_kind_check CHECK(kind IN ('settings.updated', 'member.updated', 'sessions.revoked', 'invitation.created', 'invitation.accepted', 'invitation.revoked', 'connection.updated', 'identity.linked', 'identity.provisioned', 'member.emergency_held', 'member.emergency_released'));
