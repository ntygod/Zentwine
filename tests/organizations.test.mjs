import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  OrganizationError,
  validateSettings,
  validateInvitation,
  validateConnection,
} from "../packages/domain/dist/index.js";
import { evaluatePolicy } from "../packages/policy/dist/index.js";
import { organizationGrantSql } from "../packages/db/dist/index.js";
import { buildApp } from "../services/api/dist/app.js";
import { createSsoPort } from "../services/api/dist/organizations/federation-port.js";
import {
  secret,
  csrfFor,
  cookie,
} from "../services/api/dist/identity/security.js";
const invalid = (e) =>
  e instanceof OrganizationError && e.code === "invalid_input";
const setting = () => ({
  display_name: "Team",
  locale: "zh-CN",
  time_zone: "Asia/Singapore",
  invitations_enabled: true,
  invite_ttl_hours: 24,
  guest_ttl_days: 7,
  expected_version: 1,
});
const invitation = () => ({
  request_id: randomUUID(),
  human_id: randomUUID(),
  role: "viewer",
  access_kind: "guest",
  resource_ids: [randomUUID()],
  expected_settings_version: 1,
});
const connection = () => ({
  display_name: "Synthetic IdP",
  issuer: "https://idp.example.test/",
  client_id: "fixture-client",
  enabled: false,
  expected_version: 0,
});
test("organizations rules: complete settings, guest invite and disabled provider config validate", () => {
  validateSettings(setting());
  validateInvitation(invitation());
  validateConnection(connection());
});
for (const [key, value] of Object.entries({
  display_name: " ",
  time_zone: "not/a/zone",
  invitations_enabled: "yes",
  invite_ttl_hours: 0,
  guest_ttl_days: 31,
  expected_version: 0,
  role: "owner",
}))
  test("organizations rules: settings reject " + key, () =>
    assert.throws(
      () => validateSettings({ ...setting(), [key]: value }),
      invalid,
    ),
  );
for (const [key, value] of Object.entries({
  role: "owner",
  access_kind: "superuser",
  resource_ids: [],
  human_id: "email@example.test",
  expected_settings_version: -1,
  approved: true,
}))
  test("organizations rules: guest invite rejects " + key, () =>
    assert.throws(
      () => validateInvitation({ ...invitation(), [key]: value }),
      invalid,
    ),
  );
test("organizations rules: guest cannot be member and member cannot acquire resource grants through invitation", () => {
  assert.throws(
    () => validateInvitation({ ...invitation(), role: "member" }),
    invalid,
  );
  assert.throws(
    () => validateInvitation({ ...invitation(), access_kind: "member" }),
    invalid,
  );
  validateInvitation({
    ...invitation(),
    access_kind: "member",
    role: "member",
    resource_ids: [],
  });
});
test("organizations rules: duplicated or oversized resource sets rejected", () => {
  const id = randomUUID();
  for (const resource_ids of [[id, id], Array.from({ length: 17 }, randomUUID)])
    assert.throws(
      () => validateInvitation({ ...invitation(), resource_ids }),
      invalid,
    );
});
for (const issuer of [
  "http://idp.example.test/",
  "https://" + "synthetic:placeholder@idp.example.test/",
  "https://idp.example.test/?token=secret",
  "https://idp.example.test/#fragment",
  "https://idp.example.test",
])
  test("organizations rules: issuer exact HTTPS validation " + issuer, () =>
    assert.throws(
      () => validateConnection({ ...connection(), issuer }),
      invalid,
    ),
  );
test("organizations rules: config cannot accept credential or authority fields", () =>
  assert.throws(
    () =>
      validateConnection({
        ...connection(),
        credential_digest: "a".repeat(64),
      }),
    invalid,
  ));
function facts() {
  const org = randomUUID(),
    human = randomUUID(),
    resource = randomUUID();
  return {
    principal_kind: "human",
    human_id: human,
    org_id: org,
    membership_role: "viewer",
    membership_kind: "guest",
    membership_version: 1,
    session_valid_until: 2000,
    observed_at: 1000,
    policy_revision: 1,
    write_mode: "active",
    bindings: [],
    grants: [],
    resource: {
      id: resource,
      org_id: org,
      kind: "workspace",
      display_name: "Shared",
      visibility: "organization",
      environment: "development",
      sensitivity: "internal",
      owner_human_id: human,
      status: "active",
      object_version: 1,
    },
  };
}
const rule = (f) => ({
  id: randomUUID(),
  org_id: f.org_id,
  human_id: f.human_id,
  resource_id: f.resource.id,
  valid_from: 0,
  expires_at: null,
  revoked: false,
});
test("organizations policy: guest does not inherit organization or owner visibility", () =>
  assert.equal(evaluatePolicy(facts(), "resource.read", 1000).outcome, "deny"));
