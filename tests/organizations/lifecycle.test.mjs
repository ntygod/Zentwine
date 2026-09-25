import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fixture,
  query,
  secret,
  secretDigest,
  fails,
  waitForLock,
} from "./setup.mjs";
import { PostgresOrganizationRepository } from "../../packages/db/dist/index.js";
const member = async (f, h) =>
  (await f.organizations.members(f.owner.scope)).find((m) => m.human_id === h);
test("org PG: dedicated manager role has minimum rights; normal role cannot mutate settings", () =>
  fixture(async (f) => {
    await f.organizations.assertRuntimeRole();
    await assert.rejects(
      query(
        f.appPool,
        "UPDATE zentwine_organizations.settings SET guest_ttl_days=1",
      ),
    );
    await assert.rejects(
      query(
        f.managerPool,
        "INSERT INTO zentwine_identity.humans(id,display_name) VALUES($1,'not allowed')",
        [randomUUID()],
      ),
    );
    await assert.rejects(
      query(
        f.managerPool,
        "UPDATE zentwine_organizations.connections SET credential_digest=$1",
        ["a".repeat(64)],
      ),
    );
  }));
test("org PG: settings migrate old organizations and persist across repository reconnect", () =>
  fixture(async (f) => {
    const s = await f.organizations.settings(f.owner.scope);
    assert.equal(s.locale, "zh-CN");
    const next = await f.organizations.updateSettings(
      f.owner.scope,
      await f.settingsInput({ display_name: "Changed", time_zone: "UTC" }),
    );
    assert.equal(next.object_version, 2);
    const again = await new PostgresOrganizationRepository(
      f.managerPool,
    ).settings(f.owner.scope);
    assert.equal(again.display_name, "Changed");
  }));
test("org PG: parallel settings CAS commits only once", () =>
  fixture(async (f) => {
    const i = await f.settingsInput();
    const r = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        f.organizations.updateSettings(f.owner.scope, i),
      ),
    );
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      r.filter(
        (x) => x.status === "rejected" && x.reason.code === "version_conflict",
      ).length,
      3,
    );
  }));
test("org PG: owner APIs deny ordinary member and cross-org paths", () =>
  fixture(async (f) => {
    const b = await f.auth(f.bob, f.orgB);
    await assert.rejects(f.organizations.settings(b.scope), fails("forbidden"));
    await assert.rejects(
      f.organizations.members({ ...f.owner.scope, org_id: f.orgB }),
      fails("unavailable_resource"),
    );
  }));
test("org PG: settings update revokes old invitations and invalidates bound approvals", () =>
  fixture(async (f) => {
    const i = await f.invite(),
      a = await f.propose();
    await f.organizations.updateSettings(
      f.owner.scope,
      await f.settingsInput(),
    );
    assert.equal(
      (await f.organizations.invitations(f.owner.scope))[0].state,
      "revoked",
    );
    await assert.rejects(f.accept(i));
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT state FROM zentwine_approvals.requests WHERE id=$1",
          [a.id],
        )
      ).rows[0].state,
      "revoked",
    );
  }));
test("org PG: last human owner cannot remove or demote itself", () =>
  fixture(async (f) => {
    const b = await member(f, f.bob);
    await f.organizations.updateMember(
      f.owner.scope,
      b.id,
      "member",
      "active",
      b.object_version,
    );
    const a = await member(f, f.alice);
    await assert.rejects(
      f.organizations.updateMember(
        f.owner.scope,
        a.id,
        "member",
        "active",
        a.object_version,
      ),
      fails("forbidden"),
    );
    await assert.rejects(
      f.organizations.updateMember(
        f.owner.scope,
        a.id,
        "owner",
        "revoked",
        a.object_version,
      ),
      fails("forbidden"),
    );
  }));
test("org PG: member role change invalidates only target old organization context", () =>
  fixture(async (f) => {
    const old = await f.auth(f.bob),
      other = await f.auth(f.bob, f.orgB),
      b = await member(f, f.bob);
    await f.organizations.updateMember(
      f.owner.scope,
      b.id,
      "viewer",
      "active",
      b.object_version,
    );
    await assert.rejects(f.policy.readResource(old.scope, f.a.id));
    assert.equal(
      (await f.policy.readResource(other.scope, f.b.id)).resource.id,
      f.b.id,
    );
    const fresh = await f.auth(f.bob);
    assert.equal(
      (await f.policy.readResource(fresh.scope, f.a.id)).resource.id,
      f.a.id,
    );
  }));
test("org PG: scoped session revocation does not remove another organization or explicit delegation", () =>
  fixture(async (f) => {
    const other = await f.auth(f.alice, f.orgB),
      delegation = await f.issue();
    await f.organizations.revokeOrganizationSessions(f.owner.scope, f.alice);
    await assert.rejects(f.policy.readResource(f.owner.scope, f.a.id));
    assert.equal(
      (await f.policy.readResource(other.scope, f.b.id)).resource.id,
      f.b.id,
    );
    assert.ok(await f.agents.invoke(delegation.scope, f.read()));
    const fresh = await f.auth();
    assert.ok(await f.policy.readResource(fresh.scope, f.a.id));
  }));
