import { registerApprovalRoutes } from "./approvals/routes.js";
import type { ApprovalRepository } from "@zentwine/policy";
import {
  registerAgentOwnerRoutes,
  registerAgentExecutionRoutes,
} from "./agents/routes.js";
import type { AgentRepository } from "@zentwine/policy";
import { registerPolicyRoutes } from "./policy/routes.js";
import { registerPolicySocket } from "./policy/socket.js";
import type { PolicyRepository } from "@zentwine/policy";
import Fastify, { type FastifyRequest } from "fastify";
import {
  CONTRACT_VERSION,
  bootstrapSchema,
  errorSchema,
  type Bootstrap,
} from "@zentwine/contracts";
import { parseServiceConfig, type ServiceConfig } from "@zentwine/config";
import {
  AppError,
  publicError,
  newTraceId,
  newSpanId,
  traceparent,
  TraceStore,
  SystemClock,
  SystemMonotonicClock,
  createLogger,
  type Clock,
  type MonotonicClock,
  type LogSink,
  type TraceContext,
} from "@zentwine/telemetry";
import {
  registerIdentityRoutes,
  type IdentityRoutesOptions,
} from "./identity/routes.js";
export interface AppOptions {
  identity?: IdentityRoutesOptions;
  policy?: PolicyRepository;
  agents?: AgentRepository;
  approvals?: ApprovalRepository;
  now?: () => Date;
  clock?: Clock;
  monotonicClock?: MonotonicClock;
  traces?: TraceStore;
  logSink?: LogSink;
  config?: ServiceConfig;
}
export function buildApp(options: AppOptions = {}) {
  const config = options.config ?? parseServiceConfig({});
  const clock =
    options.clock ?? (options.now ? { now: options.now } : new SystemClock());
  const monotonic = options.monotonicClock ?? new SystemMonotonicClock();
  const traces = options.traces ?? new TraceStore();
  const logger = createLogger({
    clock,
    traces,
    level: config.logging.level,
    ...(options.logSink ? { sink: options.logSink } : {}),
  });
  const requests = new WeakMap<
    FastifyRequest,
    { context: TraceContext; started: number }
  >();
  const app = Fastify({
    logger: false,
    bodyLimit: config.limits.bodyLimitBytes,
    requestTimeout: config.limits.requestTimeoutMs,
    requestIdHeader: false,
    genReqId: newTraceId,
    ajv: { customOptions: { removeAdditional: false } },
  });
  // Callback style is intentional: downstream continuations are created inside run().
  app.addHook("onRequest", (request, reply, done) => {
    const context: TraceContext = Object.freeze({
      traceId: request.id,
      spanId: newSpanId(),
      sampled: false,
    });
    requests.set(request, { context, started: monotonic.milliseconds() });
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", request.id);
    reply.header("traceparent", traceparent(context));
    // Ignore incoming x-request-id, traceparent, tracestate and baggage at public ingress.
    traces.run(context, done);
  });
  app.addHook("onRequest", async (request) => {
    const host = request.headers.host;
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
      throw new AppError("forbidden");
    if (request.headers["sec-fetch-site"] === "cross-site")
      throw new AppError("forbidden");
  });
  app.setErrorHandler((error, request, reply) => {
    const result = publicError(error, request.id);
    logger.log(result.status >= 500 ? "error" : "warn", "http.failed", {
      code: result.body.code,
      status: result.status,
    });
    reply.code(result.status).send(result.body);
  });
  app.addHook("onResponse", async (request, reply) => {
    const state = requests.get(request);
    if (!state) return;
    const elapsed = monotonic.milliseconds() - state.started;
    const method = [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ].includes(request.method)
      ? request.method
      : "OTHER";
    traces.run(state.context, () =>
      logger.log("info", "http.completed", {
        method,
        route: request.routeOptions.url ?? "(unmatched)",
        status: reply.statusCode,
        duration_ms: Math.max(0, Math.round(elapsed * 1000) / 1000),
      }),
    );
    requests.delete(request);
  });
  app.setNotFoundHandler((request, reply) => {
    const business = request.url.startsWith("/api/v1/orgs/");
    const result = publicError(
      new AppError(business ? "unauthenticated" : "unavailable_resource"),
      request.id,
    );
    reply.code(result.status).send(result.body);
  });
  app.get("/livez", async () => ({ status: "ok", service: "zentwine-api" }));
  app.get("/readyz", async (_request, reply) =>
    reply.code(503).send({
      status: "bootstrap_only",
      production_ready: false,
      reason: options.identity
        ? "local_identity_only_production_not_enabled"
        : "identity_persistence_and_execution_not_implemented",
    }),
  );
  app.get(
    "/api/v1/system/bootstrap",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        response: { 200: bootstrapSchema, 400: errorSchema },
      },
    },
    async (): Promise<Bootstrap> => ({
      schema_version: CONTRACT_VERSION,
      product: "Zentwine",
      mode: "development-bootstrap",
      server_time: clock.now().toISOString(),
      capabilities: {
        management_shell: true,
        studio_shell: true,
        identity: false,
        execution: false,
        persistence: false,
      },
      runtimes: [
        { id: "claude", state: "not_connected" },
        { id: "codex", state: "not_connected" },
      ],
    }),
  );
  if (options.identity) app.register(registerIdentityRoutes, options.identity);
  if (options.policy) {
    if (!options.identity) throw new AppError("invalid_input");
    const policyOptions = {
      repository: options.policy,
      origins: options.identity.origins,
    };
    app.register(registerPolicyRoutes, policyOptions);
    registerPolicySocket(app, policyOptions);
  }
  if (options.agents) {
    if (!options.identity || !options.policy)
      throw new AppError("invalid_input");
    const agentOptions = {
      repository: options.agents,
      origins: options.identity.origins,
    };
    app.register(registerAgentOwnerRoutes, agentOptions);
    app.register(registerAgentExecutionRoutes, agentOptions);
  }
  if (options.approvals) {
    if (!options.identity || !options.policy || !options.agents)
      throw new AppError("invalid_input");
    app.register(registerApprovalRoutes, {
      repository: options.approvals,
      origins: options.identity.origins,
    });
  }
  return app;
}
