/** No CLI-selected executable, external server, provider credential or ambient NODE_OPTIONS. */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  validateMatrix,
  verifyTap,
  coverageSummary,
} from "./access-matrix.mjs";
import { isolatedTestEnvironment } from "./test-environment.mjs";
const reportPath = "reports/access-matrix-evidence.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  schema_version: 1,
  kind: "access_matrix_evidence",
  status: "failed",
  executed: false,
  work_package_complete: false,
};
let checkOnly = false;
try {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 &&
      !["--check", "--require-all-surfaces"].includes(args[0]))
  )
    throw new Error("invalid_arguments");
  checkOnly = args[0] === "--check";
  const definition = await fs.readFile("quality/access-matrix.json");
  const cells = validateMatrix(JSON.parse(definition.toString("utf8")));
  Object.assign(report, coverageSummary(cells), {
    definition_sha256: sha256(definition),
    cells,
  });
  if (checkOnly) {
    report.status = "definition_valid_not_executed";
  } else {
    // Replace any old green evidence BEFORE checking environment or starting tests.
    await fs.mkdir("reports", { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    const env = isolatedTestEnvironment(process.env);
    const { parseTestDatabaseEnvironment } = await import(
      "../packages/testkit/dist/postgres.js"
    );
    parseTestDatabaseEnvironment(env);
    const git = (...args) =>
      execFileSync("git", args, {
        encoding: "utf8",
        env,
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const cleanSource = () => {
      if (git("status", "--porcelain", "--untracked-files=no") !== "")
        throw new Error("tracked_source_changed");
    };
    cleanSource();
    const commit = git("rev-parse", "HEAD"),
      tree = git("rev-parse", "HEAD^{tree}");
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree))
      throw new Error("invalid_source_identity");
    report.source = {
      commit,
      tree,
      lock_sha256: sha256(await fs.readFile("pnpm-lock.yaml")),
    };
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "--test-timeout=60000",
        "--test-reporter=tap",
        "tests/access-matrix/boundaries.test.mjs",
      ],
      {
        env,
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
        killSignal: "SIGKILL",
      },
    );
    const tap = result.stdout ?? "";
    await fs.writeFile("reports/access-matrix.tap", tap);
    // Stderr is retained in the CI console, not copied into a misleading pass report.
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(tap);
    report.executed = true;
    report.tap_sha256 = sha256(tap);
    report.passed_case_ids = verifyTap(tap, result.status, cells);
    if (result.error || result.signal) throw new Error("matrix_runner_failed");
    cleanSource();
    if (git("rev-parse", "HEAD") !== commit)
      throw new Error("tested_commit_changed");
    report.status = "current_surfaces_verified";
    if (args[0] === "--require-all-surfaces" && report.deferred_surfaces.length) {
      report.status = "incomplete_surface_implementation";
      process.exitCode = 2;
    }
  }
} catch {
  report.status = "failed";
  report.error = "Matrix verification failed; inspect fixed test output and disposable configuration.";
  process.exitCode = 1;
} finally {
  const text = JSON.stringify(report, null, 2) + "\n";
  if (!checkOnly) {
    await fs.mkdir("reports", { recursive: true });
    await fs.writeFile(reportPath, text);
  }
  process.stdout.write(text);
}
