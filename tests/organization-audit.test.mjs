import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { ORGANIZATION_AUDIT_KINDS, OrganizationError, validateAuditQuery } from "../packages/domain/dist/index.js";
import { organizationAuditKinds, parseOrganizationAuditPage } from "../packages/contracts/dist/index.js";
import { encodeAuditCursor, decodeAuditCursor } from "../packages/db/dist/organization-audit.js";
const serverKey = randomBytes(32);
const encode = (s, q, p) => encodeAuditCursor(s, q, p, serverKey);
const decode = (s, q, now) => decodeAuditCursor(s, q, now, serverKey);
const invalid = (e) => e instanceof OrganizationError && e.code === "invalid_input";
const scope = () => ({ session_digest: randomBytes(32).toString("hex"), org_id: randomUUID(), context_version: 2 });
const position = (now) => ({ head: "9007199254741009", before: "9007199254741008", snapshot: new Date(now).toISOString(), expires: now + 900000 });
const sample = () => ({ schema_version: "1.0.0", org_id: randomUUID(), scope: "organization-lifecycle-only", complete_ledger: false,
  snapshot_at: new Date().toISOString(), next_cursor: null,
  entries: [{ reference: randomUUID(), occurred_at: new Date().toISOString(), kind: "settings.updated", actor_kind: "human", actor_id: randomUUID(), subject_kind: "organization", subject_id: randomUUID() }] });
test("audit contract: domain and wire kinds agree and bounded queries validate", () => {
  assert.deepEqual(ORGANIZATION_AUDIT_KINDS, organizationAuditKinds);
  for (const kind of ["all", ...ORGANIZATION_AUDIT_KINDS]) validateAuditQuery({ kind, limit: 50 });
  validateAuditQuery({});
});
for (const [name, q] of Object.entries({ null: null, array: [], string: "all", field: { org_id: randomUUID() }, kind: { kind: "secret.dump" },
  zero: { limit: 0 }, high: { limit: 51 }, fractional: { limit: 1.5 }, text: { limit: "20" }, nan: { limit: NaN }, cursor: { cursor: "../raw" }, huge: { cursor: "a".repeat(1025) } }))
  test("audit query rejects " + name, () => assert.throws(() => validateAuditQuery(q), invalid));
test("audit cursor: opaque round trip preserves bigint precision and uses a fresh nonce", () => {
  const s = scope(), now = Date.now(), p = position(now), a = encode(s, {}, p), b = encode(s, {}, p);
  assert.notEqual(a, b);
  assert.deepEqual(decode(s, { cursor: a }, now + 1), p);
  assert.ok(!Buffer.from(a, "base64url").toString("utf8").includes(p.head));
});
test("audit cursor: another session organization context filter or page size is rejected", () => {
  const s = scope(), now = Date.now(), cursor = encode(s, {}, position(now));
  for (const other of [{ ...s, session_digest: scope().session_digest }, { ...s, org_id: randomUUID() }, { ...s, context_version: 3 }])
    assert.throws(() => decode(other, { cursor }, now), invalid);
  for (const q of [{ cursor, kind: "member.updated" }, { cursor, limit: 1 }])
    assert.throws(() => decode(s, q, now), invalid);
});
test("audit cursor: ciphertext tampering noncanonical base64 expiry and invalid positions are rejected", () => {
  const s = scope(), now = Date.now(), p = position(now), cursor = encode(s, {}, p);
  const raw = Buffer.from(cursor, "base64url"); raw[30] ^= 1;
  for (const value of [raw.toString("base64url"), cursor + "=", "a".repeat(1025), "A".repeat(40)])
    assert.throws(() => decode(s, { cursor: value }, now), invalid);
  assert.throws(() => decode(s, { cursor }, p.expires), invalid);
  for (const bad of [{ ...p, head: "9223372036854775808" }, { ...p, before: "0" }, { ...p, before: "9007199254741010" }, { ...p, head: "001" }, { ...p, expires: now + 900001 }, { ...p, extra: true }])
    assert.throws(() => decode(s, { cursor: encode(s, {}, bad) }, now), invalid);
});
test("audit page: browser decoder accepts only the current organization and documented projection", () => {
  const p = sample(); assert.deepEqual(parseOrganizationAuditPage(p, p.org_id), p);
  assert.throws(() => parseOrganizationAuditPage(p, randomUUID()), TypeError);
  for (const changed of [{ ...p, complete_ledger: true }, { ...p, total: 7 }, { ...p, raw: "secret" }, { ...p, entries: [...p.entries, ...p.entries] },
    { ...p, entries: [], next_cursor: "x".repeat(50) }, { ...p, snapshot_at: "bad-date" }, { ...p, next_cursor: "bad" }])
    assert.throws(() => parseOrganizationAuditPage(changed, p.org_id), TypeError);
});
test("audit page: unknown types raw payloads bad dates and false attribution are rejected", () => {
  const p = sample();
  for (const patch of [{ kind: "private.content" }, { actor_kind: "identity_connection" }, { subject_kind: "human" }, { actor_id: "email@example.test" }, { occurred_at: "bad" }, { payload: "token" }])
    assert.throws(() => parseOrganizationAuditPage({ ...p, entries: [{ ...p.entries[0], ...patch }] }, p.org_id), TypeError);
});

test("audit cursor: cookie knowledge is insufficient without the original server instance key", () => {
  const s = scope(), now = Date.now(), cursor = encode(s, {}, position(now));
  assert.throws(() => decodeAuditCursor(s, { cursor }, now, randomBytes(32)), invalid);
});
