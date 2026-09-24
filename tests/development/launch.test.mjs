import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT } from "../../scripts/local/environment.mjs";
import { localEnvironment, execute } from "../../scripts/local/process.mjs";
import { probePort } from "../../scripts/doctor.mjs";

test(
  "actual dev launcher rejects production and unknown flags before creating listeners",
  { timeout: 15000 },
  async () => {
    const production = await execute(
      process.execPath,
      ["scripts/dev.mjs", "--no-build"],
      { cwd: ROOT, env: { ...localEnvironment(), NODE_ENV: "production" } },
    );
    assert.equal(production.code, 1);
    assert.match(production.stderr, /production_environment_refused/);
    const invalid = await execute(
      process.execPath,
      ["scripts/dev.mjs", "--unrecognized"],
      { cwd: ROOT, env: localEnvironment() },
    );
    assert.equal(invalid.code, 1);
  },
);
test(
  "occupied app port is not killed or reused by a new developer session",
  { timeout: 15000 },
  async (t) => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(4100, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await execute(
      process.execPath,
      ["scripts/dev.mjs", "--no-build"],
      { cwd: ROOT, env: localEnvironment() },
    );
    assert.equal(result.code, 1);
    assert.equal(server.listening, true);
  },
);
test(
  "real dev startup terminates all three services on cancellation",
  { timeout: 60000 },
  async () => {
    const controller = new AbortController();
    const run = execute(
      process.execPath,
      ["scripts/dev.mjs", "--no-build", "--preview"],
      {
        cwd: ROOT,
        env: localEnvironment(),
        signal: controller.signal,
        timeoutMs: 45000,
        graceMs: 6000,
      },
    ).catch((error) => error);
    let ready = false;
    try {
      for (let i = 0; i < 150 && !ready; i++) {
        try {
          ready = (
            await fetch("http://127.0.0.1:4100/livez", {
              signal: AbortSignal.timeout(300),
            })
          ).ok;
        } catch {
          /* Actual child service is starting. */
        }
        if (!ready) await delay(100);
      }
      assert.equal(ready, true);
    } finally {
      controller.abort();
      await run;
    }
    for (const port of [4100, 5173, 5174]) {
      let released = false;
      for (let i = 0; i < 50 && !released; i++) {
        released = await probePort(port);
        if (!released) await delay(100);
      }
      assert.equal(released, true, `owned port ${port} must be released`);
    }
  },
);
