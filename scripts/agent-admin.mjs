/** Operator-only installation of narrowly scoped runtime privileges. No HTTP/model admin endpoint. */
import { parseIdentityConfig } from "../packages/config/dist/index.js";
import { createIdentityPool } from "../packages/db/dist/index.js";
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
  for await (const part of process.stdin) {
    input += part;
    if (Buffer.byteLength(input) > 1024) throw new Error();
  }
  const cmd = JSON.parse(input);
  if (!cmd || Object.keys(cmd).length !== 1 || cmd.action !== "grant-runtime")
    throw new Error();
  const pool = createIdentityPool(config.databaseUrl.reveal());
  try {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`GRANT USAGE ON SCHEMA zentwine_agents TO zt_identity_app;
      GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA zentwine_agents TO zt_identity_app;
      GRANT UPDATE(disabled_at,object_version) ON zentwine_agents.identities TO zt_identity_app;
      GRANT UPDATE(reserved_calls,used_calls,revoked_at,object_version) ON zentwine_agents.delegations TO zt_identity_app;`);
      await c.query("COMMIT");
      console.log(
        JSON.stringify({
          status: "configured",
          scope: "local-development",
          credential_issued: false,
        }),
      );
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error("Agent runtime grant failed; connection details withheld.");
  process.exitCode = 1;
});
