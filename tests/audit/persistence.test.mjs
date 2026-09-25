import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture,
  query,
  fails,
  migration,
  waitForDatabaseLock,
} from "./setup.mjs";
import { fixture as oldFixture } from "../organizations/setup.mjs";
import { PostgresOrganizationRepository } from "../../packages/db/dist/index.js";
import { parseOrganizationAuditPage } from "../../packages/contracts/dist/index.js";
const all = (f, q = {}, s = f.owner.scope) => f.organizations.audit(s, q);
test("audit PG: empty owner view is scoped and explicitly not a complete ledger", () =>
  fixture(async (f) => {
    const p = await all(f);
    assert.equal(p.org_id, f.orgA);
    assert.deepEqual(p.entries, []);
    assert.equal(p.next_cursor, null);
    assert.equal(p.complete_ledger, false);
    assert.equal(p.scope, "organization-lifecycle-only");
    parseOrganizationAuditPage(p, f.orgA);
  }));
test("audit migration: backfill and reversible view indexes preserve existing facts", () =>
  oldFixture(async (f) => {
    await f.organizations.updateSettings(
      f.owner.scope,
      await f.settingsInput(),
    );
    const original = (
      await query(
        f.adminPool,
        "SELECT id,org_id,actor_id,kind,subject_id,created_at FROM zentwine_organizations.events ORDER BY id",
      )
    ).rows;
    await query(f.adminPool, await migration("up"));
    assert.equal(
      (await query(f.adminPool, await migration("verify"))).rows[0].verified,
      true,
    );
    const p = await all(f);
    assert.equal(p.entries.length, 1);
    await query(f.adminPool, await migration("down"));
    assert.deepEqual(
      (
        await query(
          f.adminPool,
          "SELECT id,org_id,actor_id,kind,subject_id,created_at FROM zentwine_organizations.events ORDER BY id",
        )
      ).rows,
      original,
    );
    await query(f.adminPool, await migration("up"));
    assert.equal((await all(f)).entries.length, 1);
  }));
test("audit PG: actual setting mutation records only whitelisted facts and survives repository reconstruction", () =>
  fixture(async (f) => {
    await f.record();
    const p = await all(f),
      e = p.entries[0];
    assert.equal(e.kind, "settings.updated");
    assert.equal(e.actor_id, f.alice);
    assert.equal(e.subject_id, f.orgA);
    assert.deepEqual(
      Object.keys(e).sort(),
      [
        "reference",
        "occurred_at",
        "kind",
        "actor_kind",
        "actor_id",
        "subject_kind",
        "subject_id",
      ].sort(),
    );
    const rebuilt = await new PostgresOrganizationRepository(
      f.managerPool,
    ).audit(f.owner.scope, {});
    assert.deepEqual(rebuilt.entries, p.entries);
  }));
test("audit PG: snapshot keyset pages handle equal timestamps new writes and filters without duplicates", () =>
  fixture(async (f) => {
    for (let i = 0; i < 5; i++) await f.record();
    await f.invite();
    await query(
      f.adminPool,
      "UPDATE zentwine_organizations.events SET created_at='2026-01-01T00:00:00Z' WHERE org_id=$1",
      [f.orgA],
    );
    const expected = (
      await query(
        f.adminPool,
        "SELECT audit_ref FROM zentwine_organizations.events WHERE org_id=$1 AND kind='settings.updated' ORDER BY id DESC",
        [f.orgA],
      )
    ).rows.map((x) => x.audit_ref);
    const first = await all(f, { kind: "settings.updated", limit: 2 });
    await f.record();
    const seen = first.entries.map((e) => e.reference);
    let p = first;
    while (p.next_cursor) {
      p = await all(f, {
        kind: "settings.updated",
        limit: 2,
        cursor: p.next_cursor,
      });
      assert.equal(p.snapshot_at, first.snapshot_at);
      seen.push(...p.entries.map((e) => e.reference));
    }
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, 5);
    const refreshed = await all(f, { kind: "settings.updated" });
    assert.equal(refreshed.entries.length, 6);
    assert.ok(!seen.includes(refreshed.entries[0].reference));
    assert.equal((await all(f, { kind: "member.updated" })).entries.length, 0);
  }));
