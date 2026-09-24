import { prepareTools } from "./local/tooling.mjs";
import { LocalToolError } from "./local/process.mjs";
const args = process.argv.slice(2),
  controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--offline"))
    throw new LocalToolError("invalid_tool_command");
  const result = await prepareTools({
    offline: args.includes("--offline"),
    signal: controller.signal,
  });
  console.log(
    JSON.stringify({
      status: result.status,
      version: result.version,
      scope: "local_test_tool",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code:
        error instanceof LocalToolError
          ? error.code
          : "tool_preparation_failed",
    }),
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