test("org PG: viewer can revoke own scoped sessions but not someone else", () =>
  fixture(async (f) => {
    const v = await f.auth(f.alice, f.orgB);
    await assert.rejects(
      f.organizations.revokeOrganizationSessions(v.scope, f.bob),
      fails("forbidden"),
    );
    await f.organizations.revokeOrganizationSessions(v.scope, f.alice);
    await assert.rejects(f.policy.readResource(v.scope, f.b.id));
  }));
test("org PG: invited guest gets only explicit read shares and rotated session", () =>
  fixture(async (f) => {
    const inv = await f.invite(),
      g = await f.accept(inv);
    const me = await f.organizations.self(g.scope);
    assert.equal(me.access_kind, "guest");
    assert.equal(me.role, "viewer");
    assert.ok(me.access_expires_at);
    await assert.rejects(f.repo.readSession(secretDigest(g.old.token)));
    assert.equal(
      (await f.policy.readResource(g.scope, f.a.id)).resource.id,
      f.a.id,
    );
    await assert.rejects(f.organizations.members(g.scope), fails("forbidden"));
  }));
test("org PG: guest search never returns unshared organization-visible or private resource names", () =>
  fixture(async (f) => {
    const hidden = await f.registerResource({
        display_name: "PRIVATE-NAME-SHOULD-NOT-LEAK",
      }),
      restricted = await f.registerResource({
        display_name: "SECRET",
        visibility: "restricted",
      });
    const g = await f.accept(await f.invite());
    const rows = await f.organizations.search(g.scope, "");
    assert.deepEqual(
      rows.map((r) => r.id),
      [f.a.id],
    );
    assert.ok(!JSON.stringify(rows).includes(hidden.display_name));
    assert.deepEqual(
      await f.organizations.search(g.scope, restricted.display_name),
      [],
    );
    await assert.rejects(f.policy.readResource(g.scope, hidden.id));
  }));
test("org PG: explicit update grant cannot give guest mutation/export/Agent authority", () =>
  fixture(async (f) => {
    const g = await f.accept(await f.invite());
    await f.add(f.charlie, f.a, { action: "resource.update", effect: "allow" });
    await assert.rejects(
      f.policy.renameResource(g.scope, f.a.id, "No", 1, await f.revision()),
      fails("forbidden"),
    );
    await assert.rejects(f.agents.register(g.scope, randomUUID(), "No"));
    assert.equal(
      (await f.policy.evaluate(g.scope, f.a.id, "resource.export")).outcome,
      "deny",
    );
  }));
test("org PG: expired guest access blocks context and search without deleting identity", () =>
  fixture(async (f) => {
    const g = await f.accept(await f.invite());
    await query(
      f.adminPool,
      "UPDATE zentwine_identity.memberships SET access_expires_at=clock_timestamp()-interval '1 second' WHERE human_id=$1 AND org_id=$2",
      [f.charlie, f.orgA],
    );
    await assert.rejects(f.policy.readResource(g.scope, f.a.id));
    await assert.rejects(f.organizations.search(g.scope, ""));
    assert.equal(
      (await f.repo.readSession(g.scope.session_digest)).human.id,
      f.charlie,
    );
  }));
test("org PG: two invitations with same request id return one record and no reissued secret", () =>
  fixture(async (f) => {
    const i = await f.invite();
    const r = await f.organizations.invite(
      f.owner.scope,
      i.input,
      secretDigest(secret()),
    );
    assert.equal(r.invitation.id, i.invitation.id);
    assert.equal(r.credential_issued, false);
    await assert.rejects(
      f.organizations.invite(
        f.owner.scope,
        { ...i.input, role: "member", access_kind: "member", resource_ids: [] },
        secretDigest(secret()),
      ),
      fails("version_conflict"),
    );
  }));
test("org PG: invitation cannot be used by another logged-in human or anonymous bearer", () =>
  fixture(async (f) => {
    const i = await f.invite();
    await assert.rejects(f.accept(i, f.bob), fails("unavailable_resource"));
    await f.accept(i);
    assert.equal(
      (await f.organizations.invitations(f.owner.scope))[0].state,
      "accepted",
    );
  }));
test("org PG: concurrent invitation accept gives one membership and one new session", () =>
  fixture(async (f) => {
    const i = await f.invite();
    const r = await Promise.allSettled(
      Array.from({ length: 4 }, () => f.accept(i)),
    );
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const n = (
      await query(
        f.adminPool,
        "SELECT count(*)::int AS n FROM zentwine_identity.memberships WHERE org_id=$1 AND human_id=$2",
        [f.orgA, f.charlie],
      )
    ).rows[0].n;
    assert.equal(n, 1);
  }));
