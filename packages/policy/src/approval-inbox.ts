import { ApprovalError, type ApprovalState } from "./approvals.js";
export const APPROVAL_INBOX_STATES = [
  "all",
  "pending",
  "approved",
  "issued",
  "rejected",
  "revoked",
  "consumed",
  "expired",
] as const;
export interface ApprovalInboxQuery {
  readonly lane?: "mine" | "review";
  readonly state?: (typeof APPROVAL_INBOX_STATES)[number];
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ApprovalInboxEntry {
  readonly id: string;
  readonly resource_id: string;
  readonly requester_id: string;
  readonly requested_name: string;
  readonly state: ApprovalState;
  readonly object_version: number;
  readonly resource_version: number;
  readonly expires_at: string;
  readonly expired: boolean;
}
export interface ApprovalInboxPage {
  readonly schema_version: "1.0.0";
  readonly org_id: string;
  readonly lane: "mine" | "review";
  readonly state_filter: (typeof APPROVAL_INBOX_STATES)[number];
  readonly observed_at: string;
  readonly authorization: false;
  readonly consistency: "creation-boundary-current-visibility";
  readonly entries: readonly ApprovalInboxEntry[];
  readonly next_cursor: string | null;
}
/** Copy primitives before asynchronous work. A discovery row is not a grant or an executable command. */
export function normalizeApprovalInboxQuery(q: ApprovalInboxQuery) {
  if (
    !q ||
    typeof q !== "object" ||
    Array.isArray(q) ||
    Object.keys(q).some(
      (k) => !["lane", "state", "limit", "cursor"].includes(k),
    ) ||
    (q.lane !== undefined && !["mine", "review"].includes(q.lane)) ||
    (q.state !== undefined && !APPROVAL_INBOX_STATES.includes(q.state)) ||
    (q.limit !== undefined &&
      (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 50)) ||
    (q.cursor !== undefined &&
      (typeof q.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{40,1024}$/.test(q.cursor)))
  )
    throw new ApprovalError("invalid_input");
  return Object.freeze({
    lane: q.lane ?? "mine",
    state: q.state ?? "all",
    limit: q.limit ?? 20,
    ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
  });
}
