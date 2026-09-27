/** ZT12-01-A. Declarative wire contracts only: no authorization, persistence or execution. */
import {
  freezeWire, invalidWire, parseWire, wireArray, wireEnum, wireInteger,
  wireObject, wireRefine, wireString, wireUnion, type WireCodec, type WireValue,
} from "./runtime-wire.js";
export { RUNTIME_WIRE_LIMITS } from "./runtime-wire.js";
export const RUNTIME_PROTOCOL_VERSION = "1.0.0" as const;
const uuid = wireString("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", 36, 36);
const digest = wireString("^[a-f0-9]{64}$", 64, 64);
const version = wireInteger(1, 2147483646);
const count = wireInteger(0, Number.MAX_SAFE_INTEGER);
const identifier = wireString("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", 160);
const decimal = (zero: boolean) => wireRefine(
  wireString(zero ? "^(0|[1-9][0-9]{0,18})$" : "^[1-9][0-9]{0,18}$", 19),
  (v) => BigInt(v) <= 9223372036854775807n,
);
const timestamp = wireRefine(
  wireString("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", 24, 24),
  (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
);
const nil = wireEnum(null);
const provenance = wireEnum("synthetic", "adapter_report");
const runtime = wireObject({ runtime_id: uuid, adapter_version: identifier });
const revision = wireObject({ object_id: uuid, revision: version, sha256: digest, canonicalization_version: wireEnum("zt-json-v1") });
const stream = { org_id: uuid, run_id: uuid, attempt_id: uuid };
const artifactRef = wireObject({ artifact_id: uuid, revision: version, sha256: digest, producer: wireObject(stream) });
const uniqueBy = <T>(items: readonly T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;
const artifacts = wireRefine(wireArray(artifactRef, 64), (v) => uniqueBy(v, (a) => a.artifact_id));
export const RUNTIME_CAPABILITIES = Object.freeze([
  "start", "observe", "input", "stop", "artifacts", "resume", "steer", "fork", "checkpoint", "usage", "child_runs",
] as const);
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];
const capabilityName = wireEnum(...RUNTIME_CAPABILITIES);
const usableState = wireEnum("native", "emulated", "experimental");
const requirements = wireRefine(wireArray(wireObject({
  capability: capabilityName,
  accepted_states: wireRefine(wireArray(usableState, 3, 1), (v) => new Set(v).size === v.length),
}), 11, 4), (v) => uniqueBy(v, (x) => x.capability) &&
  ["start", "observe", "stop", "artifacts"].every((name) => v.some((x) => x.capability === name)));
const actor = wireUnion(
  wireObject({ kind: wireEnum("human"), id: uuid }),
  wireObject({ kind: wireEnum("agent"), id: uuid, accountable_owner_id: uuid, delegation_id: uuid }),
  wireObject({ kind: wireEnum("service"), id: uuid, accountable_owner_id: uuid }),
);
const header = { schema_version: wireEnum(RUNTIME_PROTOCOL_VERSION) };
const startCodec = wireRefine(wireObject({
  ...header, message_type: wireEnum("start_run"), ...stream,
  execution_kind: wireEnum("synthetic", "provider"), requested_by: actor,
  task_id: uuid, baseline: revision, context_snapshot: revision,
  workspace: wireObject({ workspace_id: uuid, lease_epoch: decimal(false) }),
  model_binding: wireObject({ binding_id: uuid, binding_version: version, provider: identifier, requested_model_id: identifier, runtime }),
  capability_report_id: uuid, capability_requirements: requirements,
  policy_snapshot: revision, budget_reservation_id: uuid,
  input_artifacts: artifacts, supersedes_run_id: wireUnion(nil, uuid),
}), (v) => v.supersedes_run_id !== v.run_id && v.input_artifacts.every((a) =>
  a.producer.org_id === v.org_id && a.producer.run_id !== v.run_id));
export type StartRun = WireValue<typeof startCodec>;

const evidenceRefs = wireRefine(wireArray(uuid, 16, 1), (v) => new Set(v).size === v.length);
const limitations = wireRefine(wireArray(wireEnum(
  "new_run_required", "partial_usage", "no_native_resume", "polling_only", "partial_child_visibility", "provider_dependent",
), 6, 1), (v) => new Set(v).size === v.length);
const capability = wireUnion(
  wireObject({ state: wireEnum("native"), evidence_refs: evidenceRefs }),
  wireObject({ state: wireEnum("emulated"), evidence_refs: evidenceRefs, limitations }),
  wireObject({ state: wireEnum("experimental"), evidence_refs: evidenceRefs, limitations }),
  wireObject({ state: wireEnum("unsupported") }),
  wireObject({ state: wireEnum("unverified") }),
);
const capabilityCodec = wireObject({
  ...header, message_type: wireEnum("capability_report"), report_id: uuid,
  runtime, provider: identifier, evidence_kind: provenance, tested_at: timestamp,
  capabilities: wireObject({
    start: capability, observe: capability, input: capability, stop: capability,
    artifacts: capability, resume: capability, steer: capability, fork: capability,
    checkpoint: capability, usage: capability, child_runs: capability,
  }),
});
export type CapabilityReport = WireValue<typeof capabilityCodec>;

const unknownError = wireObject({
  code: wireEnum("transport_lost", "timeout", "unconfirmed_stop", "unconfirmed_tool_outcome"),
  outcome: wireEnum("unknown"), recovery: wireEnum("inspect"),
});
const knownError = wireObject({
  code: wireEnum("invalid_input", "unauthorized", "incompatible_runtime", "stale_baseline", "budget_exhausted", "execution_failed", "unavailable"),
  outcome: wireEnum("not_started", "failed"), recovery: wireEnum("none", "new_run"),
});
const errorCodec = wireUnion(unknownError, knownError);
export type RuntimeProtocolError = WireValue<typeof errorCodec>;
const observation = wireUnion(
  wireObject({ status: wireEnum("unknown") }),
  wireObject({ status: wireEnum("reported"), provider: identifier, model_id: identifier, source: wireEnum("runtime_report") }),
);
const eventHeader = {
  ...header, message_type: wireEnum("runtime_event"), ...stream,
  event_id: uuid, sequence: decimal(false), occurred_at: timestamp, evidence_kind: provenance,
};
const event = <const N extends string, C extends WireCodec<unknown>>(name: N, payload: C) =>
  wireObject({ ...eventHeader, type: wireEnum(name), payload });
const eventCodec = wireUnion(
  event("run.started", wireObject({ observed_model: observation })),
  event("run.waiting_input", wireObject({ request_id: uuid, expires_at: timestamp, question_artifact: artifactRef })),
  event("run.input_accepted", wireObject({ request_id: uuid })),
  event("run.stop_requested", wireObject({ request_id: uuid })),
  event("run.cancelled", wireObject({ stop_receipt_id: uuid, scope: wireEnum("attempt_and_children"), observed_at: timestamp })),
  event("run.succeeded", wireObject({ manifest_id: uuid })),
  event("run.failed", wireObject({ error: knownError })),
  event("run.unknown", wireObject({ operation_id: uuid, error: unknownError })),
  event("tool.requested", wireObject({ request_id: uuid, action: identifier, scope_ref: uuid, approval_request_id: wireUnion(nil, uuid) })),
  event("summary.available", wireObject({ artifact: artifactRef, claim_kind: wireEnum("agent_claim") })),
  event("artifact.produced", wireObject({ artifact: artifactRef })),
  event("usage.reported", wireObject({ measurement_id: uuid, usage: wireUnion(
    wireObject({ status: wireEnum("unknown") }),
    wireObject({ status: wireEnum("reported"), input_tokens: count, output_tokens: count, cost_microusd: wireUnion(nil, decimal(true)) }),
  ) })),
);
export type RuntimeEvent = WireValue<typeof eventCodec>;
const commitRef = wireUnion(
  wireObject({ repository_id: uuid, algorithm: wireEnum("sha1"), commit_sha: wireString("^[a-f0-9]{40}$", 40, 40) }),
  wireObject({ repository_id: uuid, algorithm: wireEnum("sha256"), commit_sha: digest }),
);
const manifestCodec = wireRefine(wireObject({
  ...header, message_type: wireEnum("artifact_manifest"), ...stream,
  manifest_id: uuid, produced_at: timestamp, evidence_kind: provenance,
  artifacts: wireArray(wireObject({
    ref: artifactRef,
    media_type: wireString("^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$", 127),
    size_bytes: count, verification: wireEnum("unverified"),
    source_commits: wireRefine(wireArray(commitRef, 32), (v) => uniqueBy(v, (c) => c.repository_id)),
  }), 64),
}), (v) => uniqueBy(v.artifacts, (a) => a.ref.artifact_id) &&
  v.artifacts.every((a) => sameStream(v, a.ref.producer)));
export type ArtifactManifest = WireValue<typeof manifestCodec>;
function sameStream(a: { org_id: string; run_id: string; attempt_id: string }, b: { org_id: string; run_id: string; attempt_id: string }): boolean {
  return a.org_id === b.org_id && a.run_id === b.run_id && a.attempt_id === b.attempt_id;
}
export const runtimeProtocolSchemas = freezeWire({
  start_run: startCodec.schema, runtime_event: eventCodec.schema,
  artifact_manifest: manifestCodec.schema, capability_report: capabilityCodec.schema,
});
export const runtimeProtocolSchema = freezeWire({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://zentwine.invalid/contracts/runtime-wire/1.0.0",
  title: "Zentwine runtime wire 1.0.0; declarations, not authority",
  $defs: runtimeProtocolSchemas,
  oneOf: Object.keys(runtimeProtocolSchemas).map((name) => ({ $ref: `#/$defs/${name}` })),
});
export const parseStartRun = (v: unknown): StartRun => parseWire(startCodec, v);
export const parseCapabilityReport = (v: unknown): CapabilityReport => parseWire(capabilityCodec, v);
export const parseArtifactManifest = (v: unknown): ArtifactManifest => parseWire(manifestCodec, v);
export function parseRuntimeEvent(v: unknown): RuntimeEvent {
  const parsed = parseWire(eventCodec, v);
  if (parsed.type === "artifact.produced" && !sameStream(parsed, parsed.payload.artifact.producer)) invalidWire();
  if (parsed.type === "summary.available" && !sameStream(parsed, parsed.payload.artifact.producer)) invalidWire();
  if (parsed.type === "run.waiting_input" && !sameStream(parsed, parsed.payload.question_artifact.producer)) invalidWire();
  return parsed;
}
export const parseRuntimeProtocolError = (v: unknown): RuntimeProtocolError => parseWire(errorCodec, v);
/** Stream/provenance matching only. It does NOT attest to the event, order it, or persist it. */
export function bindRuntimeEvent(request: unknown, value: unknown): RuntimeEvent {
  const start = parseStartRun(request);
  const parsed = parseRuntimeEvent(value);
  if (!sameStream(start, parsed) || !sameProvenance(start, parsed)) invalidWire();
  if (parsed.type === "run.started" && parsed.payload.observed_model.status === "reported" &&
      parsed.payload.observed_model.provider !== start.model_binding.provider) invalidWire();
  return parsed;
}
export function bindArtifactManifest(request: unknown, value: unknown): ArtifactManifest {
  const start = parseStartRun(request);
  const parsed = parseArtifactManifest(value);
  if (!sameStream(start, parsed) || !sameProvenance(start, parsed)) invalidWire();
  return parsed;
}
function sameProvenance(start: StartRun, report: { evidence_kind: "synthetic" | "adapter_report" }): boolean {
  return (start.execution_kind === "synthetic" ? "synthetic" : "adapter_report") === report.evidence_kind;
}
export interface RuntimeCompatibility {
  readonly compatible: boolean;
  readonly authorization: false;
  readonly reasons: readonly ("report_binding_mismatch" | "provenance_mismatch" | "capability_not_accepted")[];
}
/** A matching declaration is not verified capability, authorization, freshness or permission to start. */
export function inspectRuntimeCompatibility(request: unknown, value: unknown): RuntimeCompatibility {
  const start = parseStartRun(request);
  const report = parseCapabilityReport(value);
  const reasons: RuntimeCompatibility["reasons"][number][] = [];
  if (start.capability_report_id !== report.report_id ||
      start.model_binding.provider !== report.provider ||
      JSON.stringify(start.model_binding.runtime) !== JSON.stringify(report.runtime)) reasons.push("report_binding_mismatch");
  if (!sameProvenance(start, report)) reasons.push("provenance_mismatch");
  if (start.capability_requirements.some((requirement) =>
    !(requirement.accepted_states as readonly string[]).includes(report.capabilities[requirement.capability].state)
  )) reasons.push("capability_not_accepted");
  return Object.freeze({ compatible: reasons.length === 0, authorization: false, reasons: Object.freeze(reasons) });
}
/** Compares declared fixed input, excluding attempt_id. Never authorizes a retry or resolves unknown outcomes. */
export function sameRuntimeRunInput(first: unknown, second: unknown): boolean {
  const { attempt_id: firstAttempt, ...a } = parseStartRun(first);
  const { attempt_id: secondAttempt, ...b } = parseStartRun(second);
  void firstAttempt; void secondAttempt;
  return JSON.stringify(a) === JSON.stringify(b);
}
