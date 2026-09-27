import test from "node:test";
import assert from "node:assert/strict";
import * as published from "../packages/contracts/dist/index.js";
import * as implementation from "../packages/contracts/dist/runtime-protocol.js";
import { fixture, clone } from "./fixtures/runtime-wire-cases.mjs";

const functions = [
  "parseStartRun",
  "parseRuntimeEvent",
  "parseArtifactManifest",
  "parseCapabilityReport",
  "parseRuntimeProtocolError",
  "bindRuntimeEvent",
  "bindArtifactManifest",
  "inspectRuntimeCompatibility",
  "sameRuntimeRunInput",
];

test("runtime public entry: all protocol functions are reachable", () => {
  for (const name of functions) {
    assert.equal(typeof published[name], "function", name);
    assert.equal(published[name], implementation[name], name);
  }
});

test("runtime public entry: constants and schemas retain one definition", () => {
  for (const name of [
    "RUNTIME_PROTOCOL_VERSION",
    "RUNTIME_CAPABILITIES",
    "RUNTIME_WIRE_LIMITS",
    "runtimeProtocolSchemas",
    "runtimeProtocolSchema",
  ]) {
    assert.notEqual(published[name], undefined, name);
    assert.equal(published[name], implementation[name], name);
  }
  assert.equal(published.RUNTIME_PROTOCOL_VERSION, "1.0.0");
  assert.equal(published.CONTRACT_VERSION, "0.1.0");
});

test("runtime public entry: parsers preserve strict immutable snapshots", () => {
  const input = clone(fixture.start_a);
  const parsed = published.parseStartRun(input);
  input.model_binding.requested_model_id = "changed";
  assert.equal(
    parsed.model_binding.requested_model_id,
    fixture.start_a.model_binding.requested_model_id,
  );
  assert.ok(Object.isFrozen(parsed.model_binding));
  assert.throws(
    () => published.parseStartRun({ ...input, api_key: "synthetic" }),
    { name: "TypeError", message: "Invalid runtime protocol message" },
  );
});

test("runtime public entry: compatibility never confers authorization", () => {
  assert.deepEqual(
    published.inspectRuntimeCompatibility(
      fixture.start_a,
      fixture.capabilities_a,
    ),
    { compatible: true, authorization: false, reasons: [] },
  );
  const providerRequest = clone(fixture.start_a);
  providerRequest.execution_kind = "provider";
  assert.deepEqual(
    published.inspectRuntimeCompatibility(
      providerRequest,
      fixture.capabilities_a,
    ),
    {
      compatible: false,
      authorization: false,
      reasons: ["provenance_mismatch"],
    },
  );
});

test("runtime public entry: codec internals are not public contracts", () => {
  for (const name of [
    "parseWire",
    "freezeWire",
    "wireObject",
    "wireUnion",
    "invalidWire",
  ])
    assert.equal(Object.hasOwn(published, name), false, name);
});
