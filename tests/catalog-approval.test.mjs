import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  catalogApprovalPath,
  parseCatalogApprovalPath,
  parseCatalogApproval,
  catalogApprovalActions,
} from "../packages/contracts/dist/index.js";
import {
  CatalogApprovalController,
  verifyCatalogApproval,
} from "../packages/client/dist/catalog-approval.js";
const org = randomUUID(),
  other = randomUUID(),
  rid = randomUUID(),
  human = randomUUID(),
  reviewer = randomUUID(),
  aid = randomUUID();
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
const digest = (b) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(b)
            .sort()
            .map((k) => [k, b[k]]),
        ),
      ),
    )
    .digest("hex");
const member = (who = human, role = "owner") => ({
  id: randomUUID(),
  human_id: who,
  display_name: "Synthetic member",
  display_number: "MEM-1",
  role,
  access_kind: "member",
  access_expires_at: null,
  status: "active",
  object_version: 1,
  managed_by_connection: false,
});
const resource = () => ({
  resource: {
    id: rid,
    org_id: org,
    kind: "workspace",
    display_name: "Before",
    visibility: "organization",
    environment: "development",
    sensitivity: "internal",
    owner_human_id: human,
    status: "active",
    object_version: 2,
  },
  decision: {
    schema_version: "1.0.0",
    outcome: "allow",
    reason: "allowed",
    policy_version: "1.0.0",
    policy_revision: 1,
    membership_version: 1,
    resource_version: 2,
    evaluated_at: "2026-09-26T00:00:00.000Z",
    expires_at: "2026-09-26T00:00:15.000Z",
    reusable: false,
  },
});
function approval(state = "pending") {
  const binding = {
    schema_version: "1.0.0",
    canonicalization_version: "sorted-json-v1",
    org_id: org,
    requester_id: human,
    operation: "catalog.rename",
    action: "resource.update",
    resource_id: rid,
    resource_version: 2,
    environment: "development",
    display_name: "After",
    policy_revision: 1,
    auth_version: 1,
    membership_version: 1,
    organization_version: 1,
  };
  const content_hash = digest(binding);
  return {
    id: aid,
    org_id: org,
    requester_id: human,
    object_version: {
      pending: 1,
      approved: 2,
      issued: 3,
      consumed: 4,
      rejected: 2,
      revoked: 2,
    }[state],
    state,
    content_hash,
    binding,
    expires_at: "2026-10-01T00:00:00.000Z",
    decision:
      state === "pending" || state === "revoked"
        ? null
        : {
            actor_id: reviewer,
            source: "human",
            outcome: state === "rejected" ? "reject" : "approve",
          },
    receipt:
      state !== "consumed"
        ? null
        : {
            approval_id: aid,
            content_hash,
            resource: {
              ...resource().resource,
              object_version: 3,
              display_name: "After",
            },
          },
    reusable: false,
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
/** Synthetic transport tests. Separate Chromium/PG suite is required for real authorization evidence. */
function fixture(mode = "inspect", state = "pending", who = human) {
  const f = {
    a: approval(state),
    resource: resource(),
    member: member(who),
    calls: [],
    override: null,
  };
  f.auth = {
    schema_version: "1.0.0",
    csrf_token: "a".repeat(43),
    session: {
      id: randomUUID(),
      human: { id: who, display_name: "Synthetic member" },
      expires_at: "2026-10-01T00:00:00.000Z",
      context_version: 1,
      active_org_id: org,
      organizations: [
        { id: org, display_name: "Org A" },
        { id: other, display_name: "Org B" },
      ],
    },
  };
  f.controller = new CatalogApprovalController(
    { org, mode, id: mode === "inspect" ? aid : rid },
    async (path, options) => {
      f.calls.push({ path, options });
      const replacement = await f.override?.(path, options);
      if (replacement) return replacement;
      if (path.endsWith("organization-capabilities"))
        return json({ schema_version: "1.0.0", enabled: true });
      if (path.endsWith("/auth/session")) return json(f.auth);
      if (path.endsWith("organization-self")) return json(f.member);
      if (path.includes("/resources/")) return json(f.resource);
      if (path.endsWith("/auth/organization")) {
        f.auth.session.context_version++;
        f.auth.session.active_org_id = org;
        return json(f.auth);
      }
      if (path.endsWith("/approvals") && options.method === "POST")
        return json(f.a);
      if (path.endsWith("/approvals/" + aid)) return json(f.a);
      if (path.endsWith("/decide")) {
        const body = JSON.parse(options.body);
        f.a = {
          ...f.a,
          state: body.outcome === "approve" ? "approved" : "rejected",
          object_version: f.a.object_version + 1,
          decision: { actor_id: who, source: "human", outcome: body.outcome },
        };
        return json(f.a);
      }
      if (path.endsWith("/revoke")) {
        f.a = {
          ...f.a,
          state: "revoked",
          object_version: f.a.object_version + 1,
        };
        return json(f.a);
      }
      if (path.endsWith("/permit")) {
        f.a = {
          ...f.a,
          state: "issued",
          object_version: f.a.object_version + 1,
        };
        return json({
          approval: f.a,
          permit: "zt_permit_" + "p".repeat(43),
          expires_at: f.a.expires_at,
          credential_recoverable: false,
        });
      }
      if (path.endsWith("/execute")) {
        f.a = approval("consumed");
        return json(f.a);
      }
      throw new Error("Unexpected path");
    },
  );
  return f;
}
const writes = (f) => f.calls.filter((c) => c.options.method === "POST");
test("catalog approval route: strict request and inspection locators reject ambiguity", () => {
  for (const mode of ["request", "inspect"]) {
    const path = catalogApprovalPath(org, mode, rid);
    assert.deepEqual(parseCatalogApprovalPath(path), { org, mode, id: rid });
    for (const bad of [
      path + "/",
      path + "?permit=x",
      path + "#x",
      path.replace(rid, "bad"),
      path.replace(org, "local"),
      path.replace(rid, rid.toUpperCase()),
      "https://evil.test" + path,
    ])
      assert.equal(parseCatalogApprovalPath(bad), null);
  }
  assert.throws(() => catalogApprovalPath(org, "execute", rid));
});
test("catalog approval decoder: all recorded states preserve history not current permits", async () => {
  for (const state of [
    "pending",
    "approved",
    "issued",
    "rejected",
    "revoked",
    "consumed",
  ]) {
    const a = approval(state);
    assert.deepEqual(await verifyCatalogApproval(a, org, aid), a);
  }
  const a = approval("approved");
  a.decision = {
    actor_id: human,
    source: "preauthorized_policy",
    outcome: "approve",
  };
  assert.deepEqual(parseCatalogApproval(a, org, aid), a);
});
for (const [label, patch] of Object.entries({
  wrong_org: { org_id: other },
  wrong_id: { id: rid },
  hash: { content_hash: "x" },
  raw: { raw_secret: "not allowed" },
  version: { object_version: 0 },
  reusable: { reusable: true },
  invalid_time: { expires_at: "bad" },
  unexpected_state: { state: "executing" },
}))
  test("catalog approval decoder rejects " + label, () =>
    assert.throws(
      () => parseCatalogApproval({ ...approval(), ...patch }, org, aid),
      TypeError,
    ),
  );
test("catalog approval decoder: binding, independent actor and receipt cannot contradict root", () => {
  for (const a of [
    { ...approval(), binding: { ...approval().binding, org_id: other } },
    {
      ...approval(),
      binding: { ...approval().binding, operation: "run.start" },
    },
    { ...approval(), binding: { ...approval().binding, resource_version: 0 } },
    {
      ...approval("approved"),
      decision: { actor_id: human, source: "human", outcome: "approve" },
    },
    { ...approval("pending"), decision: approval("approved").decision },
    { ...approval("approved"), decision: null },
    { ...approval("consumed"), receipt: null },
    {
      ...approval("consumed"),
      receipt: {
        ...approval("consumed").receipt,
        resource: {
          ...approval("consumed").receipt.resource,
          display_name: "Different",
        },
      },
    },
  ])
    assert.throws(() => parseCatalogApproval(a, org, aid), TypeError);
});
test("catalog approval digest: altered content is rejected even with a valid-looking hash", async () => {
  const a = approval();
  a.binding.display_name = "Tampered";
  await assert.rejects(verifyCatalogApproval(a, org, aid));
});
test("catalog approval affordances: no self-approval and no guest controls", () => {
  assert.deepEqual(catalogApprovalActions(approval(), member()), ["revoke"]);
  assert.deepEqual(catalogApprovalActions(approval(), member(reviewer)), [
    "approve",
    "reject",
    "revoke",
  ]);
  assert.deepEqual(catalogApprovalActions(approval("approved"), member()), [
    "execute",
    "revoke",
  ]);
  assert.deepEqual(catalogApprovalActions(approval("issued"), member()), [
    "revoke",
  ]);
  assert.deepEqual(
    catalogApprovalActions(approval(), { ...member(), access_kind: "guest" }),
    [],
  );
});
test("catalog approval controller: reload is read-only and stored approval is not auto-executed", async () => {
  const f = fixture("inspect", "approved");
  await f.controller.reload();
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "ready");
  assert.equal(writes(f).length, 0);
  assert.ok(Object.isFrozen(f.controller.getSnapshot().approval.binding));
});
test("catalog approval controller: explicit creation is required-review with exact resource versions", async () => {
  const f = fixture("request");
  await f.controller.reload();
  assert.equal(
    await f.controller.request("After"),
    catalogApprovalPath(org, "inspect", aid),
  );
  const call = writes(f)[0],
    b = JSON.parse(call.options.body);
  assert.equal(b.review, "required");
  assert.equal(b.operation, "catalog.rename");
  assert.equal(b.expected_version, 2);
  assert.equal(b.expected_policy_revision, 1);
  assert.match(b.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(call.options.credentials, "same-origin");
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.headers["x-zentwine-csrf"], f.auth.csrf_token);
});
test("catalog approval controller: double click cannot duplicate a write", async () => {
  const f = fixture("request"),
    d = deferred();
  await f.controller.reload();
  f.override = (p, o) => (o.method === "POST" ? d.promise : null);
  const first = f.controller.request("After");
  assert.equal(f.controller.getSnapshot().status, "loading");
  assert.equal(await f.controller.request("Another"), null);
  d.resolve(json(f.a));
  await first;
  assert.equal(writes(f).length, 1);
});
test("catalog approval controller: failed creation retains only explicit same-request recovery", async () => {
  const f = fixture("request");
  await f.controller.reload();
  f.override = (p, o) => {
    if (o.method === "POST") throw new Error("offline");
  };
  await f.controller.request("After");
  assert.equal(f.controller.getSnapshot().uncertain, true);
  const first = JSON.parse(writes(f)[0].options.body);
  f.override = null;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().retryRequest, true);
  assert.equal(writes(f).length, 1);
  await f.controller.retryRequest();
  assert.deepEqual(JSON.parse(writes(f)[1].options.body), first);
});
test("catalog approval controller: changing session context discards pending creation recovery", async () => {
  const f = fixture("request");
  await f.controller.reload();
  f.override = (p, o) => {
    if (o.method === "POST") throw new Error("offline");
  };
  await f.controller.request("After");
  f.override = null;
  f.auth.session.context_version++;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().retryRequest, false);
  await f.controller.retryRequest();
  assert.equal(writes(f).length, 1);
});
test("catalog approval controller: forbidden creation is not described as recoverable same request", async () => {
  const f = fixture("request");
  await f.controller.reload();
  f.override = (p, o) =>
    o.method === "POST" ? json({ code: "forbidden" }, 403) : null;
  await f.controller.request("After");
  assert.equal(f.controller.getSnapshot().uncertain, false);
  f.override = null;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().retryRequest, false);
});
test("catalog approval controller: decision uses the confirmed guard and stops before permits", async () => {
  const f = fixture("inspect", "pending", reviewer);
  await f.controller.reload();
  const before = f.controller.getSnapshot().approval;
  await f.controller.command("approve");
  assert.deepEqual(JSON.parse(writes(f)[0].options.body), {
    expected_version: before.object_version,
    content_hash: before.content_hash,
    outcome: "approve",
  });
  assert.equal(f.controller.getSnapshot().approval.state, "approved");
  assert.equal(writes(f).length, 1);
});
test("catalog approval controller: requester and non-owner cannot send approval commands", async () => {
  for (const f of [fixture(), fixture("inspect", "pending", reviewer)]) {
    if (f.member.human_id === reviewer) f.member.role = "member";
    await f.controller.reload();
    await f.controller.command("approve");
    assert.equal(writes(f).length, 0);
  }
});
test("catalog approval controller: changed version response is not accepted as confirmed decision", async () => {
  const f = fixture("inspect", "pending", reviewer);
  await f.controller.reload();
  f.override = (p) =>
    p.endsWith("/decide")
      ? json({ ...approval("approved"), object_version: 99 })
      : null;
  await f.controller.command("approve");
  assert.equal(f.controller.getSnapshot().status, "error");
});
test("catalog approval controller: exact permit and execute chain has no token in published state", async () => {
  const f = fixture("inspect", "approved");
  await f.controller.reload();
  const states = [];
  f.controller.subscribe(() =>
    states.push(JSON.stringify(f.controller.getSnapshot())),
  );
  await f.controller.command("execute");
  assert.equal(f.controller.getSnapshot().approval.state, "consumed");
  assert.deepEqual(
    writes(f).map((c) => c.path.split("/").at(-1)),
    ["permit", "execute"],
  );
  const b = JSON.parse(writes(f)[1].options.body);
  assert.equal(b.expected_version, 3);
  assert.equal(b.expected_resource_version, 2);
  assert.equal(b.display_name, "After");
  assert.ok(!states.join("").includes("zt_permit_"));
});
test("catalog approval controller: lost permit response only allows read reconciliation then revocation", async () => {
  const f = fixture("inspect", "approved");
  await f.controller.reload();
  f.override = (p) => {
    if (p.endsWith("/permit")) {
      f.a = approval("issued");
      throw new Error("response lost");
    }
  };
  await f.controller.command("execute");
  assert.equal(f.controller.getSnapshot().uncertain, true);
  f.override = null;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().approval.state, "issued");
  await f.controller.command("execute");
  assert.equal(writes(f).length, 1);
  await f.controller.reload();
  await f.controller.command("revoke");
  assert.equal(f.controller.getSnapshot().approval.state, "revoked");
});
test("catalog approval controller: lost execution response is reconciled without another command", async () => {
  const f = fixture("inspect", "approved");
  await f.controller.reload();
  f.override = (p) => {
    if (p.endsWith("/execute")) {
      f.a = approval("consumed");
      throw new Error("response lost");
    }
  };
  await f.controller.command("execute");
  f.override = null;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().approval.state, "consumed");
  assert.equal(writes(f).length, 2);
});
test("catalog approval controller: suspend before late permit prevents execute and drops result", async () => {
  const f = fixture("inspect", "approved"),
    d = deferred();
  await f.controller.reload();
  f.override = (p) => (p.endsWith("/permit") ? d.promise : null);
  const pending = f.controller.command("execute");
  f.controller.suspend();
  d.resolve(
    json({
      approval: approval("issued"),
      permit: "zt_permit_" + "p".repeat(43),
      expires_at: f.a.expires_at,
      credential_recoverable: false,
    }),
  );
  await pending;
  assert.equal(f.controller.getSnapshot().status, "suspended");
  assert.equal(writes(f).length, 1);
});
test("catalog approval controller: forged permit envelope never triggers execute", async () => {
  const f = fixture("inspect", "approved");
  await f.controller.reload();
  f.override = (p) =>
    p.endsWith("/permit")
      ? json({
          approval: approval("issued"),
          permit: "zt_permit_" + "p".repeat(43),
          expires_at: f.a.expires_at,
          credential_recoverable: true,
        })
      : null;
  await f.controller.command("execute");
  assert.equal(f.controller.getSnapshot().status, "error");
  assert.equal(writes(f).length, 1);
});
test("catalog approval controller: stale read cannot fill suspended content", async () => {
  const f = fixture(),
    d = deferred();
  f.override = (p) => (p.endsWith("/approvals/" + aid) ? d.promise : null);
  const pending = f.controller.reload();
  for (
    let i = 0;
    i < 20 && !f.calls.some((c) => c.path.endsWith("/approvals/" + aid));
    i++
  )
    await new Promise((r) => setImmediate(r));
  f.controller.suspend();
  d.resolve(json(f.a));
  await pending;
  assert.equal(f.controller.getSnapshot().status, "suspended");
});
test("catalog approval controller: other-organization deep link needs explicit switch", async () => {
  const f = fixture();
  f.auth.session.active_org_id = other;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "choose");
  assert.equal(writes(f).length, 0);
  await f.controller.switchOrganization();
  assert.equal(f.controller.getSnapshot().status, "ready");
  assert.equal(writes(f).length, 1);
});
test("catalog approval controller: guest is refused before any approval record read", async () => {
  const f = fixture();
  f.member.access_kind = "guest";
  f.member.role = "viewer";
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "error");
  assert.ok(!f.calls.some((c) => c.path.includes("/approvals/")));
});
