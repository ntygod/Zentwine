import {
  validateToolRequest,
  type AgentRepository,
  type AgentCredentialScope,
  type AgentToolRequest,
} from "@zentwine/policy";
/** Trusted adapter binds exactly one credential. Model input cannot pick its owner or delegation. */
export function createAgentTools(
  repository: AgentRepository,
  scope: AgentCredentialScope,
) {
  const bound = Object.freeze({ ...scope });
  return Object.freeze({
    async invoke(input: unknown) {
      validateToolRequest(input as AgentToolRequest);
      return repository.invoke(bound, input as AgentToolRequest);
    },
  });
}
