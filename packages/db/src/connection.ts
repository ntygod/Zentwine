import pg from "pg";
export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
}
export interface SqlConnection {
  query(sql: string, values?: unknown[]): Promise<SqlResult>;
  release(destroy?: boolean): void;
}
export interface IdentityPool {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}
/** Explicit DSN: callers validate environment; no implicit PG* environment fallback. */
export function createIdentityPool(url: string): IdentityPool {
  const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    query_timeout: 6000,
    allowExitOnIdle: true,
  });
  // Idle disconnects must not emit raw driver errors or terminate the process.
  pool.on("error", () => {});
  return pool;
}
