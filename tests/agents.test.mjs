import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validTerms,
  isAttenuation,
  allowsScope,
  remainingCalls,
  canonicalSnapshot,
  validateRequest,
  validateToolRequest,
} from "../packages/policy/dist/index.js";
import { createAgentTools } from "../services/api/dist/agents/tools.js";
import { buildApp } from "../services/api/dist/app.js";
import {
  secret,
  csrfFor,
  cookie,
} from "../services/api/dist/identity/security.js";
const resource = randomUUID();
const terms = (overrides = {}) => ({
  scopes: [
    {
      resource_id: resource,
      actions: ["resource.read", "resource.update"],
      environment: "development",
    },
  ],
  not_before: 1000,
  expires_at: 50000,
  max_calls: 100,
  max_depth: 8,
  ...overrides,
});
const request = () => ({
  request_id: randomUUID(),
  agent_id: randomUUID(),
  terms: terms(),
});
const code = (e) => e.code === "invalid_input";
test("delegation: valid bounded exact scope", () =>
  assert.equal(validTerms(terms()), true));
for (const [name, change] of [
  ["zero calls", { max_calls: 0 }],
  ["fractional budget", { max_calls: 1.5 }],
  ["unsafe budget", { max_calls: Number.MAX_SAFE_INTEGER }],
  ["unbounded depth", { max_depth: 9 }],
  ["zero depth", { max_depth: 0 }],
  ["expired interval", { expires_at: 1000 }],
  ["overlong interval", { expires_at: 1000 + 8 * 3600000 + 1 }],
  ["nan expiry", { expires_at: NaN }],
  ["empty scopes", { scopes: [] }],
  ["extra authority", { owner: "injected" }],
  [
    "wildcard resource",
    {
      scopes: [
        {
          resource_id: "*",
          actions: ["resource.read"],
          environment: "development",
        },
      ],
    },
  ],
  [
    "unknown action",
    {
      scopes: [
        {
          resource_id: resource,
          actions: ["resource.read", "admin.all"],
          environment: "development",
        },
      ],
    },
  ],
  [
    "duplicate action",
    {
      scopes: [
        {
          resource_id: resource,
          actions: ["resource.read", "resource.read"],
          environment: "development",
        },
      ],
    },
  ],
  [
    "missing read",
    {
      scopes: [
        {
          resource_id: resource,
          actions: ["resource.update"],
          environment: "development",
        },
      ],
    },
  ],
  ["duplicate resource", { scopes: [...terms().scopes, ...terms().scopes] }],
])
  test("delegation rejects " + name, () =>
    assert.equal(validTerms(terms(change)), false),
  );
test("delegation: scope/period/depth attenuation accepts strict subset", () =>
  assert.equal(
    isAttenuation(
      terms(),
      terms({
        max_calls: 20,
        max_depth: 7,
        not_before: 2000,
        expires_at: 40000,
        scopes: [{ ...terms().scopes[0], actions: ["resource.read"] }],
      }),
    ),
    true,
  ));
for (const [name, patch] of [
  ["budget", { max_calls: 101 }],
  ["deadline", { expires_at: 50001 }],
  ["activation", { not_before: 999 }],
  ["depth", { max_depth: 8 }],
  [
    "environment",
    { scopes: [{ ...terms().scopes[0], environment: "production" }] },
  ],
  [
    "resource",
    { scopes: [{ ...terms().scopes[0], resource_id: randomUUID() }] },
  ],
  [
    "action",
    {
      scopes: [
        { ...terms().scopes[0], actions: ["resource.read", "resource.export"] },
      ],
    },
  ],
])
  test("delegation cannot expand " + name, () =>
    assert.equal(
      isAttenuation(terms(), terms({ max_calls: 10, max_depth: 7, ...patch })),
      false,
    ),
  );
test("delegation: exact start and exclusive expiry", () => {
  assert.equal(
    allowsScope(terms(), resource, "resource.read", "development", 999),
    false,
  );
  assert.equal(
    allowsScope(terms(), resource, "resource.read", "development", 1000),
    true,
  );
  assert.equal(
    allowsScope(terms(), resource, "resource.read", "development", 49999),
    true,
  );
  assert.equal(
    allowsScope(terms(), resource, "resource.read", "development", 50000),
    false,
  );
});
test("delegation: different resource and environment are not interchangeable", () => {
  assert.equal(
    allowsScope(terms(), randomUUID(), "resource.read", "development", 2000),
    false,
  );
  assert.equal(
    allowsScope(terms(), resource, "resource.read", "staging", 2000),
    false,
  );
});
test("budget: allocation plus direct spend reduces remaining", () =>
  assert.equal(remainingCalls(10, 6, 4), 0));
