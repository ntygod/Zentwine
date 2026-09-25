SELECT 1/(CASE WHEN count(*)=4 THEN 1 ELSE 0 END) AS verified
FROM information_schema.tables WHERE table_schema='zentwine_agents' AND table_name IN ('identities','snapshots','delegations','operations');
SELECT id,org_id,credential_digest,max_calls,reserved_calls,used_calls FROM zentwine_agents.delegations WHERE false;
