/** ZT12-01-A8: explicit read-only local inspection, not an execution gate. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 300000;
const CHUNK_BYTES = 65536;
const EVENT_BYTES = 4194304;
const usage =
  "node scripts/runtime-inspect.mjs <directory> [--timeout-ms 1..300000]";

class InspectionFault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new InspectionFault(code);
};
const same = (a, b) =>
  ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink"].every(
    (key) => a[key] === b[key],
  );
const regular = (stat) => stat.isFile() && stat.nlink === 1n;
function report() {
  return {
    report_version: "1.0.0",
    scope: "local_input_artifact_inspection",
    status: "unavailable",
    exit_code: 3,
    executed: false,
    stage: "arguments",
    authorization: false,
    verification: "unverified",
    producer_trust: "reported_not_authenticated",
    plan_sha256: null,
    checked: { producers: 0, artifacts: 0, bytes: 0 },
    fault: null,
    cleanup: "complete",
  };
}

/** Native local filesystem/AbortSignal only; no hostile same-user filesystem sandbox. */
export async function inspectRuntimeDirectory(directory, options = {}) {
  const result = report();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT
  ) {
    return {
      ...result,
      status: "invalid_input",
      exit_code: 64,
      fault: { code: "invalid_arguments", subject: null },
    };
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let expired = false;
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => {
    expired = true;
    abort();
  }, timeoutMs);
  const records = [];
  let bundle;
  let subject = null;
  let root;
  let rootStat;
  const checkAbort = () => {
    if (performance.now() >= deadline) {
      expired = true;
      abort();
    }
    if (signal.aborted) fail("interrupted");
  };
  const checkRoot = async () => {
    const current = await fs.lstat(root, { bigint: true });
    checkAbort();
    if (
      !current.isDirectory() ||
      current.dev !== rootStat.dev ||
      current.ino !== rootStat.ino
    )
      fail("directory_changed");
  };
  const verify = async (record) => {
    const current = await record.handle.stat({ bigint: true });
    const named = await fs.lstat(record.filename, { bigint: true });
    checkAbort();
    if (
      !regular(current) ||
      !same(record.stat, current) ||
      !same(current, named)
    )
      fail("file_changed");
  };
  const acquire = async (name, maximum) => {
    checkAbort();
    await checkRoot();
    const filename = path.join(root, name);
    const stat = await fs.lstat(filename, { bigint: true });
    checkAbort();
    if (!regular(stat)) fail("invalid_file_type");
    if (stat.size > BigInt(maximum)) fail("file_size_limit");
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    // Register immediately: every opened descriptor participates in final cleanup.
    const record = { filename, handle, stat, maximum };
    records.push(record);
    checkAbort();
    await verify(record);
    await checkRoot();
    return record;
  };
  const stream = (record) => {
    let position = 0;
    let cancelled = false;
    return new ReadableStream(
      {
        async pull(sink) {
          const bytes = Buffer.alloc(
            Math.min(CHUNK_BYTES, record.maximum - position + 1),
          );
          try {
            checkAbort();
            const read = await record.handle.read(
              bytes,
              0,
              bytes.length,
              position,
            );
            if (cancelled) return;
            checkAbort();
            position += read.bytesRead;
            if (position > record.maximum) fail("file_size_limit");
            if (read.bytesRead === 0) {
              await verify(record);
              if (!cancelled) sink.close();
            } else {
              // Independent backing memory: raw temporary read buffers are wiped below.
              sink.enqueue(Uint8Array.from(bytes.subarray(0, read.bytesRead)));
            }
          } catch {
            if (!cancelled) sink.error(new InspectionFault("file_read_failed"));
          } finally {
            bytes.fill(0);
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
  };
  try {
    checkAbort();
    result.stage = "runtime";
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)
      fail("unsupported_platform");
    const { createRuntimeInputInspection, RUNTIME_INSPECTION_PLAN_BYTES } =
      await import("../packages/client/dist/index.js");
    checkAbort();
    result.stage = "plan";
    const selectedPath = path.resolve(directory);
    const selected = await fs.lstat(selectedPath, { bigint: true });
    if (!selected.isDirectory()) fail("invalid_directory");
    root = await fs.realpath(selectedPath);
    rootStat = await fs.lstat(root, { bigint: true });
    if (rootStat.dev !== selected.dev || rootStat.ino !== selected.ino)
      fail("directory_changed");
    const planFile = await acquire("plan.json", RUNTIME_INSPECTION_PLAN_BYTES);
    const parts = [];
    let text;
    try {
      for await (const part of stream(planFile)) parts.push(part);
      const bytes = Buffer.concat(parts);
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        bundle = createRuntimeInputInspection(text);
        result.plan_sha256 = createHash("sha256").update(bytes).digest("hex");
      } finally {
        bytes.fill(0);
      }
    } finally {
      for (const part of parts) part.fill(0);
      text = undefined;
    }
    const initial = bundle.getSnapshot();
    const producers = [];
    const artifacts = [];
    result.stage = "files";
    for (const [index, p] of initial.producers.entries()) {
      subject = { kind: "producer", index: index + 1 };
      producers.push({
        id: p.manifest_id,
        record: await acquire(`producer-${index + 1}.ndjson`, EVENT_BYTES),
      });
    }
    for (const [index, a] of initial.artifacts.entries()) {
      subject = { kind: "artifact", index: index + 1 };
      artifacts.push({
        id: a.binding.artifact.ref.artifact_id,
        size: a.binding.artifact.size_bytes,
        record: await acquire(
          `input-${index + 1}.bin`,
          a.binding.artifact.size_bytes,
        ),
      });
    }
    checkAbort();
    bundle.begin(signal);
    result.executed = true;
    result.stage = "producers";
    for (const [index, p] of producers.entries()) {
      subject = { kind: "producer", index: index + 1 };
      await bundle.observeProducer(p.id, stream(p.record));
      checkAbort();
      if (bundle.getSnapshot().status === "rejected") fail("producer_rejected");
      result.checked.producers++;
    }
    result.stage = "artifacts";
    for (const [index, a] of artifacts.entries()) {
      subject = { kind: "artifact", index: index + 1 };
      await bundle.readArtifact(a.id, stream(a.record));
      checkAbort();
      if (bundle.getSnapshot().status === "rejected") fail("artifact_rejected");
      result.checked.artifacts++;
      result.checked.bytes += a.size;
    }
    subject = null;
    if (bundle.getSnapshot().status !== "ready") fail("inspection_incomplete");
    // Do not attest to a pathname replaced or a file changed during other stages.
    for (const record of records) await verify(record);
    await checkRoot();
    checkAbort();
    result.status = "passed";
    result.exit_code = 0;
    result.stage = "complete";
  } catch (error) {
    const interrupted = signal.aborted;
    result.status = interrupted
      ? expired
        ? "timed_out"
        : "cancelled"
      : result.executed
        ? "rejected"
        : result.stage === "runtime"
          ? "unavailable"
          : "invalid_input";
    result.exit_code = interrupted
      ? expired
        ? 124
        : 130
      : result.executed
        ? 2
        : result.stage === "runtime"
          ? 3
          : 64;
    result.fault = {
      code: interrupted
        ? expired
          ? "deadline_exceeded"
          : "interrupted"
        : error instanceof InspectionFault
          ? error.code
          : result.stage === "runtime"
            ? "runtime_unavailable"
            : "local_input_unavailable",
      subject,
    };
  } finally {
    bundle?.close();
    const closed = await Promise.allSettled(
      records.map((r) => r.handle.close()),
    );
    if (performance.now() >= deadline) {
      expired = true;
      abort();
    }
    if (signal.aborted) {
      result.status = expired ? "timed_out" : "cancelled";
      result.exit_code = expired ? 124 : 130;
      result.fault = {
        code: expired ? "deadline_exceeded" : "interrupted",
        subject,
      };
    }
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (closed.some((r) => r.status === "rejected")) {
      result.cleanup = "failed";
      result.status = "unavailable";
      result.exit_code = 3;
      result.fault = { code: "cleanup_failed", subject: null };
    }
  }
  return result;
}

/** Parsing is independent of cwd and never imports or executes anything from the input. */
export async function runRuntimeInspectionCli(args) {
  if (args.length === 1 && args[0] === "--help")
    return { ...report(), status: "help", exit_code: 0, usage };
  const valid =
    (args.length === 1 ||
      (args.length === 3 &&
        args[1] === "--timeout-ms" &&
        /^[1-9]\d{0,5}$/.test(args[2]))) &&
    !args[0].startsWith("--");
  if (!valid) return inspectRuntimeDirectory("");
  const controller = new AbortController();
  let termination = false;
  const interrupt = () => controller.abort();
  const terminate = () => {
    termination = true;
    interrupt();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const result = await inspectRuntimeDirectory(args[0], {
      timeoutMs: args.length === 3 ? Number(args[2]) : DEFAULT_TIMEOUT,
      signal: controller.signal,
    });
    if (termination && result.status === "cancelled") result.exit_code = 143;
    return result;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // EPIPE/output failures must not turn an undelivered report into success.
  process.stdout.on("error", () => {
    process.exitCode = 3;
  });
  const result = await runRuntimeInspectionCli(process.argv.slice(2));
  process.exitCode = result.exit_code;
  process.stdout.write(JSON.stringify(result) + "\n");
}
