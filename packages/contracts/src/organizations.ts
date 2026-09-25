/** Additive organization contract; existing identity/bootstrap versions remain untouched. */
export const ORGANIZATION_API_VERSION = "1.0.0" as const;
const id = {
  type: "string",
  pattern:
    "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
} as const;
const label = { type: "string", minLength: 1, maxLength: 120 } as const;
const version = { type: "integer", minimum: 1, maximum: 2147483646 } as const;
const token = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } as const;
const external = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  pattern: "^[!-~]+$",
} as const;
export const organizationEmpty = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;
const shape = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const organizationSettingsInput = shape({
  display_name: label,
  locale: { enum: ["zh-CN", "en"] },
  time_zone: { type: "string", minLength: 1, maxLength: 80 },
  invitations_enabled: { type: "boolean" },
  invite_ttl_hours: { type: "integer", minimum: 1, maximum: 168 },
  guest_ttl_days: { type: "integer", minimum: 1, maximum: 30 },
  expected_version: version,
});
export const organizationSettingsSchema = shape({
  org_id: id,
  display_name: label,
  locale: { enum: ["zh-CN", "en"] },
  time_zone: { type: "string" },
  invitations_enabled: { type: "boolean" },
  invite_ttl_hours: { type: "integer" },
  guest_ttl_days: { type: "integer" },
  object_version: version,
});
export const organizationMemberSchema = shape({
  id,
  human_id: id,
  display_name: label,
  display_number: { type: "string" },
  role: { enum: ["owner", "member", "viewer"] },
  access_kind: { enum: ["member", "guest"] },
  access_expires_at: {
    anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
  },
  status: { enum: ["active", "revoked"] },
  object_version: version,
  managed_by_connection: { type: "boolean" },
});
export const organizationMemberUpdate = shape({
  role: { enum: ["owner", "member", "viewer"] },
  status: { enum: ["active", "revoked"] },
  expected_version: version,
});
export const organizationInvitationInput = shape({
  request_id: id,
  human_id: id,
  role: { enum: ["member", "viewer"] },
  access_kind: { enum: ["member", "guest"] },
  resource_ids: { type: "array", maxItems: 16, uniqueItems: true, items: id },
  expected_settings_version: version,
});
export const organizationInvitationSchema = shape({
  id,
  org_id: id,
  human_id: id,
  role: { enum: ["member", "viewer"] },
  access_kind: { enum: ["member", "guest"] },
  resource_ids: { type: "array", maxItems: 16, items: id },
  state: { enum: ["pending", "accepted", "revoked", "expired"] },
  expires_at: { type: "string", format: "date-time" },
  access_expires_at: {
    anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
  },
  object_version: version,
});
export const organizationConnectionInput = shape({
  display_name: label,
  issuer: { type: "string", minLength: 1, maxLength: 512 },
  client_id: external,
  enabled: { type: "boolean" },
  expected_version: { ...version, minimum: 0 },
});
export const organizationConnectionSchema = shape({
  id,
  org_id: id,
  display_name: label,
  issuer: { type: "string" },
  client_id: external,
  enabled: { type: "boolean" },
  object_version: version,
  protocol: { const: "oidc-adapter-port" },
});
export const organizationVersionInput = shape({ expected_version: version });
export const organizationSessionRevoke = shape({ human_id: id });
export const organizationAcceptInput = shape({ invitation_token: token });
export const organizationProvisioningInput = shape({
  request_id: id,
  external_id: external,
  active: { type: "boolean" },
  expected_version: version,
});
export const organizationIdParams = (key: string) =>
  shape({ orgId: id, [key]: id });
export const organizationConnectionParams = shape({ connectionId: id });
export const organizationSearchQuery = shape({
  q: { type: "string", maxLength: 120 },
});
