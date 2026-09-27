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
      "tests/approvals/persistence.test.mjs",
      "tests/approvals/http.test.mjs",
      "tests/approvals/waits.test.mjs",
      "tests/approvals/hardening.test.mjs",
      "tests/approvals/inbox.test.mjs",
    ],
    { env, stdio: "inherit", timeout: 240000, killSignal: "SIGKILL" },
  );
  process.exitCode = r.status ?? 1;
} catch {
  console.error(
    "Approval verification requires the explicitly acknowledged disposable database; no real model or production authorization was certified.",
  );
  process.exitCode = 1;
}
