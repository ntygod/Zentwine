import { spawnSync } from "node:child_process";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { parseTestDatabaseEnvironment } from "../packages/testkit/dist/postgres.js";
try {
  const env = isolatedTestEnvironment(process.env);
  parseTestDatabaseEnvironment(env);
  const r = spawnSync(
    process.execPath,
    ["--test", "tests/identity/persistence.test.mjs"],
    { env, stdio: "inherit", timeout: 180000, killSignal: "SIGKILL" },
  );
  process.exitCode = r.status ?? 1;
} catch {
  console.error(
    "Identity integration requires the explicitly acknowledged disposable database; no identity test was certified.",
  );
  process.exitCode = 1;
}
