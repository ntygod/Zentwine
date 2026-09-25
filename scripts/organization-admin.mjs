/** Local operator setup; secrets use a new private output file, never console, args, or repository files. */
import fs from "node:fs/promises";
import { parseIdentityConfig } from "../packages/config/dist/index.js";
import {
  createIdentityPool,
  organizationGrantSql,
  PostgresFederationAdmin,
} from "../packages/db/dist/index.js";
import {
  secret,
  secretDigest,
} from "../services/api/dist/identity/security.js";
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
    if (Buffer.byteLength(input) > 4096) throw new Error();
  }
  const command = JSON.parse(input);
  const pool = createIdentityPool(config.databaseUrl.reveal());
  try {
    const admin = new PostgresFederationAdmin(pool);
    if (
      command.action === "grant-runtime" &&
      Object.keys(command).length === 1
    ) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          organizationGrantSql("zt_organization_app", "zt_identity_app"),
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    } else if (command.action === "link" && Object.keys(command).length === 5)
      await admin.link(
        command.connection_id,
        command.human_id,
        command.subject,
        command.external_id,
      );
    else if (
      command.action === "credential" &&
      Object.keys(command).length === 3
    ) {
      const output = process.env.ZENTWINE_IDENTITY_SECRET_FILE;
      if (!output || !output.startsWith("/tmp/") || output.includes(".."))
        throw new Error();
      const handle = await fs.open(output, "wx", 0o600);
      try {
        const raw = secret();
        await admin.credential(
          command.connection_id,
          secretDigest(raw),
          command.expected_version,
        );
        await handle.writeFile(raw + "\n");
      } finally {
        await handle.close();
      }
    } else throw new Error();
    console.log(
      JSON.stringify({
        status: "configured",
        scope: "local-development",
        secrets_in_output: false,
      }),
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Organization operator command failed; input and connection details withheld.",
  );
  process.exitCode = 1;
});
