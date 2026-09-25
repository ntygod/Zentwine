/** Platform-native, exact-command approvals; unrelated to vendor SDK approval IDs. */
const id = {
  type: "string",
  pattern:
    "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
};
const version = { type: "integer", minimum: 1, maximum: 2147483646 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const name = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
};
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const approvalParamsSchema = object({ orgId: id, approvalId: id });
export const approvalInputSchema = object({
  request_id: id,
  resource_id: id,
  operation: { const: "catalog.rename" },
  display_name: name,
  expected_version: version,
  expected_policy_revision: version,
  review: { enum: ["required", "policy"] },
});
export const approvalGuardSchema = object({
  expected_version: version,
  content_hash: hash,
});
export const approvalDecisionInputSchema = object({
  ...approvalGuardSchema.properties,
  outcome: { enum: ["approve", "reject"] },
});
export const approvalExecuteSchema = object({
  ...approvalGuardSchema.properties,
  resource_id: id,
  operation: { const: "catalog.rename" },
  display_name: name,
  expected_resource_version: version,
  expected_policy_revision: version,
  permit: { type: "string", pattern: "^zt_permit_[A-Za-z0-9_-]{43}$" },
});
export const approvalEventsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    after: { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$", default: "0" },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
};
