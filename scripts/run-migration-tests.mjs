import { spawnSync } from "node:child_process";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { parseTestDatabaseEnvironment } from "../packages/testkit/dist/postgres.js";
try {
  const env = isolatedTestEnvironment(process.env);
  parseTestDatabaseEnvironment(env);
  if (process.env.QUALITY_BASE_REF)
    env.QUALITY_BASE_REF = process.env.QUALITY_BASE_REF;
  if (process.env.QUALITY_PYTHON)
    env.QUALITY_PYTHON = process.env.QUALITY_PYTHON;
  const result = spawnSync(
    process.execPath,
    ["--test", "tests/migrations/rehearsal.test.mjs"],
    { env, stdio: "inherit", timeout: 180000, killSignal: "SIGKILL" },
  );
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "Migration rehearsal requires the explicitly acknowledged disposable test database; no migration was run.",
  );
  process.exitCode = 1;
}
