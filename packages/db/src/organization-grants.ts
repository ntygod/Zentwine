/** Operator-only SQL generation. Trusted installation code, never callable by browser/Agent tools. */
export function organizationGrantSql(manager: string, reader: string): string {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(manager) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(reader) ||
    manager === reader
  )
    throw new TypeError("Invalid separate role names");
  const m = `"${manager}"`,
    r = `"${reader}"`;
  return `GRANT USAGE ON SCHEMA zentwine_identity,zentwine_policy,zentwine_organizations,zentwine_approvals TO ${m};
 GRANT SELECT ON ALL TABLES IN SCHEMA zentwine_identity,zentwine_policy,zentwine_organizations,zentwine_approvals TO ${m};
 GRANT INSERT ON zentwine_organizations.settings,zentwine_organizations.connections,zentwine_organizations.invitations,zentwine_organizations.session_cutoffs,zentwine_organizations.provisioning_receipts,zentwine_organizations.federated_tickets,zentwine_organizations.events TO ${m};
 GRANT UPDATE(locale,time_zone,invitations_enabled,invite_ttl_hours,guest_ttl_days,object_version) ON zentwine_organizations.settings TO ${m};
 GRANT UPDATE(display_name,issuer,client_id,enabled,object_version) ON zentwine_organizations.connections TO ${m};
 GRANT UPDATE(state,object_version) ON zentwine_organizations.invitations TO ${m};
 GRANT UPDATE(invalid_before) ON zentwine_organizations.session_cutoffs TO ${m};
 GRANT UPDATE(active,object_version) ON zentwine_organizations.external_identities TO ${m};
 GRANT UPDATE(display_name,object_version) ON zentwine_identity.organizations TO ${m};
 GRANT INSERT ON zentwine_identity.memberships,zentwine_identity.sessions,zentwine_identity.login_tickets,zentwine_policy.role_bindings TO ${m};
 GRANT UPDATE(role,status,object_version,access_kind,access_expires_at) ON zentwine_identity.memberships TO ${m};
 GRANT UPDATE(revoked_at) ON zentwine_identity.sessions,zentwine_policy.role_bindings,zentwine_policy.resource_grants TO ${m};
 GRANT UPDATE(state,object_version,reason) ON zentwine_approvals.requests TO ${m};
 GRANT INSERT ON zentwine_approvals.events TO ${m};
 GRANT USAGE ON ALL SEQUENCES IN SCHEMA zentwine_organizations,zentwine_approvals TO ${m};
 GRANT USAGE ON SCHEMA zentwine_organizations TO ${r};
 GRANT SELECT ON zentwine_organizations.session_cutoffs,zentwine_organizations.federated_tickets,zentwine_organizations.external_identities,zentwine_organizations.connections TO ${r};`;
}
