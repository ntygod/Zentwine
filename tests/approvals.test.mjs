import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateApprovalInput,
  validateApprovalGuard,
  validateApprovalExecution,
  approvalSource,
  requireIndependentReviewer,
  matchesApprovedOperation,
  validApprovalCursor,
  ApprovalError,
} from "../packages/policy/dist/index.js";
import { buildApp } from "../services/api/dist/app.js";
import { createApprovedCatalogTool } from "../services/api/dist/approvals/tools.js";
import {
  secret,
  csrfFor,
  cookie,
} from "../services/api/dist/identity/security.js";
const input = () => ({
  request_id: randomUUID(),
  resource_id: randomUUID(),
  operation: "catalog.rename",
  display_name: "New name",
  expected_version: 1,
  expected_policy_revision: 2,
  review: "required",
});
const guard = { expected_version: 1, content_hash: "a".repeat(64) };
const execution = () => ({
  ...guard,
  resource_id: randomUUID(),
  operation: "catalog.rename",
  display_name: "New name",
  expected_resource_version: 1,
  expected_policy_revision: 2,
});
const denied = (e) => e instanceof ApprovalError;
test("approval rules: explicit complete input and guard validate", () => {
  assert.doesNotThrow(() => validateApprovalInput(input()));
  assert.doesNotThrow(() => validateApprovalGuard(guard));
  assert.doesNotThrow(() => validateApprovalExecution(execution()));
});
for (const [k, v] of Object.entries({
  request_id: "not-id",
  resource_id: "foreign",
  operation: "release.deploy",
  display_name: " ",
  expected_version: 0,
  expected_policy_revision: -1,
  review: "auto-approve",
  role: "owner",
  environment: "development",
  approved: true,
}))
  test("approval rules: rejects invalid or authority field " + k, () =>
    assert.throws(() => validateApprovalInput({ ...input(), [k]: v }), denied),
  );
for (const value of [null, [], {}, Object.create(null)])
  test(
    "approval rules: incomplete input " +
      String(
        value === null
          ? "null"
          : Array.isArray(value)
            ? "array"
            : Object.getPrototypeOf(value) === null
              ? "no prototype"
              : "object",
      ),
    () => assert.throws(() => validateApprovalInput(value), denied),
  );
test("approval rules: guard requires exact hash and bounded version", () => {
  for (const v of [
    { ...guard, content_hash: "ABC" },
    { ...guard, expected_version: 0 },
    { ...guard, approved: true },
  ])
    assert.throws(() => validateApprovalGuard(v), denied);
});
test("approval rules: policy allow is not a human decision", () => {
  assert.equal(
    approvalSource({ outcome: "allow" }, "policy"),
    "preauthorized_policy",
  );
  assert.equal(approvalSource({ outcome: "allow" }, "required"), "pending");
  assert.equal(
    approvalSource({ outcome: "needs_approval" }, "policy"),
    "pending",
  );
  assert.throws(() => approvalSource({ outcome: "deny" }, "policy"), denied);
});
test("approval rules: only independent eligible owner reviews", () => {
  const a = randomUUID(),
    b = randomUUID(),
    allow = { outcome: "allow" },
    needs = { outcome: "needs_approval" },
    deny = { outcome: "deny" };
  assert.doesNotThrow(() =>
    requireIndependentReviewer(a, b, "owner", allow, needs),
  );
  for (const args of [
    [a, a, "owner", allow, allow],
    [a, b, "member", allow, allow],
    [a, b, "owner", deny, allow],
    [a, b, "owner", allow, deny],
  ])
    assert.throws(() => requireIndependentReviewer(...args), denied);
});
for (const [k, v] of Object.entries({
  resource_id: randomUUID(),
  operation: "catalog.read",
  display_name: "Tampered",
  expected_resource_version: 2,
  expected_policy_revision: 3,
}))
  test("approval rules: command binding rejects " + k, () => {
    const e = execution(),
      b = { ...e, resource_version: 1, policy_revision: 2 };
    assert.equal(matchesApprovedOperation(b, e), true);
    assert.equal(matchesApprovedOperation(b, { ...e, [k]: v }), false);
  });
test("approval rules: cursors avoid numeric rounding and SQL syntax", () => {
  for (const v of ["0", "10", "9223372036854775807"])
    assert.equal(validApprovalCursor(v), true);
  for (const v of ["-1", "01", "1.1", "9223372036854775808", "1;DROP", 1, null])
    assert.equal(validApprovalCursor(v), false);
});
test("approval tool: server scope is copied and exact input is checked", async () => {
  const scope = {
    org_id: randomUUID(),
    session_digest: "a".repeat(64),
    context_version: 1,
  };
  let seen;
  const tool = createApprovedCatalogTool(
    {
      execute: async (...args) => {
        seen = args;
        return "done";
      },
    },
    scope,
    "bound-id",
    "bound-digest",
  );
  const original = scope.org_id;
  scope.org_id = randomUUID();
  const e = execution();
  assert.equal(await tool.invoke(e), "done");
  assert.equal(seen[0].org_id, original);
  assert.equal(seen[1], "bound-id");
  assert.equal(seen[3], "bound-digest");
  await assert.rejects(tool.invoke({ ...e, role: "owner" }), denied);
});
const origin = "http://127.0.0.1:5173";
async function http(work) {
  let calls = 0;
  const repository = new Proxy(
    {},
    {
      get: () => async () => {
        calls++;
        return {};
      },
    },
  );
  const app = buildApp({
    identity: { repository: {}, origins: [origin] },
    policy: {},
    agents: {},
    approvals: repository,
  });
  const token = secret(),
    headers = {
      host: "127.0.0.1",
      origin,
      cookie: cookie(token).split(";")[0],
      "x-zentwine-client": "web",
      "x-zentwine-csrf": csrfFor(token),
      "x-zentwine-context-version": "1",
    };
  try {
    await work(app, headers, () => calls);
  } finally {
    await app.close();
  }
}
for (const [name, patch] of [
  ["foreign origin", { origin: "http://evil.invalid" }],
  ["CSRF", { "x-zentwine-csrf": "wrong" }],
  ["machine token", { authorization: "Bearer zt_agent_" + "a".repeat(43) }],
])
  test("approval HTTP: blocks " + name, () =>
    http(async (app, h, calls) => {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${randomUUID()}/approvals`,
        headers: { ...h, ...patch },
        payload: input(),
      });
      assert.equal(r.statusCode, 403);
      assert.equal(calls(), 0);
    }),
  );
test("approval HTTP: rejects forged authority before repository", () =>
  http(async (app, h, calls) => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${randomUUID()}/approvals`,
      headers: h,
      payload: { ...input(), requester_id: randomUUID() },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(calls(), 0);
  }));
test("approval HTTP: reads never request or execute a command", () =>
  http(async (app, h, calls) => {
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${randomUUID()}/approvals/${randomUUID()}`,
      headers: h,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(calls(), 1);
  }));
test("approval API mode requires identity policy and Agent foundations", () => {
  assert.throws(() => buildApp({ approvals: {} }));
});
