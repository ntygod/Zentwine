/** Native platform contract. Not a model SDK protocol or a reusable authorization permit. */
const id = {
  type: "string",
  pattern:
    "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
};
const version = { type: "integer", minimum: 1, maximum: 2147483646 };
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
export const agentParamsSchema = object({ orgId: id, agentId: id });
export const delegationParamsSchema = object({ orgId: id, delegationId: id });
export const agentRegisterSchema = object({
  request_id: id,
  display_name: name,
});
export const agentExpectedSchema = object({ expected_version: version });
export const delegationTermsSchema = object({
  scopes: {
    type: "array",
    minItems: 1,
    maxItems: 16,
    items: object({
      resource_id: id,
      environment: { enum: ["development", "staging", "production"] },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        items: {
          enum: [
            "resource.read",
            "resource.update",
            "resource.export",
            "workspace.write",
            "repository.write",
            "release.deploy",
          ],
        },
      },
    }),
  },
  not_before: { type: "integer", minimum: 0, maximum: 8640000000000000 },
  expires_at: { type: "integer", minimum: 0, maximum: 8640000000000000 },
  max_calls: { type: "integer", minimum: 1, maximum: 1000000 },
  max_depth: { type: "integer", minimum: 1, maximum: 8 },
});
export const delegationRequestSchema = object({
  request_id: id,
  agent_id: id,
  terms: delegationTermsSchema,
});
export const agentToolSchema = {
  oneOf: [
    object({
      request_id: id,
      resource_id: id,
      operation: { const: "catalog.read" },
    }),
    object({
      request_id: id,
      resource_id: id,
      operation: { const: "catalog.rename" },
      display_name: name,
      expected_version: version,
      expected_policy_revision: version,
    }),
  ],
};
