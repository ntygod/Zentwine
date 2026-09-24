import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { CancelledFailure } from '@temporalio/common';
import { operationId, testDatabaseUrl, testSchema } from './identity';
import { Store, poolFor, schemaSql } from './store';
import { dispatch } from './dispatch';
import type { StartCommand, WorkflowInput, WorkflowStatus } from './model';

interface OwnedWorker { child: ChildProcess; exited: Promise<NodeJS.Signals | null> }

// Real local Temporal server + real PostgreSQL. No model providers, no production services.
test('ZT01-01 durable workflow experiment', { timeout: 180_000 }, async t => {
  const url = testDatabaseUrl(process.env.POC_DATABASE_URL);
  const schema = testSchema('zt_poc_' + randomBytes(8).toString('hex'));
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  const pool = poolFor(schema);
  const store = new Store(pool);
  const dir = await mkdtemp(join(tmpdir(), 'zentwine-poc-'));
  const reportDir = resolve('reports');
  await mkdir(reportDir, { recursive: true });
  const checks: Array<{ name: string; status: string; durationMs: number }> = [];
  const workers: OwnedWorker[] = [];
  let env: TestWorkflowEnvironment | undefined;
  let databaseVersion = 'not_observed';
  const queue = 'zt-poc-' + randomBytes(8).toString('hex');
  const command = (key: string): StartCommand => ({ orgId: 'org_demo', actorId: 'human_demo', commandType: 'poc.run', idempotencyKey: key, specHash: 'a'.repeat(64) });
  const submit = async (key: string): Promise<WorkflowInput> => ({ ...(await store.submit(command(key))), specHash: command(key).specHash });
  const effects = async (id: string): Promise<number> => Number((await pool.query('SELECT count(*) FROM effects WHERE operation_id=$1', [id])).rows[0].count);

  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    let failure: unknown;
    await t.test(name, async () => {
      const start = Date.now();
      try { await fn(); checks.push({ name, status: 'passed', durationMs: Date.now() - start }); }
      catch (error) { checks.push({ name, status: 'failed', durationMs: Date.now() - start }); failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  async function startServer(): Promise<TestWorkflowEnvironment> {
    return TestWorkflowEnvironment.createLocal({ server: {
      dbFilename: join(dir, 'temporal.sqlite'), ui: false,
      executable: process.env.POC_TEMPORAL_CLI
        ? { type: 'existing-path', path: resolve(process.env.POC_TEMPORAL_CLI) }
        : { type: 'cached-download', version: '1.9.1' },
    } });
  }
  async function startWorker(crashAfterCommit = false): Promise<OwnedWorker> {
    assert.ok(env);
    const child = fork(join(__dirname, 'worker.js'), [], {
      env: { ...process.env, POC_WORKER: '1', POC_SCHEMA: schema, POC_TASK_QUEUE: queue,
        POC_TEMPORAL_ADDRESS: env.address, POC_CRASH_AFTER_COMMIT: crashAfterCommit ? '1' : '0' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const owned: OwnedWorker = { child, exited: new Promise(resolveExit => child.once('exit', (_code, signal) => resolveExit(signal))) };
    workers.push(owned);
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('WORKER_START_TIMEOUT')), 25_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('WORKER_EXITED_BEFORE_READY')); });
      child.on('message', message => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
          clearTimeout(timer); ready();
        }
      });
    });
    return owned;
  }
  async function kill(worker: OwnedWorker): Promise<void> {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    await worker.exited;
  }
  async function waitFor(input: WorkflowInput, check: (state: WorkflowStatus) => boolean): Promise<void> {
    assert.ok(env);
    const handle = env.client.workflow.getHandle(input.operationId);
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const state = await handle.query<WorkflowStatus>('status');
      if (check(state)) return;
      await sleep(50);
    }
    throw new Error('WORKFLOW_STATE_TIMEOUT');
  }
  // Register cleanup before creating schema/server/worker so failure paths are cleaned too.
  t.after(async () => {
    await Promise.all(workers.map(kill));
    if (env) await env.teardown();
    await pool.end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.end();
    await rm(dir, { recursive: true, force: true });
    await writeFile(join(reportDir, 'poc-results.json'), JSON.stringify({
      task: 'ZT01-01', commit: process.env.GITHUB_SHA ?? 'local',
      kind: 'real_temporal_and_postgresql_synthetic_business_effect',
      node: process.version, platform: process.platform, databaseVersion,
      temporalSdk: '1.24.0', temporalCli: '1.9.1', checks,
      liveModels: 'not_run', productionAcceptance: 'not_run',
    }, null, 2));
  });
  await admin.query('CREATE SCHEMA ' + schema);
  await pool.query(schemaSql);
  databaseVersion = (await pool.query('SHOW server_version')).rows[0].server_version;

  await step('concurrent duplicate requests create one operation and one outbox entry', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.submit(command('concurrent'))));
    assert.equal(new Set(results.map(r => r.operationId)).size, 1);
    assert.equal(results.filter(r => !r.reused).length, 1);
    const count = await pool.query('SELECT count(*) FROM outbox WHERE operation_id=$1', [results[0]!.operationId]);
    assert.equal(Number(count.rows[0].count), 1);
    await assert.rejects(store.submit({ ...command('concurrent'), specHash: 'b'.repeat(64) }), /IDEMPOTENCY_CONFLICT/);
    const other = await store.submit({ ...command('concurrent'), orgId: 'org_other' });
    assert.notEqual(other.operationId, results[0]!.operationId);
  });
  await step('business state and outbox roll back together', async () => {
    await assert.rejects(store.submit(command('rollback'), true), /INJECTED_TRANSACTION_FAILURE/);
    const result = await pool.query('SELECT count(*) FROM requests WHERE operation_id=$1', [operationId(command('rollback'))]);
    assert.equal(Number(result.rows[0].count), 0);
    assert.equal((await store.submit(command('rollback'))).reused, false);
  });

  env = await startServer();
  let worker = await startWorker();
  const waiting = await submit('restart');
  let firstRunId = '';
  await step('lost start acknowledgment is reconciled without a second workflow', async () => {
    assert.ok(env);
    await assert.rejects(dispatch(store, env.client, waiting, queue, true), /INJECTED_ACK_LOSS/);
    const handle = env.client.workflow.getHandle(waiting.operationId);
    firstRunId = (await handle.describe()).runId;
    await dispatch(store, env.client, waiting, queue);
    assert.equal((await handle.describe()).runId, firstRunId);
    assert.equal((await pool.query("SELECT dispatched FROM outbox WHERE operation_id=$1 AND kind='start'", [waiting.operationId])).rows[0].dispatched, true);
    await waitFor(waiting, s => s.phase === 'waiting');
    assert.equal(await effects(waiting.operationId), 0);
  });
  await step('a decision for a stale specification is rejected', async () => {
    await assert.rejects(store.decide({ ...waiting, specHash: 'b'.repeat(64) }, true), /STALE_APPROVAL/);
    assert.equal(await effects(waiting.operationId), 0);
  });
  await step('waiting survives worker SIGKILL and Temporal server restart with persisted history', async () => {
    assert.ok(env);
    await kill(worker);
    await env.teardown(); env = undefined;
    env = await startServer();
    const handle = env.client.workflow.getHandle(waiting.operationId);
    assert.equal((await handle.describe()).runId, firstRunId);
    await store.decide(waiting, true);
    // Signals are durably recorded while no Worker is running.
    await handle.signal('decisionAvailable');
    await handle.signal('decisionAvailable');
    worker = await startWorker();
    assert.equal(await handle.result(), 'completed');
    assert.equal(await effects(waiting.operationId), 1);
  });
  const crash = await submit('crash_after_commit');
  await step('committed effect survives worker crash and activity retry does not duplicate it', async () => {
    assert.ok(env);
    await kill(worker);
    await dispatch(store, env.client, crash, queue);
    await store.decide(crash, true);
    const handle = env.client.workflow.getHandle(crash.operationId);
    await handle.signal('decisionAvailable');
    const crashingWorker = await startWorker(true);
    assert.equal(await crashingWorker.exited, 'SIGKILL');
    assert.equal(await effects(crash.operationId), 1);
    worker = await startWorker();
    assert.equal(await handle.result(), 'completed');
    assert.equal(await effects(crash.operationId), 1);
    const attempts = Number((await pool.query('SELECT count FROM effect_attempts WHERE operation_id=$1', [crash.operationId])).rows[0].count);
    assert.ok(attempts >= 2, 'the activity must actually have retried');
  });
  await step('closed workflow start stays idempotent and history replays without activities', async () => {
    assert.ok(env);
    const handle = env.client.workflow.getHandle(crash.operationId);
    const runId = (await handle.describe()).runId;
    await dispatch(store, env.client, crash, queue);
    assert.equal((await handle.describe()).runId, runId);
    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath: require.resolve('./workflows') }, history);
    assert.equal(await effects(crash.operationId), 1);
    await writeFile(join(reportDir, 'history-summary.json'), JSON.stringify({ operationId: crash.operationId, runId, events: history.events?.length, replay: 'passed' }, null, 2));
  });
  await step('a signal is not approval; explicit denial cannot be overwritten', async () => {
    assert.ok(env);
    const input = await submit('deny');
    await dispatch(store, env.client, input, queue);
    const handle = env.client.workflow.getHandle(input.operationId);
    await handle.signal('decisionAvailable');
    await waitFor(input, s => s.phase === 'waiting' && s.processedSignals === 1);
    assert.equal(await effects(input.operationId), 0);
    await store.decide(input, false);
    await store.decide(input, false);
    await assert.rejects(store.decide(input, true), /DECISION_CONFLICT/);
    await handle.signal('decisionAvailable');
    assert.equal(await handle.result(), 'denied');
    assert.equal(await effects(input.operationId), 0);
  });
  await step('cancellation of a waiting workflow produces no business effect', async () => {
    assert.ok(env);
    const input = await submit('cancel');
    await dispatch(store, env.client, input, queue);
    await waitFor(input, s => s.phase === 'waiting');
    const handle = env.client.workflow.getHandle(input.operationId);
    await handle.cancel();
    await assert.rejects(handle.result(), error => error instanceof WorkflowFailedError && error.cause instanceof CancelledFailure);
    assert.equal(await effects(input.operationId), 0);
  });
});
