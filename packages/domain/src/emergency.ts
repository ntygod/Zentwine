import { OrganizationError } from "./organizations.js";
import { isIdentityId, isContextVersion } from "./identity.js";
/** Organization-local containment. Releasing a hold is not restoration of old credentials. */
export interface EmergencyInput {
  readonly request_id: string;
  readonly action: "hold" | "release";
  readonly reason: "suspected_compromise" | "access_review" | "incident_contained";
  readonly confirm_human_id: string;
  readonly expected_version: number;
  readonly expected_member_version: number;
}
export interface EmergencyState {
  readonly org_id: string;
  readonly member_id: string;
  readonly human_id: string;
  readonly held: boolean;
  readonly version: number;
  readonly member_version: number;
  readonly membership_status: "active" | "revoked";
}
export interface EmergencyReceipt {
  readonly request_id: string;
  readonly member_id: string;
  readonly human_id: string;
  readonly actor_id: string;
  readonly action: EmergencyInput["action"];
  readonly reason: EmergencyInput["reason"];
  readonly version: number;
  readonly occurred_at: string;
}
export interface EmergencyResult {
  readonly receipt: EmergencyReceipt;
  readonly current: EmergencyState;
  readonly replayed: boolean;
}
export function validateEmergencyInput(i: EmergencyInput): void {
  const keys = ["request_id", "action", "reason", "confirm_human_id", "expected_version", "expected_member_version"];
  if (!i || typeof i !== "object" || Array.isArray(i) ||
    Object.keys(i).length !== keys.length || Object.keys(i).some((k) => !keys.includes(k)) ||
    !isIdentityId(i.request_id) || !isIdentityId(i.confirm_human_id) ||
    !Number.isInteger(i.expected_version) || i.expected_version < 0 || i.expected_version > 2147483645 ||
    !isContextVersion(i.expected_member_version) ||
    !(i.action === "hold" && ["suspected_compromise", "access_review"].includes(i.reason) ||
      i.action === "release" && i.reason === "incident_contained"))
    throw new OrganizationError("invalid_input");
}
