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
import { createSsoPort } from "../../services/api/dist/organizations/federation-port.js";
const O = "zentwine_organizations";
const verifier = {
  async verify(input, connection) {
    assert.equal(input.fixture_only, true);
    return {
      issuer: connection.issuer,
      audience: connection.client_id,
      subject: "synthetic-subject",
    };
  },
};
test("IdP PG port: synthetic verified exact subject can mint then atomically consume local session ticket", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      port = createSsoPort(f.organizations, p.connection.id, verifier),
      r = await port.exchange({ fixture_only: true }),
      next = secret();
    const s = await f.repo.consumeTicket(
      secretDigest(r.ticket),
      secretDigest(next),
    );
    assert.equal(s.human.id, f.bob);
    assert.ok(s.organizations.some((o) => o.id === f.orgA));
    await assert.rejects(
      f.repo.consumeTicket(secretDigest(r.ticket), secretDigest(secret())),
    );
  }));
test("IdP PG port: unknown subject is not linked by an email-shaped identifier", () =>
  fixture(async (f) => {
    const p = await f.provider();
    await assert.rejects(
      f.organizations.federatedTicket(
        p.connection.id,
        1,
        "bob@example.test",
        secretDigest(secret()),
      ),
      fails("unavailable_resource"),
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          `SELECT count(*)::int AS n FROM ${O}.external_identities`,
        )
      ).rows[0].n,
      1,
    );
  }));
test("IdP PG port: verified proof cannot be swapped between connections or audiences", () =>
  fixture(async (f) => {
    const p = await f.provider();
    const port = createSsoPort(f.organizations, p.connection.id, {
      async verify() {
        return {
          issuer: p.connection.issuer,
          audience: "other-client",
          subject: "synthetic-subject",
        };
      },
    });
    await assert.rejects(
      port.exchange({ fixture_only: true }),
      fails("authentication_required"),
    );
  }));
test("IdP PG: immutable subject mapping cannot be silently reassigned to another human", () =>
  fixture(async (f) => {
    const p = await f.provider();
    await assert.rejects(
      f.federation.link(
        p.connection.id,
        f.alice,
        p.mapping.subject,
        p.mapping.external_id,
      ),
    );
    const m = (
      await query(
        f.adminPool,
        `SELECT human_id FROM ${O}.external_identities WHERE id=$1`,
        [p.mapping.id],
      )
    ).rows[0];
    assert.equal(m.human_id, f.bob);
  }));
test("IdP PG: same subject at a different configured connection remains a different mapping", () =>
  fixture(async (f) => {
    const p = await f.provider();
    const cid = randomUUID();
    await f.organizations.configureConnection(f.owner.scope, cid, {
      ...p.input,
      client_id: "other-client",
    });
    await f.federation.link(
      cid,
      f.alice,
      p.mapping.subject,
      p.mapping.external_id,
    );
    const rows = (
      await query(
        f.adminPool,
        `SELECT human_id FROM ${O}.external_identities WHERE subject=$1 ORDER BY human_id`,
        [p.mapping.subject],
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].human_id, rows[1].human_id);
  }));
test("IdP PG: mapped issuer/client identity cannot be changed in place", () =>
  fixture(async (f) => {
    const p = await f.provider();
    await assert.rejects(
      f.organizations.configureConnection(f.owner.scope, p.connection.id, {
        ...p.input,
        issuer: "https://another.example.test/",
        expected_version: 1,
      }),
      fails("forbidden"),
    );
  }));
test("IdP PG: config revision invalidates old provisioning credential and outstanding SSO ticket", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      r = await createSsoPort(
        f.organizations,
        p.connection.id,
        verifier,
      ).exchange({ fixture_only: true });
    await f.organizations.configureConnection(f.owner.scope, p.connection.id, {
      ...p.input,
      display_name: "Renamed provider",
      expected_version: 1,
    });
    await assert.rejects(
      f.organizations.provision(p.connection.id, p.digest, f.provisionInput(p)),
      fails("authentication_required"),
    );
    await assert.rejects(
      f.repo.consumeTicket(secretDigest(r.ticket), secretDigest(secret())),
    );
  }));
