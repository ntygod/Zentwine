import { spawnSync } from "node:child_process";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { parseTestDatabaseEnvironment } from "../packages/testkit/dist/postgres.js";
try {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode !== undefined && mode !== "--browser")) throw new Error();
  const env = isolatedTestEnvironment(process.env);
  parseTestDatabaseEnvironment(env);
  const files = mode === "--browser" ? ["tests/audit/browser.test.mjs"] : ["tests/audit/persistence.test.mjs", "tests/audit/http.test.mjs"];
  const result = spawnSync(process.execPath, ["--test", "--test-timeout=60000", ...files], { env, stdio: "inherit", timeout: 300000, killSignal: "SIGKILL" });
  process.exitCode = result.status ?? 1;
} catch {
  console.error("Audit verification requires the acknowledged disposable database and built tools. No live identity provider or production audit ledger was certified.");
  process.exitCode = 1;
}
