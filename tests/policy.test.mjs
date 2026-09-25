/** All values here are synthetic, not identities or reusable permits. */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, ACTIONS } from "../packages/policy/dist/index.js";
import {
  createCatalogTools,
  parseCatalogTool,
} from "../services/api/dist/policy/tools.js";
const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const now = 1790310000000;
function facts() {
  return {
    principal_kind: "human",
    human_id: uuid(1),
    org_id: uuid(2),
    membership_role: "member",
    membership_version: 3,
    session_valid_until: now + 100000,
    observed_at: now,
    policy_revision: 4,
    write_mode: "active",
    resource: {
      id: uuid(3),
      org_id: uuid(2),
      kind: "workspace",
      display_name: "Synthetic workspace",
      visibility: "organization",
      environment: "development",
      sensitivity: "internal",
      owner_human_id: null,
      status: "active",
      object_version: 2,
    },
    grants: [],
    bindings: [],
  };
}
const rule = (extra = {}) => ({
  id: uuid(4),
  org_id: uuid(2),
  human_id: uuid(1),
  resource_id: uuid(3),
  valid_from: now - 1000,
  expires_at: now + 5000,
  revoked: false,
  ...extra,
});
const evaluate = (f, a = "resource.update") => evaluatePolicy(f, a, now);
for (const role of ["owner", "member", "viewer"]) {
  test(`policy: ${role} can read organization-visible metadata`, () => {
    const f = facts();
    f.membership_role = role;
    assert.equal(evaluate(f, "resource.read").outcome, "allow");
  });
  test(`policy: ${role} write baseline is explicit`, () => {
    const f = facts();
    f.membership_role = role;
    assert.equal(evaluate(f).outcome, role === "viewer" ? "deny" : "allow");
  });
}
test("policy: default denies unknown and inherited prototype action names", () => {
  for (const action of ["__proto__", "toString", "workspace.delete", "*", ""]) {
    assert.equal(evaluate(facts(), action).reason, "unknown_action");
  }
});
test("policy: invalid or stale facts never grant access", () => {
  for (const change of [
    { principal_kind: "agent" },
    { membership_role: "admin" },
    { session_valid_until: now },
    { observed_at: now - 30001 },
    { observed_at: now + 1 },
    { policy_revision: 0 },
    {
      grants: Array(101).fill(
        rule({ action: "resource.read", effect: "allow" }),
      ),
    },
  ])
    assert.equal(evaluate({ ...facts(), ...change }).outcome, "deny");
  assert.equal(evaluatePolicy(null, "resource.read", now).outcome, "deny");
  assert.equal(evaluatePolicy(facts(), "resource.read", NaN).outcome, "deny");
});
test("policy: foreign and archived resources are unavailable even to owner", () => {
  for (const change of [{ org_id: uuid(9) }, { status: "archived" }]) {
    const f = facts();
    f.membership_role = "owner";
    Object.assign(f.resource, change);
    assert.equal(evaluate(f).reason, "resource_unavailable");
  }
});
test("policy: resource kind is verified independently of the requested action", () => {
  assert.equal(
    evaluate(facts(), "repository.write").reason,
    "action_resource_mismatch",
  );
  assert.equal(evaluate(facts(), "workspace.write").outcome, "allow");
});
test("policy: organization owner is not a private resource superuser", () => {
  const f = facts();
  f.membership_role = "owner";
  f.resource.visibility = "restricted";
  assert.equal(evaluate(f, "resource.read").reason, "restricted_resource");
});
test("policy: a resource owner remains subject to membership write limits", () => {
  const f = facts();
  f.membership_role = "viewer";
  Object.assign(f.resource, {
    visibility: "restricted",
    owner_human_id: f.human_id,
  });
  assert.equal(evaluate(f, "resource.read").outcome, "allow");
  assert.equal(evaluate(f).outcome, "deny");
});
test("policy: scoped reader does not unlock organization writer on private resources", () => {
  const f = facts();
  f.resource.visibility = "restricted";
  f.bindings = [rule({ role: "reader" })];
  assert.equal(evaluate(f, "resource.read").outcome, "allow");
  assert.equal(evaluate(f).reason, "no_permission");
});
test("policy: explicit editor can elevate only an exact scoped resource", () => {
  const f = facts();
  f.membership_role = "viewer";
  f.resource.visibility = "restricted";
  f.bindings = [rule({ role: "editor" })];
  assert.equal(evaluate(f).outcome, "allow");
  f.resource.id = uuid(7);
  assert.equal(evaluate(f).outcome, "deny");
});
test("policy: explicit deny overrides ownership, scoped roles and positive grants", () => {
  const f = facts();
  f.membership_role = "owner";
  f.resource.owner_human_id = f.human_id;
  f.bindings = [rule({ role: "editor" })];
  f.grants = [
    rule({ action: "resource.update", effect: "allow" }),
    rule({ id: uuid(8), action: "resource.update", effect: "deny" }),
  ];
  assert.equal(evaluate(f).reason, "explicit_deny");
});
test("policy: foreign principal, organization and resource rules are ignored", () => {
  for (const change of [
    { org_id: uuid(8) },
    { human_id: uuid(8) },
    { resource_id: uuid(8) },
  ]) {
    const f = facts();
    f.grants = [rule({ action: "resource.update", effect: "deny", ...change })];
    assert.equal(evaluate(f).outcome, "allow");
  }
});
test("policy: expired, revoked and not-yet-valid grants cannot elevate access", () => {
  for (const change of [
    { expires_at: now },
    { revoked: true },
    { valid_from: now + 1 },
  ]) {
    const f = facts();
    f.membership_role = "viewer";
    f.grants = [
      rule({ action: "resource.update", effect: "allow", ...change }),
    ];
    assert.equal(evaluate(f).outcome, "deny");
  }
});
test("policy: exact grant can authorize an action without wildcard expansion", () => {
  const f = facts();
  f.membership_role = "viewer";
  f.grants = [rule({ action: "workspace.write", effect: "allow" })];
  assert.equal(evaluate(f, "workspace.write").outcome, "allow");
  assert.equal(evaluate(f).outcome, "deny");
});
test("policy: read-only organization mode overrides all write grants", () => {
  const f = facts();
  f.write_mode = "read_only";
  f.grants = [rule({ action: "resource.update", effect: "allow" })];
  assert.equal(evaluate(f).reason, "read_only_environment");
  assert.equal(evaluate(f, "resource.read").outcome, "allow");
});
for (const role of ["owner", "member"]) {
  test(`policy: ${role} cannot bypass production approval`, () => {
    const f = facts();
    f.membership_role = role;
    f.resource.environment = "production";
    assert.equal(evaluate(f).outcome, "needs_approval");
  });
}
test("policy: staging mutation needs owner or approval, not mere scoped editor", () => {
  const f = facts();
  f.resource.environment = "staging";
  assert.equal(evaluate(f).outcome, "needs_approval");
  f.membership_role = "owner";
  assert.equal(evaluate(f).outcome, "allow");
});
test("policy: release deployment always needs approval; role refusal still comes first", () => {
  const f = facts();
  f.resource.kind = "release";
  assert.equal(evaluate(f, "release.deploy").outcome, "deny");
  f.membership_role = "owner";
  assert.equal(evaluate(f, "release.deploy").outcome, "needs_approval");
});
test("policy: confidential export cannot be auto-approved", () => {
  const f = facts();
  f.membership_role = "owner";
  f.resource.sensitivity = "confidential";
  assert.equal(evaluate(f, "resource.export").outcome, "needs_approval");
});
test("policy: decisions are frozen diagnostics bounded by fact validity", () => {
  const f = facts();
  f.grants = [
    rule({ action: "resource.read", effect: "deny", valid_from: now + 10 }),
  ];
  const d = evaluate(f);
  assert.equal(d.expires_at, new Date(now + 10).toISOString());
  assert.deepEqual(
    [d.policy_revision, d.membership_version, d.resource_version, d.reusable],
    [4, 3, 2, false],
  );
  assert.ok(Object.isFrozen(d));
  assert.throws(() => {
    d.outcome = "allow";
  });
  assert.ok(Object.isFrozen(ACTIONS));
});
test("policy: evaluator is deterministic and does not mutate its inputs", () => {
  const f = facts(),
    saved = structuredClone(f);
  assert.deepEqual(evaluate(f), evaluate(f));
  assert.deepEqual(f, saved);
});
test("policy tools: tool arguments cannot inject role, tenant, environment or approval", () => {
  for (const key of [
    "org_id",
    "role",
    "environment",
    "approval",
    "session_digest",
    "principal",
  ]) {
    assert.throws(() =>
      parseCatalogTool({
        operation: "catalog.read",
        resource_id: uuid(3),
        [key]: "spoof",
      }),
    );
  }
});
test("policy tools: unknown tools and malformed mutations fail closed", () => {
  for (const v of [
    null,
    [],
    { operation: "shell", resource_id: uuid(3) },
    { operation: "catalog.rename", resource_id: uuid(3) },
    { operation: "catalog.read", resource_id: "REQ-1" },
  ])
    assert.throws(() => parseCatalogTool(v));
});
test("policy tools: bound credentials are never published and every invocation reaches authority", async () => {
  let calls = 0;
  const scope = {
    session_digest: "a".repeat(64),
    org_id: uuid(2),
    context_version: 2,
  };
  const repo = {
    async readResource(s, r) {
      assert.equal(s.org_id, uuid(2));
      assert.equal(r, uuid(3));
      calls++;
      return { fixture_only: true };
    },
  };
  const tool = createCatalogTools(repo, scope);
  scope.org_id = uuid(9);
  await tool.invoke({ operation: "catalog.read", resource_id: uuid(3) });
  await tool.invoke({ operation: "catalog.read", resource_id: uuid(3) });
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(tool).includes("session_digest"));
});
