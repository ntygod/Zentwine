import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  LocalStack,
  ROOT,
  withLock,
} from "../../scripts/local/environment.mjs";
import {
  execute,
  checked,
  localEnvironment,
} from "../../scripts/local/process.mjs";

function stack() {
  return new LocalStack({
    directory: path.join(
      ROOT,
      ".zentwine",
      "sessions",
      randomBytes(8).toString("hex"),
    ),
  });
}
// Every case talks to a real local Docker daemon and a pinned disposable PostgreSQL image.
test(
  "real local environment starts once, has two fixture databases and cleans exact resources",
  { timeout: 120000 },
  async () => {
    const env = stack();
    await env.prepare();
    await withLock(env.directory, async () => {
      try {
        const first = await env.up();
        const again = await env.up({ offline: true });
        assert.equal(first.project, again.project);
        assert.equal(again.reused, true);
        const state = await env.state();
        const resources = await env.resources(state);
        assert.equal(resources.containers.length, 1);
        const names = await env.compose(state, [
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "zt_test_admin",
          "-d",
          "postgres",
          "-Atc",
          "SELECT datname FROM pg_database WHERE datname IN ('zentwine_test_control','zentwine_poc_test') ORDER BY datname",
        ]);
        assert.deepEqual(names.split("\n"), [
          "zentwine_poc_test",
          "zentwine_test_control",
        ]);
        const vars = await env.testEnvironment();
        assert.ok(vars.ZENTWINE_TEST_DATABASE_URL.includes("127.0.0.1:"));
        assert.ok(
          !(
            await fs.readFile(path.join(env.directory, "state.json"), "utf8")
          ).includes(await env.password()),
        );
      } finally {
        await env.down();
      }
      assert.equal((await env.status()).status, "absent");
      assert.equal((await env.down()).status, "absent");
    });
  },
);
test(
  "two local development environments run concurrently without sharing ports or cleanup",
  { timeout: 120000 },
  async () => {
    const left = stack(),
      right = stack();
    await Promise.all([left.prepare(), right.prepare()]);
    try {
      const [a, b] = await Promise.all([
        left.up({ offline: true }),
        right.up({ offline: true }),
      ]);
      assert.notEqual(a.project, b.project);
      assert.notEqual(a.port, b.port);
      await left.down();
      assert.equal((await right.status()).status, "running");
    } finally {
      await Promise.all([left.down(), right.down()]);
    }
  },
);
test(
  "exception after real startup still removes owned containers and network",
  { timeout: 120000 },
  async () => {
    const env = stack();
    await env.prepare();
    let state;
    await assert.rejects(
      withLock(env.directory, async () => {
        try {
          await env.up({ offline: true });
          state = await env.state();
          throw new Error("synthetic_callback_failure");
        } finally {
          await env.down();
        }
      }),
      /synthetic_callback_failure/,
    );
    assert.deepEqual(await env.resources(state), {
      containers: [],
      networks: [],
    });
  },
);
test(
  "unknown Studio workspaces remain denied after development database becomes available",
  { timeout: 120000 },
  async () => {
    const env = stack();
    await env.prepare();
    try {
      await env.up({ offline: true });
      // Infrastructure being available must not enable unfinished production features.
      const result = await execute(
        process.execPath,
        ["--test", "tests/api.test.mjs"],
        { cwd: ROOT, env: localEnvironment(), timeoutMs: 30000 },
      );
      assert.equal(result.code, 0);
    } finally {
      await env.down();
    }
  },
);
test(
  "temporary database state never points outside the acknowledged local Docker target",
  { timeout: 120000 },
  async () => {
    const env = stack();
    await env.prepare();
    try {
      await env.up({ offline: true });
      const state = await env.state();
      env.target = { ...env.target, daemon: "another-daemon-identifier" };
      await assert.rejects(env.down(), /docker_daemon_changed/);
      env.target = { ...env.target, daemon: state.daemon };
      assert.equal((await env.status()).status, "running");
    } finally {
      await env.down();
    }
  },
);
test("CLI rejects invalid sessions and production mode without contacting a daemon", async () => {
  const bad = await execute(
    process.execPath,
    ["scripts/environment.mjs", "down", "--session", "../foreign"],
    { cwd: ROOT, env: localEnvironment() },
  );
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /invalid_environment_command/);
  const prod = await execute(
    process.execPath,
    ["scripts/environment.mjs", "up"],
    { cwd: ROOT, env: { ...localEnvironment(), NODE_ENV: "production" } },
  );
  assert.equal(prod.code, 1);
  assert.match(prod.stderr, /production_environment_refused/);
});
test(
  "CLI up and down use the same persisted environment in separate processes",
  { timeout: 120000 },
  async () => {
    // Default scope is reserved only for this CI job; all other tests use independent sessions.
    await checked(
      process.execPath,
      ["scripts/environment.mjs", "up", "--offline"],
      { cwd: ROOT, env: localEnvironment(), timeoutMs: 90000 },
    );
    try {
      const result = JSON.parse(
        await checked(process.execPath, ["scripts/environment.mjs", "status"], {
          cwd: ROOT,
          env: localEnvironment(),
        }),
      );
      assert.equal(result.status, "running");
    } finally {
      await checked(process.execPath, ["scripts/environment.mjs", "down"], {
        cwd: ROOT,
        env: localEnvironment(),
        timeoutMs: 30000,
      });
    }
    const result = JSON.parse(
      await checked(process.execPath, ["scripts/environment.mjs", "status"], {
        cwd: ROOT,
        env: localEnvironment(),
      }),
    );
    assert.equal(result.status, "absent");
  },
);
