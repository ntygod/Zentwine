import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { LocalStack, ROOT, toolchain, withLock } from "./local/environment.mjs";
import {
  assertLocalMode,
  execute,
  localEnvironment,
  LocalToolError,
  redactOutput,
} from "./local/process.mjs";
import { temporalBinary } from "./local/tooling.mjs";
export function parseDrillArgs(args) {
  let suite = "all",
    offline = false,
    seen = false;
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === "--suite" &&
      !seen &&
      ["all", "database", "durability"].includes(args[i + 1])
    ) {
      suite = args[++i];
      seen = true;
    } else if (args[i] === "--offline" && !offline) offline = true;
    else throw new LocalToolError("invalid_drill_arguments");
  }
  return { suite, offline };
}
export async function runDrill(options, { signal, source = process.env } = {}) {
  assertLocalMode(source);
  if (process.versions.node !== toolchain.node)
    throw new LocalToolError("node_baseline_mismatch");
  const session = randomBytes(8).toString("hex");
  const reports = path.join(ROOT, "reports", "drills", session);
  await fs.mkdir(reports, { recursive: true, mode: 0o700 });
  const stack = new LocalStack({
    directory: path.join(ROOT, ".zentwine", "sessions", session),
    source,
  });
  const summary = {
    schema_version: 1,
    task: "ZT01-06",
    session,
    suite: options.suite,
    status: "running",
    cleanup: "not_started",
    steps: [],
    live_models: "not_run",
    production_acceptance: "not_run",
  };
  console.log(
    JSON.stringify({
      session,
      status: "preparing",
      recovery: `pnpm env:down --session ${session}`,
    }),
  );
  let failed,
    credential = "";
  const record = async (name, command, args, opts = {}) => {
    const result = await execute(command, args, {
      cwd: ROOT,
      env: localEnvironment(source),
      signal,
      timeoutMs: 240000,
      ...opts,
    });
    await fs.writeFile(
      path.join(reports, name + ".log"),
      redactOutput(result.stdout + result.stderr, [credential]),
      { mode: 0o600 },
    );
    summary.steps.push({
      name,
      status: result.code === 0 ? "passed" : "failed",
    });
    if (result.code !== 0) throw new LocalToolError("drill_step_failed");
  };
  try {
    const commit = await execute("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      env: localEnvironment(source),
      signal,
    });
    const tree = await execute("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: ROOT,
      env: localEnvironment(source),
      signal,
    });
    const clean = await execute("git", ["diff", "--quiet", "HEAD", "--"], {
      cwd: ROOT,
      env: localEnvironment(source),
      signal,
    });
    if (
      commit.code !== 0 ||
      tree.code !== 0 ||
      !/^[a-f0-9]{40}$/.test(commit.stdout.trim()) ||
      !/^[a-f0-9]{40}$/.test(tree.stdout.trim()) ||
      clean.code > 1
    )
      throw new LocalToolError("source_provenance_unavailable");
    summary.source = {
      commit: commit.stdout.trim(),
      tree: tree.stdout.trim(),
      tracked_clean_at_start: clean.code === 0,
      scope: "git_baseline_not_an_immutable_worktree_snapshot",
    };
    // Inspect prerequisites before creating the Compose environment. Never install implicitly.
    if (options.suite !== "durability") {
      await fs.access(path.join(ROOT, "packages/testkit/dist/postgres.js"));
      await record("python-validators", source.QUALITY_PYTHON ?? "python3", [
        "-c",
        "import jsonschema, yaml; print('ready')",
      ]);
    }
    let cli;
    if (options.suite !== "database") {
      await fs.access(
        path.join(
          ROOT,
          "spikes/ZT01-01-durable-workflow/dist/integration.test.js",
        ),
      );
      cli = await temporalBinary();
    }
    await stack.prepare();
    await withLock(stack.directory, async () => {
      try {
        await stack.up({ offline: options.offline, signal });
        const env = await stack.testEnvironment();
        credential = await stack.password();
        if (options.suite !== "durability") {
          await record(
            "database",
            process.execPath,
            ["scripts/run-database-tests.mjs"],
            { env },
          );
          await record(
            "migrations",
            process.execPath,
            ["scripts/run-migration-tests.mjs"],
            { env },
          );
        }
        if (options.suite !== "database") {
          await withLock(
            path.join(ROOT, ".zentwine", "spike-reports"),
            async () => {
              const cwd = path.join(ROOT, "spikes/ZT01-01-durable-workflow");
              const scoped = {
                ...env,
                GITHUB_SHA: summary.source.commit,
                POC_TEMPORAL_CLI: cli,
              };
              await record(
                "durability-unit",
                process.execPath,
                ["--test", "dist/unit.test.js"],
                { cwd, env: scoped },
              );
              await record(
                "durability-integration",
                process.execPath,
                ["--test", "dist/integration.test.js"],
                { cwd, env: scoped },
              );
              // Preserve original results before any later invocation can overwrite the Spike report.
              const sourceReport = JSON.parse(
                await fs.readFile(
                  path.join(cwd, "reports/poc-results.json"),
                  "utf8",
                ),
              );
              await fs.writeFile(
                path.join(reports, "durability-results.json"),
                JSON.stringify(sourceReport, null, 2),
              );
            },
          );
        }
      } finally {
        const clean = await stack.down();
        summary.cleanup = ["removed", "absent"].includes(clean.status)
          ? "passed"
          : "failed";
      }
    });
    summary.status = "passed";
  } catch (error) {
    failed = error;
    summary.status = signal?.aborted ? "cancelled" : "failed";
    summary.reason =
      error instanceof LocalToolError
        ? error.code
        : "drill_prerequisite_or_execution_failed";
    if (summary.cleanup !== "passed") summary.cleanup = "check_session";
  } finally {
    await fs.writeFile(
      path.join(reports, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary, null, 2));
  }
  if (failed) throw new LocalToolError(summary.reason);
  return summary;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runDrill(parseDrillArgs(process.argv.slice(2)), {
      signal: controller.signal,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        code: error instanceof LocalToolError ? error.code : "drill_failed",
      }),
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
