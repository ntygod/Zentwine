import { spawnSync } from "node:child_process";
import { isolatedTestEnvironment } from "./test-environment.mjs";
import { parseTestDatabaseEnvironment } from "../packages/testkit/dist/postgres.js";
try {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode !== undefined && mode !== "--browser"))
    throw new Error();
  const env = isolatedTestEnvironment(process.env);
  parseTestDatabaseEnvironment(env);
  const files =
    mode === "--browser"
      ? [
          "tests/organizations/browser.test.mjs",
          "tests/organizations/theme-browser.test.mjs",
        ]
      : [
          "tests/organizations/lifecycle.test.mjs",
          "tests/organizations/federation.test.mjs",
          "tests/organizations/http.test.mjs",
        ];
  const r = spawnSync(
    process.execPath,
    ["--test", "--test-timeout=60000", ...files],
    { env, stdio: "inherit", timeout: 300000, killSignal: "SIGKILL" },
  );
  process.exitCode = r.status ?? 1;
} catch {
  console.error(
    "Organization verification requires the acknowledged disposable database and prepared tools; no live IdP or production service was certified.",
  );
  process.exitCode = 1;
}
