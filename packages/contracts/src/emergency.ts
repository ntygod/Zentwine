/** Wire projection has no credentials, raw input or free-form incident narrative. */
export interface EmergencyState {
  org_id: string;
  member_id: string;
  human_id: string;
  held: boolean;
  version: number;
  member_version: number;
  membership_status: "active" | "revoked";
}
export interface EmergencyReceipt {
  request_id: string;
  member_id: string;
  human_id: string;
  actor_id: string;
  action: "hold" | "release";
  reason: "suspected_compromise" | "access_review" | "incident_contained";
  version: number;
  occurred_at: string;
}
export interface EmergencyResult {
  receipt: EmergencyReceipt;
  current: EmergencyState;
  replayed: boolean;
}
const pattern =
  "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$";
const id = { type: "string", pattern } as const;
const version = { type: "integer", minimum: 0, maximum: 2147483646 } as const;
const shape = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const emergencyInputSchema = shape({
  request_id: id,
  action: { enum: ["hold", "release"] },
  reason: {
    enum: ["suspected_compromise", "access_review", "incident_contained"],
  },
  confirm_human_id: id,
  expected_version: { ...version, maximum: 2147483645 },
  expected_member_version: { ...version, minimum: 1 },
});
export const emergencyStateSchema = shape({
  org_id: id,
  member_id: id,
  human_id: id,
  held: { type: "boolean" },
  version,
  member_version: { ...version, minimum: 1 },
  membership_status: { enum: ["active", "revoked"] },
});
export const emergencyResultSchema = shape({
  receipt: shape({
    request_id: id,
    member_id: id,
    human_id: id,
    actor_id: id,
    action: { enum: ["hold", "release"] },
    reason: {
      enum: ["suspected_compromise", "access_review", "incident_contained"],
    },
    version: { ...version, minimum: 1 },
    occurred_at: { type: "string", format: "date-time" },
  }),
  current: emergencyStateSchema,
  replayed: { type: "boolean" },
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" && new RegExp(pattern).test(v);
const integer = (v: unknown, min: number): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= 2147483646;
const exact = (v: Record<string, unknown>, schema: ReturnType<typeof shape>) =>
  Object.keys(v).length === schema.required.length &&
  Object.keys(v).every((k) => schema.required.includes(k));
export function parseEmergencyState(
  v: unknown,
  org: string,
  member: string,
): EmergencyState {
  if (
    !object(v) ||
    !exact(v, emergencyStateSchema) ||
    !uuid(v["org_id"]) ||
    v["org_id"] !== org ||
    !uuid(v["member_id"]) ||
    v["member_id"] !== member ||
    !uuid(v["human_id"]) ||
    typeof v["held"] !== "boolean" ||
    !integer(v["version"], v["held"] ? 1 : 0) ||
    !integer(v["member_version"], 1) ||
    !["active", "revoked"].includes(String(v["membership_status"]))
  )
    throw new TypeError("Invalid emergency state");
  return v as unknown as EmergencyState;
}
export function parseEmergencyResult(
  v: unknown,
  org: string,
  member: string,
): EmergencyResult {
  if (
    !object(v) ||
    !exact(v, emergencyResultSchema) ||
    typeof v["replayed"] !== "boolean"
  )
    throw new TypeError("Invalid emergency result");
  const current = parseEmergencyState(v["current"], org, member),
    receipt = v["receipt"];
  if (
    !object(receipt) ||
    !exact(
      receipt,
      emergencyResultSchema.properties.receipt as ReturnType<typeof shape>,
    ) ||
    !uuid(receipt["request_id"]) ||
    !uuid(receipt["actor_id"]) ||
    receipt["member_id"] !== member ||
    receipt["human_id"] !== current.human_id ||
    !integer(receipt["version"], 1) ||
    Number(receipt["version"]) > current.version ||
    typeof receipt["occurred_at"] !== "string" ||
    !Number.isFinite(Date.parse(receipt["occurred_at"])) ||
    !(
      (receipt["action"] === "hold" &&
        ["suspected_compromise", "access_review"].includes(
          String(receipt["reason"]),
        )) ||
      (receipt["action"] === "release" &&
        receipt["reason"] === "incident_contained")
    ) ||
    (!v["replayed"] &&
      (receipt["version"] !== current.version ||
        (receipt["action"] === "hold") !== current.held))
  )
    throw new TypeError("Invalid emergency receipt");
  return v as unknown as EmergencyResult;
}
