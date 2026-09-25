CREATE SCHEMA zentwine_identity;
REVOKE ALL ON SCHEMA zentwine_identity FROM PUBLIC;
CREATE TABLE zentwine_identity.humans (
  id uuid PRIMARY KEY, display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE zentwine_identity.organizations (
  id uuid PRIMARY KEY, display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  object_version integer NOT NULL DEFAULT 1 CHECK (object_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE zentwine_identity.memberships (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),
  human_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
  display_number text NOT NULL CHECK (display_number ~ '^MEM-[1-9][0-9]{0,8}$'),
  role text NOT NULL CHECK (role IN ('owner','member','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  object_version integer NOT NULL DEFAULT 1 CHECK (object_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id, human_id), UNIQUE(org_id, display_number)
);
CREATE INDEX memberships_human ON zentwine_identity.memberships(human_id);
CREATE TABLE zentwine_identity.login_tickets (
  digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),
  human_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
  auth_version integer NOT NULL, expires_at timestamptz NOT NULL,
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE zentwine_identity.sessions (
  id uuid PRIMARY KEY, digest text NOT NULL UNIQUE CHECK (digest ~ '^[a-f0-9]{64}$'),
  human_id uuid NOT NULL REFERENCES zentwine_identity.humans(id), auth_version integer NOT NULL,
  active_org_id uuid REFERENCES zentwine_identity.organizations(id),
  context_version integer NOT NULL DEFAULT 1 CHECK (context_version BETWEEN 1 AND 2147483646),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL, revoked_at timestamptz,
  CHECK (idle_expires_at <= expires_at), CHECK (expires_at > created_at)
);
CREATE INDEX sessions_human ON zentwine_identity.sessions(human_id);
REVOKE ALL ON ALL TABLES IN SCHEMA zentwine_identity FROM PUBLIC;
