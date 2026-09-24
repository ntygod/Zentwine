import path from "node:path";
import { LocalStack, ROOT, withLock } from "./local/environment.mjs";
import { LocalToolError } from "./local/process.mjs";
export function parseEnvironmentArgs(args) {
  const [action, ...flags] = args;
  let offline = false,
    session;
  if (!["up", "status", "down"].includes(action))
    throw new LocalToolError("invalid_environment_command");
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--offline" && !offline && action === "up") offline = true;
    else if (
      flags[i] === "--session" &&
      !session &&
      action !== "up" &&
      /^[a-f0-9]{16}$/.test(flags[i + 1] ?? "")
    )
      session = flags[++i];
    else throw new LocalToolError("invalid_environment_command");
  }
  return { action, offline, session };
}
if (process.argv[1]?.endsWith("/environment.mjs")) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const options = parseEnvironmentArgs(process.argv.slice(2));
    const stack = new LocalStack(
      options.session
        ? {
            directory: path.join(
              ROOT,
              ".zentwine",
              "sessions",
              options.session,
            ),
          }
        : {},
    );
    await stack.prepare();
    const result = await withLock(stack.directory, async () =>
      options.action === "up"
        ? stack.up({ offline: options.offline, signal: controller.signal })
        : options.action === "down"
          ? stack.down()
          : stack.status(),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "cleanup_required") process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        code:
          error instanceof LocalToolError
            ? error.code
            : "environment_operation_failed",
      }),
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