test("IdP PG: provider suspension blocks next resource access and preserves other organizations", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      old = await f.auth(f.bob),
      other = await f.auth(f.bob, f.orgB);
    const r = await f.organizations.provision(
      p.connection.id,
      p.digest,
      f.provisionInput(p),
    );
    assert.equal(r.active, false);
    await assert.rejects(f.policy.readResource(old.scope, f.a.id));
    assert.ok(await f.policy.readResource(other.scope, f.b.id));
    await assert.rejects(f.auth(f.bob));
  }));
test("IdP PG: reactivation never revives old session, ticket, or scoped authorization", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      old = await f.auth(f.bob),
      r = await createSsoPort(
        f.organizations,
        p.connection.id,
        verifier,
      ).exchange({ fixture_only: true });
    const disabled = await f.organizations.provision(
      p.connection.id,
      p.digest,
      f.provisionInput(p),
    );
    await f.organizations.provision(
      p.connection.id,
      p.digest,
      f.provisionInput(p, {
        active: true,
        expected_version: disabled.object_version,
      }),
    );
    await assert.rejects(f.policy.readResource(old.scope, f.a.id));
    await assert.rejects(
      f.repo.consumeTicket(secretDigest(r.ticket), secretDigest(secret())),
    );
    assert.ok(await f.policy.readResource((await f.auth(f.bob)).scope, f.a.id));
  }));
test("IdP PG: disabling accountable owner invalidates issued Agent delegation and pending approvals", () =>
  fixture(async (f) => {
    const p = await f.provider(f.alice),
      owner = await f.auth();
    const token = secret();
    const root = await f.agents.issueRoot(
      owner.scope,
      {
        request_id: randomUUID(),
        agent_id: f.parentAgent.id,
        terms: f.terms(),
      },
      secretDigest(token),
    );
    assert.ok(root.delegation);
    const a = await f.approvals.request(owner.scope, await f.input());
    await f.organizations.provision(
      p.connection.id,
      p.digest,
      f.provisionInput(p),
    );
    await assert.rejects(
      f.agents.invoke({ credential_digest: secretDigest(token) }, f.read()),
    );
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
test("IdP PG: external disable may remove final owner instead of bypassing upstream security", () =>
  fixture(async (f) => {
    const bob = (await f.organizations.members(f.owner.scope)).find(
      (m) => m.human_id === f.bob,
    );
    await f.organizations.updateMember(
      f.owner.scope,
      bob.id,
      "member",
      "active",
      bob.object_version,
    );
    const p = await f.provider(f.alice);
    await f.organizations.provision(
      p.connection.id,
      p.digest,
      f.provisionInput(p),
    );
    const count = (
      await query(
        f.adminPool,
        "SELECT count(*)::int AS n FROM zentwine_identity.memberships WHERE org_id=$1 AND role='owner' AND status='active'",
        [f.orgA],
      )
    ).rows[0].n;
    assert.equal(count, 0);
  }));
test("IdP PG: managed member cannot be re-enabled by local UI or invitation", () =>
  fixture(async (f) => {
    const p = await f.provider();
    await f.organizations.provision(
      p.connection.id,
      p.digest,
      f.provisionInput(p),
    );
    const member = (await f.organizations.members(f.owner.scope)).find(
      (m) => m.human_id === f.bob,
    );
    assert.equal(member.managed_by_connection, true);
    await assert.rejects(
      f.organizations.updateMember(
        f.owner.scope,
        member.id,
        "owner",
        "active",
        member.object_version,
      ),
      fails("forbidden"),
    );
    await assert.rejects(
      f.invite({ human_id: f.bob }),
      fails("version_conflict"),
    );
  }));
test("IdP PG: duplicate provisioning request returns historical receipt without applying state again", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      input = f.provisionInput(p);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.organizations.provision(p.connection.id, p.digest, input),
      ),
    );
    assert.ok(results.every((x) => x.object_version === 2));
    await f.organizations.provision(
      p.connection.id,
      p.digest,
      f.provisionInput(p, { active: true, expected_version: 2 }),
    );
    assert.equal(
      (await f.organizations.provision(p.connection.id, p.digest, input))
        .active,
      false,
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          `SELECT active FROM ${O}.external_identities WHERE id=$1`,
          [p.mapping.id],
        )
      ).rows[0].active,
      true,
    );
    await assert.rejects(
      f.organizations.provision(p.connection.id, p.digest, {
        ...input,
        active: true,
      }),
      fails("version_conflict"),
    );
  }));
