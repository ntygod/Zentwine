/** Explicit CLI; importing this module does not inspect a repository. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalRepositoryPort } from "./lib/local-repository.mjs";

export async function repositoryCompareMain(args, signal) {
  const invalid = {
    report_version: "1.0.0",
    scope: "local_git_commit_comparison",
    status: "rejected",
    authorization: false,
    comparison: null,
    fault: { code: "invalid_arguments" },
    exit_code: 64,
  };
  if (
    !Array.isArray(args) ||
    !args.length ||
    args.some((arg) => typeof arg !== "string")
  )
    return invalid;
  if (args.length === 1 && args[0] === "--help")
    return {
      report_version: "1.0.0",
      status: "help",
      authorization: false,
      executed: false,
      exit_code: 0,
      usage:
        "node scripts/repository-compare.mjs <directory> --base <sha> --head <sha> [--path <exact-path>] [--timeout-ms 1..30000]",
    };
  const [directory, ...rest] = args;
  if (!directory || directory.startsWith("--") || rest.length % 2)
    return invalid;
  const values = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !["--base", "--head", "--path", "--timeout-ms"].includes(rest[i]) ||
      values.has(rest[i])
    )
      return invalid;
    values.set(rest[i], rest[i + 1]);
  }
  if (
    ["--base", "--head"].some(
      (key) =>
        !values.has(key) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(values.get(key)),
    ) ||
    (values.has("--path") && !values.get("--path"))
  )
    return invalid;
  if (
    values.has("--timeout-ms") &&
    !/^[1-9][0-9]*$/.test(values.get("--timeout-ms"))
  )
    return invalid;
  try {
    const port = createLocalRepositoryPort(
      directory,
      values.has("--timeout-ms")
        ? { timeoutMs: Number(values.get("--timeout-ms")) }
        : {},
    );
    const value = {
      report: values.has("--path")
        ? await port.readCommitDiff(
            values.get("--base"),
            values.get("--head"),
            values.get("--path"),
            signal,
          )
        : await port.compareCommits(
            values.get("--base"),
            values.get("--head"),
            signal,
          ),
    };
    const code = value.report.fault?.code;
    return {
      ...value.report,
      exit_code:
        value.report.status === "compared"
          ? 0
          : code === "invalid_arguments"
            ? 64
            : code === "timeout"
              ? 124
              : code === "cancelled"
                ? 130
                : 2,
    };
  } catch {
    return invalid;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  let terminating = false;
  const interrupt = () => controller.abort();
  const terminate = () => {
    terminating = true;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.stdout.on("error", () => {
    process.exitCode = 3;
  });
  try {
    const report = await repositoryCompareMain(
      process.argv.slice(2),
      controller.signal,
    );
    if (controller.signal.aborted) {
      report.status = "rejected";
      report.comparison = null;
      report.working_tree = null;
      report.fault = { code: "cancelled" };
      report.exit_code = terminating ? 143 : 130;
    }
    await new Promise((resolve, reject) => {
      process.stdout.once("error", reject);
      process.stdout.write(`${JSON.stringify(report)}\n`, (error) => {
        process.stdout.removeListener("error", reject);
        error ? reject(error) : resolve();
      });
    });
    process.exitCode = report.exit_code;
  } catch {
    process.exitCode = 3;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
