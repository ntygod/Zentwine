import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, request, agentRequest } from "./setup.mjs";
const prefix = "agent HTTP: ";
test(
  prefix +
    "owner issue child delegate invoke and revoke use real persistent authority",
  () =>
    fixture(async (f) => {
      const app = f.agentApp();
      try {
        const issue = await request(
          app,
          f.owner,
          "POST",
          `/api/v1/orgs/${f.orgA}/delegations`,
          {
            request_id: randomUUID(),
            agent_id: f.parentAgent.id,
            terms: f.terms(),
          },
        );
        assert.equal(issue.statusCode, 200);
        const root = issue.json();
        assert.match(root.credential, /^zt_agent_/);
        const delegated = await agentRequest(
          app,
          root.credential.slice(9),
          "/api/v1/agent/delegate",
          {
            request_id: randomUUID(),
            agent_id: f.childAgent.id,
            terms: { ...root.delegation.terms, max_calls: 2, max_depth: 3 },
          },
        );
        assert.equal(delegated.statusCode, 200);
        const child = delegated.json();
        const cmd = f.read();
        const first = await agentRequest(
          app,
          child.credential.slice(9),
          "/api/v1/agent/tools",
          cmd,
        );
        assert.equal(first.statusCode, 200);
        assert.equal(first.json().delegation_id, child.delegation.id);
        const parent = await f.agents.inspectOwned(
          f.owner.scope,
          root.delegation.id,
        );
        assert.equal(
          (
            await request(
              app,
              f.owner,
              "POST",
              `/api/v1/orgs/${f.orgA}/delegations/${parent.id}/revoke`,
              { expected_version: parent.object_version },
            )
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await agentRequest(
              app,
              child.credential.slice(9),
              "/api/v1/agent/tools",
              cmd,
            )
          ).statusCode,
          403,
        );
      } finally {
        await app.close();
      }
    }),
);
test(prefix + "idempotent issuance never exposes original token on retry", () =>
  fixture(async (f) => {
    const app = f.agentApp();
    try {
      const body = {
          request_id: randomUUID(),
          agent_id: f.parentAgent.id,
          terms: f.terms(),
        },
        url = `/api/v1/orgs/${f.orgA}/delegations`;
      const a = await request(app, f.owner, "POST", url, body),
        b = await request(app, f.owner, "POST", url, body);
      assert.equal(a.statusCode, 200);
      assert.equal(b.statusCode, 200);
      assert.equal(b.json().created, false);
      assert.equal(b.json().credential, null);
      assert.equal(a.json().delegation.id, b.json().delegation.id);
    } finally {
      await app.close();
    }
  }),
);
test(
  prefix + "credentials never appear in request logs or inspection responses",
  () =>
    fixture(async (f) => {
      const logs = [],
        app = f.agentApp({ logSink: (x) => logs.push(x) });
      try {
        const root = await f.issue();
        const r = await agentRequest(
          app,
          root.token,
          "/api/v1/agent/tools",
          f.read(),
        );
        assert.equal(r.statusCode, 200);
        const inspect = await agentRequest(
          app,
          root.token,
          "/api/v1/agent/self",
        );
        assert.equal(inspect.statusCode, 200);
        assert.ok(!JSON.stringify(logs).includes(root.token));
        assert.ok(!JSON.stringify(logs).includes(root.scope.credential_digest));
        assert.ok(!inspect.body.includes(root.token));
        assert.ok(!inspect.body.includes(root.scope.credential_digest));
      } finally {
        await app.close();
      }
    }),
);
test(
  prefix +
    "browser cookie cannot impersonate an Agent and Agent cannot register identities",
  () =>
    fixture(async (f) => {
      const app = f.agentApp();
      try {
        const root = await f.issue();
        const r = await request(
          app,
          f.owner,
          "POST",
          "/api/v1/agent/tools",
          f.read(),
        );
        assert.equal(r.statusCode, 403);
        const a = await agentRequest(
          app,
          root.token,
          `/api/v1/orgs/${f.orgA}/agents`,
          { request_id: randomUUID(), display_name: "Injected" },
        );
        assert.equal(a.statusCode, 403);
      } finally {
        await app.close();
      }
    }),
);
test(
  prefix +
    "malformed body cannot choose identity, budget debit, owner or environment",
  () =>
    fixture(async (f) => {
      const app = f.agentApp();
      try {
        const root = await f.issue();
        for (const key of [
          "owner",
          "scope",
          "environment",
          "credential_digest",
          "charge",
          "policy_snapshot",
        ]) {
          const r = await agentRequest(app, root.token, "/api/v1/agent/tools", {
            ...f.read(),
            [key]: "forged",
          });
          assert.equal(r.statusCode, 400);
        }
        assert.equal((await f.agents.inspect(root.scope)).used_calls, 0);
      } finally {
        await app.close();
      }
    }),
);
test(prefix + "disabled agent cannot delegate again", () =>
  fixture(async (f) => {
    const app = f.agentApp();
    try {
      const root = await f.issue();
      const r = await request(
        app,
        f.owner,
        "POST",
        `/api/v1/orgs/${f.orgA}/agents/${f.parentAgent.id}/disable`,
        { expected_version: 1 },
      );
      assert.equal(r.statusCode, 200);
      const a = await agentRequest(app, root.token, "/api/v1/agent/delegate", {
        request_id: randomUUID(),
        agent_id: f.childAgent.id,
        terms: { ...root.delegation.terms, max_calls: 2, max_depth: 3 },
      });
      assert.equal(a.statusCode, 403);
    } finally {
      await app.close();
    }
  }),
);
test(
  prefix +
    "service reconstruction preserves credentials, quota and idempotent result",
  () =>
    fixture(async (f) => {
      const root = await f.issue(),
        cmd = f.read();
      let app = f.agentApp();
      try {
        assert.equal(
          (await agentRequest(app, root.token, "/api/v1/agent/tools", cmd))
            .statusCode,
          200,
        );
      } finally {
        await app.close();
      }
      app = f.agentApp();
      try {
        const r = await agentRequest(
          app,
          root.token,
          "/api/v1/agent/tools",
          cmd,
        );
        assert.equal(r.statusCode, 200);
        assert.equal(r.json().replayed, true);
        assert.equal((await f.agents.inspect(root.scope)).used_calls, 1);
      } finally {
        await app.close();
      }
    }),
);
test(
  prefix +
    "real loopback TCP receives an authorized result, not just request injection",
  () =>
    fixture(async (f) => {
      const root = await f.issue(),
        app = f.agentApp();
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const port = app.server.address().port;
        const r = await fetch(`http://127.0.0.1:${port}/api/v1/agent/tools`, {
          method: "POST",
          headers: {
            authorization: "Bearer zt_agent_" + root.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(f.read()),
        });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).delegation_id, root.delegation.id);
      } finally {
        await app.close();
      }
    }),
);
