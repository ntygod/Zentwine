import {
  catalogApprovalPath,
  catalogApprovalName,
  catalogApprovalActions,
  parseCatalogApproval,
  parseWorkbenchSession,
  parseWorkbenchMember,
  parseResourceObjectSnapshot,
  type CatalogApproval,
  type CatalogApprovalRoute,
  type WorkbenchSession,
  type WorkbenchMember,
  type ResourceObjectSnapshot,
} from "@zentwine/contracts";
export type CatalogApprovalState =
  | { status: "loading" | "disabled" | "anonymous" | "suspended" }
  | { status: "error"; code: string; uncertain: boolean }
  | { status: "choose"; auth: WorkbenchSession }
  | {
      status: "ready";
      auth: WorkbenchSession;
      member: WorkbenchMember;
      resource: ResourceObjectSnapshot | null;
      approval: CatalogApproval | null;
      retryRequest: boolean;
      uncertain: boolean;
    };
type Ready = Extract<CatalogApprovalState, { status: "ready" }>;
type NewRequest = {
  request_id: string;
  resource_id: string;
  operation: "catalog.rename";
  display_name: string;
  expected_version: number;
  expected_policy_revision: number;
  review: "required";
};
class Failure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const freeze = <T>(v: T): T => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const sameSession = (a: WorkbenchSession, b: WorkbenchSession) =>
  a.session.id === b.session.id &&
  a.session.human.id === b.session.human.id &&
  a.session.active_org_id === b.session.active_org_id &&
  a.session.context_version === b.session.context_version;
function unchanged(a: CatalogApproval, b: CatalogApproval) {
  if (
    a.id !== b.id ||
    a.content_hash !== b.content_hash ||
    a.expires_at !== b.expires_at
  )
    throw new Failure("invalid_response");
}
const sameDecision = (a: CatalogApproval, b: CatalogApproval) =>
  a.decision?.actor_id === b.decision?.actor_id &&
  a.decision?.source === b.decision?.source &&
  a.decision?.outcome === b.decision?.outcome;
const definite = (e: unknown) =>
  e instanceof Failure &&
  [
    "authentication_required",
    "forbidden",
    "unavailable_resource",
    "invalid_input",
    "version_conflict",
    "approval_required",
    "rate_limited",
  ].includes(e.code);
