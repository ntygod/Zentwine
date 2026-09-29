/** Explicit local feedback inspection. A content match is not author or execution authority. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createLocalRepositoryPort } from "./lib/local-repository.mjs";

const MAX_TIMEOUT = 30000;
const usage =
  "node scripts/repository-review-inspect.mjs <repository> <feedback-directory> [--path <exact-path>] [--timeout-ms 1..30000]";
class FeedbackFault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new FeedbackFault(code);
};
const validText = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !/[\uD800-\uDFFF\0]/u.test(value) &&
  Buffer.byteLength(value) <= 4096;
const validPath = (value) =>
  validText(value) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const same = (a, b) =>
  ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );
const regular = (s) => s.isFile() && s.nlink === 1n;
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function rejected(code, stage = "arguments", exitCode = 2) {
  return {
    report_version: "1.0.0",
    scope: "local_repository_review_inspection",
    status:
      code === "cancelled"
        ? "cancelled"
        : code === "timeout"
          ? "timed_out"
          : "rejected",
    authorization: false,
    code_execution: false,
    notes_trust: "unverified_claims",
    author_trust: "unverified",
    feedback: null,
    fault: { code, stage },
    exit_code: exitCode,
  };
}
function optionsSnapshot(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype)
    fail("invalid_arguments");
  const out = { timeoutMs: MAX_TIMEOUT, signal: undefined, path: null };
  for (const key of Reflect.ownKeys(input)) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (
      !["timeoutMs", "signal", "path"].includes(key) ||
      !d?.enumerable ||
      !("value" in d)
    )
      fail("invalid_arguments");
    out[key] = d.value;
  }
  if (
    !Number.isSafeInteger(out.timeoutMs) ||
    out.timeoutMs < 1 ||
    out.timeoutMs > MAX_TIMEOUT ||
    (Object.hasOwn(input, "path") && !validPath(out.path))
  )
    fail("invalid_arguments");
  if (out.signal !== undefined) {
    try {
      Object.getOwnPropertyDescriptor(
        AbortSignal.prototype,
        "aborted",
      ).get.call(out.signal);
    } catch {
      fail("invalid_arguments");
    }
  }
  return out;
}

/** Native trusted Linux I/O only; no atomic snapshot or hostile same-user filesystem sandbox. */
export async function inspectRepositoryReview(
  repository,
  directory,
  options = {},
) {
  let settings;
  try {
    if (!validText(repository) || !validText(directory))
      fail("invalid_arguments");
    settings = optionsSnapshot(options);
  } catch {
    return freeze(rejected("invalid_arguments", "arguments", 64));
  }
  const controller = new AbortController(),
    signal = controller.signal;
  let expired = false,
    stage = "runtime",
    result;
  const abort = () => controller.abort();
  settings.signal?.addEventListener("abort", abort, { once: true });
  if (settings.signal?.aborted) abort();
  const deadline = performance.now() + settings.timeoutMs;
  const timer = setTimeout(() => {
    if (!signal.aborted) {
      expired = true;
      abort();
    }
  }, settings.timeoutMs);
  const check = () => {
    if (!signal.aborted && performance.now() >= deadline) {
      expired = true;
      abort();
    }
    if (signal.aborted) fail(expired ? "timeout" : "cancelled");
  };
  const records = [];
  let rootHandle, rootStat, root;
  const selectedDirectory = path.resolve(directory);
  const verifyRoot = async () => {
    const named = await fs.lstat(selectedDirectory, { bigint: true });
    const opened = await rootHandle.stat({ bigint: true });
    const resolved = await fs.realpath(selectedDirectory);
    check();
    if (
      !named.isDirectory() ||
      !opened.isDirectory() ||
      resolved !== root ||
      [named, opened].some((s) =>
        ["dev", "ino", "mode"].some((k) => s[k] !== rootStat[k]),
      )
    )
      fail("input_directory_changed");
  };
  const verify = async (r) => {
    const opened = await r.handle.stat({ bigint: true });
    const named = await fs.lstat(r.filename, { bigint: true });
    check();
    if (
      !regular(opened) ||
      !regular(named) ||
      !same(r.stat, opened) ||
      !same(opened, named)
    )
      fail("input_changed");
  };
  const read = async (name, maximum) => {
    check();
    await verifyRoot();
    // Fixed basenames beneath a held directory descriptor, never paths from report content.
    const filename = `/proc/self/fd/${rootHandle.fd}/${name}`;
    const stat = await fs.lstat(filename, { bigint: true });
    check();
    if (!regular(stat)) fail("invalid_input_file");
    if (stat.size > BigInt(maximum)) fail("input_size_limit");
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const record = { filename, handle, stat, bytes: null };
    records.push(record); // Register before any subsequent await, including cancellation checks.
    check();
    await verify(record);
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    record.bytes = bytes;
    let position = 0;
    while (position < bytes.length) {
      check();
      const { bytesRead } = await handle.read(
        bytes,
        position,
        Math.min(65536, bytes.length - position),
        position,
      );
      check();
      if (!bytesRead) break;
      position += bytesRead;
    }
    if (position !== Number(stat.size)) fail("input_changed");
    await verify(record);
    await verifyRoot();
    const content = bytes.subarray(0, position);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        content,
      );
    } catch {
      fail("invalid_input_encoding");
    }
    return { text, sha256: createHash("sha256").update(content).digest("hex") };
  };
  const waitForSession = (promise) =>
    new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        signal.removeEventListener("abort", interrupted);
        fn(value);
      };
      const interrupted = () =>
        finish(reject, new FeedbackFault(expired ? "timeout" : "cancelled"));
      signal.addEventListener("abort", interrupted, { once: true });
      if (signal.aborted) interrupted();
      // Native digest is not cancellable; consume but never use any late result.
      promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  try {
    check();
    if (
      process.platform !== "linux" ||
      !constants.O_NOFOLLOW ||
      !constants.O_DIRECTORY ||
      !constants.O_NONBLOCK
    )
      fail("unsupported_platform");
    let client;
    try {
      client = await import("../packages/client/dist/index.js");
    } catch {
      fail("build_required");
    }
    check();
    stage = "inputs";
    rootStat = await fs.lstat(selectedDirectory, { bigint: true });
    if (!rootStat.isDirectory()) fail("invalid_input_directory");
    root = await fs.realpath(selectedDirectory);
    rootHandle = await fs.open(
      root,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
    check();
    await verifyRoot();
    const original = await read(
      "comparison.json",
      client.REPOSITORY_COMPARISON_IMPORT_LIMITS.bytes,
    );
    const inputNotes = await read(
      "review-notes.json",
      client.REPOSITORY_REVIEW_NOTES_LIMITS.bytes,
    );
    stage = "report";
    let session;
    try {
      session = await waitForSession(
        client.createRepositoryReviewSession(original.text),
      );
    } catch {
      check();
      fail("invalid_comparison_report");
    }
    check();
    if (session.report_sha256 !== original.sha256)
      fail("report_digest_mismatch");
    stage = "notes";
    let notes;
    try {
      notes = client.parseRepositoryReviewNotes(session, inputNotes.text);
    } catch {
      fail("invalid_review_notes");
    }
    const report = session.report;
    if (
      settings.path !== null &&
      !report.entries.some((e) => e.path === settings.path)
    )
      fail("path_not_in_report");
    check();
    stage = "repository";
    // Recompute only the carried detail, not every path named in the review notes.
    const port = createLocalRepositoryPort(repository, {
      timeoutMs: settings.timeoutMs,
    });
    const actual = report.selected
      ? await port.readCommitDiff(
          report.base.commit_sha,
          report.head.commit_sha,
          report.selected.path,
          signal,
        )
      : await port.compareCommits(
          report.base.commit_sha,
          report.head.commit_sha,
          signal,
        );
    check();
    if (actual.status !== "compared") {
      if (actual.fault?.code === "timeout") fail("timeout");
      fail("local_comparison_unavailable");
    }
    if (
      !isDeepStrictEqual(
        report,
        client.parseRepositoryComparisonReport(JSON.stringify(actual)),
      )
    )
      fail("local_comparison_mismatch");
    const files = new Map();
    for (const note of notes) {
      const counts = files.get(note.path) ?? {
        path: note.path,
        notes: 0,
        issue: 0,
        suggestion: 0,
        question: 0,
      };
      counts.notes++;
      counts[note.kind]++;
      files.set(note.path, counts);
    }
    const chosen =
      settings.path === null
        ? null
        : {
            path: settings.path,
            scope: "file_level_notes",
            notes: notes.filter((n) => n.path === settings.path),
          };
    const feedback = {
      comparison_verification: "matches_local_git",
      binding: {
        report_sha256: original.sha256,
        object_format: report.object_format,
        base: report.base,
        head: report.head,
      },
      notes_sha256: inputNotes.sha256,
      coverage: {
        changed_entries: report.entries.length,
        carried_detail_path: report.selected?.path ?? null,
        carried_detail:
          report.selected === null
            ? "not_present"
            : report.selected.status === "text"
              ? "text_matched"
              : "non_text_classification_matched",
        current_head: "not_inspected",
        index: "not_inspected",
        working_tree: "not_inspected",
        remote_identity: "not_verified",
        full_file_contents: "not_disclosed",
      },
      summary: { files_with_notes: files.size, notes: notes.length },
      files: report.entries
        .filter((e) => files.has(e.path))
        .map((e) => files.get(e.path)),
      selected: chosen,
      note_content_disclosed: (chosen?.notes.length ?? 0) > 0,
      comparison_content_disclosed: false,
    };
    stage = "finalize";
    for (const record of records) await verify(record);
    await verifyRoot();
    check();
    result = {
      ...rejected("unused"),
      status: "inspected",
      feedback,
      fault: null,
      exit_code: 0,
    };
  } catch (error) {
    const code = signal.aborted
      ? expired
        ? "timeout"
        : "cancelled"
      : error instanceof FeedbackFault
        ? error.code
        : "inspection_unavailable";
    result = rejected(
      code,
      stage,
      code === "timeout"
        ? 124
        : code === "cancelled"
          ? 130
          : stage === "runtime"
            ? 3
            : 2,
    );
  } finally {
    let cleanupFailed = false;
    for (const record of records.reverse()) {
      record.bytes?.fill(0);
      try {
        await record.handle.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (rootHandle)
      try {
        await rootHandle.close();
      } catch {
        cleanupFailed = true;
      }
    clearTimeout(timer);
    settings.signal?.removeEventListener("abort", abort);
    if (cleanupFailed) result = rejected("cleanup_failed", "finalize", 3);
    else if (result?.exit_code === 0) {
      try {
        check();
      } catch {
        result = rejected(
          expired ? "timeout" : "cancelled",
          "finalize",
          expired ? 124 : 130,
        );
      }
    }
  }
  return freeze(result);
}

/** Encode display-affecting characters without changing their JSON-decoded value. */
export function repositoryReviewReportJson(report) {
  return (
    JSON.stringify(report).replace(
      /[\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
      (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`,
    ) + "\n"
  );
}
export async function repositoryReviewInspectMain(args, signal) {
  if (!Array.isArray(args) || args.some((v) => typeof v !== "string"))
    return rejected("invalid_arguments", "arguments", 64);
  if (args.length === 1 && args[0] === "--help")
    return {
      report_version: "1.0.0",
      status: "help",
      authorization: false,
      code_execution: false,
      exit_code: 0,
      usage,
    };
  const [repository, directory, ...rest] = args;
  if (
    !repository ||
    !directory ||
    repository.startsWith("--") ||
    directory.startsWith("--") ||
    rest.length % 2
  )
    return rejected("invalid_arguments", "arguments", 64);
  const values = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--path", "--timeout-ms"].includes(rest[i]) || values.has(rest[i]))
      return rejected("invalid_arguments", "arguments", 64);
    values.set(rest[i], rest[i + 1]);
  }
  if (
    values.has("--timeout-ms") &&
    !/^[1-9][0-9]*$/.test(values.get("--timeout-ms"))
  )
    return rejected("invalid_arguments", "arguments", 64);
  return inspectRepositoryReview(repository, directory, {
    signal,
    ...(values.has("--path") ? { path: values.get("--path") } : {}),
    ...(values.has("--timeout-ms")
      ? { timeoutMs: Number(values.get("--timeout-ms")) }
      : {}),
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  let terminating = false;
  const interrupt = () => controller.abort();
  const terminate = () => {
    terminating = true;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.stdout.on("error", () => {
    process.exitCode = 3;
  });
  try {
    let report = await repositoryReviewInspectMain(
      process.argv.slice(2),
      controller.signal,
    );
    if (controller.signal.aborted)
      report = rejected("cancelled", "finalize", terminating ? 143 : 130);
    await new Promise((resolve, reject) => {
      process.stdout.once("error", reject);
      process.stdout.write(repositoryReviewReportJson(report), (error) => {
        process.stdout.removeListener("error", reject);
        error ? reject(error) : resolve();
      });
    });
    process.exitCode = report.exit_code;
  } catch {
    process.exitCode = 3;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