test("IdP PG: conflicting concurrent updates require current mapping version", () =>
  fixture(async (f) => {
    const p = await f.provider();
    const r = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        f.organizations.provision(
          p.connection.id,
          p.digest,
          f.provisionInput(p),
        ),
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
test("IdP PG: invalid credential denied before looking up external subjects", () =>
  fixture(async (f) => {
    const p = await f.provider();
    for (const external_id of [p.mapping.external_id, "unknown"])
      await assert.rejects(
        f.organizations.provision(
          p.connection.id,
          secretDigest(secret()),
          f.provisionInput(p, { external_id }),
        ),
        fails("authentication_required"),
      );
  }));
test("IdP PG: explicit credential rotation rejects old credential", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      next = secretDigest(secret());
    await f.federation.credential(p.connection.id, next, 1);
    await assert.rejects(
      f.organizations.provision(p.connection.id, p.digest, f.provisionInput(p)),
      fails("authentication_required"),
    );
    assert.equal(
      (
        await f.organizations.provision(
          p.connection.id,
          next,
          f.provisionInput(p),
        )
      ).active,
      false,
    );
  }));
test("IdP PG: provider credential expiry blocks attempts without changing member", () =>
  fixture(async (f) => {
    const p = await f.provider();
    await query(
      f.adminPool,
      `UPDATE ${O}.connections SET credential_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [p.connection.id],
    );
    await assert.rejects(
      f.organizations.provision(p.connection.id, p.digest, f.provisionInput(p)),
      fails("authentication_required"),
    );
    assert.equal(
      (
        await query(
          f.adminPool,
          `SELECT active FROM ${O}.external_identities WHERE id=$1`,
          [p.mapping.id],
        )
      ).rows[0].active,
      true,
    );
  }));
test("IdP PG: failed event persistence rolls back upstream disable and all revocations", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      old = await f.auth(f.bob);
    await query(
      f.adminPool,
      `REVOKE INSERT ON ${O}.events FROM "${f.managerRole}"`,
    );
    await assert.rejects(
      f.organizations.provision(p.connection.id, p.digest, f.provisionInput(p)),
      fails("unavailable"),
    );
    assert.ok(await f.policy.readResource(old.scope, f.a.id));
    assert.equal(
      (
        await query(
          f.adminPool,
          `SELECT count(*)::int AS n FROM ${O}.provisioning_receipts`,
        )
      ).rows[0].n,
      0,
    );
  }));
test("IdP PG: disabling and re-enabling connection does not silently reactivate mappings", () =>
  fixture(async (f) => {
    const p = await f.provider();
    await f.organizations.configureConnection(f.owner.scope, p.connection.id, {
      ...p.input,
      enabled: false,
      expected_version: 1,
    });
    await f.organizations.configureConnection(f.owner.scope, p.connection.id, {
      ...p.input,
      enabled: true,
      expected_version: 2,
    });
    await assert.rejects(f.auth(f.bob));
    const m = (
      await query(
        f.adminPool,
        `SELECT active,object_version FROM ${O}.external_identities WHERE id=$1`,
        [p.mapping.id],
      )
    ).rows[0];
    assert.equal(m.active, false);
    const token = secretDigest(secret());
    await f.federation.credential(p.connection.id, token, 3);
    await f.organizations.provision(
      p.connection.id,
      token,
      f.provisionInput(p, { active: true, expected_version: m.object_version }),
    );
    assert.ok(await f.auth(f.bob));
  }));
test("IdP PG: credential expiry during event lock wait rolls back a provisioning change", () =>
  fixture(async (f) => {
    const p = await f.provider(),
      lock = await f.adminPool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(`LOCK TABLE ${O}.events IN ACCESS EXCLUSIVE MODE`);
      await query(
        f.adminPool,
        `UPDATE ${O}.connections SET credential_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`,
        [p.connection.id],
      );
      const waiting = assert.rejects(
        f.organizations.provision(
          p.connection.id,
          p.digest,
          f.provisionInput(p),
        ),
        fails("authentication_required"),
      );
      await waitForLock(f.adminPool, `INSERT INTO ${O}.events`);
      await new Promise((r) => setTimeout(r, 600));
      await lock.query("COMMIT");
      await waiting;
      assert.equal(
        (
          await query(
            f.adminPool,
            `SELECT active FROM ${O}.external_identities WHERE id=$1`,
            [p.mapping.id],
          )
        ).rows[0].active,
        true,
      );
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  }));
