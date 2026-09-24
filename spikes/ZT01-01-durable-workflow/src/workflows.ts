import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Activities, WorkflowInput, WorkflowStatus, EffectResult } from './model';

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '5 seconds', scheduleToCloseTimeout: '60 seconds',
  retry: { initialInterval: '500 milliseconds', maximumInterval: '2 seconds', maximumAttempts: 5 },
});
export const decisionAvailable = defineSignal('decisionAvailable');
export const statusQuery = defineQuery<WorkflowStatus>('status');

export async function approvalWorkflow(input: WorkflowInput): Promise<EffectResult> {
  const state: WorkflowStatus = { phase: 'waiting', signalsSeen: 0, processedSignals: 0 };
  setHandler(decisionAvailable, () => { state.signalsSeen += 1; });
  setHandler(statusQuery, () => ({ ...state }));
  while (true) {
    // Durable wait: no polling model and no permanently occupied Activity.
    await condition(() => state.signalsSeen > state.processedSignals);
    state.processedSignals = state.signalsSeen;
    state.phase = 'checking';
    // A signal only wakes the workflow. PostgreSQL holds the approved business decision.
    const result = await activities.applyApprovedEffect(input);
    if (result === 'pending') { state.phase = 'waiting'; continue; }
    state.phase = result;
    return result;
  }
}
