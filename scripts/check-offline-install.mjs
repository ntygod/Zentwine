import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./local/environment.mjs";
import {
  assertLocalMode,
  checked,
  execute,
  localEnvironment,
  LocalToolError,
} from "./local/process.mjs";
let temp;
try {
  assertLocalMode();
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "zentwine-offline-"));
  const checkout = path.join(temp, "checkout");
  await fs.mkdir(checkout);
  await checked(
    "git",
    ["archive", "--format=tar", "HEAD", "-o", path.join(temp, "source.tar")],
    { cwd: ROOT },
  );
  await checked("tar", ["-xf", path.join(temp, "source.tar"), "-C", checkout]);
  const empty = await execute(
    "pnpm",
    [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--store-dir",
      path.join(temp, "empty-store"),
    ],
    { cwd: checkout, env: localEnvironment(), timeoutMs: 90000 },
  );
  if (
    empty.code === 0 ||
    !/OFFLINE|offline|not found in.*store/i.test(empty.stdout + empty.stderr)
  )
    throw new LocalToolError("empty_cache_did_not_fail_as_expected");
  await checked(
    "pnpm",
    ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: ROOT, env: localEnvironment(), timeoutMs: 90000 },
  );
  console.log(
    JSON.stringify({
      empty_store: "rejected",
      warm_store: "passed",
      network_policy: "pnpm_offline",
      lifecycle_scripts: "disabled",
      note: "Browser, OS packages and Temporal caches have separate prerequisites",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code:
        error instanceof LocalToolError
          ? error.code
          : "offline_install_check_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  if (temp) await fs.rm(temp, { recursive: true, force: true });
}
