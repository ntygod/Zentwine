import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  fixture as agentFixture,
  query,
  request,
  waitForLock,
  origin,
} from "../agents/setup.mjs";
import { PostgresApprovalRepository } from "../../packages/db/dist/index.js";
import {
  secret,
  secretDigest,
} from "../../services/api/dist/identity/security.js";
export { query, request, waitForLock, origin, secret, secretDigest };
export const fails = (code) => (e) => e.code === code;
export const guard = (a) => ({
  expected_version: a.object_version,
  content_hash: a.content_hash,
});
export const execution = (a) => ({
  ...guard(a),
  resource_id: a.binding.resource_id,
  operation: a.binding.operation,
  display_name: a.binding.display_name,
  expected_resource_version: a.binding.resource_version,
  expected_policy_revision: a.binding.policy_revision,
});
export async function fixture(work) {
  return agentFixture(async (f) => {
    await query(
      f.adminPool,
      await fs.readFile(
        "packages/db/migrations/0004-bound-approvals.up.sql",
        "utf8",
      ),
    );
    const role = f.appConfig.user;
    if (!/^zt_role_[a-f0-9]{24}$/.test(role))
      throw new Error("bad fixture role");
    await query(
      f.adminPool,
      `GRANT USAGE ON SCHEMA zentwine_approvals TO "${role}";
    GRANT SELECT ON ALL TABLES IN SCHEMA zentwine_approvals TO "${role}";
    GRANT INSERT ON zentwine_approvals.requests,zentwine_approvals.decisions,zentwine_approvals.permits,zentwine_approvals.receipts,zentwine_approvals.events TO "${role}";
    GRANT UPDATE(state,object_version,reason) ON zentwine_approvals.requests TO "${role}";
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA zentwine_approvals TO "${role}";
      GRANT UPDATE(consumed_at) ON zentwine_approvals.permits TO "${role}";`,
    );
    await f.admin.setMembership(
      randomUUID(),
      f.orgA,
      f.bob,
      "MEM-2",
      "owner",
      "active",
    );
    const reviewer = await f.auth(f.bob),
      approvals = new PostgresApprovalRepository(f.appPool);
    const input = async (overrides = {}) => ({
      request_id: randomUUID(),
      resource_id: f.a.id,
      operation: "catalog.rename",
      display_name: "Approved name",
      expected_version: 1,
      expected_policy_revision: await f.revision(),
      review: "required",
      ...overrides,
    });
    const registerResource = async (overrides = {}) => {
      const resource = {
        ...f.a,
        id: randomUUID(),
        object_version: 1,
        ...overrides,
      };
      await f.operator.registerResource(resource);
      return resource;
    };
    const propose = async (overrides = {}, scope = f.owner.scope) =>
      approvals.request(scope, await input(overrides));
    const approve = async (a) =>
      approvals.decide(reviewer.scope, a.id, guard(a), "approve");
    const permit = async (a) => {
      const token = secret(),
        digest = secretDigest(token),
        result = await approvals.issuePermit(
          f.owner.scope,
          a.id,
          guard(a),
          digest,
        );
      return { ...result, token, digest };
    };
    const ready = async (overrides = {}) =>
      permit(await approve(await propose(overrides)));
    const app = (opts) => f.agentApp({ approvals, ...opts });
    return work({
      ...f,
      reviewer,
      registerResource,
      approvals,
      input,
      propose,
      approve,
      permit,
      ready,
      app,
    });
  });
}
