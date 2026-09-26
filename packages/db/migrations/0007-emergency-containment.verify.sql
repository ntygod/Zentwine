SELECT (
 to_regclass('zentwine_organizations.emergency_receipts') IS NOT NULL
 AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='zentwine_identity' AND table_name='memberships' AND column_name='emergency_held' AND is_nullable='NO')
 AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='zentwine_identity' AND table_name='memberships' AND column_name='emergency_version' AND is_nullable='NO')
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='zentwine_identity.memberships'::regclass AND conname='emergency_hold_version')
 AND NOT EXISTS(SELECT 1 FROM pg_class t CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) a WHERE t.oid='zentwine_organizations.emergency_receipts'::regclass AND a.grantee=0)
) AS verified;
