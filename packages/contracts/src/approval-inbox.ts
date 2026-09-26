/** Read-only discovery projection. A list row never authorizes a decision or execution. */
export const approvalInboxFilters = [
  "all",
  "pending",
  "approved",
  "issued",
  "rejected",
  "revoked",
  "consumed",
  "expired",
] as const;
export type ApprovalInboxFilter = (typeof approvalInboxFilters)[number];
export type ApprovalInboxLane = "mine" | "review";
export interface ApprovalInboxSelection {
  lane: ApprovalInboxLane;
  state: ApprovalInboxFilter;
  limit: number;
}
export interface ApprovalInboxEntry {
  id: string;
  resource_id: string;
  requester_id: string;
  requested_name: string;
  state:
    | "pending"
    | "approved"
    | "issued"
    | "rejected"
    | "revoked"
    | "consumed";
  object_version: number;
  resource_version: number;
  expires_at: string;
  expired: boolean;
}
export interface ApprovalInboxPage {
  schema_version: "1.0.0";
  org_id: string;
  lane: ApprovalInboxLane;
  state_filter: ApprovalInboxFilter;
  observed_at: string;
  authorization: false;
  consistency: "creation-boundary-current-visibility";
  entries: ApprovalInboxEntry[];
  next_cursor: string | null;
}
const pattern =
  "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$";
const id = { type: "string", pattern };
const version = { type: "integer", minimum: 1, maximum: 2147483646 };
const cursor = { type: "string", pattern: "^[A-Za-z0-9_-]{40,1024}$" };
const shape = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const states = [
  "pending",
  "approved",
  "issued",
  "rejected",
  "revoked",
  "consumed",
] as const;
export const approvalInboxQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    lane: { enum: ["mine", "review"], default: "mine" },
    state: { enum: approvalInboxFilters, default: "all" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    cursor,
  },
};
export const approvalInboxEntrySchema = shape({
  id,
  resource_id: id,
  requester_id: id,
  requested_name: {
    type: "string",
    minLength: 1,
    maxLength: 120,
    pattern: "^[^\\u0000-\\u001f\\u007f]+$",
  },
  state: { enum: states },
  object_version: version,
  resource_version: version,
  expires_at: { type: "string", format: "date-time" },
  expired: { type: "boolean" },
});
export const approvalInboxPageSchema = shape({
  schema_version: { const: "1.0.0" },
  org_id: id,
  lane: { enum: ["mine", "review"] },
  state_filter: { enum: approvalInboxFilters },
  observed_at: { type: "string", format: "date-time" },
  authorization: { const: false },
  consistency: { const: "creation-boundary-current-visibility" },
  entries: { type: "array", maxItems: 50, items: approvalInboxEntrySchema },
  next_cursor: { anyOf: [cursor, { type: "null" }] },
});
const uuid = (v: unknown): v is string =>
  typeof v === "string" && new RegExp(pattern).test(v);
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const integer = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2147483646;
function exact(
  v: unknown,
  schema: ReturnType<typeof shape>,
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== schema.required.length ||
    Object.keys(v).some((k) => !schema.required.includes(k))
  )
    throw new TypeError("Invalid approval inbox response");
}
export function approvalInboxPath(org: string): string {
  if (!uuid(org)) throw new TypeError("Invalid approval inbox location");
  return `/org/${org}/workbench/approvals`;
}
export function parseApprovalInboxPath(path: string): { org: string } | null {
  const match = /^\/org\/([^/]+)\/workbench\/approvals$/.exec(path);
  return match && uuid(match[1]) ? { org: match[1] } : null;
}
export function parseApprovalInboxPage(
  v: unknown,
  org: string,
  human: string,
  selection: ApprovalInboxSelection,
): ApprovalInboxPage {
  exact(v, approvalInboxPageSchema);
  if (
    !uuid(org) ||
    !uuid(human) ||
    !["mine", "review"].includes(selection.lane) ||
    !approvalInboxFilters.includes(selection.state) ||
    !Number.isInteger(selection.limit) ||
    selection.limit < 1 ||
    selection.limit > 50 ||
    v["schema_version"] !== "1.0.0" ||
    v["org_id"] !== org ||
    v["lane"] !== selection.lane ||
    v["state_filter"] !== selection.state ||
    !date(v["observed_at"]) ||
    v["authorization"] !== false ||
    v["consistency"] !== "creation-boundary-current-visibility" ||
    !Array.isArray(v["entries"]) ||
    v["entries"].length > selection.limit ||
    (v["next_cursor"] !== null &&
      (typeof v["next_cursor"] !== "string" ||
        !/^[A-Za-z0-9_-]{40,1024}$/.test(v["next_cursor"]) ||
        v["entries"].length !== selection.limit))
  )
    throw new TypeError("Invalid approval inbox page");
  const seen = new Set<string>();
  for (const row of v["entries"]) {
    exact(row, approvalInboxEntrySchema);
    if (
      !uuid(row["id"]) ||
      seen.has(row["id"]) ||
      !uuid(row["resource_id"]) ||
      !uuid(row["requester_id"]) ||
      (selection.lane === "mine") !== (row["requester_id"] === human) ||
      typeof row["requested_name"] !== "string" ||
      !row["requested_name"].trim() ||
      row["requested_name"].length > 120 ||
      /[\u0000-\u001f\u007f]/.test(row["requested_name"]) ||
      !states.includes(row["state"] as ApprovalInboxEntry["state"]) ||
      !integer(row["object_version"]) ||
      !integer(row["resource_version"]) ||
      !date(row["expires_at"]) ||
      typeof row["expired"] !== "boolean" ||
      row["expired"] !==
        (["pending", "approved", "issued"].includes(String(row["state"])) &&
          Date.parse(row["expires_at"]) <= Date.parse(v["observed_at"])) ||
      (selection.state === "expired"
        ? !row["expired"]
        : selection.state !== "all" &&
          (row["state"] !== selection.state || row["expired"]))
    )
      throw new TypeError("Invalid approval discovery row");
    seen.add(row["id"]);
  }
  return v as unknown as ApprovalInboxPage;
}
