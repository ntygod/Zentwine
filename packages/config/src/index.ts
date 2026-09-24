export interface ServerConfig {
  mode: "development" | "test";
  host: "127.0.0.1";
  port: number;
}
export class ConfigurationError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid configuration: ${field}`);
    this.name = "ConfigurationError";
  }
}
/** Does not mutate process.env or include rejected values in errors. */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const mode = env["NODE_ENV"] ?? "development";
  if (mode !== "development" && mode !== "test")
    throw new ConfigurationError(
      "NODE_ENV (bootstrap is not production-ready)",
    );
  if ((env["ZENTWINE_HOST"] ?? "127.0.0.1") !== "127.0.0.1")
    throw new ConfigurationError("ZENTWINE_HOST (loopback only)");
  const rawPort = env["ZENTWINE_API_PORT"] ?? "4100";
  if (!/^\d{1,5}$/.test(rawPort))
    throw new ConfigurationError("ZENTWINE_API_PORT");
  const port = Number(rawPort);
  if (port < 1 || port > 65535)
    throw new ConfigurationError("ZENTWINE_API_PORT");
  return { mode, host: "127.0.0.1", port };
}
