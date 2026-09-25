import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, query, fails, migration, waitForDatabaseLock } from "./setup.mjs";
import { fixture as organizationFixture } from "../organizations/setup.mjs";
import { PostgresOrganizationRepository } from "../../packages/db/dist/index.js";
import { secret, secretDigest } from "../../services/api/dist/identity/security.js";

test("emergency PG: historical membership defaults and guarded unused rollback", () => fixture(async (f) => {
  const s = await f.state();
  assert.equal(s.held, false); assert.equal(s.version, 0);
  assert.equal((await query(f.adminPool, await migration("verify"))).rows[0].verified, true);
  const c = await f.adminPool.connect();
  try { await c.query("BEGIN"); await c.query(await migration("down")); await c.query(await migration("up")); await c.query("ROLLBACK"); } finally { c.release(); }
  assert.deepEqual(await f.state(), s);
}));
test("emergency PG: missing migration refuses action rather than faking containment", () => organizationFixture(async (f) => {
  const m = (await f.organizations.members(f.owner.scope)).find((v) => v.human_id === f.bob);
  await assert.rejects(f.organizations.emergencyState(f.owner.scope, m.id), fails("unavailable"));
}));
test("emergency PG: manager cannot rewrite receipts and ordinary runtime cannot change holds", () => fixture(async (f) => {
  await f.organizations.assertRuntimeRole();
  await assert.rejects(query(f.appPool, "UPDATE zentwine_identity.memberships SET emergency_held=true,emergency_version=1 WHERE id=$1", [f.bobMember.id]));
  await f.change();
  await assert.rejects(query(f.managerPool, "DELETE FROM zentwine_organizations.emergency_receipts"));
  await assert.rejects(query(f.managerPool, "UPDATE zentwine_organizations.emergency_receipts SET result='{}'"));
  await assert.rejects(query(f.appPool, "SELECT * FROM zentwine_organizations.emergency_receipts"));
  assert.equal((await f.state()).held, true);
}));
test("emergency PG: hold blocks catalog search audit and fresh organization selection", () => fixture(async (f) => {
  assert.equal((await f.policy.readResource(f.reviewer.scope, f.a.id)).resource.id, f.a.id);
  assert.ok((await f.organizations.search(f.reviewer.scope, "")).length);
  const changed = await f.change();
  assert.equal(changed.current.held, true);
  assert.equal(changed.current.member_version, f.bobMember.object_version + 1);
  await assert.rejects(f.policy.readResource(f.reviewer.scope, f.a.id), fails("unavailable_resource"));
  await assert.rejects(f.organizations.search(f.reviewer.scope, ""), fails("unavailable_resource"));
  await assert.rejects(f.organizations.audit(f.reviewer.scope, {}), fails("unavailable_resource"));
  await assert.rejects(f.auth(f.bob, f.orgA), fails("unavailable_resource"));
  const view = await f.repo.readSession(f.reviewer.scope.session_digest);
  assert.ok(!view.organizations.some((o) => o.id === f.orgA));
}));
test("emergency PG: another organization and actor access remain available", () => fixture(async (f) => {
  const other = await f.auth(f.bob, f.orgB);
  const before = await f.policy.readResource(other.scope, f.b.id);
  await f.change();
  assert.deepEqual((await f.policy.readResource(other.scope, f.b.id)).resource, before.resource);
  assert.equal((await f.policy.readResource(f.owner.scope, f.a.id)).resource.id, f.a.id);
}));
test("emergency PG: explicit release requires new login and does not revive pre-hold or held-period sessions", () => fixture(async (f) => {
  await f.change();
  const during = await f.login(f.bob);
  await f.change(f.bobMember.id, f.owner.scope, "release");
  await assert.rejects(f.policy.readResource(f.reviewer.scope, f.a.id), fails("unavailable_resource"));
  await assert.rejects(f.repo.selectOrganization(secretDigest(during.token), f.orgA, 1), fails("unavailable_resource"));
  const fresh = await f.auth(f.bob);
  assert.equal((await f.policy.readResource(fresh.scope, f.a.id)).resource.id, f.a.id);
  assert.equal((await f.state()).held, false);
}));
test("emergency PG: delegated parent and child credentials remain unusable after release", () => fixture(async (f) => {
  const root = await f.issue(), child = await f.delegate(root);
  assert.equal((await f.agents.execute(child.scope, f.read())).resource.id, f.a.id);
  await f.change(f.aliceMember.id, f.reviewer.scope);
  await assert.rejects(f.agents.execute(root.scope, f.read()));
  await assert.rejects(f.agents.execute(child.scope, f.read()));
  await f.change(f.aliceMember.id, f.reviewer.scope, "release");
  await assert.rejects(f.agents.execute(root.scope, f.read()));
  await assert.rejects(f.agents.execute(child.scope, f.read()));
  const fresh = await f.auth(f.alice), token = secret();
  const issued = await f.agents.issueRoot(fresh.scope, { request_id: randomUUID(), agent_id: f.parentAgent.id, terms: f.terms() }, secretDigest(token));
  assert.ok(issued.delegation);
  assert.equal((await f.agents.execute({ credential_digest: secretDigest(token) }, f.read())).resource.id, f.a.id);
}));
test("emergency PG: pending approved and issued approvals and their outbox revoke atomically", () => fixture(async (f) => {
  const pending = await f.propose();
  const approved = await f.approve(await f.propose());
  const issued = await f.ready();
  await f.change(f.aliceMember.id, f.reviewer.scope);
  const rows = (await query(f.adminPool, "SELECT state FROM zentwine_approvals.requests WHERE org_id=$1", [f.orgA])).rows;
  assert.equal(rows.length, 3); assert.ok(rows.every((r) => r.state === "revoked"));
  const events = (await query(f.adminPool, "SELECT approval_id FROM zentwine_approvals.events WHERE org_id=$1 AND kind='approval.revoked'", [f.orgA])).rows;
  assert.equal(events.length, 3);
  assert.ok(events.some((e) => e.approval_id === pending.id));
  assert.ok(events.some((e) => e.approval_id === approved.id));
  assert.ok(issued);
  await f.change(f.aliceMember.id, f.reviewer.scope, "release");
  assert.ok((await query(f.adminPool, "SELECT state FROM zentwine_approvals.requests WHERE org_id=$1", [f.orgA])).rows.every((r) => r.state === "revoked"));
}));
test("emergency PG: reviewer containment invalidates approvals it previously approved", () => fixture(async (f) => {
  const approved = await f.approve(await f.propose());
  await f.change();
  assert.equal((await query(f.adminPool, "SELECT state FROM zentwine_approvals.requests WHERE id=$1", [approved.id])).rows[0].state, "revoked");
}));
test("emergency PG: pending invitations by the target cannot be consumed or revived", () => fixture(async (f) => {
  const invitation = await f.invite();
  await f.change(f.aliceMember.id, f.reviewer.scope);
  await assert.rejects(f.accept(invitation));
  await f.change(f.aliceMember.id, f.reviewer.scope, "release");
  await assert.rejects(f.accept(invitation));
  assert.equal((await query(f.adminPool, "SELECT state FROM zentwine_organizations.invitations WHERE id=$1", [invitation.invitation.id])).rows[0].state, "revoked");
}));
test("emergency PG: normalized IdP enable and role updates cannot remove containment", () => fixture(async (f) => {
  const provider = await f.provider();
  await f.change();
  await f.organizations.provision(provider.connection.id, provider.digest, f.provisionInput(provider, { active: true }));
  assert.equal((await f.state()).held, true);
  await assert.rejects(f.auth(f.bob));
  await assert.rejects(f.organizations.federatedTicket(provider.connection.id, provider.connection.object_version, provider.mapping.subject, secretDigest(secret())));
  await f.admin.setMembership(f.bobMember.id, f.orgA, f.bob, "MEM-2", "owner", "active");
  assert.equal((await f.state()).held, true);
  await assert.rejects(f.auth(f.bob));
}));
test("emergency PG: held revoked member cannot be invited until explicit release", () => fixture(async (f) => {
  await f.change();
  await f.admin.setMembership(f.bobMember.id, f.orgA, f.bob, "MEM-2", "member", "revoked");
  await assert.rejects(f.invite({ human_id: f.bob, access_kind: "member", role: "member", resource_ids: [] }), fails("forbidden"));
  await f.change(f.bobMember.id, f.owner.scope, "release");
  assert.equal((await f.state()).membership_status, "revoked");
  await assert.rejects(f.auth(f.bob));
  const invitation = await f.invite({ human_id: f.bob, access_kind: "member", role: "member", resource_ids: [] });
  await f.accept(invitation, f.bob);
}));
test("emergency PG: self target and forged identity confirmation are refused", () => fixture(async (f) => {
  await assert.rejects(f.change(f.aliceMember.id), fails("forbidden"));
  await assert.rejects(f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, { ...await f.command(), confirm_human_id: f.alice }), fails("forbidden"));
  assert.equal((await f.state()).version, 0);
}));
test("emergency PG: held owners cannot defeat the last available owner safeguard", () => fixture(async (f) => {
  await f.change();
  const a = (await f.organizations.members(f.owner.scope)).find((m) => m.id === f.aliceMember.id);
  await assert.rejects(f.organizations.updateMember(f.owner.scope, a.id, "viewer", "active", a.object_version), fails("forbidden"));
  assert.equal((await f.organizations.self(f.owner.scope)).role, "owner");
}));
test("emergency PG: concurrent identical requests apply exactly one transition", () => fixture(async (f) => {
  const input = await f.command();
  const rows = await Promise.all(Array.from({ length: 4 }, () => f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, input)));
  assert.equal(rows.filter((r) => !r.replayed).length, 1);
  assert.equal((await f.state()).version, 1);
  for (const row of rows) assert.deepEqual(row.receipt, rows[0].receipt);
  assert.equal((await query(f.adminPool, "SELECT * FROM zentwine_organizations.emergency_receipts")).rows.length, 1);
  assert.equal((await f.organizations.audit(f.owner.scope, { kind: "member.emergency_held" })).entries.length, 1);
}));
test("emergency PG: changed request reuse stale versions and repeated transitions conflict", () => fixture(async (f) => {
  const input = await f.command();
  await f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, input);
  await assert.rejects(f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, { ...input, reason: "access_review" }), fails("version_conflict"));
  await assert.rejects(f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, { ...input, request_id: randomUUID() }), fails("version_conflict"));
  await assert.rejects(f.change(), fails("version_conflict"));
  assert.equal((await f.state()).version, 1);
}));
test("emergency PG: replay after recovery returns historical receipt and current state without reapplying", () => fixture(async (f) => {
  const input = await f.command(), first = await f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, input);
  await f.change(f.bobMember.id, f.owner.scope, "release");
  const repository = new PostgresOrganizationRepository(f.managerPool);
  const replay = await repository.emergencyChange(f.owner.scope, f.bobMember.id, input);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(replay.current.held, false); assert.equal(replay.current.version, 2);
}));
test("emergency PG: stale context and revoked actor cannot replay receipts", () => fixture(async (f) => {
  const input = await f.command(); await f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, input);
  await f.repo.selectOrganization(f.owner.scope.session_digest, f.orgB, f.owner.scope.context_version);
  await assert.rejects(f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, input), fails("version_conflict"));
  const owner = await f.auth(f.alice);
  await f.repo.revokeSession(owner.scope.session_digest);
  await assert.rejects(f.organizations.emergencyChange(owner.scope, f.bobMember.id, input), fails("authentication_required"));
}));
test("emergency PG: failure to persist the receipt rolls back hold cutoffs invitations and approval notifications", () => fixture(async (f) => {
  const pending = await f.propose(), invitation = await f.invite();
  const before = await f.state(f.aliceMember.id, f.reviewer.scope);
  const input = await f.command(f.aliceMember.id, f.reviewer.scope);
  await query(f.adminPool, `REVOKE INSERT ON zentwine_organizations.emergency_receipts FROM "${f.managerRole}"`);
  await assert.rejects(f.organizations.emergencyChange(f.reviewer.scope, f.aliceMember.id, input), fails("unavailable"));
  assert.deepEqual(await f.state(f.aliceMember.id, f.reviewer.scope), before);
  assert.equal((await query(f.adminPool, "SELECT state FROM zentwine_approvals.requests WHERE id=$1", [pending.id])).rows[0].state, "pending");
  assert.equal((await query(f.adminPool, "SELECT state FROM zentwine_organizations.invitations WHERE id=$1", [invitation.invitation.id])).rows[0].state, "pending");
  assert.equal((await query(f.adminPool, "SELECT * FROM zentwine_organizations.session_cutoffs")).rows.length, 0);
  assert.equal((await query(f.adminPool, "SELECT * FROM zentwine_approvals.events WHERE kind='approval.revoked'")).rows.length, 0);
  assert.equal((await f.organizations.audit(f.reviewer.scope, { kind: "member.emergency_held" })).entries.length, 0);
}));
test("emergency PG: completed containment cannot be erased by schema downgrade", () => fixture(async (f) => {
  await f.change();
  const c = await f.adminPool.connect();
  try { await c.query("BEGIN"); await assert.rejects(c.query(await migration("down")), /emergency_history_requires_forward_recovery/); await c.query("ROLLBACK"); } finally { c.release(); }
  assert.equal((await f.state()).held, true);
}));
test("emergency PG: real lock ordering rejects a stale resource read after containment commits", () => fixture(async (f) => {
  const input = await f.command(), blocker = await f.adminPool.connect();
  let changed, reading;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", ["zentwine.authz.v1:policy:" + f.orgA]);
    changed = f.organizations.emergencyChange(f.owner.scope, f.bobMember.id, input);
    changed.catch(() => {});
    await waitForDatabaseLock(f.adminPool, "pg_advisory_xact_lock(");
    reading = f.policy.readResource(f.reviewer.scope, f.a.id);
    reading.catch(() => {});
    await waitForDatabaseLock(f.adminPool, "pg_advisory_xact_lock_shared(");
    await blocker.query("COMMIT");
    assert.equal((await changed).current.held, true);
    await assert.rejects(reading, fails("unavailable_resource"));
  } finally {
    await blocker.query("ROLLBACK"); blocker.release();
    await Promise.allSettled([changed, reading].filter(Boolean));
  }
}));
