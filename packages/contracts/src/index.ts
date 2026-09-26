export { ERROR_CATALOG, isErrorCode, type ErrorCode } from "./errors.js";
export const CONTRACT_VERSION = "0.1.0" as const;
export const STUDIO_PATH = "/org/local/studio" as const;
export const WORKBENCH_PATH = "/org/local/workbench" as const;
export interface ApiErrorPayload {
  code: string;
  message: string;
  details: Record<string, never>;
  trace_id: string;
  retryable: boolean;
}
export interface Bootstrap {
  schema_version: typeof CONTRACT_VERSION;
  product: "Zentwine";
  mode: "development-bootstrap";
  server_time: string;
  capabilities: {
    management_shell: true;
    studio_shell: true;
    identity: false;
    execution: false;
    persistence: false;
  };
  runtimes: Array<{ id: "claude" | "codex"; state: "not_connected" }>;
}
export const bootstrapSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "product",
    "mode",
    "server_time",
    "capabilities",
    "runtimes",
  ],
  properties: {
    schema_version: { const: CONTRACT_VERSION },
    product: { const: "Zentwine" },
    mode: { const: "development-bootstrap" },
    server_time: { type: "string", format: "date-time" },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: [
        "management_shell",
        "studio_shell",
        "identity",
        "execution",
        "persistence",
      ],
      properties: {
        management_shell: { const: true },
        studio_shell: { const: true },
        identity: { const: false },
        execution: { const: false },
        persistence: { const: false },
      },
    },
    runtimes: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "state"],
        properties: {
          id: { enum: ["claude", "codex"] },
          state: { const: "not_connected" },
        },
      },
    },
  },
} as const;
export const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "details", "trace_id", "retryable"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    details: { type: "object", additionalProperties: false },
    trace_id: { type: "string" },
    retryable: { type: "boolean" },
  },
} as const;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isBootstrap(value: unknown): value is Bootstrap {
  if (
    !record(value) ||
    value["schema_version"] !== CONTRACT_VERSION ||
    value["product"] !== "Zentwine" ||
    value["mode"] !== "development-bootstrap"
  )
    return false;
  if (
    typeof value["server_time"] !== "string" ||
    !Number.isFinite(Date.parse(value["server_time"]))
  )
    return false;
  const c = value["capabilities"];
  if (
    !record(c) ||
    c["management_shell"] !== true ||
    c["studio_shell"] !== true ||
    c["identity"] !== false ||
    c["execution"] !== false ||
    c["persistence"] !== false
  )
    return false;
  const r = value["runtimes"];
  return (
    Array.isArray(r) &&
    r.length === 2 &&
    r.every(
      (item) =>
        record(item) &&
        ["claude", "codex"].includes(String(item["id"])) &&
        item["state"] === "not_connected",
    ) &&
    new Set(r.map((item) => (item as Record<string, unknown>)["id"])).size === 2
  );
}
export function isApiError(value: unknown): value is ApiErrorPayload {
  return (
    record(value) &&
    typeof value["code"] === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value["code"]) &&
    typeof value["message"] === "string" &&
    value["message"].length <= 256 &&
    typeof value["trace_id"] === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value["trace_id"]) &&
    typeof value["retryable"] === "boolean" &&
    record(value["details"]) &&
    Object.keys(value["details"]).length === 0 &&
    Object.keys(value).length === 5
  );
}
// Deep links locate resources, never authorize or start execution.
export function workspacePath(orgId: string, workspaceId: string): string {
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
  if (!valid.test(orgId) || !valid.test(workspaceId))
    throw new TypeError("Invalid resource identifier");
  return `/org/${encodeURIComponent(orgId)}/studio/workspaces/${encodeURIComponent(workspaceId)}`;
}

export * from "./identity.js";

export * from "./policy.js";

export * from "./agents.js";

export * from "./approvals.js";

export * from "./organizations.js";
export * from "./emergency.js";

export * from "./organization-audit.js";

export * from "./workbench.js";
