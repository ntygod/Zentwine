import {
  approvalInboxPath,
  approvalInboxFilters,
  parseApprovalInboxPage,
  type ApprovalInboxSelection,
  type ApprovalInboxPage,
  type ApprovalInboxLane,
  type ApprovalInboxFilter,
  type WorkbenchSession,
  type WorkbenchMember,
} from "@zentwine/contracts";
import { WorkbenchController, type WorkbenchState } from "./workbench.js";
export type ApprovalInboxState =
  | Exclude<WorkbenchState, { status: "ready" }>
  | {
      status: "ready";
      auth: WorkbenchSession;
      member: WorkbenchMember;
      page: ApprovalInboxPage;
      selection: ApprovalInboxSelection;
    };
class Failure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
/** Separate, read-only list generation; it never inspects all details or issues approval commands. */
export class ApprovalInboxController {
  #state: ApprovalInboxState = { status: "loading" };
  #epoch = 0;
  #abort: AbortController | null = null;
  #listeners = new Set<() => void>();
  readonly #context: WorkbenchController;
  constructor(
    private readonly org: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    approvalInboxPath(org);
    this.#context = new WorkbenchController(org, "overview", fetcher);
  }
  getSnapshot = (): ApprovalInboxState => this.#state;
  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };
  private publish(state: ApprovalInboxState) {
    this.#state = freeze(state);
    this.#listeners.forEach((f) => f());
  }
  private begin() {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const epoch = ++this.#epoch;
    this.publish({ status: "loading" });
    return { epoch, signal: this.#abort.signal };
  }
  suspend = () => {
    ++this.#epoch;
    this.#abort?.abort();
    this.#context.suspend();
    this.publish({ status: "suspended" });
  };
  private failure(e: unknown, epoch: number) {
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
  private async load(
    selection: ApprovalInboxSelection,
    previous?: Extract<ApprovalInboxState, { status: "ready" }>,
  ) {
    const { epoch, signal } = this.begin();
    try {
      if (
        !["mine", "review"].includes(selection.lane) ||
        !approvalInboxFilters.includes(selection.state)
      )
        throw new Failure("invalid_input");
      await this.#context.reload();
      if (epoch !== this.#epoch) return;
      const context = this.#context.getSnapshot();
      if (context.status !== "ready") {
        this.publish(context);
        return;
      }
      const { auth, member } = context;
      if (
        member.access_kind !== "member" ||
        (selection.lane === "review" && member.role !== "owner")
      )
        throw new Failure("forbidden");
      if (
        previous &&
        (auth.session.id !== previous.auth.session.id ||
          auth.session.human.id !== previous.auth.session.human.id ||
          auth.session.context_version !==
            previous.auth.session.context_version ||
          member.object_version !== previous.member.object_version)
      )
        throw new Failure("version_conflict");
      const query = new URLSearchParams({
        lane: selection.lane,
        state: selection.state,
        limit: String(selection.limit),
      });
      if (previous?.page.next_cursor)
        query.set("cursor", previous.page.next_cursor);
      let response: Response;
      try {
        response = await this.fetcher(
          `/api/v1/orgs/${this.org}/approvals?${query}`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            headers: {
              "x-zentwine-context-version": String(
                auth.session.context_version,
              ),
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          },
        );
      } catch {
        throw new Failure("network_unavailable");
      }
      if (response.redirected) throw new Failure("invalid_response");
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new Failure("network_unavailable");
      }
      if (text.length > 131072) throw new Failure("invalid_response");
      const raw: unknown = JSON.parse(text);
      if (!response.ok) {
        const code =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)["code"]
            : null;
        throw new Failure(
          typeof code === "string" &&
          [
            "authentication_required",
            "forbidden",
            "unavailable_resource",
            "version_conflict",
            "invalid_input",
            "rate_limited",
          ].includes(code)
            ? code
            : "unavailable",
        );
      }
      const page = parseApprovalInboxPage(
        raw,
        this.org,
        auth.session.human.id,
        selection,
      );
      if (
        previous?.page.next_cursor &&
        page.next_cursor === previous.page.next_cursor
      )
        throw new Failure("invalid_response");
      if (epoch === this.#epoch)
        this.publish({ status: "ready", auth, member, page, selection });
    } catch (e) {
      this.failure(e, epoch);
    }
  }
  reload = (
    lane: ApprovalInboxLane = "mine",
    state: ApprovalInboxFilter = "all",
  ) => this.load({ lane, state, limit: 20 });
  next = async () => {
    const previous = this.#state;
    if (previous.status !== "ready" || !previous.page.next_cursor) return;
    await this.load(previous.selection, previous);
  };
  switchOrganization = async (): Promise<string | null> => {
    if (this.#state.status !== "choose") return null;
    const { epoch } = this.begin();
    const path = await this.#context.switchOrganization(this.org);
    if (epoch !== this.#epoch) return null;
    if (path) return approvalInboxPath(this.org);
    const state = this.#context.getSnapshot();
    if (state.status !== "ready") this.publish(state);
    return null;
  };
}
