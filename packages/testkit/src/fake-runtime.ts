import type { Clock } from "@zentwine/domain";
import { FixedClock } from "./clocks.js";
import { fixtureId, type TenantFixture } from "./fixtures.js";

export type FakeState =
  | "running"
  | "waiting_input"
  | "stop_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type FakeStep =
  | { readonly type: "artifact"; readonly artifact_id: string }
  | { readonly type: "wait" }
  | { readonly type: "fail"; readonly reason: "injected_failure" | "timeout" }
  | { readonly type: "unknown" }
  | { readonly type: "succeed" };
export interface FakeRequest {
  readonly fixture_only: true;
  readonly org_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly context_snapshot_id: string;
  readonly model_binding: {
    readonly provider: "fixture";
    readonly requested_model_id: "fixture-model-a" | "fixture-model-b";
    readonly runtime_id: "fake";
  };
}
export interface FakeEvent {
  readonly schema_version: "fixture.v1";
  readonly fixture_only: true;
  readonly event_id: string;
  readonly org_id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}
export interface FakeSnapshot {
  readonly fixture_only: true;
  readonly request: FakeRequest;
  readonly state: FakeState;
  readonly last_sequence: number;
  readonly charge_microusd: 0;
}
type RecordState = {
  request: FakeRequest;
  fingerprint: string;
  state: FakeState;
  steps: readonly FakeStep[];
  offset: number;
  events: FakeEvent[];
  inputs: Map<string, string>;
};
export class FakeRuntimeError extends Error {
  constructor(
    readonly code:
      | "invalid_fixture"
      | "unavailable"
      | "conflict"
      | "invalid_state"
      | "limit_exceeded",
  ) {
    super(`FakeRuntime: ${code}`);
    this.name = "FakeRuntimeError";
  }
}
export function fakeRequest(
  tenant: TenantFixture,
  runId: string,
  model: "fixture-model-a" | "fixture-model-b" = "fixture-model-a",
): FakeRequest {
  fixtureId(runId);
  return Object.freeze({
    fixture_only: true,
    org_id: tenant.org_id,
    run_id: runId,
    task_id: tenant.task_id,
    workspace_id: tenant.workspace_id,
    context_snapshot_id: tenant.context_snapshot_id,
    model_binding: Object.freeze({
      provider: "fixture",
      requested_model_id: model,
      runtime_id: "fake",
    }),
  });
}
/** Explicit, deterministic in-memory simulator. No SDKs, files, shell, network or wall-clock timers. */
export class FakeRuntime {
  private readonly records = new Map<string, RecordState>();
  private connected = true;
  private readonly tenant: TenantFixture;
  constructor(
    tenant: TenantFixture,
    private readonly clock: Clock = new FixedClock(),
  ) {
    if (tenant.fixture_only !== true)
      throw new FakeRuntimeError("invalid_fixture");
    for (const value of [
      tenant.org_id,
      tenant.task_id,
      tenant.workspace_id,
      tenant.context_snapshot_id,
    ])
      fixtureId(value);
    this.tenant = Object.freeze({
      ...tenant,
      spec: Object.freeze({ ...tenant.spec }),
    });
  }
  private get(org: string, run: string, transport = true): RecordState {
    const record =
      org === this.tenant.org_id ? this.records.get(run) : undefined;
    if (!record || (transport && !this.connected))
      throw new FakeRuntimeError("unavailable");
    return record;
  }
  private emit(
    record: RecordState,
    type: string,
    payload: Record<string, string | number | boolean> = {},
  ): void {
    const sequence = record.events.length + 1;
    record.events.push(
      Object.freeze({
        schema_version: "fixture.v1",
        fixture_only: true,
        event_id: `${record.request.org_id}:${record.request.run_id}:event:${sequence}`,
        org_id: record.request.org_id,
        run_id: record.request.run_id,
        sequence,
        occurred_at: this.clock.now().toISOString(),
        type,
        payload: Object.freeze({ ...payload, fixture_only: true }),
      }),
    );
  }
  private snapshot(record: RecordState): FakeSnapshot {
    return Object.freeze({
      fixture_only: true,
      request: record.request,
      state: record.state,
      last_sequence: record.events.length,
      charge_microusd: 0,
    });
  }
  start(
    request: FakeRequest,
    steps: readonly FakeStep[] = [{ type: "succeed" }],
  ): FakeSnapshot {
    if (!this.connected) throw new FakeRuntimeError("unavailable");
    const t = this.tenant;
    if (
      request.fixture_only !== true ||
      request.org_id !== t.org_id ||
      request.task_id !== t.task_id ||
      request.workspace_id !== t.workspace_id ||
      request.context_snapshot_id !== t.context_snapshot_id ||
      request.model_binding.provider !== "fixture" ||
      request.model_binding.runtime_id !== "fake" ||
      !["fixture-model-a", "fixture-model-b"].includes(
        request.model_binding.requested_model_id,
      )
    )
      throw new FakeRuntimeError("invalid_fixture");
    fixtureId(request.run_id);
    if (steps.length < 1 || steps.length > 256)
      throw new FakeRuntimeError("limit_exceeded");
    const plan = steps.map((step, index) => {
      if (step.type === "artifact") {
        fixtureId(step.artifact_id);
        return Object.freeze({
          type: step.type,
          artifact_id: step.artifact_id,
        });
      }
      if (step.type === "fail") {
        if (
          !["injected_failure", "timeout"].includes(step.reason) ||
          index !== steps.length - 1
        )
          throw new FakeRuntimeError("invalid_fixture");
        return Object.freeze({ type: step.type, reason: step.reason });
      }
      if (step.type === "succeed" || step.type === "unknown") {
        if (index !== steps.length - 1)
          throw new FakeRuntimeError("invalid_fixture");
        return Object.freeze({ type: step.type });
      }
      if (step.type === "wait") return Object.freeze({ type: step.type });
      throw new FakeRuntimeError("invalid_fixture");
    });
    const last = plan.at(-1)?.type;
    if (!["succeed", "fail", "unknown"].includes(String(last)))
      throw new FakeRuntimeError("invalid_fixture");
    const normalized = fakeRequest(
      t,
      request.run_id,
      request.model_binding.requested_model_id,
    );
    const fingerprint = JSON.stringify([normalized, plan]);
    const existing = this.records.get(request.run_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new FakeRuntimeError("conflict");
      return this.snapshot(existing);
    }
    if (this.records.size >= 128) throw new FakeRuntimeError("limit_exceeded");
    const record: RecordState = {
      request: normalized,
      fingerprint,
      state: "running",
      steps: Object.freeze(plan),
      offset: 0,
      events: [],
      inputs: new Map(),
    };
    this.emit(record, "run.started", {
      requested_model_id: normalized.model_binding.requested_model_id,
    });
    this.records.set(request.run_id, record);
    return this.snapshot(record);
  }
  observe(org: string, run: string): FakeSnapshot {
    return this.snapshot(this.get(org, run));
  }
  /** Test-controller tick; can progress the remote simulation while its transport is disconnected. */
  advance(org: string, run: string): FakeSnapshot {
    const r = this.get(org, run, false);
    if (r.state !== "running") throw new FakeRuntimeError("invalid_state");
    const step = r.steps[r.offset++];
    if (!step) throw new FakeRuntimeError("invalid_state");
    if (step.type === "artifact")
      this.emit(r, "artifact.produced", {
        artifact_id: step.artifact_id,
        revision: 1,
        evidence_kind: "synthetic",
      });
    else if (step.type === "wait") {
      r.state = "waiting_input";
      this.emit(r, "run.waiting_input");
    } else if (step.type === "fail") {
      r.state = "failed";
      this.emit(r, "run.failed", { reason: step.reason });
    } else if (step.type === "unknown") {
      r.state = "unknown";
      this.emit(r, "run.unknown", { reason: "unconfirmed_tool_outcome" });
    } else {
      r.state = "succeeded";
      this.emit(r, "run.succeeded", {
        charge_microusd: 0,
        evidence_kind: "synthetic",
      });
    }
    return this.snapshot(r);
  }
  sendInput(
    org: string,
    run: string,
    inputId: string,
    contextId: string,
    decision: "continue" | "reject",
  ): FakeSnapshot {
    const r = this.get(org, run);
    fixtureId(inputId);
    if (
      contextId !== r.request.context_snapshot_id ||
      !["continue", "reject"].includes(decision)
    )
      throw new FakeRuntimeError("conflict");
    const prior = r.inputs.get(inputId);
    if (prior !== undefined) {
      if (prior !== decision) throw new FakeRuntimeError("conflict");
      return this.snapshot(r);
    }
    if (r.state !== "waiting_input")
      throw new FakeRuntimeError("invalid_state");
    r.inputs.set(inputId, decision);
    r.state = decision === "continue" ? "running" : "failed";
    this.emit(
      r,
      decision === "continue" ? "run.input_accepted" : "run.failed",
      { input_id: inputId, decision },
    );
    return this.snapshot(r);
  }
  requestStop(org: string, run: string): FakeSnapshot {
    const r = this.get(org, run);
    if (["running", "waiting_input"].includes(r.state)) {
      r.state = "stop_requested";
      this.emit(r, "run.stop_requested");
    }
    return this.snapshot(r);
  }
  acknowledgeStop(org: string, run: string): FakeSnapshot {
    const r = this.get(org, run, false);
    if (r.state === "cancelled") return this.snapshot(r);
    if (r.state !== "stop_requested")
      throw new FakeRuntimeError("invalid_state");
    r.state = "cancelled";
    this.emit(r, "run.cancelled");
    return this.snapshot(r);
  }
  setConnected(connected: boolean): void {
    this.connected = connected;
  }
  events(org: string, run: string, after = 0): readonly FakeEvent[] {
    const r = this.get(org, run);
    if (!Number.isSafeInteger(after) || after < 0 || after > r.events.length)
      throw new FakeRuntimeError("invalid_fixture");
    return Object.freeze(r.events.slice(after));
  }
  /** Fault injection affects delivery only, never the source history or current state. */
  transport(
    org: string,
    run: string,
    options: {
      after?: number;
      reverse?: boolean;
      duplicate?: boolean;
      omit?: readonly number[];
    } = {},
  ): readonly FakeEvent[] {
    const result = this.events(org, run, options.after ?? 0).filter(
      (e) => !options.omit?.includes(e.sequence),
    );
    const delivered = options.reverse ? result.reverse() : result;
    return Object.freeze(
      options.duplicate ? delivered.flatMap((e) => [e, e]) : delivered,
    );
  }
}
