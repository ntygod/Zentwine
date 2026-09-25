import test from "node:test";
import assert from "node:assert/strict";
import {
  secret,
  secretDigest,
  csrfFor,
  verifyCsrf,
  readSessionCookie,
  cookie,
  clearCookie,
  SESSION_COOKIE,
  LoginLimiter,
} from "../services/api/dist/identity/security.js";
import { parseIdentityConfig } from "../packages/config/dist/index.js";
import {
  isIdentityId,
  isContextVersion,
} from "../packages/domain/dist/index.js";
import { buildApp } from "../services/api/dist/app.js";
import { IdentityError } from "../packages/domain/dist/index.js";
const origin = "http://127.0.0.1:5173";
const config = () => ({
  NODE_ENV: "development",
  ZENTWINE_IDENTITY_MODE: "local-ticket",
  ZENTWINE_IDENTITY_ORIGINS: origin,
  ZENTWINE_DATABASE_URL: new URL(
    "zentwine_identity_dev",
    "postgres://" + "fixture" + ":" + "generated" + "@127.0.0.1:5544/",
  ).href,
});
const id = "12345678-1234-4567-8901-123456789012";
test("identity: mode is off by default with no dependency parsing", () => {
  assert.equal(parseIdentityConfig({ ZENTWINE_DATABASE_URL: "bad" }), null);
});
test("identity: explicit config is frozen and never serializes the DSN", () => {
  const c = parseIdentityConfig(config());
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.origins));
  assert.ok(!JSON.stringify(c).includes("generated"));
});
test("identity: production, remote database and unexpected modes fail closed", () => {
  for (const extra of [
    { NODE_ENV: "production" },
    { ZENTWINE_IDENTITY_MODE: "password" },
    {
      ZENTWINE_DATABASE_URL:
        "postgres:" + "//x:y@remote.invalid:5432/zentwine_identity_dev",
    },
  ])
    assert.throws(() => parseIdentityConfig({ ...config(), ...extra }));
});
test("identity: database and exact origins are required", () => {
  for (const key of ["ZENTWINE_DATABASE_URL", "ZENTWINE_IDENTITY_ORIGINS"]) {
    const c = config();
    delete c[key];
    assert.throws(() => parseIdentityConfig(c));
  }
});
test("identity: wildcard, null, path, credential and duplicate origins rejected", () => {
  for (const origins of [
    "*",
    "null",
    origin + "/",
    origin + "," + origin,
    "https://external.invalid",
    "http://user@127.0.0.1:5173",
  ]) {
    assert.throws(() =>
      parseIdentityConfig({ ...config(), ZENTWINE_IDENTITY_ORIGINS: origins }),
    );
  }
});
test("identity: opaque secrets are random canonical 256-bit inputs", () => {
  const tokens = Array.from({ length: 1000 }, secret);
  assert.equal(new Set(tokens).size, 1000);
  for (const t of tokens) {
    assert.equal(Buffer.from(t, "base64url").length, 32);
    assert.match(secretDigest(t), /^[a-f0-9]{64}$/);
    assert.ok(!secretDigest(t).includes(t));
  }
});
test("identity: noncanonical, truncated and encoded cookies rejected", () => {
  for (const s of ["a", " ", "%41".repeat(43), "=".repeat(43), "_".repeat(43)])
    assert.throws(() => secretDigest(s));
});
test("identity: duplicate cookie cannot shadow the authenticated session", () => {
  const t = secret();
  assert.equal(readSessionCookie(`${SESSION_COOKIE}=${t}`), t);
  assert.throws(() =>
    readSessionCookie(`${SESSION_COOKIE}=${t}; ${SESSION_COOKIE}=${secret()}`),
  );
  assert.equal(readSessionCookie("unrelated=value"), null);
});
test("identity: cookie attributes and invalidation are explicit", () => {
  const c = cookie(secret());
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\/api\/v1/);
  assert.ok(!c.includes("Domain="));
  assert.match(clearCookie(), /Max-Age=0/);
});
test("identity: CSRF token is session-bound with strict input length", () => {
  const t = secret();
  assert.doesNotThrow(() => verifyCsrf(t, csrfFor(t)));
  for (const v of [undefined, "", secret(), csrfFor(secret())])
    assert.throws(() => verifyCsrf(t, v));
});
test("identity: rate limiter rejects flooding and resets on monotonic time", () => {
  let now = 0;
  const l = new LoginLimiter(() => now);
  for (let i = 0; i < 30; i++) l.take("local");
  assert.throws(() => l.take("local"));
  now = 60001;
  assert.doesNotThrow(() => l.take("local"));
});
test("identity: rate limiter bounds attacker controlled bucket cardinality", () => {
  const l = new LoginLimiter(() => 0);
  for (let i = 0; i < 256; i++) l.take(String(i));
  assert.throws(() => l.take("new-peer"));
});
test("identity: ids and selection versions cannot encode display numbers or invalid states", () => {
  assert.equal(isIdentityId(id), true);
  for (const x of ["MEM-1", id + "/.."]) assert.equal(isIdentityId(x), false);
  for (const x of [0, -1, Infinity, "1", 1.2, 2147483647])
    assert.equal(isContextVersion(x), false);
});
const failing = {
  async consumeTicket() {
    throw new Error("private credential must not escape");
  },
  async readSession() {
    throw new IdentityError("authentication_required");
  },
  async selectOrganization() {
    throw new IdentityError("unavailable_resource");
  },
  async tenantContext() {
    throw new IdentityError("unavailable_resource");
  },
  async rotateSession() {
    throw new IdentityError("authentication_required");
  },
  async revokeSession() {},
};
const make = () =>
  buildApp({ identity: { repository: failing, origins: [origin] } });
