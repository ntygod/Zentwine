CREATE SCHEMA zentwine_agents;
REVOKE ALL ON SCHEMA zentwine_agents FROM PUBLIC;
CREATE TABLE zentwine_agents.identities (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),
  accountable_owner_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  request_id uuid NOT NULL,
  object_version integer NOT NULL DEFAULT 1 CHECK(object_version BETWEEN 1 AND 2147483646),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,accountable_owner_id,request_id),
  UNIQUE(id,org_id,accountable_owner_id)
);
CREATE TABLE zentwine_agents.snapshots (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,org_id)
);
CREATE TABLE zentwine_agents.delegations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  accountable_owner_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  parent_id uuid,
  root_id uuid NOT NULL,
  credential_digest text NOT NULL UNIQUE CHECK(credential_digest ~ '^[a-f0-9]{64}$'),
  issuer_key text NOT NULL,
  request_id uuid NOT NULL,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_id uuid NOT NULL UNIQUE,
  max_calls integer NOT NULL CHECK(max_calls BETWEEN 1 AND 1000000),
  reserved_calls integer NOT NULL DEFAULT 0 CHECK(reserved_calls>=0),
  used_calls integer NOT NULL DEFAULT 0 CHECK(used_calls>=0),
  object_version integer NOT NULL DEFAULT 1 CHECK(object_version BETWEEN 1 AND 2147483646),
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(reserved_calls+used_calls<=max_calls),
  CHECK(expires_at>not_before AND expires_at<=not_before+interval '8 hours'),
  UNIQUE(id,org_id,accountable_owner_id),
  UNIQUE(org_id,issuer_key,request_id),
  FOREIGN KEY(agent_id,org_id,accountable_owner_id) REFERENCES zentwine_agents.identities(id,org_id,accountable_owner_id),
  FOREIGN KEY(parent_id,org_id,accountable_owner_id) REFERENCES zentwine_agents.delegations(id,org_id,accountable_owner_id),
  FOREIGN KEY(root_id,org_id,accountable_owner_id) REFERENCES zentwine_agents.delegations(id,org_id,accountable_owner_id),
  FOREIGN KEY(snapshot_id,org_id) REFERENCES zentwine_agents.snapshots(id,org_id)
);
CREATE INDEX agent_parent ON zentwine_agents.delegations(parent_id);
CREATE TABLE zentwine_agents.operations (
  delegation_id uuid NOT NULL REFERENCES zentwine_agents.delegations(id),
  request_id uuid NOT NULL,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  resource_id uuid NOT NULL,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(delegation_id,request_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA zentwine_agents FROM PUBLIC;
