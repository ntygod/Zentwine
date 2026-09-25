import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fixture as identityFixture, query } from "../identity/setup.mjs";
import {
  PostgresPolicyRepository,
  PostgresPolicyAdmin,
} from "../../packages/db/dist/index.js";
import {
  secretDigest,
  csrfFor,
  cookie,
} from "../../services/api/dist/identity/security.js";
import { buildApp } from "../../services/api/dist/app.js";
export { query };
export const origin = "http://127.0.0.1:5173";
export const code = (expected) => (e) => e.code === expected;
export async function fixture(work) {
  return identityFixture(async (f) => {
    await query(
      f.adminPool,
      await fs.readFile(
        "packages/db/migrations/0002-authorization-core.up.sql",
        "utf8",
      ),
    );
    const role = f.appConfig.user;
    if (!/^zt_role_[a-f0-9]{24}$/.test(role))
      throw new Error("bad fixture role");
    await query(
      f.adminPool,
      `GRANT USAGE ON SCHEMA zentwine_policy TO "${role}";
    GRANT SELECT ON ALL TABLES IN SCHEMA zentwine_policy TO "${role}";
    GRANT UPDATE(display_name,object_version) ON zentwine_policy.resources TO "${role}";`,
    );
    const policy = new PostgresPolicyRepository(f.appPool),
      operator = new PostgresPolicyAdmin(f.adminPool);
    const register = async (overrides = {}) => {
      const r = {
        id: randomUUID(),
        org_id: f.orgA,
        kind: "workspace",
        display_name: "Synthetic catalog",
        visibility: "organization",
        environment: "development",
        sensitivity: "internal",
        owner_human_id: null,
        status: "active",
        object_version: 1,
        ...overrides,
      };
      await operator.registerResource(r);
      return r;
    };
    const a = await register(),
      b = await register({ org_id: f.orgB });
    const revision = async (org = f.orgA) =>
      (
        await query(
          f.adminPool,
          "SELECT revision FROM zentwine_policy.organization_policies WHERE org_id=$1",
          [org],
        )
      ).rows[0].revision;
    const login = async (human = f.alice, org = f.orgA) => {
      const { token } = await f.login(human);
      const selected = await f.repo.selectOrganization(
        secretDigest(token),
        org,
        1,
      );
      return {
        scope: {
          session_digest: secretDigest(token),
          org_id: org,
          context_version: selected.context_version,
        },
        token,
        cookie: cookie(token).split(";")[0],
        csrf: csrfFor(token),
      };
    };
    const add = async (auth, r, extra = {}) => {
      const rule = {
        id: randomUUID(),
        org_id: r.org_id,
        human_id: auth ?? f.alice,
        resource_id: r.id,
        valid_from: Date.now() - 1000,
        expires_at: null,
        revoked: false,
        action: "resource.update",
        effect: "allow",
        ...extra,
      };
      await operator.addRule(rule, await revision(r.org_id));
      return rule;
    };
    const app = (options) =>
      buildApp({
        identity: { repository: f.repo, origins: [origin] },
        policy,
        ...options,
      });
    return work({
      ...f,
      policy,
      operator,
      register,
      a,
      b,
      revision,
      auth: login,
      add,
      app,
    });
  });
}
export const request = (app, auth, method, url, payload) =>
  app.inject({
    method,
    url,
    headers: {
      host: "127.0.0.1:4100",
      origin,
      cookie: auth.cookie,
      "x-zentwine-client": "web",
      "x-zentwine-csrf": auth.csrf,
      "x-zentwine-context-version": String(auth.scope.context_version),
    },
    ...(payload === undefined ? {} : { payload }),
  });
export async function waitForLock(pool, fragment) {
  for (let i = 0; i < 100; i++) {
    const r = await query(
      pool,
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
      ["%" + fragment + "%"],
    );
    if (r.rows.length) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("expected real lock wait not observed");
}
