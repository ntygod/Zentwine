import { spawnSync } from "node:child_process";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { parseTestDatabaseEnvironment } from "../packages/testkit/dist/postgres.js";
try {
  if (process.argv.length !== 2) throw new Error();
  const env = isolatedTestEnvironment(process.env);
  parseTestDatabaseEnvironment(env);
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-timeout=60000", "tests/tenant/rls.test.mjs"],
    { env, stdio: "inherit", timeout: 300000, killSignal: "SIGKILL" },
  );
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "Tenant RLS tests require acknowledged disposable PostgreSQL and built tools; no integration was silently skipped.",
  );
  process.exitCode = 1;
}
