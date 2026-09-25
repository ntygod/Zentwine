CREATE SCHEMA zentwine_policy;
REVOKE ALL ON SCHEMA zentwine_policy FROM PUBLIC;
CREATE TABLE zentwine_policy.organization_policies (
  org_id uuid PRIMARY KEY REFERENCES zentwine_identity.organizations(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483646),
  write_mode text NOT NULL DEFAULT 'active' CHECK (write_mode IN ('active','read_only'))
);
CREATE TABLE zentwine_policy.resources (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),
  kind text NOT NULL CHECK (kind IN ('project','work_package','workspace','repository','artifact','release')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  visibility text NOT NULL CHECK (visibility IN ('organization','restricted')),
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('internal','confidential')),
  owner_human_id uuid, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  object_version integer NOT NULL DEFAULT 1 CHECK (object_version BETWEEN 1 AND 2147483646),
  UNIQUE(org_id,id), FOREIGN KEY(org_id,owner_human_id) REFERENCES zentwine_identity.memberships(org_id,human_id)
);
CREATE TABLE zentwine_policy.role_bindings (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, human_id uuid NOT NULL, resource_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('reader','editor')),
  valid_from timestamptz NOT NULL, expires_at timestamptz, revoked_at timestamptz,
  FOREIGN KEY(org_id,human_id) REFERENCES zentwine_identity.memberships(org_id,human_id),
  FOREIGN KEY(org_id,resource_id) REFERENCES zentwine_policy.resources(org_id,id),
  CHECK (expires_at IS NULL OR expires_at>valid_from)
);
CREATE TABLE zentwine_policy.resource_grants (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, human_id uuid NOT NULL, resource_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('resource.read','resource.update','resource.export','workspace.write','repository.write','release.deploy')),
  effect text NOT NULL CHECK (effect IN ('allow','deny')),
  valid_from timestamptz NOT NULL, expires_at timestamptz, revoked_at timestamptz,
  FOREIGN KEY(org_id,human_id) REFERENCES zentwine_identity.memberships(org_id,human_id),
  FOREIGN KEY(org_id,resource_id) REFERENCES zentwine_policy.resources(org_id,id),
  CHECK (expires_at IS NULL OR expires_at>valid_from)
);
CREATE INDEX role_bindings_scope ON zentwine_policy.role_bindings(org_id,human_id,resource_id);
CREATE INDEX resource_grants_scope ON zentwine_policy.resource_grants(org_id,human_id,resource_id);
REVOKE ALL ON ALL TABLES IN SCHEMA zentwine_policy FROM PUBLIC;
