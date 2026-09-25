/** Additive read-only organization lifecycle projection. No raw event payloads or global counters. */
export const organizationAuditKinds = [
  "settings.updated",
  "member.updated",
  "sessions.revoked",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "connection.updated",
  "identity.linked",
  "identity.provisioned",
] as const;
export type OrganizationAuditKind = (typeof organizationAuditKinds)[number];
export interface OrganizationAuditEntry {
  reference: string;
  occurred_at: string;
  kind: OrganizationAuditKind;
  actor_kind: "human" | "identity_connection";
  actor_id: string;
  subject_kind:
    | "organization"
    | "membership"
    | "human"
    | "invitation"
    | "identity_connection"
    | "external_identity";
  subject_id: string;
}
export interface OrganizationAuditPage {
  schema_version: "1.0.0";
  org_id: string;
  scope: "organization-lifecycle-only";
  complete_ledger: false;
  snapshot_at: string;
  entries: OrganizationAuditEntry[];
  next_cursor: string | null;
}
const idPattern =
  "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$";
const id = { type: "string", pattern: idPattern } as const;
const cursor = {
  type: "string",
  minLength: 40,
  maxLength: 1024,
  pattern: "^[A-Za-z0-9_-]+$",
} as const;
const date = { type: "string", format: "date-time" } as const;
const shape = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const organizationAuditQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["all", ...organizationAuditKinds] },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    cursor,
  },
} as const;
export const organizationAuditEntrySchema = shape({
  reference: id,
  occurred_at: date,
  kind: { enum: organizationAuditKinds },
  actor_kind: { enum: ["human", "identity_connection"] },
  actor_id: id,
  subject_kind: {
    enum: [
      "organization",
      "membership",
      "human",
      "invitation",
      "identity_connection",
      "external_identity",
    ],
  },
  subject_id: id,
});
export const organizationAuditPageSchema = shape({
  schema_version: { const: "1.0.0" },
  org_id: id,
  scope: { const: "organization-lifecycle-only" },
  complete_ledger: { const: false },
  snapshot_at: date,
  entries: { type: "array", maxItems: 50, items: organizationAuditEntrySchema },
  next_cursor: { anyOf: [cursor, { type: "null" }] },
});
const subjects: Record<
  OrganizationAuditKind,
  OrganizationAuditEntry["subject_kind"]
> = {
  "settings.updated": "organization",
  "member.updated": "membership",
  "sessions.revoked": "human",
  "invitation.created": "invitation",
  "invitation.accepted": "invitation",
  "invitation.revoked": "invitation",
  "connection.updated": "identity_connection",
  "identity.linked": "external_identity",
  "identity.provisioned": "external_identity",
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string =>
  typeof v === "string" && new RegExp(idPattern).test(v);
const isDate = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
/** Strict browser-side decoding; rejects a valid-looking page belonging to a different organization. */
export function parseOrganizationAuditPage(
  value: unknown,
  org: string,
): OrganizationAuditPage {
  if (
    !isObject(value) ||
    !exact(value, [
      "schema_version",
      "org_id",
      "scope",
      "complete_ledger",
      "snapshot_at",
      "entries",
      "next_cursor",
    ]) ||
    value["schema_version"] !== "1.0.0" ||
    !isId(value["org_id"]) ||
    value["org_id"] !== org ||
    value["scope"] !== "organization-lifecycle-only" ||
    value["complete_ledger"] !== false ||
    !isDate(value["snapshot_at"]) ||
    !Array.isArray(value["entries"]) ||
    value["entries"].length > 50 ||
    (value["next_cursor"] !== null &&
      (typeof value["next_cursor"] !== "string" ||
        !/^[A-Za-z0-9_-]{40,1024}$/.test(value["next_cursor"])))
  )
    throw new TypeError("Invalid audit page");
  const seen = new Set<string>();
  for (const entry of value["entries"]) {
    if (
      !isObject(entry) ||
      !exact(entry, [
        "reference",
        "occurred_at",
        "kind",
        "actor_kind",
        "actor_id",
        "subject_kind",
        "subject_id",
      ]) ||
      !isId(entry["reference"]) ||
      seen.has(entry["reference"]) ||
      !isDate(entry["occurred_at"]) ||
      !organizationAuditKinds.includes(
        entry["kind"] as OrganizationAuditKind,
      ) ||
      !isId(entry["actor_id"]) ||
      !isId(entry["subject_id"]) ||
      entry["subject_kind"] !==
        subjects[entry["kind"] as OrganizationAuditKind] ||
      entry["actor_kind"] !==
        (["identity.linked", "identity.provisioned"].includes(
          String(entry["kind"]),
        )
          ? "identity_connection"
          : "human")
    )
      throw new TypeError("Invalid audit entry");
    seen.add(entry["reference"]);
  }
  if (value["entries"].length === 0 && value["next_cursor"] !== null)
    throw new TypeError("Invalid audit continuation");
  return value as unknown as OrganizationAuditPage;
}
