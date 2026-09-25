import { isContextVersion, isIdentityId } from "@zentwine/domain";
import {
  PolicyError,
  type PolicyRepository,
  type PolicyScope,
  type PolicyRead,
} from "@zentwine/policy";
export type CatalogTool =
  | { operation: "catalog.read"; resource_id: string }
  | {
      operation: "catalog.rename";
      resource_id: string;
      display_name: string;
      expected_version: number;
      expected_policy_revision: number;
    };
export function parseCatalogTool(input: unknown): CatalogTool {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new PolicyError("invalid_input");
  const r = input as Record<string, unknown>;
  if (!isIdentityId(r["resource_id"])) throw new PolicyError("invalid_input");
  const required =
    r["operation"] === "catalog.read"
      ? ["operation", "resource_id"]
      : r["operation"] === "catalog.rename"
        ? [
            "operation",
            "resource_id",
            "display_name",
            "expected_version",
            "expected_policy_revision",
          ]
        : [];
  if (
    !required.length ||
    Object.keys(r).length !== required.length ||
    required.some((k) => !Object.hasOwn(r, k))
  )
    throw new PolicyError("invalid_input");
  if (
    r["operation"] === "catalog.rename" &&
    (typeof r["display_name"] !== "string" ||
      !r["display_name"].trim() ||
      r["display_name"].length > 120 ||
      /[\u0000-\u001f\u007f]/.test(r["display_name"]) ||
      !isContextVersion(r["expected_version"]) ||
      !isContextVersion(r["expected_policy_revision"]))
  )
    throw new PolicyError("invalid_input");
  return Object.freeze({ ...r }) as CatalogTool;
}
/** Called only by a trusted server adapter. Model tool arguments cannot select their identity or tenant. */
export function createCatalogTools(
  repository: PolicyRepository,
  scope: PolicyScope,
) {
  const bound = Object.freeze({ ...scope });
  return Object.freeze({
    async invoke(input: unknown): Promise<PolicyRead> {
      const command = parseCatalogTool(input);
      if (command.operation === "catalog.read")
        return repository.readResource(bound, command.resource_id);
      return repository.renameResource(
        bound,
        command.resource_id,
        command.display_name,
        command.expected_version,
        command.expected_policy_revision,
      );
    },
  });
}