test("audit PG: bigint ordering is exact above JavaScript safe integers and counters are not exposed", () =>
  fixture(async (f) => {
    await query(
      f.adminPool,
      "ALTER SEQUENCE zentwine_organizations.events_id_seq RESTART WITH 9007199254740992",
    );
    for (let n = 0; n < 3; n++) await f.record();
    const a = await all(f, { limit: 1 }),
      b = await all(f, { limit: 1, cursor: a.next_cursor }),
      c = await all(f, { limit: 1, cursor: b.next_cursor });
    assert.equal(new Set([a, b, c].map((p) => p.entries[0].reference)).size, 3);
    assert.equal(c.next_cursor, null);
    assert.ok(!JSON.stringify([a, b, c]).includes("900719925474099"));
  }));
for (const role of ["member", "viewer"])
  test(
    "audit PG: resource access cannot elevate " +
      role +
      " to organization auditor",
    () =>
      fixture(async (f) => {
        await f.admin.setMembership(
          randomUUID(),
          f.orgA,
          f.bob,
          "MEM-2",
          role,
          "active",
        );
        const user = await f.auth(f.bob);
        assert.equal(
          (await f.policy.readResource(user.scope, f.a.id)).resource.id,
          f.a.id,
        );
        await assert.rejects(all(f, {}, user.scope), fails("forbidden"));
      }),
  );
test("audit PG: guest shared-resource access does not authorize audit history", () =>
  fixture(async (f) => {
    const g = await f.accept(await f.invite());
    assert.equal(
      (await f.policy.readResource(g.scope, f.a.id)).resource.id,
      f.a.id,
    );
    await assert.rejects(all(f, {}, g.scope), fails("forbidden"));
  }));
test("audit PG: foreign and unknown organization paths are equally unavailable", () =>
  fixture(async (f) => {
    await f.record();
    for (const org of [f.orgB, randomUUID()])
      await assert.rejects(
        all(f, {}, { ...f.owner.scope, org_id: org }),
        fails("unavailable_resource"),
      );
  }));
test("audit PG: another session context filter or limit cannot reuse a cursor", () =>
  fixture(async (f) => {
    await f.record();
    await f.record();
    const p = await all(f, { limit: 1 });
    assert.ok(p.next_cursor);
    const other = await f.auth();
    await assert.rejects(
      all(f, { limit: 1, cursor: p.next_cursor }, other.scope),
      fails("invalid_input"),
    );
    const tampered = Buffer.from(p.next_cursor, "base64url");
    tampered[30] ^= 1;
    for (const q of [
      { limit: 2, cursor: p.next_cursor },
      { limit: 1, kind: "member.updated", cursor: p.next_cursor },
      { limit: 1, cursor: tampered.toString("base64url") },
    ])
      await assert.rejects(all(f, q), fails("invalid_input"));
    await f.repo.selectOrganization(
      f.owner.scope.session_digest,
      f.orgB,
      f.owner.scope.context_version,
    );
    await assert.rejects(
      all(f, { limit: 1, cursor: p.next_cursor }),
      fails("version_conflict"),
    );
  }));
test("audit PG: logout invalidates next page despite a formerly valid cursor", () =>
  fixture(async (f) => {
    await f.record();
    await f.record();
    const p = await all(f, { limit: 1 });
    await f.repo.revokeSession(f.owner.scope.session_digest);
    await assert.rejects(
      all(f, { limit: 1, cursor: p.next_cursor }),
      fails("authentication_required"),
    );
  }));
test("audit PG: organization session cutoff invalidates history but not another organization", () =>
  fixture(async (f) => {
    await f.record();
    await f.organizations.revokeOrganizationSessions(f.reviewer.scope, f.alice);
    await assert.rejects(all(f), fails("unavailable_resource"));
    const selected = await f.repo.selectOrganization(
      f.owner.scope.session_digest,
      f.orgB,
      f.owner.scope.context_version,
    );
    assert.equal(selected.active_org_id, f.orgB);
  }));
