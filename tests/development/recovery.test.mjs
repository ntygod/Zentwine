import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LocalStack, ROOT } from "../../scripts/local/environment.mjs";
import {
  execute,
  checked,
  localEnvironment,
} from "../../scripts/local/process.mjs";

test(
  "hard-killed local manager releases its kernel lock and exact session remains recoverable",
  { timeout: 120000 },
  async () => {
    const session = randomBytes(8).toString("hex");
    const stack = new LocalStack({
      directory: path.join(ROOT, ".zentwine", "sessions", session),
    });
    await stack.prepare();
    try {
      await stack.up({ offline: true });
      const moduleUrl = new URL(
        "../../scripts/local/environment.mjs",
        import.meta.url,
      ).href;
      const program = `import {withLock} from ${JSON.stringify(moduleUrl)};
      await withLock(${JSON.stringify(stack.directory)}, async()=>{
        process.stdout.write('fixture-lock-held\\n');
        process.kill(process.pid,'SIGKILL');
        await new Promise(()=>{});
      });`;
      const result = await execute(
        process.execPath,
        ["--input-type=module", "-e", program],
        {
          cwd: ROOT,
          env: localEnvironment(),
          timeoutMs: 10000,
        },
      );
      assert.equal(result.signal, "SIGKILL");
      assert.match(result.stdout, /fixture-lock-held/);
      assert.equal((await stack.status()).status, "running");
      await checked(
        process.execPath,
        ["scripts/environment.mjs", "down", "--session", session],
        {
          cwd: ROOT,
          env: localEnvironment(),
          timeoutMs: 30000,
        },
      );
      assert.equal((await stack.status()).status, "absent");
    } finally {
      await stack.down();
    }
  },
);
