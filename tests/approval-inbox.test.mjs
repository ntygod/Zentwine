import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  normalizeApprovalInboxQuery,
  ApprovalError,
} from "../packages/policy/dist/index.js";
import { ApprovalInboxCursor } from "../packages/db/dist/approval-inbox-cursor.js";
import {
  approvalInboxPath,
  parseApprovalInboxPath,
  parseApprovalInboxPage,
} from "../packages/contracts/dist/index.js";
import { ApprovalInboxController } from "../packages/client/dist/approval-inbox.js";
const org = randomUUID(),
  other = randomUUID(),
  human = randomUUID(),
  colleague = randomUUID();
const selection = () => ({ lane: "mine", state: "all", limit: 20 });
const row = () => ({
  id: randomUUID(),
  resource_id: randomUUID(),
  requester_id: human,
  requested_name: "Synthetic request",
  state: "pending",
  object_version: 1,
  resource_version: 1,
  expires_at: "2026-09-27T08:10:00.000Z",
  expired: false,
});
const page = () => ({
  schema_version: "1.0.0",
  org_id: org,
  lane: "mine",
  state_filter: "all",
  observed_at: "2026-09-27T08:00:00.000Z",
  authorization: false,
  consistency: "creation-boundary-current-visibility",
  entries: [row()],
  next_cursor: null,
});
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
function fixture() {
  const f = {
    calls: [],
    override: null,
    page: page(),
    auth: {
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
    },
    member: {
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
    },
  };
  f.controller = new ApprovalInboxController(org, async (path, options) => {
    f.calls.push({ path, options });
    const override = await f.override?.(path, options);
    if (override !== undefined && override !== null) return override;
    if (path.endsWith("organization-capabilities"))
      return response({ schema_version: "1.0.0", enabled: true });
    if (path.endsWith("/auth/session")) return response(f.auth);
    if (path.endsWith("organization-self")) return response(f.member);
    if (path.includes("/approvals?")) return response(f.page);
    if (path.endsWith("/auth/organization"))
      return response({
        ...f.auth,
        session: {
          ...f.auth.session,
          active_org_id: JSON.parse(options.body).org_id,
          context_version: f.auth.session.context_version + 1,
        },
      });
    throw new Error("Unexpected synthetic endpoint");
  });
  return f;
}
const listCalls = (f) => f.calls.filter((c) => c.path.includes("/approvals?"));
test("inbox input: defaults copied and frozen without modifying caller", () => {
  const q = { lane: "review", limit: 5 },
    copy = normalizeApprovalInboxQuery(q);
  q.limit = 20;
  assert.equal(copy.limit, 5);
  assert.ok(Object.isFrozen(copy));
  assert.deepEqual(normalizeApprovalInboxQuery({}), {
    lane: "mine",
    state: "all",
    limit: 20,
  });
});
for (const [name, value] of Object.entries({
  unknown: { q: "secret" },
  lane: { lane: "everybody" },
  state: { state: "done" },
  zero: { limit: 0 },
  limit: { limit: 51 },
  fractional: { limit: 2.5 },
  cursor: { cursor: "raw-sequence" },
  null: null,
  array: [],
}))
  test("inbox input rejects " + name, () =>
    assert.throws(() => normalizeApprovalInboxQuery(value), ApprovalError),
  );
