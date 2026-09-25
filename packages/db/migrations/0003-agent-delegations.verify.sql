WITH column_probe AS (
  SELECT id,org_id,credential_digest,max_calls,reserved_calls,used_calls
  FROM zentwine_agents.delegations WHERE false
)
SELECT count(*)=4 AND (SELECT count(*) FROM column_probe)=0 AS verified
FROM information_schema.tables
WHERE table_schema='zentwine_agents' AND table_name IN ('identities','snapshots','delegations','operations');
