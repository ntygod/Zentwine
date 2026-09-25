/** Trusted local operator only; no HTTP registration or remote provisioning endpoint. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { parseIdentityConfig } from "../packages/config/dist/index.js";
import {
  createIdentityPool,
  PostgresIdentityRepository,
} from "../packages/db/dist/index.js";
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function input() {
  let s = "";
  for await (const b of process.stdin) {
    s += b;
    if (Buffer.byteLength(s) > 4096) throw new Error();
  }
  return JSON.parse(s);
}
async function main() {
  if (
    process.argv.length !== 2 ||
    process.env.ZENTWINE_IDENTITY_OPERATOR_ACK !== "local-development-only"
  )
    throw new Error();
  const config = parseIdentityConfig({
    ...process.env,
    ZENTWINE_DATABASE_URL: process.env.ZENTWINE_IDENTITY_OPERATOR_URL,
  });
  if (!config) throw new Error();
  const command = await input();
  if (!command || typeof command !== "object") throw new Error();
  const pool = createIdentityPool(config.databaseUrl.reveal());
  const repository = new PostgresIdentityRepository(pool);
  try {
    if (command.action === "migrate") {
      if (command.acknowledge !== "development-database") throw new Error();
      const manifest = JSON.parse(
        await fs.readFile("packages/db/migrations/manifest.json", "utf8"),
      );
      const c = await pool.connect();
      try {
        await c.query(
          "CREATE TABLE IF NOT EXISTS public.zt_migration_ledger(id text PRIMARY KEY,digest text NOT NULL)",
        );
        await c.query("REVOKE ALL ON public.zt_migration_ledger FROM PUBLIC");
        for (const entry of manifest.migrations) {
          const m = { id: entry.id };
          for (const part of ["up", "down", "verify"]) {
            const name = `packages/db/migrations/${entry.id}.${part}.sql`;
            if (entry[part].path !== name) throw new Error();
            const bytes = await fs.readFile(name);
            if (sha(bytes) !== entry[part].sha256) throw new Error();
            m[part] = bytes.toString("utf8");
          }
          const digest = sha(JSON.stringify([m.id, m.up, m.down, m.verify]));
          await c.query("BEGIN");
          try {
            await c.query(
              "LOCK TABLE public.zt_migration_ledger IN EXCLUSIVE MODE",
            );
            const prior = (
              await c.query(
                "SELECT digest FROM public.zt_migration_ledger WHERE id=$1",
                [m.id],
              )
            ).rows[0];
            if (prior) {
              if (prior.digest !== digest) throw new Error();
            } else {
              await c.query(m.up);
              if ((await c.query(m.verify)).rows[0]?.verified !== true)
                throw new Error();
              await c.query(
                "INSERT INTO public.zt_migration_ledger(id,digest) VALUES($1,$2)",
                [m.id, digest],
              );
            }
            await c.query("COMMIT");
          } catch (e) {
            await c.query("ROLLBACK");
            throw e;
          }
        }
      } finally {
        c.release();
      }
      console.log(
        JSON.stringify({
          action: "migrate",
          status: "applied",
          scope: "local-development",
        }),
      );
    } else if (command.action === "grant-runtime") {
      const c = await pool.connect();
      try {
        await c.query(`
    GRANT USAGE ON SCHEMA zentwine_identity TO zt_identity_app;
    GRANT SELECT ON zentwine_identity.humans,zentwine_identity.organizations,zentwine_identity.memberships TO zt_identity_app;
    GRANT SELECT,UPDATE ON zentwine_identity.login_tickets TO zt_identity_app;
    GRANT SELECT,INSERT,UPDATE ON zentwine_identity.sessions TO zt_identity_app;
   `);
      } finally {
        c.release();
      }
      console.log(
        JSON.stringify({ status: "granted", role: "zt_identity_app" }),
      );
    } else if (command.action === "create-human") {
      const id = randomUUID();
      await repository.createHuman(id, command.display_name);
      console.log(JSON.stringify({ id }));
    } else if (command.action === "create-organization") {
      const id = randomUUID();
      await repository.createOrganization(id, command.display_name);
      console.log(JSON.stringify({ id }));
    } else if (command.action === "membership") {
      await repository.setMembership(
        randomUUID(),
        command.org_id,
        command.human_id,
        command.display_number,
        command.role,
        command.status,
      );
      console.log(JSON.stringify({ status: "updated" }));
    } else if (command.action === "human-status") {
      await repository.setHumanStatus(command.human_id, command.status);
      console.log(JSON.stringify({ status: "updated_sessions_invalidated" }));
    } else if (command.action === "organization-status") {
      await repository.setOrganizationStatus(command.org_id, command.status);
      console.log(JSON.stringify({ status: "updated" }));
    } else if (command.action === "issue-ticket") {
      // Tickets are deliberately NOT printed to the terminal or stored in reports.
      let dir = process.cwd();
      for (const part of [".zentwine", "identity"]) {
        dir = path.join(dir, part);
        await fs.mkdir(dir, { mode: 0o700 }).catch((e) => {
          if (e.code !== "EEXIST") throw e;
        });
        const st = await fs.lstat(dir);
        if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077)
          throw new Error();
      }
      const ticket = randomBytes(32).toString("base64url");
      await repository.issueTicket(command.human_id, sha(ticket));
      const name = path.join(
        dir,
        `ticket-${randomBytes(12).toString("hex")}.json`,
      );
      await fs.writeFile(name, JSON.stringify({ ticket }), {
        mode: 0o600,
        flag: "wx",
      });
      console.log(
        JSON.stringify({
          ticket_file: path.relative(process.cwd(), name),
          expires_in_seconds: 300,
        }),
      );
    } else throw new Error();
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Identity operator command failed; credentials and database errors withheld.",
  );
  process.exitCode = 1;
});