test("inbox cursor: bigint precision and exact binding survive round trip", () => {
  const c = new ApprovalInboxCursor(),
    p = {
      head: "9223372036854775807",
      before: "9007199254740993",
      started: 5000,
    };
  const token = c.encode(p, "session/org/lane/state/authority");
  assert.deepEqual(
    c.decode(token, "session/org/lane/state/authority", 6000),
    p,
  );
  assert.ok(!token.includes(p.head));
  for (const binding of [
    "other-session",
    "other-org",
    "other-filter",
    "other-membership",
  ])
    assert.throws(() => c.decode(token, binding, 6000), ApprovalError);
});
test("inbox cursor: tampering expiry restart and malformed tokens fail closed", () => {
  const c = new ApprovalInboxCursor(),
    token = c.encode({ head: "5", before: "4", started: 5000 }, "binding");
  const bytes = Buffer.from(token, "base64url");
  bytes[bytes.length - 1] ^= 1;
  for (const value of ["", "123", bytes.toString("base64url"), token + "="])
    assert.throws(() => c.decode(value, "binding", 6000), ApprovalError);
  for (const t of [4999, 905000, NaN])
    assert.throws(() => c.decode(token, "binding", t), ApprovalError);
  assert.throws(
    () => new ApprovalInboxCursor().decode(token, "binding", 6000),
    ApprovalError,
  );
});
test("inbox cursor: authenticated but invalid position never advances", () => {
  const c = new ApprovalInboxCursor();
  for (const patch of [
    { head: "01" },
    { before: "0" },
    { before: "11" },
    { head: "9223372036854775808" },
    { started: -1 },
    { extra: true },
  ])
    assert.throws(
      () =>
        c.decode(
          c.encode({ head: "10", before: "5", started: 5000, ...patch }, "x"),
          "x",
          6000,
        ),
      ApprovalError,
    );
});
test("inbox route: exact local deep link rejects encoded and external targets", () => {
  assert.deepEqual(parseApprovalInboxPath(approvalInboxPath(org)), { org });
  for (const p of [
    "https://evil.test",
    `/org/${org}/workbench/approvals/`,
    `/org/${org}/workbench/approvals?x=1`,
    `/org/${org.toUpperCase()}/workbench/approvals`,
    "/org/local/workbench/approvals",
  ])
    assert.equal(parseApprovalInboxPath(p), null);
  assert.throws(() => approvalInboxPath("../bad"), TypeError);
});
test("inbox decoder: exact scope filter and non-authority metadata are required", () => {
  const p = page();
  assert.deepEqual(parseApprovalInboxPage(p, org, human, selection()), p);
  for (const patch of [
    { org_id: other },
    { lane: "review" },
    { state_filter: "pending" },
    { authorization: true },
    { consistency: "historical" },
    { observed_at: "yesterday" },
    { raw: {} },
  ])
    assert.throws(
      () => parseApprovalInboxPage({ ...p, ...patch }, org, human, selection()),
      TypeError,
    );
});
test("inbox decoder: privacy projection rejects raw bindings duplicates and wrong requester", () => {
  const p = page();
  for (const patch of [
    { requester_id: colleague },
    { requested_name: "\nsecret" },
    { state: "authorized" },
    { object_version: 0 },
    { resource_version: "1" },
    { binding: {} },
    { expires_at: "x" },
    { expired: true },
  ])
    assert.throws(
      () =>
        parseApprovalInboxPage(
          { ...p, entries: [{ ...p.entries[0], ...patch }] },
          org,
          human,
          selection(),
        ),
      TypeError,
    );
  assert.throws(
    () =>
      parseApprovalInboxPage(
        { ...p, entries: [p.entries[0], p.entries[0]] },
        org,
        human,
        selection(),
      ),
    TypeError,
  );
});
test("inbox decoder: terminal records are not relabeled as expired", () => {
  const p = page();
  p.observed_at = "2026-09-27T09:00:00.000Z";
  assert.throws(
    () => parseApprovalInboxPage(p, org, human, selection()),
    TypeError,
  );
  p.entries[0].expired = true;
  p.state_filter = "expired";
  parseApprovalInboxPage(p, org, human, { ...selection(), state: "expired" });
  p.entries[0].state = "consumed";
  assert.throws(
    () =>
      parseApprovalInboxPage(p, org, human, {
        ...selection(),
        state: "expired",
      }),
    TypeError,
  );
  p.entries[0].expired = false;
  p.state_filter = "consumed";
  parseApprovalInboxPage(p, org, human, { ...selection(), state: "consumed" });
});
test("inbox decoder: filters and continuation never claim hidden counts", () => {
  const p = page();
  for (const patch of [
    { next_cursor: "a".repeat(60) },
    { total: 99 },
    { entries: Array.from({ length: 21 }, row) },
  ])
    assert.throws(
      () => parseApprovalInboxPage({ ...p, ...patch }, org, human, selection()),
      TypeError,
    );
  assert.throws(
    () =>
      parseApprovalInboxPage({ ...p, state_filter: "approved" }, org, human, {
        ...selection(),
        state: "approved",
      }),
    TypeError,
  );
});
test("inbox decoder: reviewer sees only other requester projections", () => {
  const p = { ...page(), lane: "review" };
  const q = { ...selection(), lane: "review" };
  assert.throws(() => parseApprovalInboxPage(p, org, human, q), TypeError);
  p.entries[0].requester_id = colleague;
  parseApprovalInboxPage(p, org, human, q);
});
test("inbox controller: successful discovery is frozen same-origin GET only", async () => {
  const f = fixture();
  await f.controller.reload();
  const s = f.controller.getSnapshot();
  assert.equal(s.status, "ready");
  assert.ok(Object.isFrozen(s.page.entries[0]));
  assert.ok(f.calls.every((c) => c.options.method === "GET"));
  assert.equal(listCalls(f)[0].options.credentials, "same-origin");
  assert.equal(listCalls(f)[0].options.cache, "no-store");
  assert.equal(listCalls(f)[0].options.redirect, "error");
  assert.equal(
    listCalls(f)[0].options.headers["x-zentwine-context-version"],
    "2",
  );
});
test("inbox controller: disabled and anonymous states never query the list", async () => {
  for (const mode of ["disabled", "anonymous"]) {
    const f = fixture();
    f.override = (p) =>
      p.endsWith(
        mode === "disabled" ? "organization-capabilities" : "/auth/session",
      )
        ? response(
            mode === "disabled"
              ? { schema_version: "1.0.0", enabled: false }
              : { code: "authentication_required" },
            mode === "disabled" ? 200 : 401,
          )
        : null;
    await f.controller.reload();
    assert.equal(f.controller.getSnapshot().status, mode);
    assert.equal(listCalls(f).length, 0);
  }
});
test("inbox controller: ordinary members cannot request reviewer scope and guests cannot enumerate", async () => {
  for (const [role, kind, lane] of [
    ["member", "member", "review"],
    ["viewer", "guest", "mine"],
  ]) {
    const f = fixture();
    f.member.role = role;
    f.member.access_kind = kind;
    await f.controller.reload(lane);
    assert.equal(f.controller.getSnapshot().code, "forbidden");
    assert.equal(listCalls(f).length, 0);
  }
});
test("inbox controller: another organization requires explicit switch preserving list target", async () => {
  const f = fixture();
  f.auth.session.active_org_id = other;
  await f.controller.reload();
  assert.equal(f.controller.getSnapshot().status, "choose");
  assert.ok(f.calls.every((c) => c.options.method === "GET"));
  assert.equal(await f.controller.switchOrganization(), approvalInboxPath(org));
  const writes = f.calls.filter((c) => c.options.method === "POST");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), {
    org_id: org,
    expected_version: 2,
  });
});
test("inbox controller: next page rechecks context uses exact cursor and replaces rows", async () => {
  const f = fixture();
  f.page.entries = Array.from({ length: 20 }, row);
  f.page.next_cursor = "a".repeat(60);
  await f.controller.reload();
  const first = f.controller.getSnapshot().page.entries[0].id;
  f.page = page();
  await f.controller.next();
  assert.equal(
    new URL(listCalls(f)[1].path, "http://local.test").searchParams.get(
      "cursor",
    ),
    "a".repeat(60),
  );
  assert.equal(f.controller.getSnapshot().page.entries.length, 1);
  assert.notEqual(f.controller.getSnapshot().page.entries[0].id, first);
  assert.equal(
    f.calls.filter((c) => c.path.endsWith("/auth/session")).length,
    2,
  );
});
test("inbox controller: changed session cannot reuse the previous page cursor", async () => {
  const f = fixture();
  f.page.entries = Array.from({ length: 20 }, row);
  f.page.next_cursor = "a".repeat(60);
  await f.controller.reload();
  f.auth.session.id = randomUUID();
  await f.controller.next();
  assert.equal(f.controller.getSnapshot().code, "version_conflict");
  assert.equal(listCalls(f).length, 1);
});
test("inbox controller: refresh and filter change discard old cursor synchronously", async () => {
  const f = fixture();
  f.page.entries = Array.from({ length: 20 }, row);
  f.page.next_cursor = "a".repeat(60);
  await f.controller.reload();
  f.page = page();
  f.page.lane = "review";
  f.page.state_filter = "pending";
  f.page.entries[0].requester_id = colleague;
  const work = f.controller.reload("review", "pending");
  assert.deepEqual(f.controller.getSnapshot(), { status: "loading" });
  await work;
  assert.equal(f.controller.getSnapshot().status, "ready");
  assert.ok(!listCalls(f).at(-1).path.includes("cursor="));
});
test("inbox controller: suspension discards a late protected response even if fetch ignores abort", async () => {
  const f = fixture(),
    d = deferred(),
    reached = deferred();
  f.override = (p) =>
    p.includes("/approvals?") ? (reached.resolve(), d.promise) : null;
  const pending = f.controller.reload();
  await reached.promise;
  f.controller.suspend();
  d.resolve(response(page()));
  await pending;
  assert.deepEqual(f.controller.getSnapshot(), { status: "suspended" });
});
test("inbox controller: a newer request wins over late previous filter results", async () => {
  const f = fixture(),
    d = deferred(),
    reached = deferred();
  let count = 0;
  f.override = (p) =>
    p.includes("/approvals?") && count++ === 0
      ? (reached.resolve(), d.promise)
      : null;
  const old = f.controller.reload();
  await reached.promise;
  f.page.state_filter = "pending";
  await f.controller.reload("mine", "pending");
  d.resolve(response(page()));
  await old;
  assert.equal(f.controller.getSnapshot().page.state_filter, "pending");
});
test("inbox controller: failures clear records and never automatically retry", async () => {
  for (const status of [403, 409, 503]) {
    const f = fixture();
    await f.controller.reload();
    f.override = (p) =>
      p.includes("/approvals?")
        ? response(
            {
              code:
                status === 409
                  ? "version_conflict"
                  : status === 403
                    ? "forbidden"
                    : "secret_error",
              raw: "secret",
            },
            status,
          )
        : null;
    await f.controller.reload();
    assert.equal(f.controller.getSnapshot().status, "error");
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes("secret"));
    assert.equal(listCalls(f).length, 2);
  }
});
test("inbox controller: malformed duplicate pages and cyclic cursors cannot be published", async () => {
  const f = fixture();
  f.page.entries = Array.from({ length: 20 }, row);
  f.page.next_cursor = "a".repeat(60);
  await f.controller.reload();
  await f.controller.next();
  assert.equal(f.controller.getSnapshot().code, "invalid_response");
});
