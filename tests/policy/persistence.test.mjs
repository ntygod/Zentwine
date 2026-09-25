import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, query, code, request, waitForLock } from "./setup.mjs";
import {
  PostgresPolicyAdmin,
  PostgresPolicyRepository,
} from "../../packages/db/dist/index.js";
import { createCatalogTools } from "../../services/api/dist/policy/tools.js";

test("policy db: runtime role reads policy but cannot grant, bind or reclassify", () =>
  fixture(async (f) => {
    await f.policy.assertRuntimeRole();
    await assert.rejects(
      new PostgresPolicyRepository(f.adminPool).assertRuntimeRole(),
    );
    const actor = await f.auth();
    await f.policy.readResource(actor.scope, f.a.id);
    for (const sql of [
      "UPDATE zentwine_policy.organization_policies SET write_mode='active'",
      "UPDATE zentwine_policy.resources SET environment='development'",
      "DELETE FROM zentwine_policy.resource_grants",
      "UPDATE zentwine_identity.humans SET status='active'",
    ])
      await assert.rejects(query(f.appPool, sql));
    await assert.rejects(
      new PostgresPolicyAdmin(f.appPool).setWriteMode(
        f.orgA,
        "read_only",
        await f.revision(),
      ),
      code("unavailable"),
    );
  }));
test("policy db: organization member reads shared resource, viewer cannot mutate", () =>
  fixture(async (f) => {
    const owner = await f.auth(),
      viewer = await f.auth(f.alice, f.orgB),
      member = await f.auth(f.bob, f.orgB);
    assert.equal(
      (await f.policy.evaluate(owner.scope, f.a.id, "resource.update")).outcome,
      "allow",
    );
    assert.equal(
      (await f.policy.evaluate(viewer.scope, f.b.id, "resource.update"))
        .outcome,
      "deny",
    );
    assert.equal(
      (await f.policy.evaluate(member.scope, f.b.id, "resource.update"))
        .outcome,
      "allow",
    );
  }));
test("policy db: absent, foreign and inaccessible private IDs all return unavailable", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      privateResource = await f.register({ visibility: "restricted" });
    for (const rid of [randomUUID(), f.b.id, privateResource.id]) {
      await assert.rejects(
        f.policy.readResource(auth.scope, rid),
        code("unavailable_resource"),
      );
      await assert.rejects(
        f.policy.evaluate(auth.scope, rid, "resource.update"),
        code("unavailable_resource"),
      );
    }
  }));
test("policy db: exact reader binding does not grant private editing", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      r = await f.register({ visibility: "restricted" });
    await f.add(f.alice, r, { role: "reader" });
    assert.equal(
      (await f.policy.readResource(auth.scope, r.id)).resource.id,
      r.id,
    );
    await assert.rejects(
      f.policy.renameResource(
        auth.scope,
        r.id,
        "denied",
        1,
        await f.revision(),
      ),
      code("forbidden"),
    );
  }));
test("policy db: scoped editor elevates viewer only on the bound resource", () =>
  fixture(async (f) => {
    const auth = await f.auth(f.alice, f.orgB);
    await f.add(f.alice, f.b, { role: "editor" });
    assert.equal(
      (
        await f.policy.renameResource(
          auth.scope,
          f.b.id,
          "Edited",
          1,
          await f.revision(f.orgB),
        )
      ).resource.object_version,
      2,
    );
    const other = await f.register({ org_id: f.orgB });
    await assert.rejects(
      f.policy.renameResource(
        auth.scope,
        other.id,
        "denied",
        1,
        await f.revision(f.orgB),
      ),
      code("forbidden"),
    );
  }));
test("policy db: explicit deny overrides owner and positive grant", () =>
  fixture(async (f) => {
    const auth = await f.auth();
    await f.add(f.alice, f.a);
    await f.add(f.alice, f.a, { effect: "deny" });
    assert.equal(
      (await f.policy.evaluate(auth.scope, f.a.id, "resource.update")).reason,
      "explicit_deny",
    );
    await assert.rejects(
      f.policy.renameResource(
        auth.scope,
        f.a.id,
        "denied",
        1,
        await f.revision(),
      ),
      code("forbidden"),
    );
  }));
test("policy db: revoked binding is re-read, previous allow is not a reusable permit", () =>
  fixture(async (f) => {
    const auth = await f.auth(f.alice, f.orgB),
      rule = await f.add(f.alice, f.b, { role: "editor" });
    const d = await f.policy.evaluate(auth.scope, f.b.id, "resource.update");
    assert.equal(d.outcome, "allow");
    await f.operator.revokeRule(
      f.orgB,
      rule.id,
      "binding",
      await f.revision(f.orgB),
    );
    await assert.rejects(
      f.policy.renameResource(auth.scope, f.b.id, "no", 1, d.policy_revision),
      code("forbidden"),
    );
  }));
test("policy db: unknown action never inherits resource read permission", () =>
  fixture(async (f) => {
    const auth = await f.auth();
    assert.equal(
      (await f.policy.evaluate(auth.scope, f.a.id, "toString")).reason,
      "unknown_action",
    );
  }));
