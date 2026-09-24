import { ConfigurationError, parseServiceConfig } from "@zentwine/config";
import { createLogger } from "@zentwine/telemetry";
import { buildApp } from "./app.js";
const sink = (line: string): void => {
  process.stdout.write(line);
};
async function main(): Promise<void> {
  const config = parseServiceConfig(process.env);
  const logger = createLogger({ level: config.logging.level, sink });
  const app = buildApp({ config, logSink: sink });
  await app.listen({ host: config.server.host, port: config.server.port });
  logger.log("info", "api.started", {
    host: config.server.host,
    port: config.server.port,
    mode: "development-bootstrap",
  });
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(
      () => process.exit(1),
      config.shutdownTimeoutMs,
    ).unref();
    app
      .close()
      .then(() => {
        clearTimeout(timer);
        logger.log("info", "api.stopped");
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
main().catch((error: unknown) => {
  // A constant error event with field/reason only; never dump process.env or exceptions.
  createLogger({
    sink: (line) => {
      process.stderr.write(line);
    },
  }).log(
    "error",
    "api.start_failed",
    error instanceof ConfigurationError
      ? {
          code: "invalid_configuration",
          field: error.field,
          reason: error.reason,
        }
      : { code: "startup_failed" },
  );
  process.exitCode = 1;
});
