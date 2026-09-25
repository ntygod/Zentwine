import {
  ConfigurationError,
  parseServiceConfig,
  parseIdentityConfig,
} from "@zentwine/config";
import { createLogger } from "@zentwine/telemetry";
import {
  createIdentityPool,
  PostgresIdentityRepository,
  PostgresPolicyRepository,
  PostgresAgentRepository,
  PostgresApprovalRepository,
  type IdentityPool,
} from "@zentwine/db";
import { buildApp } from "./app.js";
const sink = (line: string): void => {
  process.stdout.write(line);
};
async function main(): Promise<void> {
  const config = parseServiceConfig(process.env);
  const logger = createLogger({ level: config.logging.level, sink });
  const identity = parseIdentityConfig(process.env);
  let pool: IdentityPool | undefined;
  let repository: PostgresIdentityRepository | undefined;
  try {
    if (identity) {
      pool = createIdentityPool(identity.databaseUrl.reveal());
      repository = new PostgresIdentityRepository(pool);
      await repository.assertRuntimeRole();
    }
  } catch (error) {
    await pool?.end();
    throw error;
  }
  let policy: PostgresPolicyRepository | undefined;
  if (
    process.env["ZENTWINE_POLICY_MODE"] !== undefined &&
    process.env["ZENTWINE_POLICY_MODE"] !== "disabled"
  ) {
    try {
      if (process.env["ZENTWINE_POLICY_MODE"] !== "local" || !pool || !identity)
        throw new ConfigurationError("ZENTWINE_POLICY_MODE", "unsupported");
      policy = new PostgresPolicyRepository(pool);
      await policy.assertRuntimeRole();
    } catch (e) {
      await pool?.end();
      throw e;
    }
  }
  let agents: PostgresAgentRepository | undefined;
  if (
    process.env["ZENTWINE_AGENT_MODE"] !== undefined &&
    process.env["ZENTWINE_AGENT_MODE"] !== "disabled"
  ) {
    try {
      if (process.env["ZENTWINE_AGENT_MODE"] !== "local" || !pool || !policy)
        throw new ConfigurationError("ZENTWINE_AGENT_MODE", "unsupported");
      agents = new PostgresAgentRepository(pool);
      await agents.assertRuntimeRole();
    } catch (e) {
      await pool?.end();
      throw e;
    }
  }
  let approvals: PostgresApprovalRepository | undefined;
  if (
    process.env["ZENTWINE_APPROVAL_MODE"] !== undefined &&
    process.env["ZENTWINE_APPROVAL_MODE"] !== "disabled"
  ) {
    try {
      if (process.env["ZENTWINE_APPROVAL_MODE"] !== "local" || !pool || !agents)
        throw new ConfigurationError("ZENTWINE_APPROVAL_MODE", "unsupported");
      approvals = new PostgresApprovalRepository(pool);
      await approvals.assertRuntimeRole();
    } catch (e) {
      await pool?.end();
      throw e;
    }
  }
  const app = buildApp({
    ...(approvals ? { approvals } : {}),
    ...(agents ? { agents } : {}),
    ...(policy ? { policy } : {}),
    config,
    logSink: sink,
    ...(identity && repository
      ? { identity: { repository, origins: identity.origins } }
      : {}),
  });
  if (pool) {
    const owned = pool;
    app.addHook("onClose", async () => {
      await owned.end();
    });
  }
  try {
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  logger.log("info", "api.started", {
    host: config.server.host,
    port: config.server.port,
    mode: identity ? "local-ticket" : "development-bootstrap",
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
