SELECT (SELECT count(*) = 5 FROM information_schema.tables
  WHERE table_schema = 'zentwine_identity' AND table_type = 'BASE TABLE')
  AND to_regclass('zentwine_identity.sessions_digest_key') IS NOT NULL
  AND to_regclass('zentwine_identity.memberships_org_id_display_number_key') IS NOT NULL
  AS verified;
