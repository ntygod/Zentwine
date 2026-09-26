import {
  organizationWorkbenchPath,
  type WorkbenchMember,
} from "./workbench.js";
import { policyResourceSchema } from "./policy.js";
import type { ResourceObjectSnapshot } from "./object-page.js";
/** Existing catalog.rename approval protocol. NOT the unimplemented content revision/CAS API. */
export type CatalogApprovalRoute = {
  org: string;
  mode: "request" | "inspect";
  id: string;
};
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
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const catalogApprovalName = (v: unknown): v is string =>
  typeof v === "string" &&
  !!v.trim() &&
  v.length <= 120 &&
  !/[\u0000-\u001f\u007f]/.test(v);
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
    throw new TypeError("Invalid catalog approval response");
}
export function catalogApprovalPath(
  org: string,
  mode: CatalogApprovalRoute["mode"],
  id: string,
): string {
  if (!uuid(id) || !["request", "inspect"].includes(mode))
    throw new TypeError("Invalid approval location");
  return (
    organizationWorkbenchPath(org) +
    (mode === "request" ? "/objects/" + id + "/rename" : "/approvals/" + id)
  );
}
export function parseCatalogApprovalPath(
  path: string,
): CatalogApprovalRoute | null {
  const m =
    /^\/org\/([^/]+)\/workbench\/(?:objects\/([^/]+)\/rename|approvals\/([^/]+))$/.exec(
      path,
    );
  if (!m || !uuid(m[1]) || !uuid(m[2] ?? m[3])) return null;
  return { org: m[1], mode: m[2] ? "request" : "inspect", id: (m[2] ?? m[3])! };
}
export interface CatalogApproval {
  id: string;
  org_id: string;
  requester_id: string;
  object_version: number;
  state:
    | "pending"
    | "approved"
    | "issued"
    | "rejected"
    | "revoked"
    | "consumed";
  content_hash: string;
  binding: {
    schema_version: "1.0.0";
    canonicalization_version: "sorted-json-v1";
    org_id: string;
    requester_id: string;
    operation: "catalog.rename";
    action: "resource.update";
    resource_id: string;
    resource_version: number;
    environment: "development" | "staging" | "production";
    display_name: string;
    policy_revision: number;
    auth_version: number;
    membership_version: number;
    organization_version: number;
  };
  expires_at: string;
  decision: null | {
    actor_id: string;
    source: "human" | "preauthorized_policy";
    outcome: "approve" | "reject";
  };
  receipt: null | {
    resource: ResourceObjectSnapshot["resource"];
    content_hash: string;
    approval_id: string;
  };
  reusable: false;
}
export function parseCatalogApproval(
  v: unknown,
  org: string,
  id?: string,
): CatalogApproval {
  organizationWorkbenchPath(org);
  exact(v, [
    "id",
    "org_id",
    "requester_id",
    "object_version",
    "state",
    "content_hash",
    "binding",
    "expires_at",
    "decision",
    "receipt",
    "reusable",
  ]);
  const b = v["binding"],
    d = v["decision"],
    r = v["receipt"],
    state = v["state"];
  exact(b, [
    "schema_version",
    "canonicalization_version",
    "org_id",
    "requester_id",
    "operation",
    "action",
    "resource_id",
    "resource_version",
    "environment",
    "display_name",
    "policy_revision",
    "auth_version",
    "membership_version",
    "organization_version",
  ]);
  if (
    !uuid(v["id"]) ||
    (id !== undefined && v["id"] !== id) ||
    v["org_id"] !== org ||
    !uuid(v["requester_id"]) ||
    !integer(v["object_version"]) ||
    !hash(v["content_hash"]) ||
    !timestamp(v["expires_at"]) ||
    v["reusable"] !== false ||
    ![
      "pending",
      "approved",
      "issued",
      "rejected",
      "revoked",
      "consumed",
    ].includes(String(state)) ||
    b["schema_version"] !== "1.0.0" ||
    b["canonicalization_version"] !== "sorted-json-v1" ||
    b["org_id"] !== org ||
    b["requester_id"] !== v["requester_id"] ||
    b["operation"] !== "catalog.rename" ||
    b["action"] !== "resource.update" ||
    !uuid(b["resource_id"]) ||
    !catalogApprovalName(b["display_name"]) ||
    !["development", "staging", "production"].includes(
      String(b["environment"]),
    ) ||
    ![
      "resource_version",
      "policy_revision",
      "auth_version",
      "membership_version",
      "organization_version",
    ].every((k) => integer(b[k]))
  )
    throw new TypeError("Invalid approval binding");
  if (d !== null) {
    exact(d, ["actor_id", "source", "outcome"]);
    if (
      !uuid(d["actor_id"]) ||
      !["approve", "reject"].includes(String(d["outcome"])) ||
      !(
        (d["source"] === "human" && d["actor_id"] !== v["requester_id"]) ||
        (d["source"] === "preauthorized_policy" &&
          d["actor_id"] === v["requester_id"] &&
          d["outcome"] === "approve")
      )
    )
      throw new TypeError("Invalid decision attribution");
  }
  if (
    (state === "pending" && d !== null) ||
    (["approved", "issued", "consumed"].includes(String(state)) &&
      (!d || d["outcome"] !== "approve")) ||
    (state === "rejected" && (!d || d["outcome"] !== "reject")) ||
    (state !== "consumed" && r !== null)
  )
    throw new TypeError("Inconsistent approval state");
  if (state === "consumed") {
    exact(r, ["resource", "content_hash", "approval_id"]);
    const resource = r["resource"];
    exact(resource, policyResourceSchema.required);
    if (
      r["approval_id"] !== v["id"] ||
      r["content_hash"] !== v["content_hash"] ||
      resource["id"] !== b["resource_id"] ||
      resource["org_id"] !== org ||
      resource["object_version"] !== Number(b["resource_version"]) + 1 ||
      !integer(resource["object_version"]) ||
      resource["display_name"] !== b["display_name"] ||
      resource["environment"] !== b["environment"] ||
      resource["status"] !== "active" ||
      !policyResourceSchema.properties.kind.enum.includes(
        resource["kind"] as ResourceObjectSnapshot["resource"]["kind"],
      ) ||
      !["organization", "restricted"].includes(
        String(resource["visibility"]),
      ) ||
      !["internal", "confidential"].includes(String(resource["sensitivity"])) ||
      !(resource["owner_human_id"] === null || uuid(resource["owner_human_id"]))
    )
      throw new TypeError("Invalid execution receipt");
  }
  return v as unknown as CatalogApproval;
}
/** Display affordances only. Every command is independently reauthorized by the existing server. */
export function catalogApprovalActions(
  a: CatalogApproval,
  member: WorkbenchMember,
): readonly ("approve" | "reject" | "execute" | "revoke")[] {
  if (
    member.access_kind !== "member" ||
    member.status !== "active" ||
    member.role === "viewer"
  )
    return [];
  const own = a.requester_id === member.human_id;
  if (!own && member.role !== "owner") return [];
  const out: ("approve" | "reject" | "execute" | "revoke")[] = [];
  if (a.state === "pending" && !own && member.role === "owner")
    out.push("approve", "reject");
  if (a.state === "approved" && own) out.push("execute");
  if (["pending", "approved", "issued"].includes(a.state)) out.push("revoke");
  return out;
}
