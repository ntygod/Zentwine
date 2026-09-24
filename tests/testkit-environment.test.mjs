import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseTestDatabaseEnvironment,
  createTestDatabase,
} from "../packages/testkit/dist/postgres.js";
import { createTenantFixtures } from "../packages/testkit/dist/index.js";
import { withTemporaryDirectory } from "../packages/testkit/dist/temporary-directory.js";
import { inspectSource } from "../scripts/check-boundaries.mjs";
const base = {
  NODE_ENV: "test",
  ZENTWINE_TEST_DATABASE_ACK: "disposable-local-only",
  ZENTWINE_TEST_DATABASE_URL:
    "postgres://zt_test_admin:synthetic-password@127.0.0.1:55432/zentwine_test_control",
};
test("test database requires explicit opt-in and never falls back to DATABASE_URL", () => {
  for (const env of [
    {},
    { ...base, NODE_ENV: "production" },
    { ...base, ZENTWINE_TEST_DATABASE_ACK: "" },
    { NODE_ENV: "test", DATABASE_URL: base.ZENTWINE_TEST_DATABASE_URL },
  ])
    assert.throws(() => parseTestDatabaseEnvironment(env));
});
test("test database rejects remote, alternate, encoded and parameter-overridden targets without exposing secrets", () => {
  for (const target of [
    "postgres://zt_test_admin:secret@production.example:55432/zentwine_test_control",
    "postgres://zt_test_admin:secret@127.0.0.1:55432/production",
    "postgres://postgres:secret@127.0.0.1:55432/zentwine_test_control",
    base.ZENTWINE_TEST_DATABASE_URL + "?host=production.example",
    base.ZENTWINE_TEST_DATABASE_URL + "#secret",
    "http://zt_test_admin:secret@127.0.0.1:55432/zentwine_test_control",
    "secret",
    "postgres://zt_test_admin:secret@127.0.0.1/zentwine_test_control",
    "postgres://zt_test_admin:secret@localhost:55432/zentwine_test_control",
    "postgres://zt_test_admin:secret@127.0.0.1:80/zentwine_test_control",
  ]) {
    assert.throws(
      () =>
        parseTestDatabaseEnvironment({
          ...base,
          ZENTWINE_TEST_DATABASE_URL: target,
        }),
      (error) => !error.message.includes("secret"),
    );
  }
});
test("valid explicit loopback configuration is immutable", () => {
  const c = parseTestDatabaseEnvironment(base);
  assert.equal(c.database, "zentwine_test_control");
  assert.throws(() => {
    c.database = "other";
  }, TypeError);
});
test("unsafe database config fails before any connection attempt", async () => {
  let connected = 0;
  await assert.rejects(
    createTestDatabase(
      { ...base, NODE_ENV: "production" },
      async () => {
        connected++;
        throw new Error("must not call");
      },
      createTenantFixtures("safe"),
    ),
  );
  assert.equal(connected, 0);
});
test("missing disposable-server marker closes connection and refuses DDL", async () => {
  const queries = [];
  let closed = 0;
  await assert.rejects(
    createTestDatabase(
      base,
      async () => ({
        query: async (sql) => {
          queries.push(sql);
          return { rows: [] };
        },
        close: async () => {
          closed++;
        },
      }),
      createTenantFixtures("guard"),
    ),
    { code: "test_server_guard_missing" },
  );
  assert.equal(closed, 1);
  assert.ok(queries.every((sql) => sql.startsWith("SELECT")));
});
test("temporary directories isolate concurrent tests and clean on success", async () => {
  const directories = [];
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withTemporaryDirectory(async (dir) => {
        directories.push(dir);
        await fs.writeFile(path.join(dir, "fixture.txt"), dir);
        assert.equal(
          await fs.readFile(path.join(dir, "fixture.txt"), "utf8"),
          dir,
        );
      }),
    ),
  );
  assert.equal(new Set(directories).size, 8);
  for (const dir of directories)
    await assert.rejects(fs.stat(dir), { code: "ENOENT" });
});
test("temporary directory cleans after assertion failure and preserves original error", async () => {
  let directory;
  const sentinel = new Error("synthetic test body failure");
  await assert.rejects(
    withTemporaryDirectory(async (dir) => {
      directory = dir;
      throw sentinel;
    }),
    (error) => error === sentinel,
  );
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
test("directory ownership substitution is refused rather than deleting a replacement", async () => {
  let original;
  let moved;
  try {
    await assert.rejects(
      withTemporaryDirectory(async (dir) => {
        original = dir;
        moved = `${dir}-moved`;
        await fs.rename(dir, moved);
        await fs.mkdir(dir);
      }),
      /ownership changed/,
    );
    assert.ok((await fs.stat(original)).isDirectory());
  } finally {
    if (original) await fs.rm(original, { recursive: true, force: true });
    if (moved) await fs.rm(moved, { recursive: true, force: true });
  }
});
test("production packages cannot import fixtures; fake runtime cannot import network or provider SDKs", () => {
  for (const owner of [
    "@zentwine/api",
    "@zentwine/domain",
    "@zentwine/workbench",
    "@zentwine/studio",
  ]) {
    const root = path.resolve("/tmp", owner.replace("/", "_"));
    assert.ok(
      inspectSource(
        owner,
        path.join(root, "src/x.ts"),
        "import { FakeRuntime } from '@zentwine/testkit';",
        root,
      ).length,
    );
  }
  const root = path.resolve("/tmp/testkit");
  for (const specifier of [
    "node:net",
    "node:http",
    "node:child_process",
    "@openai/codex-sdk",
    "@anthropic-ai/claude-agent-sdk",
    "pg",
  ])
    assert.ok(
      inspectSource(
        "@zentwine/testkit",
        path.join(root, "src/x.ts"),
        `import '${specifier}';`,
        root,
      ).length,
    );
});

test("integration launcher strips provider credentials and ambient connection options", async () => {
  const { isolatedTestEnvironment } = await import(
    "../scripts/test-environment.mjs"
  );
  const safe = isolatedTestEnvironment({
    ...base,
    PATH: "/bin",
    OPENAI_API_KEY: "synthetic",
    ANTHROPIC_API_KEY: "synthetic",
    NODE_OPTIONS: "--import unsafe",
    PGHOST: "elsewhere",
    DATABASE_URL: "secret",
    HTTPS_PROXY: "secret",
  });
  assert.deepEqual(
    Object.keys(safe).sort(),
    [
      "NODE_ENV",
      "PATH",
      "TZ",
      "ZENTWINE_TEST_DATABASE_ACK",
      "ZENTWINE_TEST_DATABASE_URL",
    ].sort(),
  );
  assert.throws(() => isolatedTestEnvironment({ NODE_ENV: "production" }));
});
