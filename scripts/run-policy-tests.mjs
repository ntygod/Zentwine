import { spawnSync } from "node:child_process";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { parseTestDatabaseEnvironment } from "../packages/testkit/dist/postgres.js";
try {
  if (process.argv.length !== 2) throw new Error();
  const env = isolatedTestEnvironment(process.env);
  parseTestDatabaseEnvironment(env);
  const r = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-timeout=30000",
      "tests/policy/persistence.test.mjs",
      "tests/policy/websocket.test.mjs",
    ],
    { env, stdio: "inherit", timeout: 240000, killSignal: "SIGKILL" },
  );
  process.exitCode = r.status ?? 1;
} catch {
  console.error(
    "Policy integration requires the explicitly acknowledged disposable database; no authorization test was certified.",
  );
  process.exitCode = 1;
}