test("audit PG: downgrade rejects old sessions and fresh lower-privileged sessions", () =>
  fixture(async (f) => {
    await f.record();
    const me = (await f.organizations.members(f.reviewer.scope)).find(
      (m) => m.human_id === f.alice,
    );
    await f.organizations.updateMember(
      f.reviewer.scope,
      me.id,
      "member",
      "active",
      me.object_version,
    );
    await assert.rejects(all(f), fails("unavailable_resource"));
    await assert.rejects(
      all(f, {}, (await f.auth()).scope),
      fails("forbidden"),
    );
  }));
test("audit PG: disabled organization and identity fail closed while prior actor attribution survives", () =>
  fixture(async (f) => {
    await f.record();
    await f.admin.setHumanStatus(f.alice, "disabled");
    await assert.rejects(all(f), fails("authentication_required"));
    const p = await all(f, {}, f.reviewer.scope);
    assert.equal(p.entries[0].actor_id, f.alice);
    await f.admin.setOrganizationStatus(f.orgA, "disabled");
    await assert.rejects(
      all(f, {}, f.reviewer.scope),
      fails("unavailable_resource"),
    );
  }));
test("audit PG: provider events retain connection attribution without external subjects or credentials", () =>
  fixture(async (f) => {
    const invitation = await f.invite(),
      provider = await f.provider();
    await f.organizations.provision(
      provider.connection.id,
      provider.digest,
      f.provisionInput(provider),
    );
    const p = await all(f),
      encoded = JSON.stringify(p);
    for (const value of [
      invitation.token,
      provider.token,
      provider.digest,
      provider.mapping.external_id,
      provider.mapping.subject,
      f.owner.token,
      f.owner.scope.session_digest,
      "Synthetic provider",
      "Synthetic Charlie",
      "Synthetic catalog",
    ])
      assert.ok(!encoded.includes(value));
    for (const kind of ["identity.linked", "identity.provisioned"]) {
      const e = p.entries.find((e) => e.kind === kind);
      assert.equal(e.actor_kind, "identity_connection");
      assert.equal(e.actor_id, provider.connection.id);
      assert.equal(e.subject_id, provider.mapping.id);
    }
  }));
test("audit PG: rejected lifecycle transaction leaves no phantom audit record", () =>
  fixture(async (f) => {
    await f.record();
    const before = await all(f);
    await query(
      f.adminPool,
      "ALTER TABLE zentwine_organizations.events ADD CONSTRAINT synthetic_reject_audit CHECK(kind<>'settings.updated') NOT VALID",
    );
    await assert.rejects(f.record(), fails("unavailable"));
    assert.deepEqual((await all(f)).entries, before.entries);
  }));
test("audit PG: runtime roles cannot rewrite or remove historical audit references", () =>
  fixture(async (f) => {
    await f.record();
    for (const pool of [f.appPool, f.managerPool]) {
      for (const sql of [
        "UPDATE zentwine_organizations.events SET audit_ref=gen_random_uuid()",
        "DELETE FROM zentwine_organizations.events",
        "TRUNCATE zentwine_organizations.events",
      ])
        await assert.rejects(query(pool, sql), (e) => e.code === "42501");
    }
    assert.equal((await all(f)).entries.length, 1);
  }));
test("audit PG wait: an event writer ahead of the reader commits before snapshot capture", () =>
  fixture(async (f) => {
    const lock = await f.adminPool.connect();
    let writer, reader;
    try {
      await lock.query("BEGIN");
      await lock.query(
        "LOCK TABLE zentwine_organizations.events IN ACCESS EXCLUSIVE MODE",
      );
      writer = f.record();
      writer.catch(() => {});
      await waitForDatabaseLock(
        f.adminPool,
        "INSERT INTO zentwine_organizations.events",
      );
      reader = all(f);
      reader.catch(() => {});
      await waitForDatabaseLock(f.adminPool, "pg_advisory_xact_lock_shared");
      await lock.query("COMMIT");
      await writer;
      assert.equal((await reader).entries[0].kind, "settings.updated");
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await Promise.allSettled([writer, reader]);
    }
  }));
