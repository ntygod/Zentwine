/** Test-only pre-exec handshake. Never used by application/runtime code. */
const gateScript =
  'IFS= read -r gate <&3 || exit 125; [ "$gate" = run ] || exit 125; exec 3<&-; exec "$@"';

/**
 * Keep intercepted children behind a pipe until synchronous fault injection finishes.
 * A tiny Git command can otherwise exit before the parent sends SIGSTOP. The fixed
 * shell script receives the command and all arguments as separate argv entries,
 * then execs it in the same PID/process group; it does not evaluate argument text.
 */
export function interceptBeforeExec(spawn, intercept, ...input) {
  const held = [];
  const gated = (command, args, options) => {
    if (
      typeof command !== "string" ||
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string") ||
      options?.shell !== false ||
      options.detached !== true ||
      JSON.stringify(options.stdio) !== '["ignore","pipe","pipe"]'
    )
      throw new TypeError("Unsupported gated test spawn");
    const child = spawn(
      "/bin/sh",
      ["-c", gateScript, "zentwine-test-gate", command, ...args],
      { ...options, stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    const gate = child.stdio[3];
    // A deliberately killed child may close the pipe before release. Its normal
    // close/error event still reaches the caller; the private gate has no result.
    gate.on("error", () => {});
    held.push({ child, gate });
    return child;
  };
  try {
    const result = intercept(gated, ...input);
    for (const { gate } of held) gate.end("run\n");
    return result;
  } catch (error) {
    // Do not launch the payload after failed setup, and clean only owned groups.
    for (const { child, gate } of held) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      gate.destroy();
    }
    throw error;
  }
}
