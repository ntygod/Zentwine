/** Synthetic cases shared by independent Node codec and Python JSON Schema validation. */
import { fileURLToPath } from "node:url";
import { fixture } from "./runtime-wire-v1.mjs";
export { fixture };
export const clone = (value) => structuredClone(value);
export const uid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const cases = [];
const add = (name, kind, value, parseValid = true, schemaValid = parseValid) =>
  cases.push({ name, kind, value, parseValid, schemaValid });
const samples = [
  ["synthetic start A", "start_run", fixture.start_a],
  ["synthetic start B consumes A artifact", "start_run", fixture.start_b],
  ["synthetic capabilities A", "capability_report", fixture.capabilities_a],
  ["synthetic capabilities B", "capability_report", fixture.capabilities_b],
  ["unverified artifact manifest", "artifact_manifest", fixture.manifest_a],
  ...fixture.event_variants.map((e) => [e.type, "runtime_event", e]),
];
for (const [name, kind, value] of samples) {
  add(name, kind, value);
  const extra = clone(value); extra.unexpected = true;
  add(`${name}: unknown root field`, kind, extra, false);
  const major = clone(value); major.schema_version = "2.0.0";
  add(`${name}: unknown version`, kind, major, false);
  const missing = clone(value); delete missing.schema_version;
  add(`${name}: missing version`, kind, missing, false);
}
function change(name, kind, source, mutate, schemaValid = false) {
  const value = clone(source); mutate(value);
  add(name, kind, value, false, schemaValid);
}
const start = (name, mutate, semantic = false) => change(name, "start_run", fixture.start_a, mutate, semantic);
start("draft 1.0 is not wire 1.0.0", (x) => { x.schema_version = "1.0"; });
start("UUID-only organization", (x) => { x.org_id = "fixture_org"; });
start("credentials are not wire fields", (x) => { x.model_binding.api_key = "synthetic"; });
start("raw workspace paths are not accepted", (x) => { x.workspace.cwd = "/tmp/example"; });
start("lease epoch must not lose precision", (x) => { x.workspace.lease_epoch = 9007199254740992; });
start("epoch has no leading zero", (x) => { x.workspace.lease_epoch = "01"; });
start("epoch rejects bigint overflow", (x) => { x.workspace.lease_epoch = "9223372036854775808"; }, true);
start("hash must be lowercase SHA256", (x) => { x.baseline.sha256 = "A".repeat(64); });
start("revision is a safe bounded integer", (x) => { x.baseline.revision = 1.5; });
start("unknown canonicalization", (x) => { x.baseline.canonicalization_version = "other"; });
start("provider identifier rejects trailing newline", (x) => { x.model_binding.provider += "\n"; });
start("agent requires accountable owner", (x) => { delete x.requested_by.accountable_owner_id; });
start("unknown capability cannot be required", (x) => { x.capability_requirements[0].capability = "magic"; });
start("unverified cannot be opted into", (x) => { x.capability_requirements[0].accepted_states = ["unverified"]; });
start("required stop cannot be omitted", (x) => { x.capability_requirements[2].capability = "input"; }, true);
start("duplicate capabilities rejected", (x) => { x.capability_requirements[2] = x.capability_requirements[1]; }, true);
start("duplicate accepted states rejected", (x) => { x.capability_requirements[0].accepted_states = ["native", "native"]; }, true);
start("cannot supersede itself", (x) => { x.supersedes_run_id = x.run_id; }, true);
start("artifact org must match", (x) => { x.input_artifacts = [clone(fixture.manifest_a.artifacts[0].ref)]; x.input_artifacts[0].producer.org_id = uid(900); }, true);
start("cannot consume own run output as original input", (x) => { x.input_artifacts = [fixture.manifest_a.artifacts[0].ref]; }, true);
change("conflicting artifact revision does not pass uniqueness", "start_run", fixture.start_b, (x) => { x.input_artifacts.push(clone(x.input_artifacts[0])); x.input_artifacts[1].sha256 = "d".repeat(64); }, true);
change("native capability needs evidence reference", "capability_report", fixture.capabilities_a, (x) => { x.capabilities.start.evidence_refs = []; });
change("capability report cannot grant authorization", "capability_report", fixture.capabilities_a, (x) => { x.authorization = true; });
change("emulation must disclose limitations", "capability_report", fixture.capabilities_a, (x) => { x.capabilities.start.state = "emulated"; });
change("calendar-invalid timestamp rejected", "capability_report", fixture.capabilities_a, (x) => { x.tested_at = "2026-02-30T00:00:00.000Z"; }, true);
change("timestamp must be normalized UTC", "capability_report", fixture.capabilities_a, (x) => { x.tested_at = "2026-09-27T08:00:00+08:00"; });
change("adapter cannot assert trusted verification", "artifact_manifest", fixture.manifest_a, (x) => { x.artifacts[0].verification = "passed"; });
change("absolute artifact location not transmitted", "artifact_manifest", fixture.manifest_a, (x) => { x.artifacts[0].path = "/tmp/example"; });
change("source commit has declared algorithm", "artifact_manifest", fixture.manifest_a, (x) => { x.artifacts[0].source_commits[0].algorithm = "sha256"; });
change("manifest producer is bound", "artifact_manifest", fixture.manifest_a, (x) => { x.artifacts[0].ref.producer.attempt_id = uid(999); }, true);
change("manifest duplicate artifact is rejected", "artifact_manifest", fixture.manifest_a, (x) => { x.artifacts.push(clone(x.artifacts[0])); }, true);
change("duplicate repository commits are ambiguous", "artifact_manifest", fixture.manifest_a, (x) => { x.artifacts[0].source_commits.push(clone(x.artifacts[0].source_commits[0])); }, true);
const ev = (type) => fixture.event_variants.find((x) => x.type === type);
change("unknown model cannot carry requested alias as observation", "runtime_event", ev("run.started"), (x) => { x.payload.observed_model.model_id = "requested-alias"; });
change("natural language is not a terminal state", "runtime_event", ev("run.succeeded"), (x) => { x.payload.text = "done"; });
change("cancellation needs a stop receipt", "runtime_event", ev("run.cancelled"), (x) => { delete x.payload.stop_receipt_id; });
change("unknown result cannot request retry", "runtime_event", ev("run.unknown"), (x) => { x.payload.error.recovery = "retry"; });
change("unknown result cannot be failed", "runtime_event", ev("run.failed"), (x) => { x.payload.error = ev("run.unknown").payload.error; });
change("unknown usage cannot mean zero", "runtime_event", ev("usage.reported"), (x) => { x.payload.usage.cost_microusd = "0"; });
change("sequence cannot be float or number", "runtime_event", ev("run.started"), (x) => { x.sequence = 1; });
change("summary cannot be private reasoning field", "runtime_event", ev("summary.available"), (x) => { x.payload.chain_of_thought = "synthetic"; });
change("artifact produced is bound to event stream", "runtime_event", ev("artifact.produced"), (x) => { x.payload.artifact.producer.run_id = uid(999); }, true);
for (const state of ["native", "emulated", "experimental", "unsupported", "unverified"]) {
  const report = clone(fixture.capabilities_a);
  report.capabilities.resume = ["unsupported", "unverified"].includes(state) ? { state } :
    state === "native" ? { state, evidence_refs: [uid(1000)] } :
      { state, evidence_refs: [uid(1000)], limitations: ["new_run_required"] };
  add(`explicit ${state} capability state`, "capability_report", report);
}
const model = clone(ev("run.started"));
model.payload.observed_model = { status: "reported", provider: "fixture-provider-a", model_id: "reported-fixture-version", source: "runtime_report" };
add("reported model has explicit provenance", "runtime_event", model);
const usage = clone(ev("usage.reported"));
usage.payload.usage = { status: "reported", input_tokens: 0, output_tokens: 0, cost_microusd: null };
add("zero tokens and unknown cost are distinct", "runtime_event", usage);
const large = clone(fixture.start_a); large.workspace.lease_epoch = "9223372036854775807";
add("maximum bigint epoch remains a string", "start_run", large);
const empty = clone(fixture.manifest_a); empty.artifacts = [];
add("explicit empty manifest", "artifact_manifest", empty);
if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(cases));
