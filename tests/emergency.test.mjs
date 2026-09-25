import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateEmergencyInput, OrganizationError } from "../packages/domain/dist/index.js";
import { parseEmergencyState, parseEmergencyResult } from "../packages/contracts/dist/index.js";
const input = () => ({ request_id: randomUUID(), action: "hold", reason: "access_review", confirm_human_id: randomUUID(), expected_version: 0, expected_member_version: 1 });
const state = () => ({ org_id: randomUUID(), member_id: randomUUID(), human_id: randomUUID(), held: false, version: 0, member_version: 1, membership_status: "active" });
const result = () => {
  const current = { ...state(), held: true, version: 1, member_version: 2 };
  return { current, replayed: false, receipt: { request_id: randomUUID(), actor_id: randomUUID(), member_id: current.member_id, human_id: current.human_id, action: "hold", reason: "access_review", version: 1, occurred_at: new Date().toISOString() } };
};
test("emergency input: explicit containment and confirmed recovery have separate reasons", () => {
  validateEmergencyInput(input());
  validateEmergencyInput({ ...input(), action: "release", reason: "incident_contained", expected_version: 1 });
});
for (const [label, patch] of Object.entries({
  request: { request_id: "untrusted" }, target: { confirm_human_id: "email@example.test" },
  negative: { expected_version: -1 }, overflow: { expected_version: 2147483646 },
  fractional: { expected_version: 1.1 }, member: { expected_member_version: 0 },
  string: { expected_member_version: "1" }, action: { action: "restore_all" },
  wrong_reason: { reason: "incident_contained" }, freeform: { reason: "secret narrative" },
  unknown: { role: "owner" },
})) test("emergency input rejects " + label, () => assert.throws(() => validateEmergencyInput({ ...input(), ...patch }), (e) => e instanceof OrganizationError && e.code === "invalid_input"));
test("emergency input: null missing and array forms cannot bypass schema", () => {
  for (const value of [null, [], {}, "hold", { ...input(), action: "release" }])
    assert.throws(() => validateEmergencyInput(value), OrganizationError);
});
test("emergency state: decoder rejects forged scope extra data and impossible versions", () => {
  const s = state();
  assert.deepEqual(parseEmergencyState(s, s.org_id, s.member_id), s);
  for (const patch of [{ org_id: randomUUID() }, { member_id: randomUUID() }, { raw: "secret" }, { held: true }, { version: -1 }, { member_version: 0 }, { membership_status: "restored" }])
    assert.throws(() => parseEmergencyState({ ...s, ...patch }, s.org_id, s.member_id), TypeError);
});
test("emergency receipt: historical replay is distinct from the current released state", () => {
  const r = result();
  assert.deepEqual(parseEmergencyResult(r, r.current.org_id, r.current.member_id), r);
  const replay = { ...r, replayed: true, current: { ...r.current, held: false, version: 2 } };
  assert.deepEqual(parseEmergencyResult(replay, r.current.org_id, r.current.member_id), replay);
  assert.throws(() => parseEmergencyResult({ ...replay, replayed: false }, r.current.org_id, r.current.member_id), TypeError);
});
test("emergency receipt: malformed attribution and raw fields are never displayed", () => {
  const r = result();
  for (const patch of [{ actor_id: "name" }, { human_id: randomUUID() }, { member_id: randomUUID() }, { version: 2 }, { action: "release" }, { reason: "secret" }, { occurred_at: "not-date" }, { raw: {} }])
    assert.throws(() => parseEmergencyResult({ ...r, receipt: { ...r.receipt, ...patch } }, r.current.org_id, r.current.member_id), TypeError);
});
