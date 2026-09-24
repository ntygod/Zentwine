import Fastify from 'fastify';
import { CONTRACT_VERSION, bootstrapSchema, errorSchema, type Bootstrap } from '@zentwine/contracts';
import { apiError, newTraceId } from '@zentwine/telemetry';
export interface AppOptions { now?: () => Date }
export function buildApp(options: AppOptions = {}) {
  const now = options.now ?? (() => new Date());
  const app = Fastify({ logger: false, bodyLimit: 16384, requestIdHeader: false, genReqId: newTraceId, ajv: { customOptions: { removeAdditional: false } } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('x-request-id', request.id);
    const host = request.headers.host;
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return reply.code(403).send(apiError('forbidden', 'Local development access only', request.id));
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send(apiError('forbidden', 'Cross-site access denied', request.id));
  });
  app.setErrorHandler((error, request, reply) => {
    // Fastify can receive an arbitrary thrown value. Narrow instead of casting away unknown.
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const inputError = status >= 400 && status < 500;
    reply.code(inputError ? 400 : 500).send(apiError(inputError ? 'invalid_input' : 'internal_error', inputError ? 'Invalid request' : 'Service error', request.id, !inputError));
  });
  app.setNotFoundHandler((request, reply) => {
    const isBusiness = request.url.startsWith('/api/v1/orgs/');
    reply.code(isBusiness ? 401 : 404).send(apiError(isBusiness ? 'unauthenticated' : 'unavailable_resource', isBusiness ? 'Identity is not configured' : 'Resource unavailable', request.id));
  });
  app.get('/livez', async () => ({ status: 'ok', service: 'zentwine-api' }));
  app.get('/readyz', async (_request, reply) => reply.code(503).send({ status: 'bootstrap_only', production_ready: false, reason: 'identity_persistence_and_execution_not_implemented' }));
  app.get('/api/v1/system/bootstrap', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} }, response: { 200: bootstrapSchema, 400: errorSchema } } }, async (): Promise<Bootstrap> => ({
    schema_version: CONTRACT_VERSION, product: 'Zentwine', mode: 'development-bootstrap', server_time: now().toISOString(),
    capabilities: { management_shell: true, studio_shell: true, identity: false, execution: false, persistence: false },
    runtimes: [{ id: 'claude', state: 'not_connected' }, { id: 'codex', state: 'not_connected' }]
  }));
  return app;
}
