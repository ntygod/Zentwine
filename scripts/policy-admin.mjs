/** Operator-only catalog/policy setup. Never a model tool or public HTTP endpoint. */
import { randomUUID } from "node:crypto";
import { parseIdentityConfig } from "../packages/config/dist/index.js";
import {
  createIdentityPool,
  PostgresPolicyAdmin,
} from "../packages/db/dist/index.js";
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
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 8192) throw new Error();
  }
  const cmd = JSON.parse(input);
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) throw new Error();
  const pool = createIdentityPool(config.databaseUrl.reveal()),
    admin = new PostgresPolicyAdmin(pool);
  try {
    if (cmd.action === "grant-runtime") {
      const c = await pool.connect();
      try {
        await c.query(`GRANT USAGE ON SCHEMA zentwine_policy TO zt_identity_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA zentwine_policy TO zt_identity_app;
    GRANT UPDATE(display_name,object_version) ON zentwine_policy.resources TO zt_identity_app;`);
      } finally {
        c.release();
      }
    } else if (cmd.action === "register-resource") {
      const id = randomUUID();
      await admin.registerResource({ ...cmd.resource, id, object_version: 1 });
      console.log(JSON.stringify({ id, status: "registered" }));
      return;
    } else if (cmd.action === "add-rule") {
      const id = randomUUID();
      await admin.addRule(
        { ...cmd.rule, id, revoked: false },
        cmd.expected_revision,
      );
      console.log(JSON.stringify({ id, status: "configured" }));
      return;
    } else if (cmd.action === "revoke-rule")
      await admin.revokeRule(
        cmd.org_id,
        cmd.rule_id,
        cmd.kind,
        cmd.expected_revision,
      );
    else if (cmd.action === "write-mode")
      await admin.setWriteMode(cmd.org_id, cmd.mode, cmd.expected_revision);
    else throw new Error();
    console.log(
      JSON.stringify({ status: "configured", scope: "local-development" }),
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Policy operator command failed; database details and credentials withheld.",
  );
  process.exitCode = 1;
});
