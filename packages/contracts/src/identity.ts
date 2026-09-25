/** Separate versioned identity contract. Does not overwrite the v0.1 bootstrap schema. */
export const IDENTITY_VERSION = "1.0.0" as const;
const id = {
  type: "string",
  pattern:
    "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
} as const;
const name = { type: "string", minLength: 1, maxLength: 120 } as const;
const version = { type: "integer", minimum: 1, maximum: 2147483646 } as const;
const human = {
  type: "object",
  additionalProperties: false,
  required: ["id", "display_name"],
  properties: { id, display_name: name },
} as const;
export const identitySessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "session", "csrf_token"],
  properties: {
    schema_version: { const: IDENTITY_VERSION },
    csrf_token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    session: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "human",
        "expires_at",
        "context_version",
        "active_org_id",
        "organizations",
      ],
      properties: {
        id,
        human,
        expires_at: { type: "string", format: "date-time" },
        context_version: version,
        active_org_id: { anyOf: [id, { type: "null" }] },
        organizations: { type: "array", maxItems: 100, items: human },
      },
    },
  },
} as const;
export const tenantContextSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "context"],
  properties: {
    schema_version: { const: IDENTITY_VERSION },
    context: {
      type: "object",
      additionalProperties: false,
      required: [
        "principal_kind",
        "session_id",
        "context_version",
        "human",
        "organization",
        "membership",
      ],
      properties: {
        principal_kind: { const: "human" },
        session_id: id,
        context_version: version,
        human,
        organization: human,
        membership: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "org_id",
            "human_id",
            "display_number",
            "role",
            "object_version",
          ],
          properties: {
            id,
            org_id: id,
            human_id: id,
            display_number: {
              type: "string",
              pattern: "^MEM-[1-9][0-9]{0,8}$",
            },
            role: { enum: ["owner", "member", "viewer"] },
            object_version: version,
          },
        },
      },
    },
  },
} as const;
export const loginTicketSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ticket"],
  properties: { ticket: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
} as const;
export const selectOrgSchema = {
  type: "object",
  additionalProperties: false,
  required: ["org_id", "expected_version"],
  properties: { org_id: id, expected_version: version },
} as const;
export const rotateSessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_version"],
  properties: { expected_version: version },
} as const;
export const identityOrgParams = {
  type: "object",
  additionalProperties: false,
  required: ["orgId"],
  properties: { orgId: id },
} as const;
