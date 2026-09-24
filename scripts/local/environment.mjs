import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  assertLocalMode,
  checked,
  localEnvironment,
  LocalToolError,
} from "./process.mjs";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const COMPOSE = "infra/development/compose.yml";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const toolchain = JSON.parse(
  await fs.readFile(
    path.join(ROOT, "infra/development/toolchain.json"),
    "utf8",
  ),
);
export function parsePort(text) {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(text.trim());
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535)
    throw new LocalToolError("invalid_local_port");
  return Number(match[1]);
}
export function localDockerHost(host) {
  if (
    typeof host !== "string" ||
    !/^unix:\/\/[\/A-Za-z0-9_.-]+$/.test(host) ||
    host.includes("/../")
  )
    throw new LocalToolError("remote_docker_refused");
  return host;
}
export async function dockerTarget(source = process.env, run = checked) {
  assertLocalMode(source);
  const env = localEnvironment(source);
  let host;
  if (source.DOCKER_CONTEXT) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(source.DOCKER_CONTEXT))
      throw new LocalToolError("invalid_docker_context");
    host = JSON.parse(
      await run(
        "docker",
        [
          "context",
          "inspect",
          source.DOCKER_CONTEXT,
          "--format",
          "{{json .Endpoints.docker.Host}}",
        ],
        { env },
      ),
    );
  } else if (source.DOCKER_HOST) host = source.DOCKER_HOST;
  else
    host = JSON.parse(
      await run(
        "docker",
        ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
        { env },
      ),
    );
  host = localDockerHost(host);
  const daemon = JSON.parse(
    await run("docker", ["--host", host, "info", "--format", "{{json .ID}}"], {
      env,
    }),
  );
  if (typeof daemon !== "string" || !/^[A-Za-z0-9:_-]{6,128}$/.test(daemon))
    throw new LocalToolError("invalid_docker_daemon");
  const version = await run(
    "docker",
    ["--host", host, "compose", "version", "--short"],
    { env },
  );
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(version);
  if (!match || +match[1] < 2 || (+match[1] === 2 && +match[2] < 20))
    throw new LocalToolError("compose_version_unsupported");
  return Object.freeze({ host, daemon, compose: version });
}
async function privateDirectory(dir) {
  await fs.mkdir(dir, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new LocalToolError("unsafe_local_directory");
}
async function readPrivate(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.mode & 0o077)
      throw new LocalToolError("unsafe_local_state");
    return await handle.readFile("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new LocalToolError("unsafe_local_state");
  } finally {
    await handle?.close();
  }
}
async function writePrivate(file, value) {
  const temp = file + "." + randomBytes(6).toString("hex");
  try {
    await fs.writeFile(temp, value, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export function validateState(state, rootId) {
  if (
    !state ||
    state.schema_version !== 1 ||
    state.kind !== "disposable_local" ||
    state.root_id !== rootId ||
    !/^zt06-[a-f0-9]{12}-[a-f0-9]{16}$/.test(state.project) ||
    !/^[a-f0-9]{32}$/.test(state.owner) ||
    !/^[a-f0-9]{64}$/.test(state.compose_hash) ||
    !/^[A-Za-z0-9:_-]{6,128}$/.test(state.daemon) ||
    !["starting", "running", "cleanup_required"].includes(state.phase) ||
    (state.outcome_unknown !== undefined &&
      typeof state.outcome_unknown !== "boolean")
  )
    throw new LocalToolError("invalid_environment_state");
  localDockerHost(state.host);
  return state;
}

export async function withLock(directory, fn) {
  await privateDirectory(directory);
  const file = path.join(directory, "operation.lock");
  // Never unlink the lock inode: the kernel releases flock on exit/crash.
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const stat = await handle.stat();
  await handle.close();
  if (!stat.isFile() || stat.mode & 0o077)
    throw new LocalToolError("unsafe_environment_lock");
  const holder = spawn(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      file,
      process.execPath,
      "--input-type=module",
      "-e",
      'process.stdout.write("LOCKED\\n");process.stdin.resume();process.stdin.once("end",()=>process.exit(0));',
    ],
    {
      env: localEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    },
  );
  const exited = new Promise((resolve) => holder.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new LocalToolError("environment_lock_timeout")),
        5000,
      );
      let output = "";
      holder.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("LOCKED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.once("error", () => {
        clearTimeout(timer);
        reject(new LocalToolError("flock_unavailable"));
      });
      holder.once("exit", () => {
        clearTimeout(timer);
        reject(new LocalToolError("environment_busy"));
      });
    });
    return await fn();
  } finally {
    holder.stdin.on("error", () => {});
    holder.stdin.end();
    const timer = setTimeout(() => holder.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
}
/** Local developer convenience, not an OS sandbox or production credential vault. */
export class LocalStack {
  constructor({
    root = ROOT,
    directory = path.join(ROOT, ".zentwine", "environment"),
    source = process.env,
    run = checked,
  } = {}) {
    this.root = root;
    this.directory = directory;
    this.source = source;
    this.run = run;
  }
  async prepare() {
    assertLocalMode(this.source);
    this.root = await fs.realpath(this.root);
    this.rootId = hash(this.root).slice(0, 12);
    await privateDirectory(path.join(this.root, ".zentwine"));
    await privateDirectory(path.dirname(this.directory));
    await privateDirectory(this.directory);
    this.target = await dockerTarget(this.source, this.run);
    this.composeHash = hash(await fs.readFile(path.join(this.root, COMPOSE)));
  }
  async state() {
    const raw = await readPrivate(path.join(this.directory, "state.json"));
    if (raw === null) return null;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new LocalToolError("invalid_environment_state");
    }
    const state = validateState(value, this.rootId);
    if (state.host !== this.target.host || state.daemon !== this.target.daemon)
      throw new LocalToolError("docker_daemon_changed");
    if (state.compose_hash !== this.composeHash)
      throw new LocalToolError("compose_definition_changed");
    return state;
  }
  async save(state) {
    await writePrivate(
      path.join(this.directory, "state.json"),
      JSON.stringify(state),
    );
  }
  async password() {
    const value = await readPrivate(path.join(this.directory, "credential"));
    if (!value || !/^[a-f0-9]{48}$/.test(value))
      throw new LocalToolError("missing_local_credential");
    return value;
  }
  async docker(args, options = {}) {
    return this.run("docker", ["--host", this.target.host, ...args], {
      cwd: this.root,
      env: localEnvironment(this.source),
      ...options,
    });
  }
  async compose(state, args, options = {}) {
    return this.docker(
      [
        "compose",
        "--env-file",
        path.join(this.root, "infra/development/empty.env"),
        "--project-name",
        state.project,
        "--file",
        path.join(this.root, COMPOSE),
        ...args,
      ],
      {
        timeoutMs: 120000,
        ...options,
        env: {
          ...localEnvironment(this.source),
          ZENTWINE_LOCAL_OWNER: state.owner,
          ZENTWINE_LOCAL_PASSWORD: await this.password(),
        },
      },
    );
  }
  async resources(state) {
    const filter = "label=com.docker.compose.project=" + state.project;
    const containers = (await this.docker(["ps", "-aq", "--filter", filter]))
      .split(/\s+/)
      .filter(Boolean);
    const networks = (
      await this.docker(["network", "ls", "-q", "--filter", filter])
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const [kind, ids] of [
      ["container", containers],
      ["network", networks],
    ]) {
      for (const id of ids) {
        if (!/^[a-f0-9]{12,64}$/.test(id))
          throw new LocalToolError("invalid_resource_id");
        const labels = JSON.parse(
          await this.docker([
            kind,
            "inspect",
            id,
            "--format",
            kind === "container"
              ? "{{json .Config.Labels}}"
              : "{{json .Labels}}",
          ]),
        );
        if (
          labels?.["io.zentwine.local-owner"] !== state.owner ||
          labels?.["io.zentwine.scope"] !== "disposable-local-only"
        )
          throw new LocalToolError("resource_ownership_mismatch");
      }
    }
    return { containers, networks };
  }
  async status() {
    const state = await this.state();
    if (!state)
      return {
        status: "absent",
        scope: "disposable_local",
        live_models: "not_run",
      };
    const resources = await this.resources(state);
    if (resources.containers.length !== 1)
      return {
        status: "cleanup_required",
        project: state.project,
        outcome_unknown: Boolean(state.outcome_unknown),
        live_models: "not_run",
      };
    const runtime = JSON.parse(
      await this.docker([
        "container",
        "inspect",
        resources.containers[0],
        "--format",
        "{{json .State}}",
      ]),
    );
    const healthy =
      runtime.Running === true && runtime.Health?.Status === "healthy";
    const port = healthy
      ? parsePort(await this.compose(state, ["port", "postgres", "5432"]))
      : undefined;
    return {
      status:
        healthy && state.phase === "running" ? "running" : "cleanup_required",
      project: state.project,
      outcome_unknown: Boolean(state.outcome_unknown),
      port,
      scope: "disposable_local",
      live_models: "not_run",
    };
  }
  async up({ offline = false, signal } = {}) {
    const prior = await this.state();
    if (prior) {
      const current = await this.status();
      if (current.status !== "running")
        throw new LocalToolError("environment_needs_cleanup");
      return { ...current, reused: true };
    }
    const state = {
      schema_version: 1,
      kind: "disposable_local",
      root_id: this.rootId,
      project: `zt06-${this.rootId}-${randomBytes(8).toString("hex")}`,
      owner: randomBytes(16).toString("hex"),
      host: this.target.host,
      daemon: this.target.daemon,
      compose_hash: this.composeHash,
      phase: "starting",
      outcome_unknown: true,
    };
    await writePrivate(
      path.join(this.directory, "credential"),
      randomBytes(24).toString("hex"),
    );
    await this.save(state); // Record ownership before the first remote side effect.
    try {
      const resources = await this.resources(state);
      if (resources.containers.length || resources.networks.length)
        throw new LocalToolError("environment_name_collision");
      await this.compose(
        state,
        [
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          "60",
          "--pull",
          offline ? "never" : "missing",
        ],
        { signal },
      );
      state.outcome_unknown = false; // Compose acknowledged completion; no pending start remains.
      state.phase = "running";
      await this.save(state);
      const status = await this.status();
      if (status.status !== "running")
        throw new LocalToolError("environment_unhealthy");
      return { ...status, reused: false };
    } catch (error) {
      state.phase = "cleanup_required";
      await this.save(state);
      // Do not use the already-aborted signal for cleanup.
      try {
        await this.down();
      } catch {
        throw new LocalToolError("environment_cleanup_required");
      }
      throw error;
    }
  }
  async down({ acknowledgeUnknown = false } = {}) {
    const state = await this.state();
    if (!state) return { status: "absent" };
    const existing = await this.resources(state); // Never remove a resource that fails the ownership check.
    try {
      if (existing.containers.length || existing.networks.length)
        await this.compose(state, ["down", "--volumes", "--timeout", "10"]);
      const remaining = await this.resources(state);
      if (remaining.containers.length || remaining.networks.length)
        throw new LocalToolError("resources_remain");
    } catch {
      state.phase = "cleanup_required";
      await this.save(state);
      throw new LocalToolError("environment_cleanup_required");
    }
    if (state.outcome_unknown && !acknowledgeUnknown) {
      state.phase = "cleanup_required";
      await this.save(state);
      return {
        status: "cleanup_required",
        project: state.project,
        reason: "start_outcome_unknown",
        observed_resources_removed: true,
      };
    }
    await fs.rm(path.join(this.directory, "credential"), { force: true });
    await fs.unlink(path.join(this.directory, "state.json"));
    return { status: "removed", project: state.project };
  }
  async testEnvironment() {
    const status = await this.status();
    if (status.status !== "running")
      throw new LocalToolError("environment_not_running");
    const password = await this.password();
    const base = new URL(`postgres://127.0.0.1:${status.port}/`);
    base.username = "zt_test_admin";
    base.password = password;
    const prefix = base.href;
    return {
      ...localEnvironment(this.source),
      ZENTWINE_TEST_DATABASE_ACK: "disposable-local-only",
      ZENTWINE_TEST_DATABASE_URL: prefix + "zentwine_test_control",
      POC_DATABASE_URL: prefix + "zentwine_poc_test",
    };
  }
}
