/** Independent deterministic synthetic inputs. No codec imports, providers or execution. */
const uid = (n) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const revision = (n) => ({
  object_id: uid(n),
  revision: 1,
  sha256: "a".repeat(64),
  canonicalization_version: "zt-json-v1",
});
const artifact = (n, run, attempt) => ({
  artifact_id: uid(n),
  revision: 1,
  sha256: "b".repeat(64),
  producer: { org_id: uid(1), run_id: uid(run), attempt_id: uid(attempt) },
});
function start(offset, provider, model) {
  return {
    schema_version: "1.0.0",
    message_type: "start_run",
    org_id: uid(1),
    run_id: uid(10 + offset),
    attempt_id: uid(11 + offset),
    execution_kind: "synthetic",
    requested_by: {
      kind: "agent",
      id: uid(2 + offset),
      accountable_owner_id: uid(3),
      delegation_id: uid(4 + offset),
    },
    task_id: uid(5),
    baseline: revision(6),
    context_snapshot: revision(7),
    workspace: { workspace_id: uid(8 + offset), lease_epoch: "1" },
    model_binding: {
      binding_id: uid(12 + offset),
      binding_version: 1,
      provider,
      requested_model_id: model,
      runtime: { runtime_id: uid(13 + offset), adapter_version: "fixture.1" },
    },
    capability_report_id: uid(14 + offset),
    capability_requirements: ["start", "observe", "stop", "artifacts"].map(
      (capability) => ({ capability, accepted_states: ["native"] }),
    ),
    policy_snapshot: revision(9),
    budget_reservation_id: uid(15 + offset),
    input_artifacts: [],
    supersedes_run_id: null,
  };
}
function capabilities(request) {
  return {
    schema_version: "1.0.0",
    message_type: "capability_report",
    report_id: request.capability_report_id,
    runtime: structuredClone(request.model_binding.runtime),
    provider: request.model_binding.provider,
    evidence_kind: "synthetic",
    tested_at: "2026-09-27T00:00:00.000Z",
    capabilities: Object.fromEntries(
      [
        "start",
        "observe",
        "input",
        "stop",
        "artifacts",
        "resume",
        "steer",
        "fork",
        "checkpoint",
        "usage",
        "child_runs",
      ].map((name) => [
        name,
        ["start", "observe", "stop", "artifacts"].includes(name)
          ? { state: "native", evidence_refs: [uid(30)] }
          : { state: "unverified" },
      ]),
    ),
  };
}
const a = start(0, "fixture-provider-a", "fixture-model-a");
const b = start(100, "fixture-provider-b", "fixture-model-b");
b.input_artifacts = [artifact(20, 10, 11)];
const manifest = {
  schema_version: "1.0.0",
  message_type: "artifact_manifest",
  org_id: uid(1),
  run_id: uid(10),
  attempt_id: uid(11),
  manifest_id: uid(31),
  produced_at: "2026-09-27T00:00:01.000Z",
  evidence_kind: "synthetic",
  artifacts: [
    {
      ref: artifact(20, 10, 11),
      media_type: "text/plain",
      size_bytes: 0,
      verification: "unverified",
      source_commits: [
        {
          repository_id: uid(32),
          algorithm: "sha1",
          commit_sha: "c".repeat(40),
        },
      ],
    },
  ],
};
const payloads = {
  "run.started": { observed_model: { status: "unknown" } },
  "run.waiting_input": {
    request_id: uid(40),
    expires_at: "2026-09-27T00:10:00.000Z",
    question_artifact: artifact(21, 10, 11),
  },
  "run.input_accepted": { request_id: uid(40) },
  "run.stop_requested": { request_id: uid(41) },
  "run.cancelled": {
    stop_receipt_id: uid(42),
    scope: "attempt_and_children",
    observed_at: "2026-09-27T00:00:03.000Z",
  },
  "run.succeeded": { manifest_id: uid(31) },
  "run.failed": {
    error: { code: "execution_failed", outcome: "failed", recovery: "none" },
  },
  "run.unknown": {
    operation_id: uid(43),
    error: { code: "transport_lost", outcome: "unknown", recovery: "inspect" },
  },
  "tool.requested": {
    request_id: uid(44),
    action: "catalog.read",
    scope_ref: uid(45),
    approval_request_id: null,
  },
  "summary.available": {
    artifact: artifact(22, 10, 11),
    claim_kind: "agent_claim",
  },
  "artifact.produced": { artifact: artifact(20, 10, 11) },
  "usage.reported": { measurement_id: uid(46), usage: { status: "unknown" } },
};
export const fixture = {
  fixture_only: true,
  description:
    "Independent synthetic message examples, not one legal event history or live provider evidence.",
  start_a: a,
  start_b: b,
  capabilities_a: capabilities(a),
  capabilities_b: capabilities(b),
  manifest_a: manifest,
  event_variants: Object.entries(payloads).map(([type, payload], index) => ({
    schema_version: "1.0.0",
    message_type: "runtime_event",
    org_id: uid(1),
    run_id: uid(10),
    attempt_id: uid(11),
    event_id: uid(50 + index),
    sequence: String(index + 1),
    occurred_at: "2026-09-27T00:00:00.000Z",
    evidence_kind: "synthetic",
    type,
    payload,
  })),
};
