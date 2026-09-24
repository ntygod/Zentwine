import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertLocalMode,
  localEnvironment,
  execute,
  redactOutput,
  LocalToolError,
} from "../scripts/local/process.mjs";
import {
  ROOT,
  COMPOSE,
  LocalStack,
  parsePort,
  localDockerHost,
  dockerTarget,
  validateState,
  withLock,
  toolchain,
} from "../scripts/local/environment.mjs";
import { parseEnvironmentArgs } from "../scripts/environment.mjs";
import { parseDoctorArgs, diagnose, probePort } from "../scripts/doctor.mjs";
import { parseDrillArgs } from "../scripts/drill.mjs";
import { temporalBinary } from "../scripts/local/tooling.mjs";

async function directory(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "zentwine dev fixture "),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function fakeDocker() {
  const engine = {
    active: false,
    owner: null,
    upCount: 0,
    downCount: 0,
    failUp: false,
    failDown: false,
    foreign: false,
    calls: [],
  };
  engine.run = async (command, args, options = {}) => {
    engine.calls.push({ command, args, options });
    if (args.includes("context"))
      return JSON.stringify("unix:///var/run/docker.sock");
    if (args.includes("info")) return JSON.stringify("fixture-daemon-123456");
    if (args.includes("version")) return "2.39.4";
    if (args.includes("compose")) {
      if (args.includes("up")) {
        engine.upCount++;
        engine.owner = options.env.ZENTWINE_LOCAL_OWNER;
        engine.active = true;
        if (engine.failUp) throw new LocalToolError("command_failed");
        return "";
      }
      if (args.includes("down")) {
        engine.downCount++;
        if (engine.failDown) throw new LocalToolError("command_failed");
        engine.active = false;
        return "";
      }
      if (args.includes("port")) return "127.0.0.1:55321";
    }
    if (args.includes("ps")) return engine.active ? "a".repeat(64) : "";
    if (args.includes("ls")) return engine.active ? "b".repeat(64) : "";
    if (args.includes("inspect")) {
      if (args.at(-1) === "{{json .State}}")
        return JSON.stringify({ Running: true, Health: { Status: "healthy" } });
      return JSON.stringify({
        "io.zentwine.local-owner": engine.foreign
          ? "another-owner"
          : engine.owner,
        "io.zentwine.scope": "disposable-local-only",
      });
    }
    throw new Error("Unexpected fake Docker command");
  };
  return engine;
}
async function stackFixture(t) {
  const root = await directory(t);
  await fs.mkdir(path.join(root, "infra/development"), { recursive: true });
  await fs.copyFile(path.join(ROOT, COMPOSE), path.join(root, COMPOSE));
  const engine = fakeDocker();
  const stack = new LocalStack({
    root,
    directory: path.join(root, ".zentwine", "environment"),
    source: { PATH: process.env.PATH, HOME: process.env.HOME },
    run: engine.run,
  });
  await stack.prepare();
  return { root, engine, stack };
}

