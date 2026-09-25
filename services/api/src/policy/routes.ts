import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  PolicyError,
  type PolicyRepository,
  type PolicyScope,
} from "@zentwine/policy";
import { AppError } from "@zentwine/telemetry";
import {
  errorSchema,
  identityOrgParams,
  policyParamsSchema,
  policyReadSchema,
  policyDecisionSchema,
  policyRequestSchema,
  policyRenameSchema,
} from "@zentwine/contracts";
import {
  readSessionCookie,
  secretDigest,
  verifyCsrf,
} from "../identity/security.js";
import { createCatalogTools } from "./tools.js";
export interface PolicyRoutesOptions {
  readonly repository: PolicyRepository;
  readonly origins: readonly string[];
}
export async function policyCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PolicyError) throw new AppError(e.code);
    if (e instanceof AppError) throw e;
    throw new AppError("unavailable");
  }
}
export function requestScope(r: FastifyRequest): PolicyScope {
  const token = readSessionCookie(r.headers.cookie);
  if (!token) throw new AppError("authentication_required");
  const v = r.headers["x-zentwine-context-version"];
  if (typeof v !== "string" || !/^[1-9][0-9]{0,9}$/.test(v))
    throw new AppError("invalid_input");
  return Object.freeze({
    session_digest: secretDigest(token),
    org_id: (r.params as { orgId: string }).orgId,
    context_version: Number(v),
  });
}
export async function registerPolicyRoutes(
  app: FastifyInstance,
  options: PolicyRoutesOptions,
): Promise<void> {
  const repo = options.repository,
    empty = { type: "object", additionalProperties: false, properties: {} },
    errors = {
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
      503: errorSchema,
    };
  app.addHook("onRequest", async (r) => {
    const origin = r.headers.origin;
    if (origin !== undefined && !options.origins.includes(origin))
      throw new AppError("forbidden");
    if (!["GET", "HEAD"].includes(r.method)) {
      if (
        !origin ||
        !options.origins.includes(origin) ||
        r.headers["x-zentwine-client"] !== "web"
      )
        throw new AppError("forbidden");
      if (
        r.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
      )
        throw new AppError("unsupported_media_type");
      const token = readSessionCookie(r.headers.cookie);
      if (!token) throw new AppError("authentication_required");
      verifyCsrf(token, r.headers["x-zentwine-csrf"]);
    }
  });
  app.post<{ Body: { resource_id: string; action: string } }>(
    "/api/v1/orgs/:orgId/policy/evaluate",
    {
      bodyLimit: 2048,
      schema: {
        params: identityOrgParams,
        body: policyRequestSchema,
        querystring: empty,
        response: { 200: policyDecisionSchema, ...errors },
      },
    },
    async (r) =>
      policyCall(() =>
        repo.evaluate(requestScope(r), r.body.resource_id, r.body.action),
      ),
  );
  app.get<{ Params: { orgId: string; resourceId: string } }>(
    "/api/v1/orgs/:orgId/resources/:resourceId",
    {
      schema: {
        params: policyParamsSchema,
        querystring: empty,
        response: { 200: policyReadSchema, ...errors },
      },
    },
    async (r) =>
      policyCall(() =>
        createCatalogTools(repo, requestScope(r)).invoke({
          operation: "catalog.read",
          resource_id: r.params.resourceId,
        }),
      ),
  );
  app.patch<{
    Params: { orgId: string; resourceId: string };
    Body: {
      display_name: string;
      expected_version: number;
      expected_policy_revision: number;
    };
  }>(
    "/api/v1/orgs/:orgId/resources/:resourceId",
    {
      bodyLimit: 2048,
      schema: {
        params: policyParamsSchema,
        body: policyRenameSchema,
        querystring: empty,
        response: { 200: policyReadSchema, ...errors },
      },
    },
    async (r) =>
      policyCall(() =>
        createCatalogTools(repo, requestScope(r)).invoke({
          operation: "catalog.rename",
          resource_id: r.params.resourceId,
          ...r.body,
        }),
      ),
  );
}
