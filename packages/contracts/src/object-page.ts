import {
  organizationWorkbenchPath,
  type WorkbenchMember,
} from "./workbench.js";
import { policyResourceSchema, policyDecisionSchema } from "./policy.js";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2147483646;
const timestamp = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function exact(
  v: unknown,
  keys: readonly string[],
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new TypeError("Invalid object response");
}
/** Locator only. Authorization is rechecked by the existing resource endpoint. */
export function resourceObjectPath(org: string, id: string): string {
  if (!uuid(id)) throw new TypeError("Invalid resource location");
  return organizationWorkbenchPath(org) + "/objects/" + id;
}
export function parseResourceObjectPath(
  path: string,
): { org: string; id: string } | null {
  const m = /^\/org\/([^/]+)\/workbench\/objects\/([^/]+)$/.exec(path);
  return m && uuid(m[1]) && uuid(m[2]) ? { org: m[1], id: m[2] } : null;
}
export interface ResourceObjectSnapshot {
  resource: {
    id: string;
    org_id: string;
    kind: (typeof policyResourceSchema.properties.kind.enum)[number];
    display_name: string;
    visibility: "organization" | "restricted";
    environment: "development" | "staging" | "production";
    sensitivity: "internal" | "confidential";
    owner_human_id: string | null;
    status: "active";
    object_version: number;
  };
  decision: {
    schema_version: "1.0.0";
    outcome: "allow";
    reason: "allowed";
    policy_version: "1.0.0";
    policy_revision: number;
    membership_version: number;
    resource_version: number;
    evaluated_at: string;
    expires_at: string;
    reusable: false;
  };
}
/** Strict projection of a successful GET, not an approval, capability token or content revision. */
export function parseResourceObjectSnapshot(
  v: unknown,
  org: string,
  id: string,
  member: WorkbenchMember,
): ResourceObjectSnapshot {
  resourceObjectPath(org, id);
  exact(v, ["resource", "decision"]);
  const r = v["resource"],
    d = v["decision"];
  exact(r, policyResourceSchema.required);
  exact(d, policyDecisionSchema.required);
  if (
    r["org_id"] !== org ||
    r["id"] !== id ||
    !policyResourceSchema.properties.kind.enum.includes(
      r["kind"] as ResourceObjectSnapshot["resource"]["kind"],
    ) ||
    typeof r["display_name"] !== "string" ||
    r["display_name"].length < 1 ||
    r["display_name"].length > 120 ||
    /[\u0000-\u001f\u007f]/.test(r["display_name"]) ||
    !["organization", "restricted"].includes(String(r["visibility"])) ||
    !["development", "staging", "production"].includes(
      String(r["environment"]),
    ) ||
    !["internal", "confidential"].includes(String(r["sensitivity"])) ||
    !(r["owner_human_id"] === null || uuid(r["owner_human_id"])) ||
    r["status"] !== "active" ||
    !integer(r["object_version"]) ||
    d["schema_version"] !== "1.0.0" ||
    d["policy_version"] !== "1.0.0" ||
    d["outcome"] !== "allow" ||
    d["reason"] !== "allowed" ||
    d["reusable"] !== false ||
    !integer(d["policy_revision"]) ||
    !integer(d["membership_version"]) ||
    d["membership_version"] !== member.object_version ||
    d["resource_version"] !== r["object_version"] ||
    !timestamp(d["evaluated_at"]) ||
    !timestamp(d["expires_at"]) ||
    Date.parse(d["expires_at"]) <= Date.parse(d["evaluated_at"])
  )
    throw new TypeError("Invalid resource snapshot");
  return v as unknown as ResourceObjectSnapshot;
}
