import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class LocalToolError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalToolError";
    this.code = code;
  }
}
export function assertLocalMode(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== "linux") throw new LocalToolError("unsupported_platform");
  if (env.NODE_ENV && !["test", "development"].includes(env.NODE_ENV))
    throw new LocalToolError("production_environment_refused");
}
/** Do not forward provider credentials, DATABASE_URL, NODE_OPTIONS, dotenv or proxy overrides. */
export function localEnvironment(source = process.env) {
  const env = { NODE_ENV: "test", TZ: "UTC", LANG: "C.UTF-8" };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "CI",
    "QUALITY_BASE_REF",
    "QUALITY_PYTHON",
  ])
    if (typeof source[key] === "string") env[key] = source[key];
  return env;
}
export function redactOutput(text, secrets = []) {
  let value = String(text);
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    value = value.split(secret).join("[REDACTED]");
  return value
    .replace(/(?:postgres(?:ql)?):\/\/[^\s'"<>]+/gi, "[DATABASE_URL]")
    .replace(/\x1b\[[0-9;]*m/g, "");
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH")
      throw new LocalToolError("process_signal_failed");
  }
}
function groupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
/** Fixed executables/argument arrays only. Captures bounded output; no shell interpretation. */
export function execute(
  command,
  args,
  {
    cwd = process.cwd(),
    env = localEnvironment(),
    signal,
    timeoutMs = 30000,
    maxBytes = 8 * 1024 * 1024,
    graceMs = 1000,
  } = {},
) {
  if (signal?.aborted)
    return Promise.reject(new LocalToolError("operation_cancelled"));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new LocalToolError("command_unavailable"));
      return;
    }
    let failure,
      bytes = 0,
      force,
      finished = false;
    const stdout = [],
      stderr = [];
    const stop = (code) => {
      failure ??= code;
      try {
        signalGroup(child, "SIGTERM");
      } catch {
        failure = "process_signal_failed";
      }
      force ??= setTimeout(() => {
        try {
          signalGroup(child, "SIGKILL");
        } catch {
          failure = "process_signal_failed";
        }
      }, graceMs);
    };
    const timer = setTimeout(() => stop("command_timeout"), timeoutMs);
    const cancel = () => stop("operation_cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop("command_output_limit");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => {
      failure ??= "command_unavailable";
    });
    child.once("close", async (code, terminationSignal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", cancel);
      // A child may exit while leaving descendants in its owned process group.
      if (groupExists(child.pid)) {
        try {
          signalGroup(child, "SIGTERM");
          await delay(100);
          if (groupExists(child.pid)) signalGroup(child, "SIGKILL");
        } catch {
          failure ??= "process_cleanup_failed";
        }
      }
      const result = {
        code: code ?? 1,
        signal: terminationSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (failure) {
        const error = new LocalToolError(failure);
        // Raw output is intentionally NOT attached to errors.
        reject(error);
      } else resolve(result);
    });
  });
}
export async function checked(command, args, options) {
  const result = await execute(command, args, options);
  if (result.code !== 0) throw new LocalToolError("command_failed");
  return result.stdout.trim();
}