test("policy db: production mutations require approval with no side effects", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      r = await f.register({ environment: "production" });
    assert.equal(
      (await f.policy.evaluate(auth.scope, r.id, "resource.update")).outcome,
      "needs_approval",
    );
    await assert.rejects(
      f.policy.renameResource(auth.scope, r.id, "no", 1, await f.revision()),
      code("approval_required"),
    );
    assert.equal(
      (await f.policy.readResource(auth.scope, r.id)).resource.object_version,
      1,
    );
  }));
test("policy db: read-only mode blocks write, leaves read available", () =>
  fixture(async (f) => {
    const auth = await f.auth();
    await f.operator.setWriteMode(f.orgA, "read_only", await f.revision());
    await assert.rejects(
      f.policy.renameResource(auth.scope, f.a.id, "no", 1, await f.revision()),
      code("forbidden"),
    );
    assert.equal(
      (await f.policy.readResource(auth.scope, f.a.id)).decision.outcome,
      "allow",
    );
  }));
test("policy db: exact resource and policy versions prevent stale mutations", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      rev = await f.revision();
    await assert.rejects(
      f.policy.renameResource(auth.scope, f.a.id, "no", 2, rev),
      code("version_conflict"),
    );
    await f.operator.setWriteMode(f.orgA, "active", rev);
    await assert.rejects(
      f.policy.renameResource(auth.scope, f.a.id, "no", 1, rev),
      code("version_conflict"),
    );
    assert.equal(
      (await f.policy.readResource(auth.scope, f.a.id)).resource.display_name,
      "Synthetic catalog",
    );
  }));
test("policy db: parallel writes commit one version, not duplicate effects", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      rev = await f.revision();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        f.policy.renameResource(auth.scope, f.a.id, "Renamed", 1, rev),
      ),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      results.filter(
        (x) => x.status === "rejected" && x.reason.code === "version_conflict",
      ).length,
      3,
    );
    assert.equal(
      (await f.policy.readResource(auth.scope, f.a.id)).resource.object_version,
      2,
    );
  }));
test("policy db: invalid foreign rule rolls back policy revision", () =>
  fixture(async (f) => {
    const rev = await f.revision();
    await assert.rejects(f.add(f.bob, f.a));
    assert.equal(await f.revision(), rev);
  }));
test("policy db: member revocation denies next request across every adapter", () =>
  fixture(async (f) => {
    const auth = await f.auth(f.bob, f.orgB),
      tool = createCatalogTools(f.policy, auth.scope);
    await tool.invoke({ operation: "catalog.read", resource_id: f.b.id });
    await f.admin.setMembership(
      randomUUID(),
      f.orgB,
      f.bob,
      "MEM-2",
      "member",
      "revoked",
    );
    await assert.rejects(
      tool.invoke({ operation: "catalog.read", resource_id: f.b.id }),
      code("unavailable_resource"),
    );
    await assert.rejects(
      f.policy.readResource(auth.scope, f.b.id),
      code("unavailable_resource"),
    );
  }));
test("policy db: old organization window, revoked session and identity are rejected", () =>
  fixture(async (f) => {
    const auth = await f.auth();
    await f.repo.selectOrganization(auth.scope.session_digest, f.orgB, 2);
    await assert.rejects(
      f.policy.readResource(auth.scope, f.a.id),
      code("version_conflict"),
    );
    const next = await f.auth();
    await f.repo.revokeSession(next.scope.session_digest);
    await assert.rejects(
      f.policy.readResource(next.scope, f.a.id),
      code("authentication_required"),
    );
    const third = await f.auth();
    await f.admin.setHumanStatus(f.alice, "disabled");
    await assert.rejects(
      f.policy.readResource(third.scope, f.a.id),
      code("authentication_required"),
    );
  }));
test("policy db: role downgrades and organization disable are not cached", () =>
  fixture(async (f) => {
    const auth = await f.auth();
    await f.policy.readResource(auth.scope, f.a.id);
    await f.admin.setMembership(
      randomUUID(),
      f.orgA,
      f.alice,
      "MEM-1",
      "viewer",
      "active",
    );
    await assert.rejects(
      f.policy.renameResource(auth.scope, f.a.id, "no", 1, await f.revision()),
      code("forbidden"),
    );
    await f.admin.setOrganizationStatus(f.orgA, "disabled");
    await assert.rejects(
      f.policy.readResource(auth.scope, f.a.id),
      code("unavailable_resource"),
    );
  }));
