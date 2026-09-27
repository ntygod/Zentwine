import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseStartRun, parseRuntimeEvent, parseArtifactManifest, parseCapabilityReport,
  bindRuntimeEvent, bindArtifactManifest, inspectRuntimeCompatibility,
  sameRuntimeRunInput, runtimeProtocolSchema, RUNTIME_CAPABILITIES,
  parseRuntimeProtocolError,
} from "../packages/contracts/dist/runtime-protocol.js";
import { cases, fixture, clone, uid } from "./fixtures/runtime-wire-cases.mjs";
const parsers = { start_run: parseStartRun, runtime_event: parseRuntimeEvent,
  artifact_manifest: parseArtifactManifest, capability_report: parseCapabilityReport };
for (const entry of cases) test(`runtime wire: ${entry.name}`, () => {
  if (entry.parseValid) {
    const parsed = parsers[entry.kind](entry.value);
    assert.deepEqual(parsed, entry.value);
    assert.ok(Object.isFrozen(parsed));
    assert.notEqual(parsed, entry.value);
  } else assert.throws(() => parsers[entry.kind](entry.value), { name: "TypeError", message: "Invalid runtime protocol message" });
});
test("runtime wire: exported schema matches fixed versioned fingerprint", () => {
  assert.equal(createHash("sha256").update(JSON.stringify(runtimeProtocolSchema)).digest("hex"), "089c237dd26866a9ae1da3e06b42e04978d75c1e7fb8316781dedc8b836682e2");
  assert.ok(Object.isFrozen(runtimeProtocolSchema.$defs.start_run.properties));
});
test("runtime wire: snapshot rejects ordinary getters without invoking them", () => {
  let calls = 0;
  const input = clone(fixture.start_a);
  Object.defineProperty(input.model_binding, "provider", { enumerable: true, get() { calls++; throw new Error("private detail"); } });
  assert.throws(() => parseStartRun(input), /Invalid runtime protocol message/);
  assert.equal(calls, 0);
});
test("runtime wire: nested source mutations do not change frozen parsed request", () => {
  const input = clone(fixture.start_b); const parsed = parseStartRun(input);
  input.input_artifacts[0].sha256 = "d".repeat(64);
  input.capability_requirements[0].accepted_states.push("emulated");
  assert.equal(parsed.input_artifacts[0].sha256, "b".repeat(64));
  assert.deepEqual(parsed.capability_requirements[0].accepted_states, ["native"]);
  assert.throws(() => { parsed.input_artifacts[0].producer.run_id = uid(999); }, TypeError);
});
test("runtime wire: rejects non-JSON, sparse, cyclic and reflective input", () => {
  for (const mutate of [
    (x) => { x.baseline = new Date(); }, (x) => { x.baseline = x; },
    (x) => { x.input_artifacts = new Array(1); }, (x) => { x.input_artifacts.extra = 1; },
    (x) => { x.baseline.sha256 = Symbol("synthetic"); },
    (x) => { x.workspace.lease_epoch = 1n; },
    (x) => { x[Symbol("private")] = true; },
    (x) => { Object.defineProperty(x, "hidden", { value: true }); },
    (x) => { x.baseline.sha256 = "\ud800"; },
    (x) => { x.baseline.revision = NaN; },
  ]) { const input = clone(fixture.start_a); mutate(input); assert.throws(() => parseStartRun(input), TypeError); }
});
test("runtime wire: toJSON is never invoked", () => {
  const input = clone(fixture.start_a); let calls = 0;
  input.toJSON = () => { calls++; return fixture.start_a; };
  assert.throws(() => parseStartRun(input), TypeError); assert.equal(calls, 0);
});
test("runtime wire: byte, node, depth and collection limits fail closed", () => {
  for (const extension of ["x".repeat(262144), Array.from({ length: 8193 }, () => 1),
    Array.from({ length: 18 }).reduce((acc) => ({ value: acc }), {})]) {
    assert.throws(() => parseStartRun({ ...fixture.start_a, extra: extension }), TypeError);
  }
  const input = clone(fixture.start_b); input.input_artifacts = Array.from({ length: 65 }, (_, i) => ({ ...input.input_artifacts[0], artifact_id: uid(2000 + i) }));
  assert.throws(() => parseStartRun(input), TypeError);
});
test("runtime wire: null-prototype JSON records are copied safely", () => {
  const input = Object.assign(Object.create(null), fixture.start_a);
  assert.deepEqual(parseStartRun(input), fixture.start_a);
});
test("runtime wire: all five capability states are represented and no missing capability is native", () => {
  assert.equal(RUNTIME_CAPABILITIES.length, 11);
  for (const name of RUNTIME_CAPABILITIES) {
    const report = clone(fixture.capabilities_a); delete report.capabilities[name];
    assert.throws(() => parseCapabilityReport(report), TypeError);
  }
});
test("runtime wire: compatible synthetic declarations remain non-authorizing", () => {
  assert.deepEqual(inspectRuntimeCompatibility(fixture.start_a, fixture.capabilities_a), { compatible: true, authorization: false, reasons: [] });
  assert.deepEqual(inspectRuntimeCompatibility(fixture.start_b, fixture.capabilities_b), { compatible: true, authorization: false, reasons: [] });
});
test("runtime wire: model, runtime, adapter and report binding mismatches reject compatibility", () => {
  for (const mutate of [(x) => { x.provider = "other"; }, (x) => { x.runtime.runtime_id = uid(999); },
    (x) => { x.runtime.adapter_version = "fixture.2"; }, (x) => { x.report_id = uid(999); }]) {
    const report = clone(fixture.capabilities_a); mutate(report);
    const result = inspectRuntimeCompatibility(fixture.start_a, report);
    assert.equal(result.compatible, false); assert.deepEqual(result.reasons, ["report_binding_mismatch"]);
  }
});
test("runtime wire: unsupported and unverified critical controls never satisfy requirements", () => {
  for (const state of ["unsupported", "unverified"]) {
    const report = clone(fixture.capabilities_a); report.capabilities.stop = { state };
    assert.deepEqual(inspectRuntimeCompatibility(fixture.start_a, report).reasons, ["capability_not_accepted"]);
  }
});
test("runtime wire: emulation requires explicit acceptance and remains a declaration", () => {
  const report = clone(fixture.capabilities_a);
  report.capabilities.stop = { state: "emulated", evidence_refs: [uid(700)], limitations: ["provider_dependent"] };
  assert.equal(inspectRuntimeCompatibility(fixture.start_a, report).compatible, false);
  const request = clone(fixture.start_a); request.capability_requirements[2].accepted_states.push("emulated");
  const result = inspectRuntimeCompatibility(request, report);
  assert.equal(result.compatible, true); assert.equal(result.authorization, false);
});
test("runtime wire: synthetic reports cannot satisfy provider requests", () => {
  const request = clone(fixture.start_a); request.execution_kind = "provider";
  assert.deepEqual(inspectRuntimeCompatibility(request, fixture.capabilities_a).reasons, ["provenance_mismatch"]);
  assert.throws(() => bindRuntimeEvent(request, fixture.event_variants[0]), TypeError);
  assert.throws(() => bindArtifactManifest(request, fixture.manifest_a), TypeError);
});
test("runtime wire: stream binding rejects cross-org, run and attempt", () => {
  for (const key of ["org_id", "run_id", "attempt_id"]) {
    const event = clone(fixture.event_variants[0]); event[key] = uid(999);
    assert.throws(() => bindRuntimeEvent(fixture.start_a, event), TypeError);
    const manifest = clone(fixture.manifest_a); manifest[key] = uid(999); manifest.artifacts = [];
    assert.throws(() => bindArtifactManifest(fixture.start_a, manifest), TypeError);
  }
});
test("runtime wire: stream binding does not infer actual model from requested alias", () => {
  const event = bindRuntimeEvent(fixture.start_a, fixture.event_variants[0]);
  assert.deepEqual(event.payload.observed_model, { status: "unknown" });
  const reported = clone(event); reported.payload.observed_model = { status: "reported", provider: "other", model_id: "reported", source: "runtime_report" };
  assert.throws(() => bindRuntimeEvent(fixture.start_a, reported), TypeError);
});
test("runtime wire: run input equality excludes only attempt and cannot authorize retry", () => {
  const request = clone(fixture.start_a); request.attempt_id = uid(888);
  assert.equal(sameRuntimeRunInput(fixture.start_a, request), true);
  for (const mutate of [
    (x) => { x.model_binding.requested_model_id = "other-model"; },
    (x) => { x.model_binding.binding_version++; }, (x) => { x.baseline.revision++; },
    (x) => { x.baseline.sha256 = "d".repeat(64); }, (x) => { x.context_snapshot.revision++; },
    (x) => { x.workspace.lease_epoch = "2"; }, (x) => { x.policy_snapshot.revision++; },
    (x) => { x.budget_reservation_id = uid(777); }, (x) => { x.requested_by.delegation_id = uid(777); },
    (x) => { x.execution_kind = "provider"; }, (x) => { x.run_id = uid(777); },
  ]) { const changed = clone(request); mutate(changed); assert.equal(sameRuntimeRunInput(fixture.start_a, changed), false); }
});
test("runtime wire: equivalent object property order is not a changed fixed input", () => {
  const reordered = Object.fromEntries(Object.entries(fixture.start_a).reverse());
  reordered.model_binding = Object.fromEntries(Object.entries(reordered.model_binding).reverse());
  assert.equal(sameRuntimeRunInput(fixture.start_a, reordered), true);
});
test("runtime wire: unknown error requires inspect, never retry or raw diagnostics", () => {
  assert.deepEqual(parseRuntimeProtocolError({ code: "timeout", outcome: "unknown", recovery: "inspect" }), { code: "timeout", outcome: "unknown", recovery: "inspect" });
  for (const recovery of ["retry", "none", "new_run"]) assert.throws(() => parseRuntimeProtocolError({ code: "timeout", outcome: "unknown", recovery }), TypeError);
  assert.throws(() => parseRuntimeProtocolError({ code: "timeout", outcome: "unknown", recovery: "inspect", message: "sensitive" }), TypeError);
});
test("runtime wire: valid manifest identifies exact A output consumed by B without claiming live execution", () => {
  const manifest = bindArtifactManifest(fixture.start_a, fixture.manifest_a);
  const request = parseStartRun(fixture.start_b);
  assert.deepEqual(manifest.artifacts[0].ref, request.input_artifacts[0]);
  assert.notEqual(fixture.start_a.model_binding.provider, request.model_binding.provider);
  assert.notEqual(fixture.start_a.model_binding.requested_model_id, request.model_binding.requested_model_id);
  assert.equal(manifest.evidence_kind, "synthetic"); assert.equal(manifest.artifacts[0].verification, "unverified");
});
