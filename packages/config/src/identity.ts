import {
  ConfigurationError,
  parseConfig,
  parseDatabaseConfig,
  type Environment,
  type SecretValue,
} from "./index.js";
export interface IdentityConfig {
  readonly mode: "local-ticket";
  readonly databaseUrl: SecretValue;
  readonly origins: readonly string[];
}
/** Off unless explicitly enabled. Local ticket authentication is not a production login provider. */
export function parseIdentityConfig(env: Environment): IdentityConfig | null {
  const mode = env["ZENTWINE_IDENTITY_MODE"];
  if (mode === undefined || mode === "disabled") return null;
  if (mode !== "local-ticket")
    throw new ConfigurationError("ZENTWINE_IDENTITY_MODE", "unsupported");
  parseConfig(env);
  const database = parseDatabaseConfig(env);
  const u = new URL(database.url.reveal());
  if (
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    !u.username ||
    !u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/zentwine_identity_dev"
  )
    throw new ConfigurationError("ZENTWINE_DATABASE_URL", "unsupported");
  const raw = env["ZENTWINE_IDENTITY_ORIGINS"];
  if (!raw)
    throw new ConfigurationError("ZENTWINE_IDENTITY_ORIGINS", "missing");
  const origins = raw.split(",");
  if (origins.length > 4 || new Set(origins).size !== origins.length)
    throw new ConfigurationError("ZENTWINE_IDENTITY_ORIGINS");
  for (const origin of origins) {
    try {
      const o = new URL(origin);
      if (
        o.origin !== origin ||
        o.protocol !== "http:" ||
        o.hostname !== "127.0.0.1" ||
        !o.port
      )
        throw new Error();
    } catch {
      throw new ConfigurationError("ZENTWINE_IDENTITY_ORIGINS");
    }
  }
  return Object.freeze({
    mode,
    databaseUrl: database.url,
    origins: Object.freeze(origins),
  });
}
