import type { FastifyInstance } from "fastify";
import {
  ApprovalError,
  type ApprovalRepository,
  type ApprovalInput,
  type ApprovalGuard,
  type ApprovalExecution,
} from "@zentwine/policy";
import {
  approvalParamsSchema,
  approvalInputSchema,
  approvalGuardSchema,
  approvalDecisionInputSchema,
  approvalExecuteSchema,
  approvalEventsQuerySchema,
  identityOrgParams,
} from "@zentwine/contracts";
import { AppError } from "@zentwine/telemetry";
import {
  secret,
  secretDigest,
  readSessionCookie,
  verifyCsrf,
  LoginLimiter,
} from "../identity/security.js";
import { requestScope } from "../policy/routes.js";
export interface ApprovalRoutesOptions {
  repository: ApprovalRepository;
  origins: readonly string[];
}
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApprovalError) throw new AppError(e.code);
    if (e instanceof AppError) throw e;
    throw new AppError("unavailable");
  }
}
const empty = { type: "object", additionalProperties: false, properties: {} };
/** Approval credentials are human-subject-bound and cannot mint broader Agent delegations. */
export async function registerApprovalRoutes(
  app: FastifyInstance,
  o: ApprovalRoutesOptions,
): Promise<void> {
  const limiter = new LoginLimiter();
  app.addHook("onRequest", async (r) => {
    if (r.headers.authorization !== undefined) throw new AppError("forbidden");
    const origin = r.headers.origin;
    if (origin !== undefined && !o.origins.includes(origin))
      throw new AppError("forbidden");
    if (!["GET", "HEAD"].includes(r.method)) {
      if (
        !origin ||
        !o.origins.includes(origin) ||
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
    limiter.take(r.ip);
  });
  app.post<{ Body: ApprovalInput }>(
    "/api/v1/orgs/:orgId/approvals",
    {
      bodyLimit: 4096,
      schema: {
        params: identityOrgParams,
        body: approvalInputSchema,
        querystring: empty,
      },
    },
    async (r) => call(() => o.repository.request(requestScope(r), r.body)),
  );
  app.get<{ Querystring: { after: string; limit: number } }>(
    "/api/v1/orgs/:orgId/approval-events",
    {
      schema: {
        params: identityOrgParams,
        querystring: approvalEventsQuerySchema,
      },
    },
    async (r) =>
      call(() =>
        o.repository.events(requestScope(r), r.query.after, r.query.limit),
      ),
  );
  app.get<{ Params: { orgId: string; approvalId: string } }>(
    "/api/v1/orgs/:orgId/approvals/:approvalId",
    { schema: { params: approvalParamsSchema, querystring: empty } },
    async (r) =>
      call(() => o.repository.inspect(requestScope(r), r.params.approvalId)),
  );
  app.post<{
    Params: { orgId: string; approvalId: string };
    Body: ApprovalGuard & { outcome: "approve" | "reject" };
  }>(
    "/api/v1/orgs/:orgId/approvals/:approvalId/decide",
    {
      bodyLimit: 2048,
      schema: {
        params: approvalParamsSchema,
        body: approvalDecisionInputSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(() =>
        o.repository.decide(
          requestScope(r),
          r.params.approvalId,
          {
            expected_version: r.body.expected_version,
            content_hash: r.body.content_hash,
          },
          r.body.outcome,
        ),
      ),
  );
  app.post<{
    Params: { orgId: string; approvalId: string };
    Body: ApprovalGuard;
  }>(
    "/api/v1/orgs/:orgId/approvals/:approvalId/permit",
    {
      bodyLimit: 2048,
      schema: {
        params: approvalParamsSchema,
        body: approvalGuardSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(async () => {
        const token = secret(),
          result = await o.repository.issuePermit(
            requestScope(r),
            r.params.approvalId,
            r.body,
            secretDigest(token),
          );
        return {
          ...result,
          permit: "zt_permit_" + token,
          credential_recoverable: false,
        };
      }),
  );
  app.post<{
    Params: { orgId: string; approvalId: string };
    Body: ApprovalExecution & { permit: string };
  }>(
    "/api/v1/orgs/:orgId/approvals/:approvalId/execute",
    {
      bodyLimit: 4096,
      schema: {
        params: approvalParamsSchema,
        body: approvalExecuteSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(() => {
        const { permit, ...input } = r.body;
        return o.repository.execute(
          requestScope(r),
          r.params.approvalId,
          input,
          secretDigest(permit.slice("zt_permit_".length)),
        );
      }),
  );
  app.post<{
    Params: { orgId: string; approvalId: string };
    Body: ApprovalGuard;
  }>(
    "/api/v1/orgs/:orgId/approvals/:approvalId/revoke",
    {
      bodyLimit: 2048,
      schema: {
        params: approvalParamsSchema,
        body: approvalGuardSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(() =>
        o.repository.revoke(requestScope(r), r.params.approvalId, r.body),
      ),
  );
}
