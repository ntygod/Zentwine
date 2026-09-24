import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { ROOT, toolchain, dockerTarget } from "./local/environment.mjs";
import { execute, localEnvironment, LocalToolError } from "./local/process.mjs";
import { temporalBinary } from "./local/tooling.mjs";
export function parseDoctorArgs(args) {
  let profile = "app",
    json = false,
    seen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true;
    else if (
      args[i] === "--profile" &&
      !seen &&
      ["fresh", "app", "integration", "faults"].includes(args[i + 1])
    ) {
      profile = args[++i];
      seen = true;
    } else throw new LocalToolError("invalid_doctor_arguments");
  }
  return { profile, json };
}
export async function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
export async function diagnose(
  profile = "app",
  {
    root = ROOT,
    source = process.env,
    run = execute,
    portProbe = probePort,
    nodeVersion = process.versions.node,
    platform = process.platform,
  } = {},
) {
  const checks = [];
  const add = (name, pass, action) =>
    checks.push({
      name,
      status: pass ? "passed" : "failed",
      action: pass ? "none" : action,
    });
  const env = localEnvironment(source);
  const command = async (name, args) => {
    try {
      const result = await run(name, args, {
        cwd: root,
        env,
        timeoutMs: 15000,
        maxBytes: 65536,
      });
      return result.code === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  add(
    "supported_platform",
    platform === "linux",
    "Use the tested Linux environment; other platforms need separate verification",
  );
  add(
    "local_mode",
    !source.NODE_ENV || ["test", "development"].includes(source.NODE_ENV),
    "Unset production NODE_ENV; no service was changed",
  );
  add(
    "node",
    nodeVersion === toolchain.node,
    "Install the version in .node-version",
  );
  add(
    "pnpm",
    (await command("pnpm", ["--version"])) === toolchain.pnpm,
    "Install the packageManager version in package.json",
  );
  add("git", Boolean(await command("git", ["--version"])), "Install Git");
  const exists = async (name) =>
    Boolean(await fs.stat(path.join(root, name)).catch(() => null));
  add(
    "lockfile",
    await exists("pnpm-lock.yaml"),
    "Restore the checked-in dependency lock",
  );
  if (profile !== "fresh") {
    add(
      "workspace_dependencies",
      await exists("node_modules/typescript/package.json"),
      "Run pnpm install --frozen-lockfile",
    );
    for (const entry of [
      "services/api/dist/main.js",
      "apps/workbench/dist/index.html",
      "apps/studio/dist/index.html",
    ])
      add("build:" + entry, await exists(entry), "Run pnpm build");
    for (const port of [4100, 5173, 5174])
      add(
        "port:" + port,
        await portProbe(port),
        "Stop your running local session; doctor never kills another process",
      );
  }
  if (["integration", "faults"].includes(profile)) {
    add(
      "python_validators",
      (await command(source.QUALITY_PYTHON ?? "python3", [
        "-c",
        "import jsonschema, yaml; print('ready')",
      ])) === "ready",
      "Activate .venv-quality and install quality/requirements.txt",
    );
    add(
      "flock",
      Boolean(await command("flock", ["--version"])),
      "Install util-linux flock",
    );
    try {
      await dockerTarget(source, async (cmd, args, opts) => {
        const result = await run(cmd, args, opts);
        if (result.code !== 0) throw new LocalToolError("docker_unavailable");
        return result.stdout.trim();
      });
      add("local_docker_compose", true, "");
    } catch {
      add(
        "local_docker_compose",
        false,
        "Select a local Unix-socket Docker daemon and Compose >=2.20; remote targets are refused",
      );
    }
  }
  if (profile === "faults") {
    add(
      "spike_dependencies",
      await exists(
        "spikes/ZT01-01-durable-workflow/node_modules/@temporalio/worker/package.json",
      ),
      "Run npm ci --prefix spikes/ZT01-01-durable-workflow",
    );
    add(
      "spike_build",
      await exists("spikes/ZT01-01-durable-workflow/dist/integration.test.js"),
      "Run npm run build --prefix spikes/ZT01-01-durable-workflow",
    );
    try {
      await temporalBinary();
      add("verified_temporal_cli", true, "");
    } catch {
      add(
        "verified_temporal_cli",
        false,
        "Run pnpm tools:prepare; corrupted cached tools require explicit removal/reinstall",
      );
    }
  }
  return {
    schema_version: 1,
    profile,
    status: checks.every((c) => c.status === "passed") ? "passed" : "failed",
    checks,
    live_models: "not_run",
    production_ready: false,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const options = parseDoctorArgs(process.argv.slice(2));
    const result = await diagnose(options.profile);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const c of result.checks)
        console.log(
          `${c.status === "passed" ? "PASS" : "CHECK"} ${c.name}${c.status === "failed" ? ": " + c.action : ""}`,
        );
      console.log(
        "Read-only diagnostics. No credentials printed, tools installed or services started.",
      );
    }
    process.exitCode = result.status === "passed" ? 0 : 1;
  } catch {
    console.error(
      JSON.stringify({ status: "failed", code: "invalid_doctor_arguments" }),
    );
    process.exitCode = 1;
  }
}