test("identity: routes remain disabled by default", async () => {
  const a = buildApp();
  try {
    assert.equal(
      (
        await a.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { ticket: secret() },
        })
      ).statusCode,
      404,
    );
  } finally {
    await a.close();
  }
});
test("identity: login refuses missing or untrusted origins before repository call", async () => {
  const a = make();
  try {
    for (const o of [undefined, "http://evil.invalid", "null"]) {
      const res = await a.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { ...(o ? { origin: o } : {}), "x-zentwine-client": "web" },
        payload: { ticket: secret() },
      });
      assert.equal(res.statusCode, 403);
    }
  } finally {
    await a.close();
  }
});
test("identity: login cannot be invoked by a simple cross origin form", async () => {
  const a = make();
  try {
    const r = await a.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
        "x-zentwine-client": "web",
      },
      payload: "ticket=test",
    });
    assert.equal(r.statusCode, 415);
  } finally {
    await a.close();
  }
});
test("identity: unknown repository failures are sanitized and not successful login", async () => {
  const a = make();
  try {
    const r = await a.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, "x-zentwine-client": "web" },
      payload: { ticket: secret() },
    });
    assert.equal(r.statusCode, 503);
    assert.ok(!r.body.includes("private"));
    assert.equal(r.headers["set-cookie"], undefined);
  } finally {
    await a.close();
  }
});
test("identity: mutating routes require session-bound CSRF", async () => {
  const a = make();
  try {
    for (const url of [
      "/api/v1/auth/organization",
      "/api/v1/auth/rotate",
      "/api/v1/auth/logout",
    ]) {
      const r = await a.inject({
        method: "POST",
        url,
        headers: {
          origin,
          "x-zentwine-client": "web",
          cookie: `${SESSION_COOKIE}=${secret()}`,
        },
        payload: {},
      });
      assert.equal(r.statusCode, 403);
    }
  } finally {
    await a.close();
  }
});
test("identity: spoofed identity headers do not authenticate", async () => {
  const a = make();
  try {
    const r = await a.inject({
      url: `/api/v1/orgs/${id}/context`,
      headers: {
        "x-human-id": id,
        "x-org-id": id,
        "x-zentwine-context-version": "1",
      },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "authentication_required");
  } finally {
    await a.close();
  }
});
test("identity: response defaults prohibit caching authentication state", async () => {
  const a = make();
  try {
    const r = await a.inject({ url: "/api/v1/auth/session" });
    assert.equal(r.statusCode, 401);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  } finally {
    await a.close();
  }
});
