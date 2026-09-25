import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  fixture as policyFixture,
  query,
  request,
  waitForLock,
  origin,
} from "../policy/setup.mjs";
import { PostgresAgentRepository } from "../../packages/db/dist/index.js";
import {
  secret,
  secretDigest,
} from "../../services/api/dist/identity/security.js";
export { query, request, waitForLock, origin };
export const fails = (code) => (e) => e.code === code;
export async function fixture(work) {
  return policyFixture(async (f) => {
    await query(
      f.adminPool,
      await fs.readFile(
        "packages/db/migrations/0003-agent-delegations.up.sql",
        "utf8",
      ),
    );
    const role = f.appConfig.user;
    if (!/^zt_role_[a-f0-9]{24}$/.test(role)) throw new Error("bad test role");
    await query(
      f.adminPool,
      `GRANT USAGE ON SCHEMA zentwine_agents TO "${role}";
    GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA zentwine_agents TO "${role}";
    GRANT UPDATE(disabled_at,object_version) ON zentwine_agents.identities TO "${role}";
    GRANT UPDATE(reserved_calls,used_calls,revoked_at,object_version) ON zentwine_agents.delegations TO "${role}";`,
    );
    const agents = new PostgresAgentRepository(f.appPool),
      auth = await f.auth();
    const register = async (name = "Synthetic Agent", scope = auth.scope) =>
      agents.register(scope, randomUUID(), name);
    const parentAgent = await register("Parent"),
      childAgent = await register("Child"),
      grandAgent = await register("Grandchild");
    const terms = (overrides) => ({
      scopes: [
        {
          resource_id: f.a.id,
          actions: ["resource.read", "resource.update"],
          environment: "development",
        },
      ],
      not_before: Date.now() - 1000,
      expires_at: Date.now() + 60000,
      max_calls: 10,
      max_depth: 4,
      ...overrides,
    });
    const issue = async (overrides = {}) => {
      const token = secret(),
        r = {
          request_id: randomUUID(),
          agent_id: parentAgent.id,
          terms: terms(),
          ...overrides,
        };
      return {
        ...(await agents.issueRoot(auth.scope, r, secretDigest(token))),
        token,
        scope: { credential_digest: secretDigest(token) },
        input: r,
      };
    };
    const delegate = async (parent, overrides = {}) => {
      const token = secret(),
        r = {
          request_id: randomUUID(),
          agent_id: childAgent.id,
          terms: {
            ...parent.delegation.terms,
            max_calls: 3,
            max_depth: parent.delegation.terms.max_depth - 1,
          },
          ...overrides,
        };
      return {
        ...(await agents.delegate(parent.scope, r, secretDigest(token))),
        token,
        scope: { credential_digest: secretDigest(token) },
        input: r,
      };
    };
    const read = (rid) => ({
      request_id: randomUUID(),
      resource_id: rid ?? f.a.id,
      operation: "catalog.read",
    });
    const rename = async (name = "Renamed") => ({
      request_id: randomUUID(),
      resource_id: f.a.id,
      operation: "catalog.rename",
      display_name: name,
      expected_version: (
        await query(
          f.adminPool,
          "SELECT object_version FROM zentwine_policy.resources WHERE id=$1",
          [f.a.id],
        )
      ).rows[0].object_version,
      expected_policy_revision: await f.revision(),
    });
    return work({
      ...f,
      agents,
      owner: auth,
      register,
      parentAgent,
      childAgent,
      grandAgent,
      terms,
      issue,
      delegate,
      read,
      rename,
      agentApp: (opts) => f.app({ agents, ...opts }),
    });
  });
}
export async function agentRequest(app, token, url, payload) {
  return app.inject({
    method: payload === undefined ? "GET" : "POST",
    url,
    headers: { host: "127.0.0.1", authorization: "Bearer zt_agent_" + token },
    ...(payload === undefined ? {} : { payload }),
  });
}