test("policy db: waiting command rechecks grant expiration after resource lock", () =>
  fixture(async (f) => {
    const auth = await f.auth(f.alice, f.orgB);
    await f.add(f.alice, f.b, { role: "editor", expires_at: Date.now() + 500 });
    const c = await f.adminPool.connect();
    await c.query("BEGIN");
    await c.query(
      "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
      [f.b.id],
    );
    const pending = f.policy.renameResource(
      auth.scope,
      f.b.id,
      "no",
      1,
      await f.revision(f.orgB),
    );
    const rejected = assert.rejects(pending, code("forbidden"));
    try {
      await waitForLock(f.adminPool, "resources");
      await new Promise((r) => setTimeout(r, 550));
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    await rejected;
  }));
test("policy db: authorization and identity revocation serialize before commit", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      c = await f.adminPool.connect();
    await c.query("BEGIN");
    await c.query(
      "SELECT id FROM zentwine_policy.resources WHERE id=$1 FOR UPDATE",
      [f.a.id],
    );
    const pending = f.policy.renameResource(
      auth.scope,
      f.a.id,
      "Before revocation",
      1,
      await f.revision(),
    );
    let revoked = false,
      revocation;
    try {
      await waitForLock(f.adminPool, "resources");
      revocation = f.admin.setHumanStatus(f.alice, "disabled").then(() => {
        revoked = true;
      });
      await waitForLock(f.adminPool, "pg_advisory_xact_lock");
      assert.equal(revoked, false);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    await pending;
    await revocation;
    await assert.rejects(
      f.policy.readResource(auth.scope, f.a.id),
      code("authentication_required"),
    );
  }));
test("policy http: authenticated metadata read and mutation use the authority", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      app = f.app();
    try {
      const path = `/api/v1/orgs/${f.orgA}/resources/${f.a.id}`;
      assert.equal((await request(app, auth, "GET", path)).statusCode, 200);
      const r = await request(app, auth, "PATCH", path, {
        display_name: "Via HTTP",
        expected_version: 1,
        expected_policy_revision: await f.revision(),
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().resource.object_version, 2);
    } finally {
      await app.close();
    }
  }));
test("policy http: evaluate reports unknown action denial and production approval", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      r = await f.register({ environment: "production" }),
      app = f.app();
    try {
      const path = `/api/v1/orgs/${f.orgA}/policy/evaluate`;
      const a = await request(app, auth, "POST", path, {
        resource_id: r.id,
        action: "not.real",
      });
      assert.equal(a.statusCode, 200);
      assert.equal(a.json().outcome, "deny");
      const b = await request(app, auth, "POST", path, {
        resource_id: r.id,
        action: "resource.update",
      });
      assert.equal(b.json().outcome, "needs_approval");
      const c = await request(
        app,
        auth,
        "PATCH",
        `/api/v1/orgs/${f.orgA}/resources/${r.id}`,
        {
          display_name: "no",
          expected_version: 1,
          expected_policy_revision: await f.revision(),
        },
      );
      assert.equal(c.statusCode, 403);
      assert.equal(c.json().code, "approval_required");
    } finally {
      await app.close();
    }
  }));
test("policy http: spoofed roles environments and approvals rejected by strict schema", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      app = f.app();
    try {
      for (const key of ["role", "environment", "approval", "human_id"]) {
        const r = await request(
          app,
          auth,
          "POST",
          `/api/v1/orgs/${f.orgA}/policy/evaluate`,
          { resource_id: f.a.id, action: "resource.update", [key]: "fake" },
        );
        assert.equal(r.statusCode, 400);
      }
    } finally {
      await app.close();
    }
  }));
test("policy http: origin CSRF and missing cookies cannot reach authorized actions", () =>
  fixture(async (f) => {
    const auth = await f.auth(),
      app = f.app(),
      url = `/api/v1/orgs/${f.orgA}/resources/${f.a.id}`,
      payload = {
        display_name: "no",
        expected_version: 1,
        expected_policy_revision: await f.revision(),
      };
    try {
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      assert.equal(
        (await request(app, { ...auth, csrf: "bad" }, "PATCH", url, payload))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url,
            headers: { origin: "http://evil.invalid", cookie: auth.cookie },
            payload,
          })
        ).statusCode,
        403,
      );
    } finally {
      await app.close();
    }
  }));
test("policy http and tools: denial equivalence without calling the frontend", () =>
  fixture(async (f) => {
    const auth = await f.auth(f.alice, f.orgB),
      app = f.app();
    try {
      const r = await request(
        app,
        auth,
        "PATCH",
        `/api/v1/orgs/${f.orgB}/resources/${f.b.id}`,
        {
          display_name: "no",
          expected_version: 1,
          expected_policy_revision: await f.revision(f.orgB),
        },
      );
      assert.equal(r.statusCode, 403);
      await assert.rejects(
        createCatalogTools(f.policy, auth.scope).invoke({
          operation: "catalog.rename",
          resource_id: f.b.id,
          display_name: "no",
          expected_version: 1,
          expected_policy_revision: await f.revision(f.orgB),
        }),
        code("forbidden"),
      );
    } finally {
      await app.close();
    }
  }));
test("policy db: storage outage fails closed with a fixed diagnostic", async () => {
  const repo = new PostgresPolicyRepository({
    async connect() {
      throw new Error("secret SQL and credentials");
    },
  });
  await assert.rejects(
    repo.readResource(
      {
        session_digest: "a".repeat(64),
        org_id: randomUUID(),
        context_version: 1,
      },
      randomUUID(),
    ),
    (e) => e.code === "unavailable" && !e.message.includes("secret"),
  );
});
