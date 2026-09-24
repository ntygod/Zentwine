import { spawnSync } from "node:child_process";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { parseTestDatabaseEnvironment } from "../packages/testkit/dist/postgres.js";
try {
  const env = isolatedTestEnvironment(process.env);
  parseTestDatabaseEnvironment(env);
  const result = spawnSync(
    process.execPath,
    ["--test", "tests/integration/postgres.test.mjs"],
    {
      env,
      stdio: "inherit",
      timeout: 180000,
      killSignal: "SIGKILL",
    },
  );
  if (result.error)
    console.error(
      "Database test process could not finish; dispose of its dedicated test container",
    );
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "Database tests require a disposable loopback test server, ZENTWINE_TEST_DATABASE_URL and ZENTWINE_TEST_DATABASE_ACK=disposable-local-only. No tests were run.",
  );
  process.exitCode = 1;
}
