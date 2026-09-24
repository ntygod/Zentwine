import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { Store, poolFor } from './store';
import type { Activities } from './model';

async function main(): Promise<void> {
  if (process.env.POC_WORKER !== '1') throw new Error('EXPERIMENT_WORKER_ONLY');
  Runtime.install({ logger: new DefaultLogger('WARN') });
  const pool = poolFor(process.env.POC_SCHEMA ?? '');
  const store = new Store(pool);
  const connection = await NativeConnection.connect({ address: process.env.POC_TEMPORAL_ADDRESS });
  try {
    const activities: Activities = {
      async applyApprovedEffect(input) {
        const result = await store.apply(input);
        if (result.inserted && process.env.POC_CRASH_AFTER_COMMIT === '1') {
          // Kill this owned child AFTER commit and BEFORE Temporal receives the Activity result.
          process.kill(process.pid, 'SIGKILL');
          await new Promise<never>(() => {});
        }
        return result.result;
      },
    };
    const worker = await Worker.create({
      connection, taskQueue: process.env.POC_TASK_QUEUE ?? 'invalid',
      workflowsPath: require.resolve('./workflows'), activities,
      maxCachedWorkflows: 0, shutdownGraceTime: '1 second',
    });
    process.send?.({ type: 'ready' });
    await worker.run();
  } finally { await connection.close(); await pool.end(); }
}
main().catch(error => {
  // Do not print connection strings or arbitrary exception details.
  console.error('POC_WORKER_FAILED', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
});
