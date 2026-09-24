import Fastify from "fastify";
import {
  CONTRACT_VERSION,
  bootstrapSchema,
  errorSchema,
  type Bootstrap,
} from "@zentwine/contracts";
import { apiError, newTraceId } from "@zentwine/telemetry";

export interface AppOptions {
  now?: () => Date;
}

function errorStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  if (!("statusCode" in error) || typeof error.statusCode !== "number") {
    return 500;
  }
  return error.statusCode;
}

export function buildApp(options: AppOptions = {}) {
  const now = options.now ?? (() => new Date());
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    requestIdHeader: false,
    genReqId: newTraceId,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", request.id);
    const host = request.headers.host;
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      const body = apiError(
        "forbidden",
        "Local development access only",
        request.id,
      );
      return reply.code(403).send(body);
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      const body = apiError(
        "forbidden",
        "Cross-site access denied",
        request.id,
      );
      return reply.code(403).send(body);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = errorStatus(error);
    const inputError = status >= 400 && status < 500;
    const body = apiError(
      inputError ? "invalid_input" : "internal_error",
      inputError ? "Invalid request" : "Service error",
      request.id,
      !inputError,
    );
    reply.code(inputError ? 400 : 500).send(body);
  });
  app.setNotFoundHandler((request, reply) => {
    const isBusiness = request.url.startsWith("/api/v1/orgs/");
    const body = apiError(
      isBusiness ? "unauthenticated" : "unavailable_resource",
      isBusiness ? "Identity is not configured" : "Resource unavailable",
      request.id,
    );
    reply.code(isBusiness ? 401 : 404).send(body);
  });
  app.get("/livez", async () => ({ status: "ok", service: "zentwine-api" }));
  app.get("/readyz", async (_request, reply) => {
    const body = {
      status: "bootstrap_only",
      production_ready: false,
      reason: "identity_persistence_and_execution_not_implemented",
    };
    return reply.code(503).send(body);
  });
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
      server_time: now().toISOString(),
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
  return app;
}
