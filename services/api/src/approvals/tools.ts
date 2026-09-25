import {
  ApprovalError,
  validateApprovalExecution,
  type ApprovalRepository,
  type PolicyScope,
  type ApprovalExecution,
} from "@zentwine/policy";
/** Internal server adapter; scope and digest belong to the trusted gateway, never to model arguments. */
export function createApprovedCatalogTool(
  repo: ApprovalRepository,
  scope: PolicyScope,
  approvalId: string,
  permitDigest: string,
) {
  const bound = Object.freeze({ ...scope });
  return Object.freeze({
    async invoke(input: ApprovalExecution) {
      if (!input || input.operation !== "catalog.rename")
        throw new ApprovalError("invalid_input");
      validateApprovalExecution(input);
      return repo.execute(bound, approvalId, input, permitDigest);
    },
  });
}