test("organizations policy: exact reader binding grants guest read only", () => {
  const f = facts();
  f.bindings = [{ ...rule(f), role: "reader" }];
  assert.equal(evaluatePolicy(f, "resource.read", 1000).outcome, "allow");
  for (const action of [
    "resource.update",
    "resource.export",
    "workspace.write",
  ])
    assert.equal(evaluatePolicy(f, action, 1000).outcome, "deny");
});
test("organizations policy: even explicit update allow cannot elevate guest", () => {
  const f = facts();
  f.grants = [{ ...rule(f), effect: "allow", action: "resource.update" }];
  assert.equal(evaluatePolicy(f, "resource.update", 1000).outcome, "deny");
});
test("organizations policy: explicit deny still overrides a shared binding", () => {
  const f = facts();
  f.bindings = [{ ...rule(f), role: "reader" }];
  f.grants = [{ ...rule(f), effect: "deny", action: "resource.read" }];
  assert.equal(
    evaluatePolicy(f, "resource.read", 1000).reason,
    "explicit_deny",
  );
});
test("organizations role installation rejects role injection or shared roles", () => {
  for (const pair of [
    ["app;DROP ROLE x", "reader"],
    ["app", "app"],
    ["", "reader"],
  ])
    assert.throws(() => organizationGrantSql(...pair));
  const sql = organizationGrantSql("manager", "reader");
  assert.ok(!sql.includes("GRANT UPDATE ON"));
  assert.match(sql, /session_cutoffs/);
});
async function fakeSso(proof, work) {
  let writes = 0;
  const con = {
    ...connection(),
    id: randomUUID(),
    org_id: randomUUID(),
    object_version: 2,
    enabled: true,
    protocol: "oidc-adapter-port",
  };
  const repo = {
    async connection() {
      return con;
    },
    async federatedTicket(id, v, subject, digest) {
      assert.equal(id, con.id);
      assert.equal(v, 2);
      assert.equal(subject, "synthetic-subject");
      assert.match(digest, /^[a-f0-9]{64}$/);
      writes++;
    },
  };
  const port = createSsoPort(repo, con.id, {
    async verify(input, c) {
      assert.ok(Object.isFrozen(c));
      if (proof instanceof Error) throw proof;
      return (
        proof ?? {
          issuer: con.issuer,
          audience: con.client_id,
          subject: "synthetic-subject",
        }
      );
    },
  });
  await work(port, () => writes);
}
test("organizations SSO port: synthetic trusted verifier yields a single hashed ticket write", () =>
  fakeSso(null, async (p, w) => {
    const r = await p.exchange({ fixture_only: true });
    assert.equal(r.ticket.length, 43);
    assert.equal(w(), 1);
  }));
for (const proof of [
  new Error("private provider detail"),
  {
    issuer: "https://evil.test/",
    audience: "fixture-client",
    subject: "synthetic-subject",
  },
  {
    issuer: "https://idp.example.test/",
    audience: "wrong",
    subject: "synthetic-subject",
  },
])
  test(
    "organizations SSO port: verification/issuer/audience failure cannot issue ticket " +
      (proof instanceof Error ? "error" : proof.audience + proof.issuer),
    () =>
      fakeSso(proof, async (p, w) => {
        await assert.rejects(
          p.exchange({ verified: true }),
          (e) => e.code === "authentication_required",
        );
        assert.equal(w(), 0);
      }),
  );
test("organizations capabilities: default off returns no fabricated IdP connection", async () => {
  const app = buildApp();
  try {
    const r = await app.inject("/api/v1/system/organization-capabilities");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().enabled, false);
    assert.equal(r.json().sso_verifier_connected, false);
    assert.equal(
      (await app.inject("/api/v1/orgs/" + randomUUID() + "/settings"))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
async function http(work) {
  let calls = 0;
  const token = secret(),
    org = randomUUID();
  const repo = new Proxy(
    {},
    {
      get: () => async () => {
        calls++;
        throw new OrganizationError("forbidden");
      },
    },
  );
  const app = buildApp({
    identity: { repository: repo, origins: ["http://127.0.0.1:5173"] },
    policy: repo,
    agents: repo,
    approvals: repo,
    organizations: repo,
  });
  const headers = {
    origin: "http://127.0.0.1:5173",
    cookie: cookie(token).split(";")[0],
    "x-zentwine-client": "web",
    "x-zentwine-csrf": csrfFor(token),
    "x-zentwine-context-version": "1",
  };
  try {
    await work(app, headers, org, () => calls);
  } finally {
    await app.close();
  }
}
test("organizations HTTP: forged role in settings rejected before repository", () =>
  http(async (a, h, o, c) => {
    const r = await a.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${o}/settings`,
      headers: h,
      payload: { ...setting(), role: "owner" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(c(), 0);
  }));
test("organizations HTTP: origin and CSRF independently required for mutation", () =>
  http(async (a, h, o, c) => {
    for (const headers of [
      { ...h, origin: "http://evil.invalid" },
      { ...h, "x-zentwine-csrf": "bad" },
      { ...h, authorization: "Bearer nope" },
    ]) {
      const r = await a.inject({
        method: "PATCH",
        url: `/api/v1/orgs/${o}/settings`,
        headers,
        payload: setting(),
      });
      assert.equal(r.statusCode, 403);
    }
    assert.equal(c(), 0);
  }));
test("organizations HTTP: machine provisioning rejects browser cookies or raw claims", () =>
  http(async (a, h, o, c) => {
    const r = await a.inject({
      method: "POST",
      url: `/api/v1/idp/connections/${o}/provisioning`,
      headers: h,
      payload: {
        request_id: randomUUID(),
        external_id: "x",
        active: false,
        expected_version: 1,
      },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(c(), 0);
  }));
