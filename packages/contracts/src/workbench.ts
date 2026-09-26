/** Browser navigation and strict projections of EXISTING organization endpoints. Paths never grant authority. */
export const ORGANIZATIONS_PATH = "/org/local/workbench/organizations";
export type WorkbenchView = "overview" | "catalog" | "governance";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
export function organizationWorkbenchPath(
  org: string,
  view: WorkbenchView = "overview",
): string {
  if (!uuid(org) || !["overview", "catalog", "governance"].includes(view))
    throw new TypeError("Invalid workbench location");
  return `/org/${org}/workbench${view === "overview" ? "" : "/" + view}`;
}
export function parseOrganizationWorkbenchPath(
  path: string,
): { org: string | null; view: WorkbenchView } | null {
  if (path === ORGANIZATIONS_PATH) return { org: null, view: "overview" };
  const match = /^\/org\/([^/]+)\/workbench(?:\/(catalog|governance))?$/.exec(
    path,
  );
  return match && uuid(match[1])
    ? { org: match[1], view: (match[2] ?? "overview") as WorkbenchView }
    : null;
}
export interface WorkbenchSession {
  schema_version: "1.0.0";
  csrf_token: string;
  session: {
    id: string;
    human: { id: string; display_name: string };
    expires_at: string;
    context_version: number;
    active_org_id: string | null;
    organizations: { id: string; display_name: string }[];
  };
}
export interface WorkbenchMember {
  id: string;
  human_id: string;
  display_name: string;
  display_number: string;
  role: "owner" | "member" | "viewer";
  access_kind: "member" | "guest";
  access_expires_at: string | null;
  status: "active";
  object_version: number;
  managed_by_connection: boolean;
}
export interface WorkbenchSettings {
  org_id: string;
  display_name: string;
  locale: "zh-CN" | "en";
  time_zone: string;
  invitations_enabled: boolean;
  invite_ttl_hours: number;
  guest_ttl_days: number;
  object_version: number;
}
export interface WorkbenchCatalogItem {
  id: string;
  display_name: string;
  kind: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 120): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown, min = 1, max = 2147483646) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const date = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
function exact(
  v: unknown,
  keys: string[],
): asserts v is Record<string, unknown> {
  if (
    !record(v) ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new TypeError("Invalid workbench response");
}
export function parseWorkbenchSession(v: unknown): WorkbenchSession {
  exact(v, ["schema_version", "csrf_token", "session"]);
  const s = v["session"];
  exact(s, [
    "id",
    "human",
    "expires_at",
    "context_version",
    "active_org_id",
    "organizations",
  ]);
  const h = s["human"];
  exact(h, ["id", "display_name"]);
  if (
    v["schema_version"] !== "1.0.0" ||
    typeof v["csrf_token"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v["csrf_token"]) ||
    !uuid(s["id"]) ||
    !uuid(h["id"]) ||
    !text(h["display_name"]) ||
    !date(s["expires_at"]) ||
    !integer(s["context_version"]) ||
    (s["active_org_id"] !== null && !uuid(s["active_org_id"])) ||
    !Array.isArray(s["organizations"]) ||
    s["organizations"].length > 100
  )
    throw new TypeError("Invalid workbench session");
  const seen = new Set<string>();
  for (const org of s["organizations"]) {
    exact(org, ["id", "display_name"]);
    if (!uuid(org["id"]) || !text(org["display_name"]) || seen.has(org["id"]))
      throw new TypeError("Invalid organization choice");
    seen.add(org["id"]);
  }
  // A revoked selected organization may legitimately be absent. Never turn that stale selection into access.
  return v as unknown as WorkbenchSession;
}
export function parseWorkbenchMember(
  v: unknown,
  auth: WorkbenchSession,
): WorkbenchMember {
  exact(v, [
    "id",
    "human_id",
    "display_name",
    "display_number",
    "role",
    "access_kind",
    "access_expires_at",
    "status",
    "object_version",
    "managed_by_connection",
  ]);
  if (
    !uuid(v["id"]) ||
    v["human_id"] !== auth.session.human.id ||
    !text(v["display_name"]) ||
    typeof v["display_number"] !== "string" ||
    !/^MEM-[1-9][0-9]{0,8}$/.test(v["display_number"]) ||
    !["owner", "member", "viewer"].includes(String(v["role"])) ||
    !["member", "guest"].includes(String(v["access_kind"])) ||
    v["status"] !== "active" ||
    !integer(v["object_version"]) ||
    typeof v["managed_by_connection"] !== "boolean" ||
    (v["access_expires_at"] !== null && !date(v["access_expires_at"])) ||
    (v["access_kind"] === "guest" && v["role"] !== "viewer")
  )
    throw new TypeError("Invalid current membership");
  return v as unknown as WorkbenchMember;
}
export function parseWorkbenchSettings(
  v: unknown,
  org: string,
): WorkbenchSettings {
  exact(v, [
    "org_id",
    "display_name",
    "locale",
    "time_zone",
    "invitations_enabled",
    "invite_ttl_hours",
    "guest_ttl_days",
    "object_version",
  ]);
  if (
    v["org_id"] !== org ||
    !uuid(org) ||
    !text(v["display_name"]) ||
    !["zh-CN", "en"].includes(String(v["locale"])) ||
    !text(v["time_zone"], 80) ||
    typeof v["invitations_enabled"] !== "boolean" ||
    !integer(v["invite_ttl_hours"], 1, 168) ||
    !integer(v["guest_ttl_days"], 1, 30) ||
    !integer(v["object_version"])
  )
    throw new TypeError("Invalid organization settings");
  return v as unknown as WorkbenchSettings;
}
export function parseWorkbenchCatalog(v: unknown): WorkbenchCatalogItem[] {
  if (!Array.isArray(v) || v.length > 20)
    throw new TypeError("Invalid resource page");
  const seen = new Set<string>();
  for (const item of v) {
    exact(item, ["id", "display_name", "kind"]);
    if (
      !uuid(item["id"]) ||
      seen.has(item["id"]) ||
      !text(item["display_name"]) ||
      typeof item["kind"] !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(item["kind"])
    )
      throw new TypeError("Invalid resource entry");
    seen.add(item["id"]);
  }
  return v as WorkbenchCatalogItem[];
}
export function workbenchNavigation(
  member: WorkbenchMember,
): readonly WorkbenchView[] {
  return member.status === "active" &&
    member.role === "owner" &&
    member.access_kind === "member"
    ? ["overview", "catalog", "governance"]
    : ["overview", "catalog"];
}
