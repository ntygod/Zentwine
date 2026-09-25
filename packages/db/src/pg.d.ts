/** Narrow driver surface used here, checked by real pg integration tests. */
declare module "pg" {
  interface QueryResult {
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }
  interface PoolClient {
    query(sql: string, values?: unknown[]): Promise<QueryResult>;
    release(destroy?: boolean): void;
  }
  class Pool {
    constructor(options: {
      connectionString: string;
      max: number;
      connectionTimeoutMillis: number;
      idleTimeoutMillis: number;
      statement_timeout: number;
      query_timeout: number;
      allowExitOnIdle: boolean;
    });
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "error", callback: (error: unknown) => void): this;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