/** The binding is flat sorted-json-v1, not the general content canonicalization format. */
export async function verifyCatalogApproval(
  v: unknown,
  org: string,
  id?: string,
): Promise<CatalogApproval> {
  const a = parseCatalogApproval(v, org, id);
  const binding = a.binding as unknown as Record<string, unknown>;
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.keys(binding)
        .sort()
        .map((k) => [k, binding[k]]),
    ),
  );
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const actual = Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== a.content_hash) throw new Failure("invalid_response");
  return freeze(a);
}
/** No persistent cache, write retry loop, permit exposure or effect on GET/refresh. */
export class CatalogApprovalController {
  #state: CatalogApprovalState = { status: "loading" };
  #epoch = 0;
  #abort: AbortController | null = null;
  #busy = false;
  #uncertain = false;
  #approvalId: string | null;
  #pending: { auth: WorkbenchSession; body: NewRequest } | null = null;
  #listeners = new Set<() => void>();
  constructor(
    private readonly route: CatalogApprovalRoute,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    catalogApprovalPath(route.org, route.mode, route.id);
    this.route = Object.freeze({ ...route });
    this.#approvalId = route.mode === "inspect" ? route.id : null;
  }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };
  private publish(s: CatalogApprovalState) {
    this.#state = freeze(s);
    this.#listeners.forEach((fn) => fn());
  }
  private begin() {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const epoch = ++this.#epoch,
      signal = this.#abort.signal;
    this.publish({ status: "loading" });
    return { epoch, signal };
  }
  suspend = () => {
    ++this.#epoch;
    this.#abort?.abort();
    this.publish({ status: "suspended" });
  };
  private check(epoch: number) {
    if (epoch !== this.#epoch) throw new Failure("superseded");
  }
  private async json(
    path: string,
    signal: AbortSignal,
    auth?: WorkbenchSession,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        headers: {
          ...(auth
            ? {
                "x-zentwine-context-version": String(
                  auth.session.context_version,
                ),
              }
            : {}),
          ...(body !== undefined && auth
            ? {
                "content-type": "application/json",
                "x-zentwine-client": "web",
                "x-zentwine-csrf": auth.csrf_token,
              }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.redirected) throw new Failure("invalid_response");
      const text = await response.text();
      if (text.length > 1048576) throw new Failure("invalid_response");
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Failure("invalid_response");
      }
      if (!response.ok) {
        const code = record(data) ? data["code"] : null;
        throw new Failure(
          typeof code === "string" &&
          [
            "authentication_required",
            "forbidden",
            "unavailable_resource",
            "invalid_input",
            "version_conflict",
            "approval_required",
            "rate_limited",
          ].includes(code)
            ? code
            : "unavailable",
        );
      }
      return data;
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure("network_unavailable");
    }
  }
  private failure(e: unknown, epoch: number) {
    if (epoch !== this.#epoch) return;
    if (e instanceof Failure && e.code === "authentication_required") {
      this.#pending = null;
      this.publish({ status: "anonymous" });
    } else
      this.publish({
        status: "error",
        code: e instanceof Failure ? e.code : "invalid_response",
        uncertain: this.#uncertain,
      });
  }
  private path(id = this.#approvalId) {
    return `/api/v1/orgs/${this.route.org}/approvals${id ? "/" + id : ""}`;
  }
  reload = async (): Promise<void> => {
    const { epoch, signal } = this.begin();
    try {
      const cap = await this.json(
        "/api/v1/system/organization-capabilities",
        signal,
      );
      this.check(epoch);
      if (
        !record(cap) ||
        cap["schema_version"] !== "1.0.0" ||
        typeof cap["enabled"] !== "boolean"
      )
        throw new Failure("invalid_response");
      if (!cap["enabled"]) {
        this.publish({ status: "disabled" });
        return;
      }
      const auth = parseWorkbenchSession(
        await this.json("/api/v1/auth/session", signal),
      );
      this.check(epoch);
      if (this.#pending && !sameSession(this.#pending.auth, auth))
        this.#pending = null;
      if (auth.session.active_org_id !== this.route.org) {
        if (!auth.session.organizations.some((o) => o.id === this.route.org))
          throw new Failure("unavailable_resource");
        this.publish({ status: "choose", auth });
        return;
      }
      const member = parseWorkbenchMember(
        await this.json(
          `/api/v1/orgs/${this.route.org}/organization-self`,
          signal,
          auth,
        ),
        auth,
      );
      this.check(epoch);
      if (member.access_kind !== "member" || member.role === "viewer")
        throw new Failure("forbidden");
      const approval = this.#approvalId
        ? await verifyCatalogApproval(
            await this.json(this.path(), signal, auth),
            this.route.org,
            this.#approvalId,
          )
        : null;
      this.check(epoch);
      const resource = approval
        ? null
        : parseResourceObjectSnapshot(
            await this.json(
              `/api/v1/orgs/${this.route.org}/resources/${this.route.id}`,
              signal,
              auth,
            ),
            this.route.org,
            this.route.id,
            member,
          );
      this.check(epoch);
      // A read can reconcile a known command, never issue a new permit or execute it.
      if (approval) this.#uncertain = false;
      this.publish({
        status: "ready",
        auth,
        member,
        resource,
        approval,
        retryRequest: this.#pending !== null,
        uncertain: this.#uncertain,
      });
    } catch (e) {
      this.failure(e, epoch);
    }
  };
  switchOrganization = async (): Promise<void> => {
    const previous = this.#state;
    if (previous.status !== "choose" || this.#busy) return;
    this.#busy = true;
    const { epoch, signal } = this.begin();
    try {
      const next = parseWorkbenchSession(
        await this.json("/api/v1/auth/organization", signal, previous.auth, {
          org_id: this.route.org,
          expected_version: previous.auth.session.context_version,
        }),
      );
      this.check(epoch);
      if (
        next.session.active_org_id !== this.route.org ||
        next.session.id !== previous.auth.session.id ||
        next.session.human.id !== previous.auth.session.human.id ||
        next.session.context_version !==
          previous.auth.session.context_version + 1
      )
        throw new Failure("invalid_response");
      this.#pending = null;
      await this.reload();
    } catch (e) {
      this.failure(e, epoch);
    } finally {
      this.#busy = false;
    }
  };
  private async write(
    work: (
      s: Ready,
      signal: AbortSignal,
      epoch: number,
    ) => Promise<CatalogApproval>,
  ): Promise<string | null> {
    const previous = this.#state;
    if (previous.status !== "ready" || this.#busy) return null;
    this.#busy = true;
    const { epoch, signal } = this.begin();
    this.#uncertain = true;
    try {
      const a = await work(previous, signal, epoch);
      this.check(epoch);
      this.#approvalId = a.id;
      this.#pending = null;
      this.#uncertain = false;
      this.publish({
        ...previous,
        resource: null,
        approval: a,
        retryRequest: false,
        uncertain: false,
      });
      return catalogApprovalPath(this.route.org, "inspect", a.id);
    } catch (e) {
      this.failure(e, epoch);
      return null;
    } finally {
      this.#busy = false;
    }
  }
  request = async (name: string): Promise<string | null> =>
    this.write(async (s, signal, epoch) => {
      if (s.uncertain && !this.#pending) throw new Failure("version_conflict");
      if (
        s.approval ||
        !s.resource ||
        this.#pending ||
        !catalogApprovalName(name)
      ) {
        this.#uncertain = false;
        throw new Failure("invalid_input");
      }
      const body: NewRequest = Object.freeze({
        request_id: globalThis.crypto.randomUUID(),
        resource_id: s.resource.resource.id,
        operation: "catalog.rename",
        display_name: name,
        expected_version: s.resource.resource.object_version,
        expected_policy_revision: s.resource.decision.policy_revision,
        review: "required",
      });
      this.#pending = { auth: s.auth, body };
      return this.submitRequest(s, signal, epoch, body);
    });
  private async submitRequest(
    s: Ready,
    signal: AbortSignal,
    epoch: number,
    body: NewRequest,
  ): Promise<CatalogApproval> {
    let raw: unknown;
    try {
      raw = await this.json(this.path(null), signal, s.auth, body);
    } catch (e) {
      if (definite(e)) {
        this.#pending = null;
        this.#uncertain = false;
      }
      throw e;
    }
    this.check(epoch);
    const a = await verifyCatalogApproval(raw, this.route.org);
    if (
      a.requester_id !== s.auth.session.human.id ||
      a.binding.resource_id !== body.resource_id ||
      a.binding.resource_version !== body.expected_version ||
      a.binding.policy_revision !== body.expected_policy_revision ||
      a.binding.display_name !== body.display_name ||
      a.decision?.source === "preauthorized_policy"
    )
      throw new Failure("invalid_response");
    return a;
  }
  retryRequest = async (): Promise<string | null> =>
    this.write(async (s, signal, epoch) => {
      const pending = this.#pending;
      if (!pending || !sameSession(pending.auth, s.auth)) {
        this.#pending = null;
        throw new Failure("version_conflict");
      }
      return this.submitRequest(s, signal, epoch, pending.body);
    });
  command = async (
    action: "approve" | "reject" | "execute" | "revoke",
  ): Promise<string | null> =>
    this.write(async (s, signal, epoch) => {
      const a = s.approval;
      if (!a || !catalogApprovalActions(a, s.member).includes(action)) {
        this.#uncertain = false;
        throw new Failure("forbidden");
      }
      const guard = {
        expected_version: a.object_version,
        content_hash: a.content_hash,
      };
      if (action !== "execute") {
        let raw: unknown;
        try {
          raw = await this.json(
            this.path(a.id) + (action === "revoke" ? "/revoke" : "/decide"),
            signal,
            s.auth,
            action === "revoke" ? guard : { ...guard, outcome: action },
          );
        } catch (e) {
          if (definite(e)) this.#uncertain = false;
          throw e;
        }
        this.check(epoch);
        const next = await verifyCatalogApproval(raw, this.route.org, a.id);
        unchanged(a, next);
        if (action === "revoke" && !sameDecision(a, next))
          throw new Failure("invalid_response");
        if (
          next.object_version !== a.object_version + 1 ||
          next.state !==
            (
              {
                approve: "approved",
                reject: "rejected",
                revoke: "revoked",
              } as const
            )[action] ||
          (action !== "revoke" &&
            (next.decision?.actor_id !== s.member.human_id ||
              next.decision.source !== "human" ||
              next.decision.outcome !== action))
        )
          throw new Failure("invalid_response");
        return next;
      }
      // Only this explicit user action may obtain and spend a permit. No token reaches state, URL or Storage.
      let permit = "";
      try {
        const raw = await this.json(
          this.path(a.id) + "/permit",
          signal,
          s.auth,
          guard,
        );
        this.check(epoch);
        if (
          !record(raw) ||
          Object.keys(raw).sort().join(",") !==
            "approval,credential_recoverable,expires_at,permit" ||
          raw["credential_recoverable"] !== false ||
          typeof raw["permit"] !== "string" ||
          !/^zt_permit_[A-Za-z0-9_-]{43}$/.test(raw["permit"]) ||
          typeof raw["expires_at"] !== "string" ||
          !Number.isFinite(Date.parse(raw["expires_at"])) ||
          Date.parse(raw["expires_at"]) > Date.parse(a.expires_at)
        )
          throw new Failure("invalid_response");
        const issued = await verifyCatalogApproval(
          raw["approval"],
          this.route.org,
          a.id,
        );
        this.check(epoch);
        unchanged(a, issued);
        if (
          issued.state !== "issued" ||
          issued.object_version !== a.object_version + 1 ||
          !sameDecision(issued, a)
        )
          throw new Failure("invalid_response");
        permit = raw["permit"];
        const result = await this.json(
          this.path(a.id) + "/execute",
          signal,
          s.auth,
          {
            expected_version: issued.object_version,
            content_hash: a.content_hash,
            resource_id: a.binding.resource_id,
            operation: a.binding.operation,
            display_name: a.binding.display_name,
            expected_resource_version: a.binding.resource_version,
            expected_policy_revision: a.binding.policy_revision,
            permit,
          },
        );
        this.check(epoch);
        const done = await verifyCatalogApproval(result, this.route.org, a.id);
        unchanged(a, done);
        if (
          done.state !== "consumed" ||
          done.object_version !== issued.object_version + 1 ||
          !sameDecision(done, a)
        )
          throw new Failure("invalid_response");
        return done;
      } finally {
        permit = "";
      }
    });
}
