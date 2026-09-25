CREATE SCHEMA zentwine_organizations;
REVOKE ALL ON SCHEMA zentwine_organizations FROM PUBLIC;
ALTER TABLE zentwine_identity.memberships ADD COLUMN access_kind text NOT NULL DEFAULT 'member' CHECK(access_kind IN ('member','guest'));
ALTER TABLE zentwine_identity.memberships ADD COLUMN access_expires_at timestamptz;
ALTER TABLE zentwine_identity.memberships ADD CONSTRAINT membership_access_boundary CHECK ((access_kind='member' AND access_expires_at IS NULL) OR (access_kind='guest' AND role='viewer' AND access_expires_at IS NOT NULL));
CREATE TABLE zentwine_organizations.settings (
 org_id uuid PRIMARY KEY REFERENCES zentwine_identity.organizations(id),locale text NOT NULL DEFAULT 'zh-CN' CHECK(locale IN ('zh-CN','en')),
 time_zone text NOT NULL DEFAULT 'Asia/Singapore' CHECK(length(time_zone) BETWEEN 1 AND 80),invitations_enabled boolean NOT NULL DEFAULT true,
 invite_ttl_hours integer NOT NULL DEFAULT 24 CHECK(invite_ttl_hours BETWEEN 1 AND 168),guest_ttl_days integer NOT NULL DEFAULT 7 CHECK(guest_ttl_days BETWEEN 1 AND 30),
 object_version integer NOT NULL DEFAULT 1 CHECK(object_version BETWEEN 1 AND 2147483646)
);
INSERT INTO zentwine_organizations.settings(org_id) SELECT id FROM zentwine_identity.organizations;
CREATE TABLE zentwine_organizations.session_cutoffs (
 org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),human_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),invalid_before timestamptz NOT NULL,PRIMARY KEY(org_id,human_id)
);
CREATE TABLE zentwine_organizations.invitations (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),human_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),inviter_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
 request_id uuid NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),digest text NOT NULL UNIQUE CHECK(digest ~ '^[a-f0-9]{64}$'),
 role text NOT NULL CHECK(role IN ('member','viewer')),access_kind text NOT NULL CHECK(access_kind IN ('member','guest')),resource_ids uuid[] NOT NULL,
 inviter_version integer NOT NULL,settings_version integer NOT NULL,org_version integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','revoked')),object_version integer NOT NULL DEFAULT 1 CHECK(object_version BETWEEN 1 AND 2147483646),
 expires_at timestamptz NOT NULL,access_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,inviter_id,request_id),CHECK(cardinality(resource_ids)<=16),CHECK(expires_at>created_at),
 CHECK((access_kind='member' AND access_expires_at IS NULL AND cardinality(resource_ids)=0) OR (access_kind='guest' AND role='viewer' AND access_expires_at>expires_at AND cardinality(resource_ids)>0))
);
CREATE TABLE zentwine_organizations.connections (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),display_name text NOT NULL,issuer text NOT NULL,client_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,object_version integer NOT NULL DEFAULT 1 CHECK(object_version BETWEEN 1 AND 2147483646),
 credential_version integer,credential_digest text CHECK(credential_digest ~ '^[a-f0-9]{64}$'),credential_expires_at timestamptz,UNIQUE(id,org_id),
 CHECK((credential_digest IS NULL)=(credential_expires_at IS NULL))
);
CREATE TABLE zentwine_organizations.external_identities (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),connection_id uuid NOT NULL,human_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 255),
 active boolean NOT NULL DEFAULT true,object_version integer NOT NULL DEFAULT 1 CHECK(object_version BETWEEN 1 AND 2147483646),
 FOREIGN KEY(connection_id,org_id) REFERENCES zentwine_organizations.connections(id,org_id),
 UNIQUE(connection_id,subject),UNIQUE(connection_id,external_id),UNIQUE(org_id,human_id)
);
CREATE TABLE zentwine_organizations.provisioning_receipts (
 connection_id uuid NOT NULL REFERENCES zentwine_organizations.connections(id),request_id uuid NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,
 PRIMARY KEY(connection_id,request_id)
);
CREATE TABLE zentwine_organizations.federated_tickets (
 digest text PRIMARY KEY REFERENCES zentwine_identity.login_tickets(digest),connection_id uuid NOT NULL REFERENCES zentwine_organizations.connections(id),connection_version integer NOT NULL,
 external_identity_id uuid NOT NULL REFERENCES zentwine_organizations.external_identities(id),mapping_version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE zentwine_organizations.events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),actor_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('settings.updated','member.updated','sessions.revoked','invitation.created','invitation.accepted','invitation.revoked','connection.updated','identity.linked','identity.provisioned')),
 subject_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ALL TABLES IN SCHEMA zentwine_organizations FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA zentwine_organizations FROM PUBLIC;