test("audit PG wait: a queued read cannot pass organization revocation committed ahead of it", () =>
  fixture(async (f) => {
    await f.record();
    const lock = await f.adminPool.connect();
    let revoke, reader;
    try {
      await lock.query("BEGIN");
      await lock.query(
        "LOCK TABLE zentwine_organizations.events IN ACCESS EXCLUSIVE MODE",
      );
      revoke = f.organizations.revokeOrganizationSessions(
        f.reviewer.scope,
        f.alice,
      );
      revoke.catch(() => {});
      await waitForDatabaseLock(
        f.adminPool,
        "INSERT INTO zentwine_organizations.events",
      );
      reader = all(f);
      reader.catch(() => {});
      await waitForDatabaseLock(f.adminPool, "pg_advisory_xact_lock_shared");
      await lock.query("COMMIT");
      await revoke;
      await assert.rejects(reader, fails("unavailable_resource"));
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await Promise.allSettled([revoke, reader]);
    }
  }));
test("audit PG wait: session expiring during event storage wait is rechecked before returning records", () =>
  fixture(async (f) => {
    await f.record();
    const lock = await f.adminPool.connect();
    let reader;
    try {
      await lock.query("BEGIN");
      await lock.query(
        "LOCK TABLE zentwine_organizations.events IN ACCESS EXCLUSIVE MODE",
      );
      await query(
        f.adminPool,
        "UPDATE zentwine_identity.sessions SET idle_expires_at=clock_timestamp()+interval '1 second' WHERE digest=$1",
        [f.owner.scope.session_digest],
      );
      reader = all(f);
      reader.catch(() => {});
      await waitForDatabaseLock(f.adminPool, "MAX(id)");
      await lock.query("SELECT pg_sleep(1.1)");
      await lock.query("COMMIT");
      await assert.rejects(reader, fails("authentication_required"));
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await Promise.allSettled([reader]);
    }
  }));
test("audit PG: missing migration and denied storage never masquerade as empty successful history", () =>
  oldFixture(async (f) => {
    await assert.rejects(all(f), fails("unavailable"));
    await query(f.adminPool, await migration("up"));
    await f.organizations.updateSettings(
      f.owner.scope,
      await f.settingsInput(),
    );
    await query(
      f.adminPool,
      `REVOKE SELECT ON zentwine_organizations.events FROM "${f.managerRole}"`,
    );
    await assert.rejects(all(f), fails("unavailable"));
  }));

test("audit PG: interleaved real organization histories are filtered before pagination", () =>
  fixture(async (f) => {
    await f.admin.setMembership(
      randomUUID(),
      f.orgB,
      f.bob,
      "MEM-2",
      "owner",
      "active",
    );
    const other = await f.auth(f.bob, f.orgB);
    for (let n = 0; n < 3; n++) {
      await f.record();
      const { org_id, object_version, ...settings } =
        await f.organizations.settings(other.scope);
      assert.equal(org_id, f.orgB);
      await f.organizations.updateSettings(other.scope, {
        ...settings,
        expected_version: object_version,
      });
    }
    const own = await all(f, { limit: 2 });
    const next = await all(f, { limit: 2, cursor: own.next_cursor });
    const foreign = await all(f, {}, other.scope);
    assert.equal(own.entries.length, 2);
    assert.equal(next.entries.length, 1);
    assert.equal(next.next_cursor, null);
    assert.equal(foreign.entries.length, 3);
    const refs = foreign.entries.map((entry) => entry.reference);
    for (const entry of [...own.entries, ...next.entries]) {
      assert.equal(entry.subject_id, f.orgA);
      assert.ok(!refs.includes(entry.reference));
    }
    assert.ok(foreign.entries.every((entry) => entry.subject_id === f.orgB));
    await assert.rejects(
      all(f, { limit: 2, cursor: own.next_cursor }, other.scope),
      fails("invalid_input"),
    );
  }));
