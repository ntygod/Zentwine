import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, request, origin, guard, execution } from "./setup.mjs";
const root = (f) => `/api/v1/orgs/${f.orgA}/approvals`;
test("approval HTTP: request review claim execute and read receipt use real persistent facts", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const created = await request(
        app,
        f.owner,
        "POST",
        root(f),
        await f.input(),
      );
      assert.equal(created.statusCode, 200);
      const a = created.json();
      const approved = await request(
        app,
        f.reviewer,
        "POST",
        `${root(f)}/${a.id}/decide`,
        { ...guard(a), outcome: "approve" },
      );
      assert.equal(approved.statusCode, 200);
      const issued = await request(
        app,
        f.owner,
        "POST",
        `${root(f)}/${a.id}/permit`,
        guard(approved.json()),
      );
      assert.equal(issued.statusCode, 200);
      const v = issued.json();
      assert.match(v.permit, /^zt_permit_/);
      assert.equal(v.credential_recoverable, false);
      const done = await request(
        app,
        f.owner,
        "POST",
        `${root(f)}/${a.id}/execute`,
        { ...execution(v.approval), permit: v.permit },
      );
      assert.equal(done.statusCode, 200);
      assert.equal(done.json().state, "consumed");
      assert.equal(done.body.includes(v.permit), false);
      const old = await request(
        app,
        f.owner,
        "POST",
        `${root(f)}/${a.id}/execute`,
        { ...execution(v.approval), permit: v.permit },
      );
      assert.equal(old.statusCode, 409);
      const viewed = await request(app, f.owner, "GET", `${root(f)}/${a.id}`);
      assert.equal(viewed.json().receipt.content_hash, a.content_hash);
    } finally {
      await app.close();
    }
  }));
test("approval HTTP: changing content hash and injecting environment are blocked", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const v = await f.ready(),
        url = `${root(f)}/${v.approval.id}/execute`;
      const bad = await request(app, f.owner, "POST", url, {
        ...execution(v.approval),
        content_hash: "b".repeat(64),
        permit: "zt_permit_" + v.token,
      });
      assert.equal(bad.statusCode, 409);
      const injected = await request(app, f.owner, "POST", url, {
        ...execution(v.approval),
        environment: "production",
        permit: "zt_permit_" + v.token,
      });
      assert.equal(injected.statusCode, 400);
    } finally {
      await app.close();
    }
  }));
test("approval HTTP: notifications filter current subject, reject unauthorized cursor syntax", () =>
  fixture(async (f) => {
    const app = f.app();
    try {
      const v = await f.ready();
      await f.approvals.revoke(f.owner.scope, v.approval.id, guard(v.approval));
      const r = await request(
        app,
        f.owner,
        "GET",
        `/api/v1/orgs/${f.orgA}/approval-events?after=0&limit=2`,
      );
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().authorization, false);
      assert.equal(r.json().events.length, 2);
      const bad = await request(
        app,
        f.owner,
        "GET",
        `/api/v1/orgs/${f.orgA}/approval-events?after=9223372036854775808`,
      );
      assert.equal(bad.statusCode, 400);
    } finally {
      await app.close();
    }
  }));
test("approval HTTP: success and replay rejection never disclose secrets", () =>
  fixture(async (f) => {
    const lines = [],
      app = f.app({ logSink: (line) => lines.push(line) });
    try {
      const v = await f.ready();
      const r = await request(
        app,
        f.owner,
        "POST",
        `${root(f)}/${v.approval.id}/execute`,
        { ...execution(v.approval), permit: "zt_permit_" + v.token },
      );
      assert.equal(r.statusCode, 200);
      const replay = await request(
        app,
        f.owner,
        "POST",
        `${root(f)}/${v.approval.id}/execute`,
        { ...execution(v.approval), permit: "zt_permit_" + v.token },
      );
      assert.equal(replay.statusCode, 409);
      assert.equal(replay.body.includes(v.token), false);
      const logs = lines.join("");
      for (const sensitive of [
        v.token,
        f.owner.token,
        f.owner.csrf,
        "Approved name",
      ])
        assert.equal(logs.includes(sensitive), false);
    } finally {
      await app.close();
    }
  }));
test("approval HTTP: logout and stale organization context cannot consume permit", () =>
  fixture(async (f) => {
    const v = await f.ready(),
      app = f.app();
    try {
      const stale = await request(
        app,
        { ...f.owner, scope: { ...f.owner.scope, context_version: 999 } },
        "POST",
        `${root(f)}/${v.approval.id}/execute`,
        { ...execution(v.approval), permit: "zt_permit_" + v.token },
      );
      assert.equal(stale.statusCode, 409);
      await f.repo.revokeSession(f.owner.scope.session_digest);
      const r = await request(
        app,
        f.owner,
        "POST",
        `${root(f)}/${v.approval.id}/execute`,
        { ...execution(v.approval), permit: "zt_permit_" + v.token },
      );
      assert.equal(r.statusCode, 401);
    } finally {
      await app.close();
    }
  }));
test("approval HTTP: default disabled mode has no approval side effects", async () => {
  const { buildApp } = await import("../../services/api/dist/app.js");
  const app = buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${randomUUID()}/approvals`,
      payload: {},
    });
    assert.equal(r.statusCode, 401);
  } finally {
    await app.close();
  }
});
test("approval TCP: real loopback transport enforces reviewer and one-time execution", () =>
  fixture(async (f) => {
    const app = f.app();
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address(),
        base = `http://127.0.0.1:${address.port}`;
      const post = async (auth, path, body) =>
        fetch(base + path, {
          method: "POST",
          headers: {
            origin,
            cookie: auth.cookie,
            "content-type": "application/json",
            "x-zentwine-client": "web",
            "x-zentwine-csrf": auth.csrf,
            "x-zentwine-context-version": String(auth.scope.context_version),
          },
          body: JSON.stringify(body),
        });
      const a = await (await post(f.owner, root(f), await f.input())).json();
      const self = await post(f.owner, `${root(f)}/${a.id}/decide`, {
        ...guard(a),
        outcome: "approve",
      });
      assert.equal(self.status, 403);
      const approved = await (
        await post(f.reviewer, `${root(f)}/${a.id}/decide`, {
          ...guard(a),
          outcome: "approve",
        })
      ).json();
      const permit = await (
        await post(f.owner, `${root(f)}/${a.id}/permit`, guard(approved))
      ).json();
      const done = await post(f.owner, `${root(f)}/${a.id}/execute`, {
        ...execution(permit.approval),
        permit: permit.permit,
      });
      assert.equal(done.status, 200);
      assert.equal((await done.json()).state, "consumed");
    } finally {
      await app.close();
    }
  }));
