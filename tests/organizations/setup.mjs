/** Synthetic people and normalized IdP inputs in a real, disposable database. No live identity provider. */
import fs from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import {
  fixture as approvalFixture,
  query,
  request,
  waitForLock,
  origin,
  secret,
  secretDigest,
} from "../approvals/setup.mjs";
import { dsn } from "../identity/setup.mjs";
import {
  createIdentityPool,
  PostgresOrganizationRepository,
  PostgresFederationAdmin,
  organizationGrantSql,
} from "../../packages/db/dist/index.js";
import { cookie, csrfFor } from "../../services/api/dist/identity/security.js";
export { query, request, waitForLock, origin, secret, secretDigest };
export const fails = (code) => (e) => e.code === code;
export async function fixture(work) {
  return approvalFixture(async (f) => {
    const role = "zt_org_" + randomBytes(12).toString("hex"),
      password = secret();
    let managerPool,
      created = false;
    try {
      await query(
        f.adminPool,
        await fs.readFile(
          "packages/db/migrations/0005-organization-lifecycle.up.sql",
          "utf8",
        ),
      );
      await query(
        f.adminPool,
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      created = true;
      await query(f.adminPool, organizationGrantSql(role, f.appConfig.user));
      managerPool = createIdentityPool(
        dsn({ ...f.appConfig, user: role, password }),
      );
      const organizations = new PostgresOrganizationRepository(managerPool),
        federation = new PostgresFederationAdmin(f.adminPool);
      const charlie = randomUUID();
      await f.admin.createHuman(charlie, "Synthetic Charlie");
      const settingsInput = async (extra = {}) => {
        const s = await organizations.settings(f.owner.scope);
        return {
          display_name: s.display_name,
          locale: s.locale,
          time_zone: s.time_zone,
          invitations_enabled: s.invitations_enabled,
          invite_ttl_hours: s.invite_ttl_hours,
          guest_ttl_days: s.guest_ttl_days,
          expected_version: s.object_version,
          ...extra,
        };
      };
      const invite = async (extra = {}, scope = f.owner.scope) => {
        const token = secret(),
          input = {
            request_id: randomUUID(),
            human_id: charlie,
            role: "viewer",
            access_kind: "guest",
            resource_ids: [f.a.id],
            expected_settings_version: (await organizations.settings(scope))
              .object_version,
            ...extra,
          };
        return {
          ...(await organizations.invite(scope, input, secretDigest(token))),
          token,
          input,
        };
      };
      const accept = async (inv, human = charlie) => {
        const old = await f.login(human),
          token = secret();
        const accepted = await organizations.acceptInvitation(
          secretDigest(old.token),
          secretDigest(inv.token),
          secretDigest(token),
        );
        const view = await f.repo.readSession(secretDigest(token));
        return {
          token,
          cookie: cookie(token).split(";")[0],
          csrf: csrfFor(token),
          scope: {
            session_digest: secretDigest(token),
            org_id: accepted.org_id,
            context_version: view.context_version,
          },
          old,
          accepted,
        };
      };
      const provider = async (human = f.bob) => {
        const id = randomUUID(),
          input = {
            display_name: "Synthetic provider",
            issuer: "https://idp.example.test/",
            client_id: "zentwine-fixture",
            enabled: true,
            expected_version: 0,
          };
        const connection = await organizations.configureConnection(
          f.owner.scope,
          id,
          input,
        );
        await federation.link(
          id,
          human,
          "synthetic-subject",
          "synthetic-external",
        );
        const token = secret();
        await federation.credential(
          id,
          secretDigest(token),
          connection.object_version,
        );
        const mapping = (
          await query(
            f.adminPool,
            "SELECT * FROM zentwine_organizations.external_identities WHERE connection_id=$1",
            [id],
          )
        ).rows[0];
        return {
          connection,
          token,
          digest: secretDigest(token),
          mapping,
          input,
        };
      };
      const provisionInput = (p, extra = {}) => ({
        request_id: randomUUID(),
        external_id: p.mapping.external_id,
        active: false,
        expected_version: p.mapping.object_version,
        ...extra,
      });
      return await work({
        ...f,
        charlie,
        organizations,
        federation,
        managerPool,
        managerRole: role,
        settingsInput,
        invite,
        accept,
        provider,
        provisionInput,
        app: (opts) => f.app({ organizations, ...opts }),
      });
    } finally {
      await managerPool?.end();
      if (created) {
        await query(f.adminPool, `DROP OWNED BY "${role}"`);
        await query(f.adminPool, `DROP ROLE "${role}"`);
      }
    }
  });
}
