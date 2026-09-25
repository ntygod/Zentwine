CREATE SCHEMA zentwine_approvals;
REVOKE ALL ON SCHEMA zentwine_approvals FROM PUBLIC;
CREATE TABLE zentwine_approvals.requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES zentwine_identity.organizations(id),
  requester_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
  resource_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','issued','rejected','revoked','consumed')),
  object_version integer NOT NULL DEFAULT 1 CHECK(object_version BETWEEN 1 AND 2147483646),
  reason text NOT NULL DEFAULT 'requested' CHECK(reason IN ('requested','human','preauthorized_policy','permit_issued','executed','revoked','authority_changed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
  UNIQUE(id,org_id),
  UNIQUE(org_id,requester_id,request_id),
  FOREIGN KEY(resource_id,org_id) REFERENCES zentwine_policy.resources(id,org_id)
);
CREATE TABLE zentwine_approvals.decisions (
  approval_id uuid PRIMARY KEY REFERENCES zentwine_approvals.requests(id),
  actor_id uuid NOT NULL REFERENCES zentwine_identity.humans(id),
  source text NOT NULL CHECK(source IN ('human','preauthorized_policy')),
  outcome text NOT NULL CHECK(outcome IN ('approve','reject')),
  authority jsonb NOT NULL CHECK(jsonb_typeof(authority)='object'),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE zentwine_approvals.permits (
  approval_id uuid PRIMARY KEY REFERENCES zentwine_approvals.requests(id),
  digest text NOT NULL UNIQUE CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '2 minutes')
);
CREATE TABLE zentwine_approvals.receipts (
  approval_id uuid PRIMARY KEY REFERENCES zentwine_approvals.requests(id),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE zentwine_approvals.events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  kind text NOT NULL,
  object_version integer NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(approval_id,object_version),
  FOREIGN KEY(approval_id,org_id) REFERENCES zentwine_approvals.requests(id,org_id)
);
CREATE INDEX approval_owner ON zentwine_approvals.requests(org_id,requester_id);
CREATE INDEX approval_events_cursor ON zentwine_approvals.events(org_id,sequence);
REVOKE ALL ON ALL TABLES IN SCHEMA zentwine_approvals FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA zentwine_approvals FROM PUBLIC;

