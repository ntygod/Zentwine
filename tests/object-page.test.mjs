import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  resourceObjectPath,
  parseResourceObjectPath,
  parseResourceObjectSnapshot,
} from "../packages/contracts/dist/index.js";
import { WorkbenchController } from "../packages/client/dist/workbench.js";
import {
  OBJECT_LAYOUT_KEY,
  DEFAULT_OBJECT_LAYOUT,
  parseObjectLayout,
  readObjectLayout,
  saveObjectLayout,
  resetObjectLayout,
} from "../packages/client/dist/object-layout.js";
const org = randomUUID(),
  other = randomUUID(),
  id = randomUUID(),
  human = randomUUID();
const member = () => ({
  id: randomUUID(),
  human_id: human,
  display_name: "Synthetic owner",
  display_number: "MEM-1",
  role: "owner",
  access_kind: "member",
  access_expires_at: null,
  status: "active",
  object_version: 2,
  managed_by_connection: false,
});
const snapshot = () => ({
  resource: {
    id,
    org_id: org,
    kind: "workspace",
    display_name: "Synthetic resource",
    visibility: "organization",
    environment: "development",
    sensitivity: "internal",
    owner_human_id: human,
    status: "active",
    object_version: 3,
  },
  decision: {
    schema_version: "1.0.0",
    outcome: "allow",
    reason: "allowed",
    policy_version: "1.0.0",
    policy_revision: 1,
    membership_version: 2,
    resource_version: 3,
    evaluated_at: "2026-09-26T00:00:00.000Z",
    expires_at: "2026-09-26T00:00:15.000Z",
    reusable: false,
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
/** Synthetic response tests only. Browser tests separately exercise PostgreSQL and actual HTTP. */
function fixture() {
  const f = {
    calls: [],
    override: null,
    member: member(),
    snapshot: snapshot(),
    auth: {
      schema_version: "1.0.0",
      csrf_token: "a".repeat(43),
      session: {
        id: randomUUID(),
        human: { id: human, display_name: "Synthetic owner" },
        expires_at: "2026-10-01T00:00:00.000Z",
        context_version: 1,
        active_org_id: org,
        organizations: [
          { id: org, display_name: "A" },
          { id: other, display_name: "B" },
        ],
      },
    },
  };
  f.controller = new WorkbenchController(
    org,
    "overview",
    async (path, options) => {
      f.calls.push({ path, options });
      const replacement = await f.override?.(path, options);
      if (replacement) return replacement;
      if (path.endsWith("organization-capabilities"))
        return json({ schema_version: "1.0.0", enabled: true });
      if (path.endsWith("/auth/session")) return json(f.auth);
      if (path.endsWith("organization-self")) return json(f.member);
      if (path.includes("/resources/")) return json(f.snapshot);
      if (path.endsWith("/auth/organization"))
        return json({
          ...f.auth,
          session: {
            ...f.auth.session,
            active_org_id: JSON.parse(options.body).org_id,
            context_version: 2,
          },
        });
      throw new Error("Unexpected endpoint");
    },
    id,
  );
  return f;
}
test("object route: canonical UUID path roundtrip and malformed paths fail", () => {
  const path = resourceObjectPath(org, id);
  assert.deepEqual(parseResourceObjectPath(path), { org, id });
  for (const p of [
    path + "/",
    path + "?x=1",
    path + "#secret",
    path.replace(id, "../"),
    path.replace(id, id.toUpperCase()),
    "https://evil.test" + path,
    path.replace(org, "local"),
    path.replace(id, "%2f"),
  ])
    assert.equal(parseResourceObjectPath(p), null);
  assert.throws(() => resourceObjectPath(org, "bad"), TypeError);
  assert.throws(
    () => new WorkbenchController(null, "overview", fetch, id),
    TypeError,
  );
  assert.throws(
    () => new WorkbenchController(org, "catalog", fetch, id),
    TypeError,
  );
});
test("object decoder: exact successful read is accepted but remains nonreusable", () => {
  const s = snapshot();
  assert.deepEqual(parseResourceObjectSnapshot(s, org, id, member()), s);
  assert.equal(s.decision.reusable, false);
});
for (const [name, patch] of Object.entries({
  org: { org_id: other },
  id: { id: randomUUID() },
  kind: { kind: "execution_secret" },
  archived: { status: "archived" },
  name: { display_name: "bad\nname" },
  empty: { display_name: "" },
  owner: { owner_human_id: "email@example.test" },
  extra: { raw: "secret" },
}))
  test("object decoder rejects resource " + name, () => {
    const s = snapshot();
    assert.throws(
      () =>
        parseResourceObjectSnapshot(
          { ...s, resource: { ...s.resource, ...patch } },
          org,
          id,
          member(),
        ),
      TypeError,
    );
  });
for (const [name, patch] of Object.entries({
  deny: { outcome: "deny" },
  approval: { outcome: "needs_approval" },
  reusable: { reusable: true },
  stale_member: { membership_version: 1 },
  wrong_version: { resource_version: 4 },
  reason: { reason: "no_permission" },
  unknown_policy: { policy_version: "2.0.0" },
  expired: { expires_at: "2026-09-26T00:00:00.000Z" },
  malformed_date: { evaluated_at: "today" },
  extra: { permission_token: "bad" },
}))
  test("object decoder rejects decision " + name, () => {
    const s = snapshot();
    assert.throws(
      () =>
        parseResourceObjectSnapshot(
          { ...s, decision: { ...s.decision, ...patch } },
          org,
          id,
          member(),
        ),
      TypeError,
    );
  });
test("object controller: read only exact object after fresh self and freeze snapshot", async () => {
  const f = fixture();
  await f.controller.reload();
  const s = f.controller.getSnapshot();
  assert.equal(s.status, "ready");
  assert.deepEqual(s.object, f.snapshot);
  assert.ok(Object.isFrozen(s.object.resource));
  assert.equal(f.calls.at(-1).path, `/api/v1/orgs/${org}/resources/${id}`);
  assert.ok(
    f.calls.every(
      (c) => c.options.method === "GET" && c.options.cache === "no-store",
    ),
  );
});
test("object controller: different organization deep link requests no resource and explicit switch preserves target", async () => {
  const f = fixture();
  f.auth.session.active_org_id = other;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "choose");
  assert.ok(!f.calls.some((c) => c.path.includes("/resources/")));
  assert.equal(
    await f.controller.switchOrganization(org),
    resourceObjectPath(org, id),
  );
});
test("object controller: revocation error removes the previously displayed object", async () => {
  const f = fixture();
  await f.controller.reload();
  f.override = (p) =>
    p.includes("/resources/")
      ? json({ code: "unavailable_resource" }, 404)
      : null;
  const pending = f.controller.reload();
  assert.deepEqual(f.controller.getSnapshot(), { status: "loading" });
  await pending;
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "unavailable_resource",
  });
});
test("object controller: mismatched response cannot become a successful read", async () => {
  const f = fixture();
  f.snapshot.resource.org_id = other;
  await f.controller.reload();
  assert.deepEqual(f.controller.getSnapshot(), {
    status: "error",
    code: "invalid_response",
  });
});
test("object controller: late authorized response cannot refill suspended page", async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  f.override = async (p) => {
    if (p.includes("/resources/")) {
      entered.resolve();
      await release.promise;
      return json(f.snapshot);
    }
    return null;
  };
  const pending = f.controller.reload();
  await entered.promise;
  f.controller.suspend();
  release.resolve();
  await pending;
  assert.deepEqual(f.controller.getSnapshot(), { status: "suspended" });
});
test("object controller: anonymous request never resolves protected object", async () => {
  const f = fixture();
  f.override = (p) =>
    p.endsWith("/auth/session")
      ? json({ code: "authentication_required" }, 401)
      : null;
  await f.controller.reload();
  assert.deepEqual(f.controller.getSnapshot(), { status: "anonymous" });
  assert.ok(!f.calls.some((c) => c.path.includes("/resources/")));
});
function memory() {
  const values = new Map(),
    calls = [];
  return {
    values,
    calls,
    getItem(k) {
      calls.push(["get", k]);
      return values.get(k) ?? null;
    },
    setItem(k, v) {
      calls.push(["set", k, v]);
      values.set(k, v);
    },
    removeItem(k) {
      calls.push(["remove", k]);
      values.delete(k);
    },
  };
}
test("object layout: defaults and reads never write local storage", () => {
  const s = memory();
  assert.deepEqual(
    readObjectLayout(() => s),
    { layout: DEFAULT_OBJECT_LAYOUT, status: "default" },
  );
  assert.deepEqual(s.calls, [["get", OBJECT_LAYOUT_KEY]]);
});
test("object layout: opt-in persists only fixed enums and reset preserves unrelated data", () => {
  const s = memory();
  s.values.set("unrelated", "keep");
  const layout = { schema_version: 1, density: "compact", inspector: "hidden" };
  assert.equal(
    saveObjectLayout(() => s, layout),
    true,
  );
  assert.deepEqual(readObjectLayout(() => s).layout, layout);
  assert.deepEqual(JSON.parse(s.values.get(OBJECT_LAYOUT_KEY)), layout);
  assert.ok(Object.isFrozen(parseObjectLayout(JSON.stringify(layout))));
  assert.equal(
    resetObjectLayout(() => s),
    true,
  );
  assert.equal(s.values.get("unrelated"), "keep");
});
test("object layout: foreign fields future formats and oversized text fail closed without rewrite", () => {
  const s = memory();
  for (const value of [
    { ...DEFAULT_OBJECT_LAYOUT, org_id: org },
    { ...DEFAULT_OBJECT_LAYOUT, schema_version: 2 },
    { ...DEFAULT_OBJECT_LAYOUT, density: "url(secret)" },
    [],
    null,
  ]) {
    const raw = JSON.stringify(value);
    assert.throws(() => parseObjectLayout(raw));
    s.values.set(OBJECT_LAYOUT_KEY, raw);
    assert.equal(readObjectLayout(() => s).status, "unavailable");
    assert.equal(
      saveObjectLayout(() => s, value),
      false,
    );
    assert.equal(s.values.get(OBJECT_LAYOUT_KEY), raw);
  }
  assert.throws(() => parseObjectLayout(" ".repeat(161)));
});
test("object layout: blocked storage getter and quota errors do not escape or report success", () => {
  const blocked = () => {
    throw new Error("blocked");
  };
  assert.equal(readObjectLayout(blocked).status, "unavailable");
  assert.equal(saveObjectLayout(blocked, DEFAULT_OBJECT_LAYOUT), false);
  assert.equal(resetObjectLayout(blocked), false);
  const s = memory();
  s.setItem = () => {
    throw new Error("quota");
  };
  assert.equal(
    saveObjectLayout(() => s, DEFAULT_OBJECT_LAYOUT),
    false,
  );
  assert.equal(s.values.size, 0);
});
