import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  IdentityError,
  type IdentityRepository,
  type TenantContext,
} from "@zentwine/domain";
import { AppError } from "@zentwine/telemetry";
import {
  IDENTITY_VERSION,
  identitySessionSchema,
  tenantContextSchema,
  loginTicketSchema,
  selectOrgSchema,
  rotateSessionSchema,
  identityOrgParams,
  errorSchema,
} from "@zentwine/contracts";
import {
  secret,
  secretDigest,
  csrfFor,
  verifyCsrf,
  readSessionCookie,
  cookie,
  clearCookie,
  LoginLimiter,
} from "./security.js";
export interface IdentityRoutesOptions {
  readonly repository: IdentityRepository;
  readonly origins: readonly string[];
}
const emptyQuery = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const errors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  429: errorSchema,
  503: errorSchema,
};
/** Values live only in a request-keyed WeakMap, never a mutable global active tenant. */
export function createTenantMiddleware(repository: IdentityRepository) {
  const contexts = new WeakMap<FastifyRequest, TenantContext>();
  return {
    async preHandler(request: FastifyRequest) {
      const raw = readSessionCookie(request.headers.cookie);
      if (!raw) throw new AppError("authentication_required");
      const version = request.headers["x-zentwine-context-version"];
      if (typeof version !== "string" || !/^\d{1,10}$/.test(version))
        throw new AppError("invalid_input");
      const org = (request.params as { orgId: string }).orgId;
      const context = await translate(() =>
        repository.tenantContext(secretDigest(raw), org, Number(version)),
      );
      contexts.set(request, context);
    },
    context(request: FastifyRequest): TenantContext {
      const c = contexts.get(request);
      if (!c) throw new AppError("authentication_required");
      return c;
    },
  };
}
async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof IdentityError) throw new AppError(e.code);
    if (e instanceof AppError) throw e;
    throw new AppError("unavailable");
  }
}
/** All identity endpoints are encapsulated. No operator method is exported over HTTP. */
export async function registerIdentityRoutes(
  app: FastifyInstance,
  options: IdentityRoutesOptions,
): Promise<void> {
  const repo = options.repository;
  const limiter = new LoginLimiter();
  const tenants = createTenantMiddleware(repo);
  const token = (r: FastifyRequest): string => {
    const t = readSessionCookie(r.headers.cookie);
    if (!t) throw new AppError("authentication_required");
    return t;
  };
  app.addHook("onRequest", async (request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !options.origins.includes(origin))
      throw new AppError("forbidden");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (
        !origin ||
        !options.origins.includes(origin) ||
        request.headers["x-zentwine-client"] !== "web"
      )
        throw new AppError("forbidden");
      if (
        request.headers["content-type"]?.split(";")[0]?.trim() !==
        "application/json"
      )
        throw new AppError("unsupported_media_type");
      if (request.routeOptions.url !== "/api/v1/auth/login")
        verifyCsrf(token(request), request.headers["x-zentwine-csrf"]);
    }
  });
  app.post<{ Body: { ticket: string } }>(
    "/api/v1/auth/login",
    {
      bodyLimit: 1024,
      schema: {
        body: loginTicketSchema,
        querystring: emptyQuery,
        response: { 200: identitySessionSchema, ...errors },
      },
    },
    async (request, reply) => {
      limiter.take(request.ip);
      const next = secret();
      let prior: string | null = null;
      try {
        prior = readSessionCookie(request.headers.cookie);
      } catch {
        /* Successful login replaces an invalid cookie. */
      }
      let ticketHash: string;
      try {
        ticketHash = secretDigest(request.body.ticket);
      } catch {
        throw new AppError("invalid_login");
      }
      const session = await translate(() =>
        repo.consumeTicket(
          ticketHash,
          secretDigest(next),
          prior ? secretDigest(prior) : undefined,
        ),
      );
      reply.header("set-cookie", cookie(next));
      return {
        schema_version: IDENTITY_VERSION,
        session,
        csrf_token: csrfFor(next),
      };
    },
  );
  app.get(
    "/api/v1/auth/session",
    {
      schema: {
        querystring: emptyQuery,
        response: { 200: identitySessionSchema, ...errors },
      },
    },
    async (request) => {
      const t = token(request);
      return {
        schema_version: IDENTITY_VERSION,
        session: await translate(() => repo.readSession(secretDigest(t))),
        csrf_token: csrfFor(t),
      };
    },
  );
  app.post<{ Body: { org_id: string; expected_version: number } }>(
    "/api/v1/auth/organization",
    {
      schema: {
        body: selectOrgSchema,
        querystring: emptyQuery,
        response: { 200: identitySessionSchema, ...errors },
      },
    },
    async (request) => {
      const t = token(request);
      return {
        schema_version: IDENTITY_VERSION,
        session: await translate(() =>
          repo.selectOrganization(
            secretDigest(t),
            request.body.org_id,
            request.body.expected_version,
          ),
        ),
        csrf_token: csrfFor(t),
      };
    },
  );
  app.post<{ Body: { expected_version: number } }>(
    "/api/v1/auth/rotate",
    {
      schema: {
        body: rotateSessionSchema,
        querystring: emptyQuery,
        response: { 200: identitySessionSchema, ...errors },
      },
    },
    async (request, reply) => {
      const t = token(request),
        next = secret();
      const session = await translate(() =>
        repo.rotateSession(
          secretDigest(t),
          secretDigest(next),
          request.body.expected_version,
        ),
      );
      reply.header("set-cookie", cookie(next));
      return {
        schema_version: IDENTITY_VERSION,
        session,
        csrf_token: csrfFor(next),
      };
    },
  );
  app.post(
    "/api/v1/auth/logout",
    {
      schema: {
        body: emptyQuery,
        querystring: emptyQuery,
        response: { ...errors },
      },
    },
    async (request, reply) => {
      await translate(() => repo.revokeSession(secretDigest(token(request))));
      reply.header("set-cookie", clearCookie());
      reply.code(204).send();
    },
  );
  app.get(
    "/api/v1/orgs/:orgId/context",
    {
      preHandler: tenants.preHandler,
      schema: {
        params: identityOrgParams,
        querystring: emptyQuery,
        response: { 200: tenantContextSchema, ...errors },
      },
    },
    async (request) => ({
      schema_version: IDENTITY_VERSION,
      context: tenants.context(request),
    }),
  );
}
