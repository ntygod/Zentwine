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
      await c.query(`GRANT USAGE ON SCHEMA zentwine_approvals TO zt_identity_app;
      GRANT SELECT ON ALL TABLES IN SCHEMA zentwine_approvals TO zt_identity_app;
      GRANT INSERT ON zentwine_approvals.requests,zentwine_approvals.decisions,zentwine_approvals.permits,zentwine_approvals.receipts,zentwine_approvals.events TO zt_identity_app;
      GRANT UPDATE(state,object_version,reason) ON zentwine_approvals.requests TO zt_identity_app;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA zentwine_approvals TO zt_identity_app;
      GRANT UPDATE(consumed_at) ON zentwine_approvals.permits TO zt_identity_app;`);
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
  console.error("Approval runtime grant failed; connection details withheld.");
  process.exitCode = 1;
});
