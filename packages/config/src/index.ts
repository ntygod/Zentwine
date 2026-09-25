export type Environment = Readonly<Record<string, string | undefined>>;
export type ConfigField =
  | "NODE_ENV"
  | "ZENTWINE_HOST"
  | "ZENTWINE_API_PORT"
  | "ZENTWINE_LOG_LEVEL"
  | "ZENTWINE_BODY_LIMIT_BYTES"
  | "ZENTWINE_REQUEST_TIMEOUT_MS"
  | "ZENTWINE_SHUTDOWN_TIMEOUT_MS"
  | "ZENTWINE_DATABASE_URL"
  | "ZENTWINE_IDENTITY_MODE"
  | "ZENTWINE_IDENTITY_ORIGINS";
export type ConfigReason = "missing" | "invalid" | "unsupported";
export class ConfigurationError extends Error {
  constructor(
    public readonly field: ConfigField,
    public readonly reason: ConfigReason = "invalid",
  ) {
    super(`Invalid configuration: ${field} (${reason})`);
    this.name = "ConfigurationError";
  }
}
export interface ServerConfig {
  readonly mode: "development" | "test";
  readonly host: "127.0.0.1";
  readonly port: number;
}
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export interface ServiceConfig {
  readonly server: ServerConfig;
  readonly logging: Readonly<{ level: LogLevel }>;
  readonly limits: Readonly<{
    bodyLimitBytes: number;
    requestTimeoutMs: number;
  }>;
  readonly shutdownTimeoutMs: number;
}
function integer(
  env: Environment,
  field: ConfigField,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[field];
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) throw new ConfigurationError(field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(field);
  }
  return value;
}
/** Explicit input only: no process.env mutation or implicit .env file loading. */
export function parseConfig(env: Environment): ServerConfig {
  const mode = env["NODE_ENV"] ?? "development";
  if (mode !== "development" && mode !== "test") {
    throw new ConfigurationError("NODE_ENV", "unsupported");
  }
  if ((env["ZENTWINE_HOST"] ?? "127.0.0.1") !== "127.0.0.1") {
    throw new ConfigurationError("ZENTWINE_HOST", "unsupported");
  }
  return Object.freeze({
    mode,
    host: "127.0.0.1",
    port: integer(env, "ZENTWINE_API_PORT", 4100, 1, 65535),
  });
}
export function parseServiceConfig(env: Environment): ServiceConfig {
  const server = parseConfig(env);
  const level = env["ZENTWINE_LOG_LEVEL"] ?? "info";
  if (!["debug", "info", "warn", "error", "silent"].includes(level)) {
    throw new ConfigurationError("ZENTWINE_LOG_LEVEL");
  }
  return Object.freeze({
    server,
    logging: Object.freeze({ level: level as LogLevel }),
    limits: Object.freeze({
      bodyLimitBytes: integer(
        env,
        "ZENTWINE_BODY_LIMIT_BYTES",
        16384,
        1024,
        1048576,
      ),
      requestTimeoutMs: integer(
        env,
        "ZENTWINE_REQUEST_TIMEOUT_MS",
        30000,
        1000,
        120000,
      ),
    }),
    shutdownTimeoutMs: integer(
      env,
      "ZENTWINE_SHUTDOWN_TIMEOUT_MS",
      5000,
      100,
      30000,
    ),
  });
}
/** Accidental serialization hides the value; this is not encryption or a vault. */
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "[REDACTED]";
  }
  toString(): string {
    return "[REDACTED]";
  }
}
/** Optional dependency parser. The bootstrap does NOT call this or connect a DB. */
export function parseDatabaseConfig(
  env: Environment,
): Readonly<{ url: SecretValue }> {
  const field = "ZENTWINE_DATABASE_URL";
  const raw = env[field];
  if (raw === undefined || raw.length === 0) {
    throw new ConfigurationError(field, "missing");
  }
  try {
    if (raw.length > 4096 || /[\s\u0000-\u001f]/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2 ||
      url.hash ||
      (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    )
      throw new Error();
    return Object.freeze({ url: new SecretValue(raw) });
  } catch {
    throw new ConfigurationError(field);
  }
}

export * from "./identity.js";
