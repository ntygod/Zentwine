/** Explicit local-development installation only. Does not create users, issue credentials or run migrations. */
import { parseIdentityConfig } from "../packages/config/dist/index.js";
import {
  createIdentityPool,
  tenantRuntimeGrantSql,
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
  for await (const part of process.stdin) {
    input += part;
    if (Buffer.byteLength(input) > 256) throw new Error();
  }
  const command = JSON.parse(input);
  if (
    !command ||
    command.action !== "grant-runtime" ||
    Object.keys(command).length !== 1
  )
    throw new Error();
  const pool = createIdentityPool(config.databaseUrl.reveal());
  let c;
  try {
    c = await pool.connect();
    await c.query("BEGIN");
    await c.query(tenantRuntimeGrantSql("zt_tenant_app"));
    await c.query("COMMIT");
    console.log(
      JSON.stringify({
        status: "configured",
        scope: "local-development",
        runtime_role: "zt_tenant_app",
        secrets_in_output: false,
      }),
    );
  } catch {
    await c?.query("ROLLBACK").catch(() => {});
    throw new Error();
  } finally {
    c?.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Tenant operator command failed; credentials and database details withheld.",
  );
  process.exitCode = 1;
});
