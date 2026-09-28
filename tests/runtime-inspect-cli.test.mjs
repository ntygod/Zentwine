import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  inspectRuntimeDirectory,
  runRuntimeInspectionCli,
} from "../scripts/runtime-inspect.mjs";
import { inspectionFixture } from "./fixtures/runtime-inspection-data.mjs";

const script = fileURLToPath(
  new URL("../scripts/runtime-inspect.mjs", import.meta.url),
);
const fixture = fileURLToPath(
  new URL("./fixtures/runtime-inspect-faults.mjs", import.meta.url),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zt-inspect-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = inspectionFixture();
  await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify(f.plan));
  for (const [i, text] of f.events.entries())
    await fs.writeFile(path.join(dir, `producer-${i + 1}.ndjson`), text);
  for (const [i, bytes] of f.bytes.entries())
    await fs.writeFile(path.join(dir, `input-${i + 1}.bin`), bytes);
  return { dir, f, file: (name) => path.join(dir, name) };
}
function cli(dir, args = [], options = {}) {
  const child = spawnSync(process.execPath, [script, dir, ...args], {
    encoding: "utf8",
    timeout: 10000,
    ...options,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const value = JSON.parse(lines[0]);
  assert.equal(value.exit_code, child.status);
  assert.equal(value.authorization, false);
  assert.equal(value.verification, "unverified");
  assert.equal(value.cleanup, "complete");
  return value;
}
async function opened(t, onRead = async () => {}) {
  const native = fs.open;
  const handles = [];
  const reads = [];
  t.mock.method(fs, "open", async (...args) => {
    const handle = await native(...args);
    const name = path.basename(args[0]);
    handles.push(handle);
    const read = handle.read.bind(handle);
    handle.read = async (...input) => {
      reads.push(name);
      await onRead(name, input);
      return read(...input);
    };
    return handle;
  });
  return { handles, reads };
}
function noLeak(result, dir) {
  const text = JSON.stringify(result);
  assert.equal(text.includes(dir), false);
  assert.equal(text.includes("not-for-output"), false);
  assert.equal(text.includes("\u001b"), false);
}

test("inspection CLI: real command verifies the Studio sample without changing file contents", async (t) => {
  const { dir, file, f } = await directory(t);
  const before = await Promise.all(
    (await fs.readdir(dir)).map(async (name) => [
      name,
      sha(await fs.readFile(file(name))),
    ]),
  );
  const result = cli(dir);
  assert.equal(result.status, "passed");
  assert.equal(result.executed, true);
  assert.equal(result.stage, "complete");
  assert.deepEqual(result.checked, {
    producers: 2,
    artifacts: 2,
    bytes: f.bytes.reduce((n, b) => n + b.length, 0),
  });
  assert.equal(result.plan_sha256, sha(await fs.readFile(file("plan.json"))));
  assert.equal(result.producer_trust, "reported_not_authenticated");
  assert.deepEqual(
    await fs.readdir(dir),
    before.map(([name]) => name),
  );
  for (const [name, hash] of before)
    assert.equal(sha(await fs.readFile(file(name))), hash);
  noLeak(result, dir);
});
test("inspection CLI: documented example generator and command work from another cwd", async (t) => {
  const { dir } = await directory(t);
  const example = path.join(dir, "example");
  const generator = fileURLToPath(
    new URL("../scripts/runtime-inspection-example.mjs", import.meta.url),
  );
  assert.equal(spawnSync(process.execPath, [generator, example]).status, 0);
  assert.equal(cli(example, [], { cwd: os.tmpdir() }).status, "passed");
});
test("inspection CLI: import alone does not inspect or print a report", () => {
  const code = `await import(${JSON.stringify(new URL("../scripts/runtime-inspect.mjs", import.meta.url).href)});`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});
for (const args of [
  [],
  ["--unknown"],
  ["dir", "extra"],
  ["dir", "--timeout-ms", "0"],
  ["dir", "--timeout-ms", "300001"],
  ["dir", "--timeout-ms", "1e3"],
  ["dir", "--timeout-ms", "-2"],
  ["dir", "--timeout-ms", "1.5"],
  ["dir", "--timeout-ms", "10", "extra"],
]) {
  test(`inspection CLI: rejects argument form ${JSON.stringify(args)}`, async () => {
    const result = await runRuntimeInspectionCli(args);
    assert.equal(result.exit_code, 64);
    assert.equal(result.executed, false);
    assert.equal(result.fault.code, "invalid_arguments");
  });
}
test("inspection CLI: help is explicit and never reports a passed inspection", async () => {
  const result = await runRuntimeInspectionCli(["--help"]);
  assert.equal(result.exit_code, 0);
  assert.equal(result.status, "help");
  assert.equal(result.executed, false);
});
for (const name of ["plan.json", "producer-1.ndjson", "input-2.bin"]) {
  test(`inspection CLI: missing ${name} fails before execution`, async (t) => {
    const { dir, file } = await directory(t);
    await fs.unlink(file(name));
    const result = cli(dir);
    assert.equal(result.exit_code, 64);
    assert.equal(result.executed, false);
    noLeak(result, dir);
  });
}
for (const [label, content] of [
  [
    "duplicate key",
    '{"inspection_version":"1.0.0","inspection_version":"1.0.0"}',
  ],
  ["invalid UTF8", Buffer.from([0xff, 0xfe])],
  ["BOM", "\ufeff{}"],
  [
    "path injection",
    '{"inspection_version":"1.0.0","path":"../../not-for-output"}',
  ],
  ["malicious text", '{"secret":"not-for-output\\u001b[2J"}'],
  ["oversized plan", " ".repeat(262145)],
]) {
  test(`inspection CLI: rejects ${label} plan without disclosure`, async (t) => {
    const { dir, file } = await directory(t);
    await fs.writeFile(file("plan.json"), content);
    const result = cli(dir);
    assert.equal(result.exit_code, 64);
    assert.equal(result.plan_sha256, null);
    noLeak(result, dir);
  });
}
for (const [label, modify] of [
  [
    "same-length corruption",
    async (file) => {
      const bytes = await fs.readFile(file("input-1.bin"));
      bytes[0] ^= 1;
      await fs.writeFile(file("input-1.bin"), bytes);
    },
  ],
  ["truncation", async (file) => fs.truncate(file("input-1.bin"), 1)],
]) {
  test(`inspection CLI: ${label} cannot produce a passing report`, async (t) => {
    const { dir, file } = await directory(t);
    await modify(file);
    const result = cli(dir);
    assert.equal(result.exit_code, 2);
    assert.equal(result.stage, "artifacts");
    assert.equal(result.fault.code, "artifact_rejected");
    assert.deepEqual(result.fault.subject, { kind: "artifact", index: 1 });
    assert.equal(result.checked.artifacts, 0);
  });
}
test("inspection CLI: oversized artifact fails preflight without reading any report", async (t) => {
  const { dir, file } = await directory(t);
  await fs.appendFile(file("input-2.bin"), "x");
  const result = cli(dir);
  assert.equal(result.exit_code, 64);
  assert.equal(result.executed, false);
  assert.equal(result.fault.code, "file_size_limit");
});
for (const [label, mutate] of [
  [
    "wrong manifest",
    (events) => events.replace(/manifest_id/g, "not_manifest"),
  ],
  ["unterminated tail", (events) => events.slice(0, -1)],
  [
    "missing success",
    (events) => events.split("\n").slice(0, -2).join("\n") + "\n",
  ],
  ["invalid UTF8", () => Buffer.from([0xff, 10])],
]) {
  test(`inspection CLI: ${label} report prevents all artifact-body reads`, async (t) => {
    const { dir, file, f } = await directory(t);
    await fs.writeFile(file("producer-2.ndjson"), mutate(f.events[1]));
    const tracked = await opened(t);
    const result = await inspectRuntimeDirectory(dir);
    assert.equal(result.exit_code, 2);
    assert.equal(result.stage, "producers");
    assert.equal(result.checked.producers, 1);
    assert.equal(
      tracked.reads.some((name) => name.startsWith("input-")),
      false,
    );
    assert.equal(
      tracked.handles.every((handle) => handle.fd === -1),
      true,
    );
  });
}
for (const kind of ["symlink", "hardlink", "directory", "fifo"]) {
  test(`inspection CLI: rejects ${kind} leaf without hanging`, async (t) => {
    const { dir, file } = await directory(t);
    const saved = file("original.bin");
    await fs.rename(file("input-1.bin"), saved);
    if (kind === "symlink") await fs.symlink(saved, file("input-1.bin"));
    if (kind === "hardlink") await fs.link(saved, file("input-1.bin"));
    if (kind === "directory") await fs.mkdir(file("input-1.bin"));
    if (kind === "fifo")
      assert.equal(spawnSync("mkfifo", [file("input-1.bin")]).status, 0);
    const result = cli(dir);
    assert.equal(result.exit_code, 64);
    assert.equal(result.fault.code, "invalid_file_type");
  });
}
test("inspection CLI: rejects symlink directory rather than inspecting its target", async (t) => {
  const { dir, file } = await directory(t);
  await fs.symlink(dir, file("alias"));
  assert.equal(cli(file("alias")).exit_code, 64);
});
test("inspection CLI: full file-name convention is explicit and extra files are never inspected", async (t) => {
  const { dir, file } = await directory(t);
  await fs.writeFile(
    file("package.json"),
    '{"scripts":{"start":"not-for-output"}}',
  );
  await fs.symlink("/not-for-output", file("unrelated"));
  const tracked = await opened(t);
  assert.equal((await inspectRuntimeDirectory(dir)).exit_code, 0);
  assert.equal(tracked.reads.includes("package.json"), false);
  assert.equal(tracked.reads.includes("unrelated"), false);
});
test("inspection CLI: valid empty plan is explicit, not an executable run", async (t) => {
  const { dir, f, file } = await directory(t);
  f.plan.consumer.input_artifacts = [];
  f.plan.producers = [];
  await fs.writeFile(file("plan.json"), JSON.stringify(f.plan));
  const result = cli(dir);
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.checked, { producers: 0, artifacts: 0, bytes: 0 });
});
test("inspection CLI: exact plan byte boundary passes, one additional byte fails", async (t) => {
  const { dir, file } = await directory(t);
  const plan = await fs.readFile(file("plan.json"), "utf8");
  await fs.writeFile(
    file("plan.json"),
    plan + " ".repeat(262144 - Buffer.byteLength(plan)),
  );
  assert.equal(cli(dir).exit_code, 0);
  await fs.appendFile(file("plan.json"), " ");
  assert.equal(cli(dir).exit_code, 64);
});
test("inspection CLI: event file cap is enforced before body reads", async (t) => {
  const { dir, file } = await directory(t);
  await fs.truncate(file("producer-1.ndjson"), 4194305);
  const tracked = await opened(t);
  const result = await inspectRuntimeDirectory(dir);
  assert.equal(result.exit_code, 64);
  assert.deepEqual(
    tracked.reads.filter((name) => name !== "plan.json"),
    [],
  );
});
test("inspection CLI: pre-aborted signal never opens a file and never echoes its reason", async (t) => {
  const { dir } = await directory(t);
  const tracked = await opened(t);
  const controller = new AbortController();
  controller.abort(new Error("not-for-output"));
  const result = await inspectRuntimeDirectory(dir, {
    signal: controller.signal,
  });
  assert.equal(result.exit_code, 130);
  assert.equal(tracked.handles.length, 0);
  noLeak(result, dir);
});
test("inspection CLI: abort between reports closes all handles without artifact reads", async (t) => {
  const { dir } = await directory(t);
  const controller = new AbortController();
  const tracked = await opened(t, async (name) => {
    if (name === "producer-2.ndjson") controller.abort("not-for-output");
  });
  const result = await inspectRuntimeDirectory(dir, {
    signal: controller.signal,
  });
  assert.equal(result.exit_code, 130);
  assert.equal(
    tracked.reads.some((n) => n.startsWith("input-")),
    false,
  );
  assert.equal(
    tracked.handles.every((h) => h.fd === -1),
    true,
  );
  noLeak(result, dir);
});
test("inspection CLI: file mutation during reading is rejected and descriptors close", async (t) => {
  const { dir, file } = await directory(t);
  let changed = false;
  const tracked = await opened(t, async (name) => {
    if (name === "input-1.bin" && !changed) {
      changed = true;
      await fs.appendFile(file(name), "x");
    }
  });
  const result = await inspectRuntimeDirectory(dir);
  assert.equal(result.exit_code, 2);
  assert.equal(
    tracked.handles.every((h) => h.fd === -1),
    true,
  );
});
test("inspection CLI: replacing a pre-opened path with identical bytes still rejects", async (t) => {
  const { dir, file } = await directory(t);
  let changed = false;
  const tracked = await opened(t, async (name) => {
    if (name === "input-2.bin" && !changed) {
      changed = true;
      const bytes = await fs.readFile(file("input-1.bin"));
      await fs.rename(file("input-1.bin"), file("saved"));
      await fs.writeFile(file("input-1.bin"), bytes);
    }
  });
  const result = await inspectRuntimeDirectory(dir);
  assert.equal(result.exit_code, 2);
  assert.equal(result.fault.code, "file_changed");
  assert.equal(
    tracked.handles.every((h) => h.fd === -1),
    true,
  );
});
test("inspection CLI: unexpected native errors do not reveal paths or stack traces", async (t) => {
  const { dir } = await directory(t);
  t.mock.method(fs, "lstat", async () => {
    throw new Error("not-for-output");
  });
  const result = await inspectRuntimeDirectory(dir);
  assert.equal(result.exit_code, 64);
  noLeak(result, dir);
});
for (const action of ["deadline", "SIGINT", "SIGTERM"]) {
  test(
    `inspection CLI: actual child handles ${action} with nonzero JSON and exits`,
    { timeout: 10000 },
    async (t) => {
      const { dir } = await directory(t);
      const child = fork(
        script,
        [dir, "--timeout-ms", action === "deadline" ? "100" : "10000"],
        {
          execArgv: ["--import", fixture],
          env: { ...process.env, ZT_INSPECTION_TEST_FAULT: action },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => {
        stdout += b;
      });
      child.stderr.on("data", (b) => {
        stderr += b;
      });
      child.on("message", (value) => {
        assert.equal(value, "read_started");
        if (action !== "deadline") child.kill(action);
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (value, signal) => {
          assert.equal(signal, null);
          resolve(value);
        });
      });
      const expected =
        action === "deadline" ? 124 : action === "SIGINT" ? 130 : 143;
      assert.equal(code, expected);
      const result = JSON.parse(stdout);
      assert.equal(result.exit_code, expected);
      assert.equal(result.authorization, false);
      assert.equal(result.cleanup, "complete");
      assert.equal(stderr, "");
    },
  );
}
test("inspection CLI: trailing separator does not disguise a symlink root", async (t) => {
  const { dir, file } = await directory(t);
  await fs.symlink(dir, file("alias"));
  assert.equal(cli(file("alias") + path.sep).exit_code, 64);
});
test("inspection CLI: build missing yields a fixed machine-readable nonzero result", async (t) => {
  const { dir, file } = await directory(t);
  const copy = file("standalone.mjs");
  await fs.copyFile(script, copy);
  const child = spawnSync(process.execPath, [copy, dir], { encoding: "utf8" });
  assert.equal(child.status, 3);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(result.fault.code, "runtime_unavailable");
  assert.equal(result.executed, false);
  noLeak(result, dir);
});
test("inspection CLI: cleanup failure cannot leave a passing exit status", async (t) => {
  const { dir } = await directory(t);
  const native = fs.open;
  const handles = [];
  t.mock.method(fs, "open", async (...args) => {
    const h = await native(...args);
    handles.push(h);
    const close = h.close.bind(h);
    h.close = async () => {
      await close();
      throw new Error("not-for-output");
    };
    return h;
  });
  const result = await inspectRuntimeDirectory(dir);
  assert.equal(result.exit_code, 3);
  assert.equal(result.cleanup, "failed");
  assert.equal(result.fault.code, "cleanup_failed");
  assert.equal(
    handles.every((h) => h.fd === -1),
    true,
  );
  noLeak(result, dir);
});
test("inspection CLI: cancellation during descriptor cleanup cannot return success", async (t) => {
  const { dir } = await directory(t);
  const native = fs.open;
  const controller = new AbortController();
  t.mock.method(fs, "open", async (...args) => {
    const h = await native(...args);
    const close = h.close.bind(h);
    h.close = async () => {
      controller.abort();
      await close();
    };
    return h;
  });
  const result = await inspectRuntimeDirectory(dir, {
    signal: controller.signal,
  });
  assert.equal(result.exit_code, 130);
  assert.equal(result.cleanup, "complete");
});
