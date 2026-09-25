/** Synthetic provisioning against a real disposable PostgreSQL instance. Never a production seeder. */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createTestDatabase,
  parseTestDatabaseEnvironment,
} from "../../packages/testkit/dist/postgres.js";
import { createTenantFixtures } from "../../packages/testkit/dist/index.js";
import { connectTestPostgres } from "../integration/pg-driver.mjs";
import {
  createIdentityPool,
  PostgresIdentityRepository,
} from "../../packages/db/dist/index.js";
import {
  secret,
  secretDigest,
} from "../../services/api/dist/identity/security.js";
export function dsn(c) {
  const u = new URL("postgres://127.0.0.1/");
  u.port = String(c.port);
  u.username = c.user;
  u.password = c.password;
  u.pathname = "/" + c.database;
  return u.href;
}
export async function fixture(work) {
  const tenants = createTenantFixtures("identity");
  let appConfig;
  const connect = async (c) => {
    if (c.user.startsWith("zt_role_")) appConfig = c;
    return connectTestPostgres(c);
  };
  const db = await createTestDatabase(process.env, connect, tenants);
  let adminPool, appPool;
  try {
    await db.transaction(tenants[0], async (c) => {
      await c.query("SELECT 1");
    });
    const config = {
      ...parseTestDatabaseEnvironment(process.env),
      database: db.databaseName,
    };
    adminPool = createIdentityPool(dsn(config));
    const c = await adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        await fs.readFile(
          "packages/db/migrations/0001-identity-core.up.sql",
          "utf8",
        ),
      );
      await c.query("COMMIT");
      const role = db.roleName;
      if (!/^zt_role_[a-f0-9]{24}$/.test(role)) throw new Error();
      await c.query(`GRANT USAGE ON SCHEMA zentwine_identity TO "${role}";
    GRANT SELECT ON zentwine_identity.humans,zentwine_identity.organizations,zentwine_identity.memberships TO "${role}";
    GRANT SELECT,UPDATE ON zentwine_identity.login_tickets TO "${role}";
    GRANT SELECT,INSERT,UPDATE ON zentwine_identity.sessions TO "${role}";`);
    } finally {
      c.release();
    }
    appPool = createIdentityPool(dsn(appConfig));
    const admin = new PostgresIdentityRepository(adminPool),
      repo = new PostgresIdentityRepository(appPool);
    const [alice, bob, orgA, orgB] = Array.from({ length: 4 }, randomUUID);
    await admin.createHuman(alice, "Synthetic Alice");
    await admin.createHuman(bob, "Synthetic Bob");
    await admin.createOrganization(orgA, "Synthetic A");
    await admin.createOrganization(orgB, "Synthetic B");
    await admin.setMembership(
      randomUUID(),
      orgA,
      alice,
      "MEM-1",
      "owner",
      "active",
    );
    await admin.setMembership(
      randomUUID(),
      orgB,
      alice,
      "MEM-1",
      "viewer",
      "active",
    );
    await admin.setMembership(
      randomUUID(),
      orgB,
      bob,
      "MEM-2",
      "member",
      "active",
    );
    const ticket = async (human) => {
      const t = secret();
      await admin.issueTicket(human, secretDigest(t));
      return t;
    };
    const login = async (human = alice) => {
      const t = await ticket(human),
        token = secret();
      return {
        token,
        session: await repo.consumeTicket(secretDigest(t), secretDigest(token)),
      };
    };
    return await work({
      admin,
      repo,
      appPool,
      adminPool,
      appConfig,
      alice,
      bob,
      orgA,
      orgB,
      ticket,
      login,
      fixture_only: true,
    });
  } finally {
    await appPool?.end();
    await adminPool?.end();
    await db.dispose();
  }
}
export async function query(pool, sql, values) {
  const c = await pool.connect();
  try {
    return await c.query(sql, values);
  } finally {
    c.release();
  }
}