test("budget: rejects overspend and malformed accounting", () => {
  assert.throws(() => remainingCalls(10, 8, 3), code);
  assert.throws(() => remainingCalls(10, -1, 0), code);
  assert.throws(() => remainingCalls(10, 1.2, 0), code);
});
test("snapshot: canonical key order and changed scope produce different encodings", () => {
  assert.equal(
    canonicalSnapshot({ z: 1, a: { c: 2, b: 3 } }),
    canonicalSnapshot({ a: { b: 3, c: 2 }, z: 1 }),
  );
  assert.notEqual(
    canonicalSnapshot(terms()),
    canonicalSnapshot(terms({ max_calls: 1 })),
  );
});
test("snapshot: non-json and excessive depth fail", () => {
  assert.throws(() => canonicalSnapshot({ x: undefined }), code);
  assert.throws(() => canonicalSnapshot(new Date()), code);
  let o = {};
  for (let i = 0; i < 20; i++) o = { o };
  assert.throws(() => canonicalSnapshot(o), code);
});
test("delegation: request cannot choose owner, digest or snapshot", () => {
  const r = request();
  validateRequest(r);
  for (const k of ["owner", "credential_digest", "snapshot", "org_id"])
    assert.throws(() => validateRequest({ ...r, [k]: "forged" }), code);
});
test("tools: strict identity-free arguments", () => {
  const r = {
    request_id: randomUUID(),
    resource_id: resource,
    operation: "catalog.read",
  };
  validateToolRequest(r);
  for (const k of [
    "credential_digest",
    "agent_id",
    "role",
    "environment",
    "approval",
    "cost",
  ])
    assert.throws(() => validateToolRequest({ ...r, [k]: "forged" }), code);
});
test("tools: caller scope is copied and no unbounded execute callback exists", async () => {
  const s = { credential_digest: "a".repeat(64) };
  let observed;
  const tools = createAgentTools(
    {
      invoke: async (scope, r) => {
        observed = { scope, r };
        return "result";
      },
    },
    s,
  );
  s.credential_digest = "b".repeat(64);
  const r = {
    request_id: randomUUID(),
    resource_id: resource,
    operation: "catalog.read",
  };
  assert.equal(await tools.invoke(r), "result");
  assert.equal(observed.scope.credential_digest, "a".repeat(64));
  assert.deepEqual(Object.keys(tools), ["invoke"]);
});
test("agent routes: require identity and policy dependencies", () =>
  assert.throws(() => buildApp({ agents: {} })));
function appFixture() {
  let calls = 0;
  const repository = {
    register: async () => {
      calls++;
      return { id: randomUUID() };
    },
    inspect: async () => {
      calls++;
      return {};
    },
    invoke: async () => {
      calls++;
      return {};
    },
  };
  const app = buildApp({
    identity: { repository: {}, origins: ["http://127.0.0.1:5173"] },
    policy: {},
    agents: repository,
  });
  return { app, count: () => calls };
}
test("agent routes: default build does not enable agent APIs", async () => {
  const app = buildApp();
  try {
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/agent/self",
          headers: { host: "127.0.0.1" },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
test("agent routes: token rejected in cookies, query and browser origins", async () => {
  const { app, count } = appFixture();
  try {
    const token = secret();
    for (const headers of [
      { cookie: cookie(token) },
      {
        authorization: "Bearer zt_agent_" + token,
        origin: "http://127.0.0.1:5173",
      },
      {
        authorization: "Bearer zt_agent_" + token,
        "sec-fetch-site": "same-origin",
      },
    ]) {
      const r = await app.inject({
        url: "/api/v1/agent/self",
        headers: { host: "127.0.0.1", ...headers },
      });
      assert.ok([401, 403].includes(r.statusCode));
    }
    const q = await app.inject({
      url: "/api/v1/agent/self?token=" + token,
      headers: { host: "127.0.0.1", authorization: "Bearer zt_agent_" + token },
    });
    assert.equal(q.statusCode, 400);
    assert.equal(count(), 0);
  } finally {
    await app.close();
  }
});
test("agent routes: owner registration requires CSRF and refuses responsibility injection", async () => {
  const { app, count } = appFixture();
  try {
    const token = secret(),
      base = {
        host: "127.0.0.1",
        origin: "http://127.0.0.1:5173",
        cookie: cookie(token),
        "x-zentwine-client": "web",
        "x-zentwine-context-version": "1",
      },
      payload = { request_id: randomUUID(), display_name: "Example" };
    const url = "/api/v1/orgs/" + randomUUID() + "/agents";
    assert.equal(
      (await app.inject({ method: "POST", url, headers: base, payload }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...base, "x-zentwine-csrf": csrfFor(token) },
          payload: { ...payload, accountable_owner_id: randomUUID() },
        })
      ).statusCode,
      400,
    );
    assert.equal(count(), 0);
  } finally {
    await app.close();
  }
});
