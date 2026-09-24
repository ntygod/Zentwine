import pg from "pg";
/** Real test driver. Fixed options override ambient PG* settings; raw DB errors/credentials are not logged. */
export async function connectTestPostgres(config) {
  const client = new pg.Client({
    ...config,
    ssl: false,
    application_name: "zentwine_fixture",
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
    idle_in_transaction_session_timeout: 8000,
  });
  let unhealthy = false;
  client.on("error", () => {
    unhealthy = true;
  });
  const safe = (error) =>
    Object.assign(new Error("Synthetic PostgreSQL operation failed"), {
      code:
        typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
          ? error.code
          : "test_database_unavailable",
    });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw safe(error);
  }
  return {
    async query(sql, values) {
      if (unhealthy) throw safe(undefined);
      try {
        return await client.query(sql, values);
      } catch (error) {
        throw safe(error);
      }
    },
    async close() {
      await client.end();
    },
  };
}
