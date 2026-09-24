import { Pool, type PoolClient } from 'pg';
import { operationId, parseCommand, requestHash, testDatabaseUrl, testSchema } from './identity';
import type { EffectResult, WorkflowInput } from './model';

export const schemaSql = `
CREATE TABLE requests (
  operation_id text PRIMARY KEY, org_id text NOT NULL, actor_id text NOT NULL,
  request_hash text NOT NULL, spec_hash text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','completed','denied'))
);
CREATE TABLE outbox (
  operation_id text REFERENCES requests(operation_id), kind text NOT NULL,
  dispatched boolean NOT NULL DEFAULT false, PRIMARY KEY(operation_id, kind)
);
CREATE TABLE decisions (
  operation_id text PRIMARY KEY REFERENCES requests(operation_id),
  spec_hash text NOT NULL, allowed boolean NOT NULL
);
CREATE TABLE effects (
  operation_id text PRIMARY KEY REFERENCES requests(operation_id), spec_hash text NOT NULL
);
CREATE TABLE effect_attempts (
  operation_id text PRIMARY KEY REFERENCES requests(operation_id), count integer NOT NULL
);`;

export function poolFor(schema: string): Pool {
  return new Pool({ connectionString: testDatabaseUrl(process.env.POC_DATABASE_URL),
    options: '-c search_path=' + testSchema(schema), max: 12,
    connectionTimeoutMillis: 5000, statement_timeout: 5000 });
}

export class Store {
  constructor(readonly pool: Pool) {}
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async submit(raw: unknown, failBeforeOutbox = false): Promise<{ operationId: string; reused: boolean }> {
    const command = parseCommand(raw);
    const id = operationId(command);
    return this.transaction(async client => {
      const inserted = await client.query(
        'INSERT INTO requests(operation_id,org_id,actor_id,request_hash,spec_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING operation_id',
        [id, command.orgId, command.actorId, requestHash(command), command.specHash]);
      const row = (await client.query('SELECT request_hash FROM requests WHERE operation_id=$1', [id])).rows[0];
      if (row.request_hash !== requestHash(command)) throw new Error('IDEMPOTENCY_CONFLICT');
      // Explicit fault injection for the experiment; never an HTTP input or production switch.
      if (failBeforeOutbox) throw new Error('INJECTED_TRANSACTION_FAILURE');
      await client.query("INSERT INTO outbox(operation_id,kind) VALUES($1,'start') ON CONFLICT DO NOTHING", [id]);
      return { operationId: id, reused: inserted.rowCount === 0 };
    });
  }

  // Test harness substitutes for an authenticated human command; this is not an authorization service.
  async decide(input: WorkflowInput, allowed: boolean): Promise<void> {
    await this.transaction(async client => {
      const request = (await client.query('SELECT spec_hash,state FROM requests WHERE operation_id=$1 FOR UPDATE', [input.operationId])).rows[0];
      if (!request || request.spec_hash !== input.specHash) throw new Error('STALE_APPROVAL');
      const prior = (await client.query('SELECT spec_hash,allowed FROM decisions WHERE operation_id=$1', [input.operationId])).rows[0];
      if (prior) {
        if (prior.spec_hash !== input.specHash || prior.allowed !== allowed) throw new Error('DECISION_CONFLICT');
        return;
      }
      if (request.state !== 'queued') throw new Error('INVALID_TRANSITION');
      await client.query('INSERT INTO decisions(operation_id,spec_hash,allowed) VALUES($1,$2,$3)', [input.operationId, input.specHash, allowed]);
    });
  }

  async apply(input: WorkflowInput): Promise<{ result: EffectResult; inserted: boolean }> {
    await this.pool.query('INSERT INTO effect_attempts(operation_id,count) VALUES($1,1) ON CONFLICT(operation_id) DO UPDATE SET count=effect_attempts.count+1', [input.operationId]);
    return this.transaction(async client => {
      const request = (await client.query('SELECT spec_hash FROM requests WHERE operation_id=$1 FOR UPDATE', [input.operationId])).rows[0];
      if (!request || request.spec_hash !== input.specHash) throw new Error('STALE_EXECUTION');
      const decision = (await client.query('SELECT spec_hash,allowed FROM decisions WHERE operation_id=$1', [input.operationId])).rows[0];
      if (!decision) return { result: 'pending', inserted: false };
      if (decision.spec_hash !== input.specHash) throw new Error('STALE_APPROVAL');
      if (!decision.allowed) {
        await client.query("UPDATE requests SET state='denied' WHERE operation_id=$1", [input.operationId]);
        return { result: 'denied', inserted: false };
      }
      // Simulated business effect, actually persisted in PostgreSQL, not a model call or deployment.
      const effect = await client.query('INSERT INTO effects(operation_id,spec_hash) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING operation_id', [input.operationId, input.specHash]);
      await client.query("UPDATE requests SET state='completed' WHERE operation_id=$1", [input.operationId]);
      await client.query("INSERT INTO outbox(operation_id,kind) VALUES($1,'completed') ON CONFLICT DO NOTHING", [input.operationId]);
      return { result: 'completed', inserted: effect.rowCount === 1 };
    });
  }
}
