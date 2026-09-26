import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  organizationWorkbenchPath,
  parseOrganizationWorkbenchPath,
  ORGANIZATIONS_PATH,
  parseWorkbenchSession,
  parseWorkbenchMember,
  parseWorkbenchSettings,
  parseWorkbenchCatalog,
  workbenchNavigation,
} from "../packages/contracts/dist/index.js";
import { WorkbenchController } from "../packages/client/dist/workbench.js";
const org = randomUUID(),
  other = randomUUID(),
  human = randomUUID();
const auth = () => ({
  schema_version: "1.0.0",
  csrf_token: "a".repeat(43),
  session: {
    id: randomUUID(),
    human: { id: human, display_name: "Synthetic human" },
    expires_at: "2026-10-01T00:00:00.000Z",
    context_version: 2,
    active_org_id: org,
    organizations: [
      { id: org, display_name: "Synthetic A" },
      { id: other, display_name: "Synthetic B" },
    ],
  },
});
const member = () => ({
  id: randomUUID(),
  human_id: human,
  display_name: "Synthetic human",
  display_number: "MEM-1",
  role: "owner",
  access_kind: "member",
  access_expires_at: null,
  status: "active",
  object_version: 1,
  managed_by_connection: false,
});
const settings = () => ({
  org_id: org,
  display_name: "Synthetic A",
  locale: "zh-CN",
  time_zone: "Asia/Singapore",
  invitations_enabled: true,
  invite_ttl_hours: 24,
  guest_ttl_days: 7,
  object_version: 1,
});
const item = () => ({
  id: randomUUID(),
  display_name: "Synthetic resource",
  kind: "artifact",
});
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
/** Deliberately synthetic transport for state/decoder tests. Real endpoints are tested separately. */
function fixture(view = "catalog", target = org) {
  const f = {
    auth: auth(),
    member: member(),
    settings: settings(),
    resources: [item()],
    calls: [],
    override: null,
  };
  f.controller = new WorkbenchController(
    target,
    view,
    async (path, options) => {
      f.calls.push({ path, options });
      const overridden = await f.override?.(path, options);
      if (overridden !== undefined && overridden !== null) return overridden;
      if (path.endsWith("organization-capabilities"))
        return response({ schema_version: "1.0.0", enabled: true });
      if (path.endsWith("/auth/session")) return response(f.auth);
      if (path.endsWith("organization-self")) return response(f.member);
      if (path.endsWith("/settings")) return response(f.settings);
      if (path.includes("catalog/search")) return response(f.resources);
      if (path.endsWith("/auth/organization"))
        return response({
          ...f.auth,
          session: {
            ...f.auth.session,
            active_org_id: JSON.parse(options.body).org_id,
            context_version: f.auth.session.context_version + 1,
          },
        });
      if (path.endsWith("/auth/logout"))
        return new Response(null, { status: 204 });
      throw new Error("Unexpected test endpoint");
    },
  );
  return f;
}
test("workbench route: exact deep links and fixed entry reject malformed and external targets", () => {
  assert.deepEqual(parseOrganizationWorkbenchPath(ORGANIZATIONS_PATH), {
    org: null,
    view: "overview",
  });
  for (const view of ["overview", "catalog", "governance"])
    assert.deepEqual(
      parseOrganizationWorkbenchPath(organizationWorkbenchPath(org, view)),
      { org, view },
    );
  for (const path of [
    "//evil.test",
    `/org/${org}/workbench/`,
    `/org/${org}/workbench/unknown`,
    `/org/${org.toUpperCase()}/workbench`,
    `/org/%2e%2e/workbench`,
    `/org/${org}/workbench?org=other`,
    "/org/local/workbench/catalog",
  ])
    assert.equal(parseOrganizationWorkbenchPath(path), null);
  assert.throws(() => organizationWorkbenchPath("//evil.test"), TypeError);
  assert.throws(() => organizationWorkbenchPath(org, "//evil"), TypeError);
});
test("workbench decoder: session fields duplicates and credential shape are checked", () => {
  const a = auth();
  assert.deepEqual(parseWorkbenchSession(a), a);
  for (const value of [
    { ...a, raw: "secret" },
    { ...a, csrf_token: "invalid" },
    { ...a, session: { ...a.session, context_version: 0 } },
    {
      ...a,
      session: {
        ...a.session,
        organizations: [a.session.organizations[0], a.session.organizations[0]],
      },
    },
    {
      ...a,
      session: { ...a.session, human: { ...a.session.human, email: "secret" } },
    },
  ])
    assert.throws(() => parseWorkbenchSession(value), TypeError);
});
test("workbench decoder: current member must match the verified human and active membership", () => {
  const a = auth(),
    m = member();
  assert.deepEqual(parseWorkbenchMember(m, a), m);
  for (const patch of [
    { human_id: randomUUID() },
    { role: "admin" },
    { access_kind: "guest" },
    { status: "revoked" },
    { object_version: -1 },
    { raw: true },
  ])
    assert.throws(() => parseWorkbenchMember({ ...m, ...patch }, a), TypeError);
});
test("workbench decoder: governance cannot project another organization or malformed settings", () => {
  const s = settings();
  assert.deepEqual(parseWorkbenchSettings(s, org), s);
  for (const patch of [
    { org_id: other },
    { object_version: "1" },
    { invite_ttl_hours: 169 },
    { raw: "secret" },
  ])
    assert.throws(
      () => parseWorkbenchSettings({ ...s, ...patch }, org),
      TypeError,
    );
});
test("workbench decoder: catalog has exact bounded unique entries and no hidden metadata", () => {
  const a = item();
  assert.deepEqual(parseWorkbenchCatalog([a]), [a]);
  for (const v of [
    [a, a],
    [{ ...a, raw: "secret" }],
    Array.from({ length: 21 }, item),
    [{ ...a, id: "bad" }],
    {},
  ])
    assert.throws(() => parseWorkbenchCatalog(v), TypeError);
});
test("workbench navigation: only current non-guest owner sees governance", () => {
  const m = member();
  assert.deepEqual(workbenchNavigation(m), [
    "overview",
    "catalog",
    "governance",
  ]);
  for (const patch of [
    { role: "viewer" },
    { role: "member" },
    { access_kind: "guest" },
    { status: "revoked" },
  ])
    assert.deepEqual(workbenchNavigation({ ...m, ...patch }), [
      "overview",
      "catalog",
    ]);
});
test("workbench lifecycle: disabled service never probes session or protected endpoints", async () => {
  const f = fixture();
  f.override = (path) =>
    path.endsWith("organization-capabilities")
      ? response({ schema_version: "1.0.0", enabled: false })
      : null;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "disabled");
  assert.equal(f.calls.length, 1);
});
test("workbench lifecycle: expired session shows login without member requests", async () => {
  const f = fixture();
  f.override = (path) =>
    path.endsWith("/auth/session")
      ? response({ code: "authentication_required" }, 401)
      : null;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "anonymous");
  assert.equal(f.calls.length, 2);
});
test("workbench lifecycle: foreign deep link cannot read or silently switch organization", async () => {
  const f = fixture("overview", other);
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "choose");
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.options.method === "GET"));
  const absent = fixture("overview", randomUUID());
  await absent.controller.reload();
  assert.deepEqual(absent.controller.getSnapshot(), {
    status: "error",
    code: "unavailable_resource",
  });
  assert.equal(absent.calls.length, 2);
});
test("workbench lifecycle: entry remains explicit selection even with an active organization", async () => {
  const f = fixture("overview", null);
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "choose");
  assert.equal(f.calls.length, 2);
});
test("workbench lifecycle: real scope headers and read-only no-store requests are built for catalog", async () => {
  const f = fixture();
  await f.controller.reload("中 & ?");
  const s = f.controller.getSnapshot();
  assert.equal(s.status, "ready");
  assert.deepEqual(s.resources, f.resources);
  assert.ok(f.calls.at(-1).path.endsWith("q=" + encodeURIComponent("中 & ?")));
  for (const c of f.calls) {
    assert.equal(c.options.method, "GET");
    assert.equal(c.options.cache, "no-store");
    assert.equal(c.options.credentials, "same-origin");
    assert.equal(c.options.redirect, "error");
    assert.equal(c.options.body, undefined);
  }
  assert.equal(
    f.calls.at(-1).options.headers["x-zentwine-context-version"],
    "2",
  );
  assert.ok(Object.isFrozen(s.resources[0]));
});
test("workbench lifecycle: owner governance reads settings but viewer denial never probes them", async () => {
  const f = fixture("governance");
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().settings.org_id, org);
  f.member.role = "viewer";
  f.calls.length = 0;
  await f.controller.reload();
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "forbidden",
  });
  assert.ok(!f.calls.some((c) => c.path.endsWith("/settings")));
});
test("workbench lifecycle: all response errors erase previous names and ignore raw remote text", async () => {
  const f = fixture();
  await f.controller.reload();
  f.override = (path) =>
    path.includes("catalog/search")
      ? response({ code: "unavailable", message: "DO-NOT-DISPLAY-SECRET" }, 503)
      : null;
  await f.controller.reload();
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "unavailable",
  });
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes("SECRET"));
});
test("workbench lifecycle: new read clears synchronously and a late old response cannot refill it", async () => {
  const f = fixture(),
    entered = deferred(),
    delayed = deferred();
  let slow = true;
  f.override = (path) => {
    if (path.includes("catalog/search") && slow) {
      entered.resolve();
      return delayed.promise;
    }
    return null;
  };
  const old = f.controller.reload();
  await entered.promise;
  slow = false;
  f.resources = [{ ...item(), display_name: "Newest" }];
  const next = f.controller.reload();
  assert.deepEqual(f.controller.getSnapshot(), { status: "loading" });
  await next;
  delayed.resolve(response([{ ...item(), display_name: "Old secret" }]));
  await old;
  assert.equal(f.controller.getSnapshot().resources[0].display_name, "Newest");
});
test("workbench lifecycle: suspension invalidates in-flight reads and keeps no identity cache", async () => {
  const f = fixture(),
    entered = deferred(),
    delayed = deferred();
  f.override = (path) => {
    if (path.includes("catalog/search")) {
      entered.resolve();
      return delayed.promise;
    }
    return null;
  };
  const reading = f.controller.reload();
  await entered.promise;
  f.controller.suspend();
  assert.deepEqual(f.controller.getSnapshot(), { status: "suspended" });
  delayed.resolve(response(f.resources));
  await reading;
  assert.deepEqual(f.controller.getSnapshot(), { status: "suspended" });
});
test("workbench command: explicit switch clears synchronously and binds CSRF expected version and safe destination", async () => {
  const f = fixture();
  await f.controller.reload();
  const switching = f.controller.switchOrganization(other);
  assert.deepEqual(f.controller.getSnapshot(), { status: "loading" });
  assert.equal(await f.controller.switchOrganization(org), null);
  assert.equal(await switching, organizationWorkbenchPath(other));
  const c = f.calls.at(-1);
  assert.equal(c.options.method, "POST");
  assert.deepEqual(JSON.parse(c.options.body), {
    org_id: other,
    expected_version: 2,
  });
  assert.equal(c.options.headers["x-zentwine-csrf"], f.auth.csrf_token);
  assert.equal(c.options.headers["x-zentwine-client"], "web");
  assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 1);
});
test("workbench command: unknown organization never causes a write", async () => {
  const f = fixture();
  await f.controller.reload();
  assert.equal(await f.controller.switchOrganization(randomUUID()), null);
  assert.ok(f.calls.every((c) => c.options.method === "GET"));
  assert.equal(f.controller.getSnapshot().status, "error");
});
test("workbench command: wrong identity or unexpected response cannot change location", async () => {
  const f = fixture();
  await f.controller.reload();
  f.override = (path) =>
    path.endsWith("/auth/organization")
      ? response({
          ...f.auth,
          session: {
            ...f.auth.session,
            id: randomUUID(),
            active_org_id: other,
            context_version: 3,
          },
        })
      : null;
  assert.equal(await f.controller.switchOrganization(other), null);
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "invalid_response",
  });
});
test("workbench command: uncertain switch failure is not retried automatically", async () => {
  const f = fixture();
  await f.controller.reload();
  f.override = (_path, options) => {
    if (options.method === "POST") throw new Error("synthetic disconnect");
  };
  assert.equal(await f.controller.switchOrganization(other), null);
  assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 1);
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "network_unavailable",
  });
});
test("workbench command: logout immediately erases data and ends at anonymous", async () => {
  const f = fixture();
  await f.controller.reload();
  const p = f.controller.logout();
  assert.deepEqual(f.controller.getSnapshot(), { status: "loading" });
  await p;
  assert.deepEqual(f.controller.getSnapshot(), { status: "anonymous" });
  assert.equal(f.calls.at(-1).path, "/api/v1/auth/logout");
});
test("workbench lifecycle: malformed responses and invalid queries fail closed", async () => {
  const f = fixture();
  f.override = (path) =>
    path.endsWith("/auth/session") ? new Response("not JSON") : null;
  await f.controller.reload();
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "invalid_response",
  });
  f.calls.length = 0;
  await f.controller.reload("x".repeat(121));
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "invalid_input",
  });
  assert.equal(f.calls.length, 0);
});
