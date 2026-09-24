import { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/common';
import { Store } from './store';
import type { WorkflowInput } from './model';

export async function dispatch(store: Store, client: Client, input: WorkflowInput, taskQueue: string, loseAcknowledgement = false): Promise<void> {
  const request = (await store.pool.query('SELECT spec_hash FROM requests WHERE operation_id=$1', [input.operationId])).rows[0];
  if (!request || request.spec_hash !== input.specHash) throw new Error('STALE_DISPATCH');
  try {
    await client.workflow.start('approvalWorkflow', {
      workflowId: input.operationId, taskQueue, args: [input],
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowExecutionTimeout: '3 minutes',
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    // Reconcile the existing remote workflow; never allocate a replacement ID on timeout.
    const existing = await client.workflow.getHandle(input.operationId).describe();
    if (existing.type !== 'approvalWorkflow') throw new Error('REMOTE_OPERATION_MISMATCH');
  }
  if (loseAcknowledgement) throw new Error('INJECTED_ACK_LOSS');
  await store.pool.query("UPDATE outbox SET dispatched=true WHERE operation_id=$1 AND kind='start'", [input.operationId]);
}