test("org PG: revoked invitation never grants membership", () =>
  fixture(async (f) => {
    const i = await f.invite();
    await f.organizations.revokeInvitation(f.owner.scope, i.invitation.id, 1);
    await assert.rejects(f.accept(i), fails("unavailable_resource"));
  }));
test("org PG: expired invitation is displayed expired and cannot be consumed", () =>
  fixture(async (f) => {
    const i = await f.invite();
    await query(
      f.adminPool,
      "UPDATE zentwine_organizations.invitations SET created_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE id=$1",
      [i.invitation.id],
    );
    assert.equal(
      (await f.organizations.invitations(f.owner.scope))[0].state,
      "expired",
    );
    await assert.rejects(f.accept(i), fails("unavailable_resource"));
  }));
test("org PG: disabled invitations and unknown recipients cannot mint a credential", () =>
  fixture(async (f) => {
    await assert.rejects(
      f.invite({ human_id: randomUUID() }),
      fails("unavailable_resource"),
    );
    await f.organizations.updateSettings(
      f.owner.scope,
      await f.settingsInput({ invitations_enabled: false }),
    );
    await assert.rejects(f.invite(), fails("forbidden"));
  }));
test("org PG: inviting private or foreign resources without a read grant is refused", () =>
  fixture(async (f) => {
    const r = await f.registerResource({ visibility: "restricted" });
    for (const rid of [r.id, f.b.id])
      await assert.rejects(
        f.invite({ resource_ids: [rid] }),
        fails("unavailable_resource"),
      );
  }));
test("org PG: explicit target deny survives invitation and prevents successful acceptance", () =>
  fixture(async (f) => {
    const i = await f.invite();
    await f.add(f.charlie, f.a, { action: "resource.read", effect: "deny" });
    await assert.rejects(f.accept(i), fails("unavailable_resource"));
    assert.equal(
      (await f.organizations.invitations(f.owner.scope))[0].state,
      "pending",
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          "SELECT id FROM zentwine_identity.memberships WHERE human_id=$1",
          [f.charlie],
        )
      ).rows.length,
      0,
    );
  }));
test("org PG: revoked member rejoins with fresh scope; old session and old grants stay unusable", () =>
  fixture(async (f) => {
    const g = await f.accept(await f.invite()),
      m = await member(f, f.charlie);
    await f.organizations.updateMember(
      f.owner.scope,
      m.id,
      "viewer",
      "revoked",
      m.object_version,
    );
    await assert.rejects(
      f.organizations.updateMember(
        f.owner.scope,
        m.id,
        "viewer",
        "active",
        m.object_version + 1,
      ),
      fails("forbidden"),
    );
    const again = await f.accept(await f.invite());
    await assert.rejects(f.policy.readResource(g.scope, f.a.id));
    assert.ok(await f.policy.readResource(again.scope, f.a.id));
  }));
test("org PG: failing lifecycle event insertion rolls back settings and invitation revocation", () =>
  fixture(async (f) => {
    const i = await f.invite();
    await query(
      f.adminPool,
      `REVOKE INSERT ON zentwine_organizations.events FROM "${f.managerRole}"`,
    );
    await assert.rejects(
      f.organizations.updateSettings(f.owner.scope, await f.settingsInput()),
      fails("unavailable"),
    );
    assert.equal(
      (await f.organizations.settings(f.owner.scope)).object_version,
      1,
    );
    assert.equal(
      (await f.organizations.invitations(f.owner.scope))[0].id,
      i.invitation.id,
    );
    assert.equal(
      (await f.organizations.invitations(f.owner.scope))[0].state,
      "pending",
    );
  }));
test("org PG: session expiry while waiting for lifecycle event rolls back membership change", () =>
  fixture(async (f) => {
    const b = await member(f, f.bob),
      lock = await f.adminPool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(
        "LOCK TABLE zentwine_organizations.events IN ACCESS EXCLUSIVE MODE",
      );
      await query(
        f.adminPool,
        "UPDATE zentwine_identity.sessions SET idle_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE digest=$1",
        [f.owner.scope.session_digest],
      );
      const pending = f.organizations.updateMember(
        f.owner.scope,
        b.id,
        "viewer",
        "active",
        b.object_version,
      );
      const rejected = assert.rejects(
        pending,
        fails("authentication_required"),
      );
      await waitForLock(
        f.adminPool,
        "INSERT INTO zentwine_organizations.events",
      );
      await new Promise((r) => setTimeout(r, 600));
      await lock.query("COMMIT");
      await rejected;
      const m = (
        await query(
          f.adminPool,
          "SELECT role FROM zentwine_identity.memberships WHERE id=$1",
          [b.id],
        )
      ).rows[0];
      assert.equal(m.role, "owner");
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  }));
