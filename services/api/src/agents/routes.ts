import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DelegationError,
  type AgentRepository,
  type DelegationRequest,
  type AgentToolRequest,
} from "@zentwine/policy";
import {
  agentParamsSchema,
  delegationParamsSchema,
  agentRegisterSchema,
  agentExpectedSchema,
  delegationRequestSchema,
  agentToolSchema,
  identityOrgParams,
} from "@zentwine/contracts";
import { AppError } from "@zentwine/telemetry";
import {
  secret,
  secretDigest,
  verifyCsrf,
  readSessionCookie,
  LoginLimiter,
} from "../identity/security.js";
import { requestScope } from "../policy/routes.js";
import { createAgentTools } from "./tools.js";
export interface AgentRoutesOptions {
  readonly repository: AgentRepository;
  readonly origins: readonly string[];
}
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DelegationError)
      throw new AppError(e.code === "budget_exhausted" ? "forbidden" : e.code);
    if (e instanceof AppError) throw e;
    throw new AppError("unavailable");
  }
}
function bearer(r: FastifyRequest) {
  const value = r.headers.authorization;
  if (
    typeof value !== "string" ||
    !/^Bearer zt_agent_[A-Za-z0-9_-]{43}$/.test(value)
  )
    throw new AppError("authentication_required");
  return {
    credential_digest: secretDigest(value.slice("Bearer zt_agent_".length)),
  };
}
const empty = { type: "object", additionalProperties: false, properties: {} };
/** Public local human controller. Only the authenticated human can register and delegate their own authority. */
export async function registerAgentOwnerRoutes(
  app: FastifyInstance,
  o: AgentRoutesOptions,
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
      limiter.take(r.ip);
    }
  });
  app.post<{ Body: { request_id: string; display_name: string } }>(
    "/api/v1/orgs/:orgId/agents",
    {
      bodyLimit: 2048,
      schema: {
        params: identityOrgParams,
        body: agentRegisterSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(() =>
        o.repository.register(
          requestScope(r),
          r.body.request_id,
          r.body.display_name,
        ),
      ),
  );
  app.post<{
    Params: { orgId: string; agentId: string };
    Body: { expected_version: number };
  }>(
    "/api/v1/orgs/:orgId/agents/:agentId/disable",
    {
      bodyLimit: 1024,
      schema: {
        params: agentParamsSchema,
        body: agentExpectedSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(() =>
        o.repository.disable(
          requestScope(r),
          r.params.agentId,
          r.body.expected_version,
        ),
      ),
  );
  app.post<{ Body: DelegationRequest }>(
    "/api/v1/orgs/:orgId/delegations",
    {
      bodyLimit: 16384,
      schema: {
        params: identityOrgParams,
        body: delegationRequestSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(async () => {
        const token = secret(),
          result = await o.repository.issueRoot(
            requestScope(r),
            r.body,
            secretDigest(token),
          );
        return {
          ...result,
          credential: result.created ? "zt_agent_" + token : null,
          credential_recoverable: false,
        };
      }),
  );
  app.get<{ Params: { orgId: string; delegationId: string } }>(
    "/api/v1/orgs/:orgId/delegations/:delegationId",
    { schema: { params: delegationParamsSchema, querystring: empty } },
    async (r) =>
      call(() =>
        o.repository.inspectOwned(requestScope(r), r.params.delegationId),
      ),
  );
  app.post<{
    Params: { orgId: string; delegationId: string };
    Body: { expected_version: number };
  }>(
    "/api/v1/orgs/:orgId/delegations/:delegationId/revoke",
    {
      bodyLimit: 1024,
      schema: {
        params: delegationParamsSchema,
        body: agentExpectedSchema,
        querystring: empty,
      },
    },
    async (r) =>
      call(() =>
        o.repository.revoke(
          requestScope(r),
          r.params.delegationId,
          r.body.expected_version,
        ),
      ),
  );
}
/** Local machine-to-machine endpoint, not a browser API. Bearer never accepted in URL or Cookie. */
export async function registerAgentExecutionRoutes(
  app: FastifyInstance,
  o: AgentRoutesOptions,
): Promise<void> {
  const limiter = new LoginLimiter();
  app.addHook("onRequest", async (r) => {
    if (
      r.headers.origin !== undefined ||
      r.headers.cookie !== undefined ||
      r.headers["sec-fetch-site"] !== undefined
    )
      throw new AppError("forbidden");
    bearer(r);
    limiter.take(r.ip);
    if (
      r.method === "POST" &&
      r.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
    )
      throw new AppError("unsupported_media_type");
  });
  app.get("/api/v1/agent/self", { schema: { querystring: empty } }, async (r) =>
    call(() => o.repository.inspect(bearer(r))),
  );
  app.post<{ Body: DelegationRequest }>(
    "/api/v1/agent/delegate",
    {
      bodyLimit: 16384,
      schema: { body: delegationRequestSchema, querystring: empty },
    },
    async (r) =>
      call(async () => {
        const token = secret(),
          result = await o.repository.delegate(
            bearer(r),
            r.body,
            secretDigest(token),
          );
        return {
          ...result,
          credential: result.created ? "zt_agent_" + token : null,
          credential_recoverable: false,
        };
      }),
  );
  app.post<{ Body: AgentToolRequest }>(
    "/api/v1/agent/tools",
    { bodyLimit: 4096, schema: { body: agentToolSchema, querystring: empty } },
    async (r) =>
      call(() => createAgentTools(o.repository, bearer(r)).invoke(r.body)),
  );
}
