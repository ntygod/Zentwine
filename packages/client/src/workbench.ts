import {
  parseWorkbenchSession,
  parseWorkbenchMember,
  parseWorkbenchSettings,
  parseWorkbenchCatalog,
  organizationWorkbenchPath,
  workbenchNavigation,
  type WorkbenchSession,
  type WorkbenchMember,
  type WorkbenchSettings,
  type WorkbenchCatalogItem,
  type WorkbenchView,
} from "@zentwine/contracts";
export type WorkbenchState =
  | { status: "loading" | "disabled" | "anonymous" | "suspended" }
  | { status: "error"; code: string }
  | { status: "choose"; auth: WorkbenchSession; requested: string | null }
  | {
      status: "ready";
      auth: WorkbenchSession;
      org: string;
      member: WorkbenchMember;
      resources: WorkbenchCatalogItem[];
      settings: WorkbenchSettings | null;
    };
class Failure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
/** One window/route, one request generation, NO tenant cache or persistent credentials. */
export class WorkbenchController {
  #state: WorkbenchState = { status: "loading" };
  #epoch = 0;
  #abort: AbortController | null = null;
  #listeners = new Set<() => void>();
  constructor(
    private readonly org: string | null,
    private readonly view: WorkbenchView,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (org !== null) organizationWorkbenchPath(org, view);
    else if (view !== "overview") throw new TypeError("Invalid entry route");
  }
  getSnapshot = (): WorkbenchState => this.#state;
  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };
  private publish(state: WorkbenchState) {
    this.#state = freeze(state);
    this.#listeners.forEach((fn) => fn());
  }
  private begin() {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const epoch = ++this.#epoch,
      signal = this.#abort.signal;
    this.publish({ status: "loading" }); // Remove old names, inputs, results and nav BEFORE any async work.
    return { epoch, signal };
  }
  suspend = () => {
    ++this.#epoch;
    this.#abort?.abort();
    this.publish({ status: "suspended" });
  };
  private async json(
    path: string,
    signal: AbortSignal,
    auth?: WorkbenchSession,
    body?: unknown,
  ): Promise<unknown> {
    try {
      const response = await this.fetcher(path, {
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
      if (response.status === 204 && body !== undefined) return null;
      const text = await response.text();
      if (text.length > 1048576) throw new Failure("invalid_response");
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Failure("invalid_response");
      }
      if (!response.ok) {
        const code = object(data) ? data["code"] : null;
        throw new Failure(
          typeof code === "string" &&
          [
            "authentication_required",
            "unavailable_resource",
            "forbidden",
            "version_conflict",
            "invalid_input",
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
  private failed(e: unknown, epoch: number) {
    if (epoch !== this.#epoch) return;
    this.publish(
      e instanceof Failure && e.code === "authentication_required"
        ? { status: "anonymous" }
        : {
            status: "error",
            code: e instanceof Failure ? e.code : "invalid_response",
          },
    );
  }
  reload = async (query = ""): Promise<void> => {
    const { epoch, signal } = this.begin();
    try {
      if (
        typeof query !== "string" ||
        query.length > 120 ||
        /[\u0000-\u001f\u007f]/.test(query)
      )
        throw new Failure("invalid_input");
      const caps = await this.json(
        "/api/v1/system/organization-capabilities",
        signal,
      );
      if (
        !object(caps) ||
        caps["schema_version"] !== "1.0.0" ||
        typeof caps["enabled"] !== "boolean"
      )
        throw new Failure("invalid_response");
      if (!caps["enabled"]) {
        if (epoch === this.#epoch) this.publish({ status: "disabled" });
        return;
      }
      const auth = parseWorkbenchSession(
        await this.json("/api/v1/auth/session", signal),
      );
      if (epoch !== this.#epoch) return;
      if (!this.org || auth.session.active_org_id !== this.org) {
        if (
          this.org &&
          !auth.session.organizations.some((o) => o.id === this.org)
        )
          throw new Failure("unavailable_resource");
        this.publish({ status: "choose", auth, requested: this.org });
        return;
      }
      // Revalidate even if the session's organization list was just read. It is not an authorization grant.
      const base = `/api/v1/orgs/${this.org}`;
      const member = parseWorkbenchMember(
        await this.json(base + "/organization-self", signal, auth),
        auth,
      );
      if (!workbenchNavigation(member).includes(this.view))
        throw new Failure("forbidden");
      const resources =
        this.view === "catalog"
          ? parseWorkbenchCatalog(
              await this.json(
                base + "/catalog/search?q=" + encodeURIComponent(query),
                signal,
                auth,
              ),
            )
          : [];
      const settings =
        this.view === "governance"
          ? parseWorkbenchSettings(
              await this.json(base + "/settings", signal, auth),
              this.org,
            )
          : null;
      if (epoch === this.#epoch)
        this.publish({
          status: "ready",
          auth,
          org: this.org,
          member,
          resources,
          settings,
        });
    } catch (e) {
      this.failed(e, epoch);
    }
  };
  switchOrganization = async (org: string): Promise<string | null> => {
    const previous = this.#state;
    if (previous.status !== "ready" && previous.status !== "choose")
      return null;
    const { epoch, signal } = this.begin();
    try {
      const path = organizationWorkbenchPath(org);
      if (!previous.auth.session.organizations.some((o) => o.id === org))
        throw new Failure("unavailable_resource");
      // Explicit command only. Unknown outcome is not automatically retried.
      const next = parseWorkbenchSession(
        await this.json("/api/v1/auth/organization", signal, previous.auth, {
          org_id: org,
          expected_version: previous.auth.session.context_version,
        }),
      );
      if (
        next.session.active_org_id !== org ||
        next.session.id !== previous.auth.session.id ||
        next.session.human.id !== previous.auth.session.human.id ||
        next.session.context_version !==
          previous.auth.session.context_version + 1
      )
        throw new Failure("invalid_response");
      return epoch === this.#epoch ? path : null;
    } catch (e) {
      this.failed(e, epoch);
      return null;
    }
  };
  logout = async (): Promise<void> => {
    const previous = this.#state;
    if (previous.status !== "ready" && previous.status !== "choose") return;
    const { epoch, signal } = this.begin();
    try {
      await this.json("/api/v1/auth/logout", signal, previous.auth, {});
      if (epoch === this.#epoch) this.publish({ status: "anonymous" });
    } catch (e) {
      this.failed(e, epoch);
    }
  };
}
