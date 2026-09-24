// This file may be imported into Temporal's deterministic workflow sandbox.
export interface StartCommand {
  orgId: string;
  actorId: string;
  commandType: 'poc.run';
  idempotencyKey: string;
  specHash: string;
}
export interface WorkflowInput { operationId: string; specHash: string }
export type EffectResult = 'pending' | 'denied' | 'completed';
export interface Activities {
  applyApprovedEffect(input: WorkflowInput): Promise<EffectResult>;
}
export interface WorkflowStatus {
  phase: 'waiting' | 'checking' | 'completed' | 'denied';
  signalsSeen: number;
  processedSignals: number;
}
