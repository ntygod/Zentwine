import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { interceptBeforeExec } from "./fixtures/gated-spawn.mjs";

const options = {
  shell: false,
  detached: true,
  env: { PATH: "/usr/bin:/bin" },
  stdio: ["ignore", "pipe", "pipe"],
};
function output(child) {
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}
function marker(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zt-gated-spawn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "marker");
}
const writeMarker = (p) => [
  "-e",
  "require('node:fs').writeFileSync(process.argv[1], 'executed')",
  p,
];

test("gated fixture: command cannot finish during synchronous signal injection", async (t) => {
  const p = marker(t);
  const child = interceptBeforeExec(
    spawn,
    (launch, command, args, opts) => {
      const child = launch(command, args, opts);
      // Explicitly model parent descheduling; payload must still be behind the gate.
      const until = performance.now() + 30;
      while (performance.now() < until) {}
      assert.equal(fs.existsSync(p), false);
      const state = fs
        .readFileSync(`/proc/${child.pid}/stat`, "utf8")
        .split(") ")[1]
        .split(" ")[0];
      assert.notEqual(state, "Z");
      process.kill(-child.pid, "SIGSTOP");
      return child;
    },
    process.execPath,
    writeMarker(p),
    options,
  );
  const pending = output(child);
  assert.equal(fs.existsSync(p), false);
  process.kill(-child.pid, "SIGKILL");
  const result = await pending;
  assert.equal(result.signal, "SIGKILL");
  assert.equal(fs.existsSync(p), false);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});
test("gated fixture: release preserves exact argv without evaluating shell text", async () => {
  const args = ["$(touch /should-not-run)", "a;b", "a\nb", "'\"", "中文", ""];
  const child = interceptBeforeExec(
    spawn,
    (launch, ...input) => launch(...input),
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...args,
    ],
    options,
  );
  const result = await output(child);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), args);
});
test("gated fixture: exec keeps PID and forwards the original environment", async () => {
  const child = interceptBeforeExec(
    spawn,
    (launch, ...input) => launch(...input),
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({pid:process.pid,value:process.env.ZT_SYNTHETIC}))",
    ],
    { ...options, env: { PATH: "/usr/bin:/bin", ZT_SYNTHETIC: "fixture" } },
  );
  const result = await output(child);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    pid: child.pid,
    value: "fixture",
  });
});
test("gated fixture: nonzero command exit and stderr are not converted to success", async () => {
  const child = interceptBeforeExec(
    spawn,
    (launch, ...input) => launch(...input),
    process.execPath,
    ["-e", "process.stderr.write('synthetic failure');process.exitCode=7"],
    options,
  );
  assert.deepEqual(await output(child), {
    code: 7,
    signal: null,
    stdout: "",
    stderr: "synthetic failure",
  });
});
test("gated fixture: throwing interceptor kills owned child before payload execution", async (t) => {
  const p = marker(t);
  let pending, child;
  assert.throws(
    () =>
      interceptBeforeExec(
        spawn,
        (launch, ...input) => {
          child = launch(...input);
          pending = output(child);
          throw new Error("synthetic setup failure");
        },
        process.execPath,
        writeMarker(p),
        options,
      ),
    /synthetic setup failure/,
  );
  const result = await pending;
  assert.equal(result.signal, "SIGKILL");
  assert.equal(fs.existsSync(p), false);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});
test("gated fixture: unsupported stdio or shell options reject before any spawn", () => {
  let calls = 0;
  const launch = () => {
    calls++;
    throw new Error("must not spawn");
  };
  for (const change of [
    { shell: true },
    { detached: false },
    { stdio: "pipe" },
    { stdio: ["pipe", "pipe", "pipe"] },
  ])
    assert.throws(
      () =>
        interceptBeforeExec(
          launch,
          (fn, ...input) => fn(...input),
          process.execPath,
          [],
          { ...options, ...change },
        ),
      /Unsupported gated test spawn/,
    );
  assert.equal(calls, 0);
});
