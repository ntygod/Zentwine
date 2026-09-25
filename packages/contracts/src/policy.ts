/** Public policy/canonical resource metadata protocol; no client-owned principal or environment. */
const id = {
  type: "string",
  pattern:
    "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
} as const;
const version = { type: "integer", minimum: 1, maximum: 2147483646 } as const;
export const policyDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "outcome",
    "reason",
    "policy_version",
    "policy_revision",
    "membership_version",
    "resource_version",
    "evaluated_at",
    "expires_at",
    "reusable",
  ],
  properties: {
    schema_version: { const: "1.0.0" },
    outcome: { enum: ["allow", "deny", "needs_approval"] },
    reason: {
      enum: [
        "allowed",
        "invalid_facts",
        "unknown_action",
        "resource_unavailable",
        "stale_facts",
        "action_resource_mismatch",
        "explicit_deny",
        "no_permission",
        "restricted_resource",
        "read_only_environment",
        "approval_required",
      ],
    },
    policy_version: { const: "1.0.0" },
    policy_revision: { type: "integer", minimum: 0 },
    membership_version: { type: "integer", minimum: 0 },
    resource_version: { type: "integer", minimum: 0 },
    evaluated_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
    reusable: { const: false },
  },
} as const;
export const policyResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "org_id",
    "kind",
    "display_name",
    "visibility",
    "environment",
    "sensitivity",
    "owner_human_id",
    "status",
    "object_version",
  ],
  properties: {
    id,
    org_id: id,
    kind: {
      enum: [
        "project",
        "work_package",
        "workspace",
        "repository",
        "artifact",
        "release",
      ],
    },
    display_name: { type: "string", minLength: 1, maxLength: 120 },
    visibility: { enum: ["organization", "restricted"] },
    environment: { enum: ["development", "staging", "production"] },
    sensitivity: { enum: ["internal", "confidential"] },
    owner_human_id: { anyOf: [id, { type: "null" }] },
    status: { enum: ["active", "archived"] },
    object_version: version,
  },
} as const;
export const policyReadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["resource", "decision"],
  properties: {
    resource: policyResourceSchema,
    decision: policyDecisionSchema,
  },
} as const;
export const policyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["resource_id", "action"],
  properties: {
    resource_id: id,
    action: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;
export const policyRenameSchema = {
  type: "object",
  additionalProperties: false,
  required: ["display_name", "expected_version", "expected_policy_revision"],
  properties: {
    display_name: {
      type: "string",
      minLength: 1,
      maxLength: 120,
      pattern: "^[^\\u0000-\\u001f\\u007f]+$",
    },
    expected_version: version,
    expected_policy_revision: version,
  },
} as const;
export const policyParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["orgId", "resourceId"],
  properties: { orgId: id, resourceId: id },
} as const;