test("local command environment omits provider keys, production DB, injection and Compose overrides", () => {
  const env = localEnvironment({
    PATH: "/bin",
    HOME: "/home/example",
    OPENAI_API_KEY: "never-forward",
    ANTHROPIC_API_KEY: "never-forward",
    DATABASE_URL: "never-forward",
    NODE_OPTIONS: "--import=untrusted",
    COMPOSE_FILE: "elsewhere",
    DOCKER_HOST: "tcp://remote",
    QUALITY_BASE_REF: "a".repeat(40),
  });
  assert.deepEqual(
    Object.keys(env).sort(),
    ["NODE_ENV", "TZ", "LANG", "PATH", "HOME", "QUALITY_BASE_REF"].sort(),
  );
  assert.equal(env.NODE_ENV, "test");
});
test("production modes and unsupported operating systems are refused before a subprocess", () => {
  for (const mode of ["production", "staging", "PRODUCTION"])
    assert.throws(
      () => assertLocalMode({ NODE_ENV: mode }, "linux"),
      /production_environment_refused/,
    );
  assert.throws(() => assertLocalMode({}, "win32"), /unsupported_platform/);
  assert.doesNotThrow(() => assertLocalMode({ NODE_ENV: "test" }, "linux"));
});
test("Docker targets only accept explicit local Unix sockets", () => {
  for (const host of [
    "tcp://127.0.0.1:2375",
    "ssh://server",
    "unix:///tmp/../remote.sock",
    "unix:///tmp/a;rm",
    null,
  ])
    assert.throws(() => localDockerHost(host), /remote_docker_refused/);
  assert.equal(
    localDockerHost("unix:///run/user/1000/docker.sock"),
    "unix:///run/user/1000/docker.sock",
  );
});
test("remote Docker environment is rejected before daemon access", async () => {
  let calls = 0;
  await assert.rejects(
    dockerTarget({ DOCKER_HOST: "ssh://server" }, async () => {
      calls++;
    }),
    /remote_docker_refused/,
  );
  assert.equal(calls, 0);
});
test("Docker context takes precedence and is resolved before pinning the local daemon", async () => {
  const engine = fakeDocker();
  const result = await dockerTarget(
    { DOCKER_CONTEXT: "local", DOCKER_HOST: "ssh://ignored" },
    engine.run,
  );
  assert.equal(result.host, "unix:///var/run/docker.sock");
  assert.ok(engine.calls[0].args.includes("local"));
  for (const call of engine.calls)
    assert.equal(call.options.env.DOCKER_HOST, undefined);
});
test("Compose versions without wait support are refused", async () => {
  const engine = fakeDocker(),
    run = engine.run;
  engine.run = (cmd, args, opts) =>
    args.includes("version") ? Promise.resolve("2.19.9") : run(cmd, args, opts);
  await assert.rejects(
    dockerTarget({}, engine.run),
    /compose_version_unsupported/,
  );
});
test("port parser refuses public, multiline, unsafe and invalid bindings", () => {
  assert.equal(parsePort("127.0.0.1:55432\n"), 55432);
  for (const value of [
    "0.0.0.0:5432",
    "[::]:5432",
    "127.0.0.1:80",
    "127.0.0.1:65536",
    "127.0.0.1:4000\n127.0.0.1:4001",
  ])
    assert.throws(() => parsePort(value), /invalid_local_port/);
});
test("environment arguments accept only fixed actions, offline up and owned session identifiers", () => {
  assert.deepEqual(parseEnvironmentArgs(["up", "--offline"]), {
    action: "up",
    offline: true,
    session: undefined,
  });
  assert.equal(
    parseEnvironmentArgs(["down", "--session", "a".repeat(16)]).session,
    "a".repeat(16),
  );
  for (const args of [
    ["rm"],
    ["down", "--offline"],
    ["up", "--session", "a".repeat(16)],
    ["down", "--session", "../other"],
    ["up", "--offline", "--offline"],
  ])
    assert.throws(
      () => parseEnvironmentArgs(args),
      /invalid_environment_command/,
    );
});
test("doctor and drill reject misspelled or duplicate arguments", () => {
  assert.deepEqual(parseDoctorArgs(["--json", "--profile", "fresh"]), {
    profile: "fresh",
    json: true,
  });
  assert.deepEqual(parseDrillArgs(["--suite", "database", "--offline"]), {
    suite: "database",
    offline: true,
  });
  for (const args of [
    ["--json", "--json"],
    ["--profile", "prod"],
    ["--whatever"],
  ])
    assert.throws(() => parseDoctorArgs(args));
  for (const args of [
    ["--suite", "prod"],
    ["--suite", "all", "--suite", "database"],
    ["--offline", "--offline"],
  ])
    assert.throws(() => parseDrillArgs(args));
});
test("subprocess failures and secret-bearing command output are not exposed in exceptions", async () => {
  await assert.rejects(
    execute("/missing/zentwine-tool", []),
    /command_unavailable/,
  );
  const result = await execute(process.execPath, ["-e", "process.exitCode=7"]);
  assert.equal(result.code, 7);
  const secret = "synthetic-" + "value-".repeat(4);
  assert.ok(
    !redactOutput(secret + " postgres" + "://u:x@127.0.0.1/db", [
      secret,
    ]).includes(secret),
  );
});
test("subprocess timeout is bounded and parent cancellation is explicit", async () => {
  await assert.rejects(
    execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 100,
      graceMs: 20,
    }),
    /command_timeout/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    execute(process.execPath, ["-e", "throw new Error('must not run')"], {
      signal: controller.signal,
    }),
    /operation_cancelled/,
  );
});
test("subprocess output size guard rejects rather than silently truncating success", async () => {
  await assert.rejects(
    execute(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000))"],
      { maxBytes: 1024 },
    ),
    /command_output_limit/,
  );
});
test("process-group timeout removes a spawned descendant and releases its bound port", async (t) => {
  const root = await directory(t),
    marker = path.join(root, "port");
  const descendant = `const net=require('node:net');const fs=require('node:fs');const s=net.createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(marker)},String(s.address().port)));`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  await assert.rejects(
    execute(process.execPath, ["-e", parent], { timeoutMs: 1000, graceMs: 50 }),
    /command_timeout/,
  );
  const port = Number(await fs.readFile(marker, "utf8"));
  assert.ok(port > 0);
  let released = false;
  for (let i = 0; i < 20 && !released; i++) {
    released = await probePort(port);
    if (!released) await delay(50);
  }
  assert.equal(released, true);
});
test("kernel lock prevents concurrent environment mutation and releases after a failure", async (t) => {
  const root = await directory(t),
    dir = path.join(root, "private");
  await withLock(dir, async () => {
    await assert.rejects(
      withLock(dir, async () => {}),
      /environment_busy/,
    );
  });
  await assert.rejects(
    withLock(dir, async () => {
      throw new Error("synthetic");
    }),
    /synthetic/,
  );
  assert.equal(await withLock(dir, async () => 42), 42);
});
test("lock helper refuses symlink lock files", async (t) => {
  const root = await directory(t),
    dir = path.join(root, "private");
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(root, "other"), "untouched");
  await fs.symlink(path.join(root, "other"), path.join(dir, "operation.lock"));
  await assert.rejects(withLock(dir, async () => {}));
  assert.equal(
    await fs.readFile(path.join(root, "other"), "utf8"),
    "untouched",
  );
});
test("read-only environment status does not create a container or credentials", async (t) => {
  const { engine, stack } = await stackFixture(t);
  assert.equal((await stack.status()).status, "absent");
  assert.equal(engine.upCount, 0);
  await assert.rejects(fs.access(path.join(stack.directory, "credential")));
});
test("environment repeated up is idempotent and status never starts a second environment", async (t) => {
  const { engine, stack } = await stackFixture(t);
  const first = await stack.up(),
    again = await stack.up();
  assert.equal(first.project, again.project);
  assert.equal(again.reused, true);
  assert.equal(engine.upCount, 1);
  assert.equal((await stack.status()).port, 55321);
  assert.equal((await stack.down()).status, "removed");
  assert.equal((await stack.down()).status, "absent");
  assert.equal(engine.downCount, 1);
});
test("environment state excludes credential and uses explicit Compose file and empty dotenv", async (t) => {
  const { engine, stack } = await stackFixture(t);
  await stack.up({ offline: true });
  const credential = await stack.password(),
    state = await fs.readFile(path.join(stack.directory, "state.json"), "utf8");
  assert.ok(!state.includes(credential));
  assert.equal(
    (await fs.stat(path.join(stack.directory, "credential"))).mode & 0o777,
    0o600,
  );
  const call = engine.calls.find((c) => c.args.includes("up"));
  assert.ok(call.args.includes("--env-file"));
  assert.ok(call.args.includes("never"));
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
  await stack.down();
});
test("partial Compose startup failure is cleaned without reporting ready", async (t) => {
  const { engine, stack } = await stackFixture(t);
  engine.failUp = true;
  await assert.rejects(stack.up(), /command_failed/);
  assert.equal(engine.active, false);
  assert.equal((await stack.status()).status, "absent");
});
test("cleanup failure retains exact ownership state for a later retry", async (t) => {
  const { engine, stack } = await stackFixture(t);
  await stack.up();
  engine.failDown = true;
  await assert.rejects(stack.down(), /environment_cleanup_required/);
  assert.equal((await stack.state()).phase, "cleanup_required");
  engine.failDown = false;
  await stack.down();
  assert.equal((await stack.status()).status, "absent");
});
test("foreign resource labels block deletion and preserve the resource", async (t) => {
  const { engine, stack } = await stackFixture(t);
  await stack.up();
  engine.foreign = true;
  await assert.rejects(stack.down(), /resource_ownership_mismatch/);
  assert.equal(engine.downCount, 0);
  assert.equal(engine.active, true);
});
test("changed Compose definitions and different daemon IDs are not used to clean old state", async (t) => {
  const { root, stack } = await stackFixture(t);
  await stack.up();
  stack.target = { ...stack.target, daemon: "changed-daemon-123" };
  await assert.rejects(stack.state(), /docker_daemon_changed/);
  stack.target = { ...stack.target, daemon: "fixture-daemon-123456" };
  await fs.appendFile(path.join(root, COMPOSE), "\n# changed");
  await stack.prepare();
  await assert.rejects(stack.state(), /compose_definition_changed/);
});
test("copied or malformed state cannot address another checkout's resources", () => {
  assert.throws(
    () => validateState({ schema_version: 1, kind: "production" }, "a"),
    /invalid_environment_state/,
  );
  assert.throws(() => validateState(null, "a"), /invalid_environment_state/);
});
test("symlinked environment state is refused without reading its contents", async (t) => {
  const { stack, root } = await stackFixture(t);
  await fs.writeFile(path.join(root, "other"), "outside", { mode: 0o600 });
  await fs.symlink(
    path.join(root, "other"),
    path.join(stack.directory, "state.json"),
  );
  await assert.rejects(stack.state(), /unsafe_local_state/);
});
test("generated test environment replaces caller database and provider settings", async (t) => {
  const { stack } = await stackFixture(t);
  await stack.up();
  stack.source = {
    ...stack.source,
    DATABASE_URL: "production",
    POC_DATABASE_URL: "remote",
    OPENAI_API_KEY: "do-not-forward",
  };
  const env = await stack.testEnvironment();
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.ok(env.POC_DATABASE_URL.endsWith("/zentwine_poc_test"));
  assert.equal(env.ZENTWINE_TEST_DATABASE_ACK, "disposable-local-only");
  await stack.down();
});
test("fresh doctor does not require builds, Docker or model credentials and prints only diagnostics", async (t) => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lock");
  const calls = [];
  const result = await diagnose("fresh", {
    root,
    nodeVersion: toolchain.node,
    platform: "linux",
    source: { OPENAI_API_KEY: "never-print" },
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return {
        code: 0,
        stdout: cmd === "pnpm" ? toolchain.pnpm : "git version 2.0",
      };
    },
  });
  assert.equal(result.status, "passed");
  assert.ok(calls.every((c) => c.cmd !== "docker"));
  assert.ok(!JSON.stringify(result).includes("never-print"));
  assert.ok(calls.every((c) => !c.opts.env.OPENAI_API_KEY));
});
test("doctor app profile reports busy ports without killing or reusing them", async (t) => {
  const root = await directory(t);
  const result = await diagnose("app", {
    root,
    nodeVersion: toolchain.node,
    platform: "linux",
    source: {},
    run: async () => ({ code: 1, stdout: "untrusted secret content" }),
    portProbe: async () => false,
  });
  assert.equal(result.status, "failed");
  assert.equal(
    result.checks.filter(
      (c) => c.name.startsWith("port:") && c.status === "failed",
    ).length,
    3,
  );
  assert.ok(!JSON.stringify(result).includes("untrusted secret content"));
});
test("missing or corrupted Temporal caches are rejected before execution", async (t) => {
  const root = await directory(t);
  await assert.rejects(temporalBinary(root), /temporal_tool_missing/);
  await fs.writeFile(path.join(root, "temporal"), "not an executable");
  await fs.writeFile(path.join(root, "temporal.tar.gz"), "corrupt");
  await assert.rejects(temporalBinary(root), /temporal_archive_mismatch/);
});
test("local Compose and toolchain pin the same immutable PostgreSQL image", async () => {
  const source = await fs.readFile(path.join(ROOT, COMPOSE), "utf8");
  assert.ok(source.includes(toolchain.postgres_image));
  assert.ok(source.includes("host_ip: 127.0.0.1"));
  assert.ok(!source.includes("privileged:"));
  assert.ok(!source.includes("docker.sock"));
});
