import type { FastifyInstance } from "fastify";
import {
  OrganizationError,
  type EmergencyInput,
  type OrganizationRepository,
  type OrganizationAuditQuery,
  type SettingsInput,
  type InvitationInput,
  type ConnectionInput,
  type MemberRole,
  type ProvisioningInput,
} from "@zentwine/domain";
import {
  organizationEmpty,
  emergencyInputSchema,
  emergencyStateSchema,
  emergencyResultSchema,
  organizationAuditQuerySchema,
  organizationAuditPageSchema,
  organizationSettingsInput,
  organizationSettingsSchema,
  organizationMemberSchema,
  organizationMemberUpdate,
  organizationInvitationInput,
  organizationInvitationSchema,
  organizationConnectionInput,
  organizationConnectionSchema,
  organizationVersionInput,
  organizationSessionRevoke,
  organizationAcceptInput,
  organizationProvisioningInput,
  organizationIdParams,
  organizationConnectionParams,
  organizationSearchQuery,
  identityOrgParams,
} from "@zentwine/contracts";
import { AppError } from "@zentwine/telemetry";
import {
  secret,
  secretDigest,
  readSessionCookie,
  verifyCsrf,
  cookie,
  LoginLimiter,
} from "../identity/security.js";
import { requestScope } from "../policy/routes.js";
export interface OrganizationRoutesOptions {
  repository: OrganizationRepository;
  origins: readonly string[];
}
const call = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OrganizationError) throw new AppError(e.code);
    if (e instanceof AppError) throw e;
    throw new AppError("unavailable");
  }
};
export async function registerOrganizationRoutes(
  app: FastifyInstance,
  o: OrganizationRoutesOptions,
): Promise<void> {
  const limiter = new LoginLimiter();
  app.addHook("onRequest", async (r) => {
    if (r.headers.authorization !== undefined) throw new AppError("forbidden");
    if (r.headers.origin !== undefined && !o.origins.includes(r.headers.origin))
      throw new AppError("forbidden");
    if (!["GET", "HEAD"].includes(r.method)) {
      if (
        !o.origins.includes(r.headers.origin ?? "") ||
        r.headers["x-zentwine-client"] !== "web"
      )
        throw new AppError("forbidden");
      if (
        r.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
      )
        throw new AppError("unsupported_media_type");
      const t = readSessionCookie(r.headers.cookie);
      if (!t) throw new AppError("authentication_required");
      verifyCsrf(t, r.headers["x-zentwine-csrf"]);
      limiter.take(r.ip);
    }
  });
  app.get<{ Params: { orgId: string; memberId: string } }>(
    "/api/v1/orgs/:orgId/members/:memberId/emergency-access",
    {
      schema: {
        params: organizationIdParams("memberId"),
        querystring: organizationEmpty,
        response: { 200: emergencyStateSchema },
      },
    },
    (r) =>
      call(() =>
        o.repository.emergencyState(requestScope(r), r.params.memberId),
      ),
  );
  app.post<{
    Params: { orgId: string; memberId: string };
    Body: EmergencyInput;
  }>(
    "/api/v1/orgs/:orgId/members/:memberId/emergency-access",
    {
      bodyLimit: 1024,
      schema: {
        params: organizationIdParams("memberId"),
        querystring: organizationEmpty,
        body: emergencyInputSchema,
        response: { 200: emergencyResultSchema },
      },
    },
    (r) =>
      call(() =>
        o.repository.emergencyChange(
          requestScope(r),
          r.params.memberId,
          r.body,
        ),
      ),
  );
  app.get<{ Querystring: OrganizationAuditQuery }>(
    "/api/v1/orgs/:orgId/audit-events",
    {
      schema: {
        params: identityOrgParams,
        querystring: organizationAuditQuerySchema,
        response: { 200: organizationAuditPageSchema },
      },
    },
    (r) => call(() => o.repository.audit(requestScope(r), r.query)),
  );
  app.get(
    "/api/v1/orgs/:orgId/settings",
    {
      schema: {
        params: identityOrgParams,
        querystring: organizationEmpty,
        response: { 200: organizationSettingsSchema },
      },
    },
    (r) => call(() => o.repository.settings(requestScope(r))),
  );
  app.patch<{ Body: SettingsInput }>(
    "/api/v1/orgs/:orgId/settings",
    {
      bodyLimit: 2048,
      schema: {
        params: identityOrgParams,
        querystring: organizationEmpty,
        body: organizationSettingsInput,
        response: { 200: organizationSettingsSchema },
      },
    },
    (r) => call(() => o.repository.updateSettings(requestScope(r), r.body)),
  );
  app.get(
    "/api/v1/orgs/:orgId/organization-self",
    {
      schema: {
        params: identityOrgParams,
        querystring: organizationEmpty,
        response: { 200: organizationMemberSchema },
      },
    },
    (r) => call(() => o.repository.self(requestScope(r))),
  );
  app.get(
    "/api/v1/orgs/:orgId/members",
    {
      schema: {
        params: identityOrgParams,
        querystring: organizationEmpty,
        response: {
          200: {
            type: "array",
            maxItems: 200,
            items: organizationMemberSchema,
          },
        },
      },
    },
    (r) => call(() => o.repository.members(requestScope(r))),
  );
  app.patch<{
    Params: { orgId: string; memberId: string };
    Body: {
      role: MemberRole;
      status: "active" | "revoked";
      expected_version: number;
    };
  }>(
    "/api/v1/orgs/:orgId/members/:memberId",
    {
      schema: {
        params: organizationIdParams("memberId"),
        querystring: organizationEmpty,
        body: organizationMemberUpdate,
        response: { 200: organizationMemberSchema },
      },
    },
    (r) =>
      call(() =>
        o.repository.updateMember(
          requestScope(r),
          r.params.memberId,
          r.body.role,
          r.body.status,
          r.body.expected_version,
        ),
      ),
  );
  app.post<{ Body: { human_id: string } }>(
    "/api/v1/orgs/:orgId/sessions/revoke",
    {
      schema: {
        params: identityOrgParams,
        body: organizationSessionRevoke,
        querystring: organizationEmpty,
      },
    },
    async (r, reply) => {
      await call(() =>
        o.repository.revokeOrganizationSessions(
          requestScope(r),
          r.body.human_id,
        ),
      );
      reply.code(204).send();
    },
  );
  app.get(
    "/api/v1/orgs/:orgId/invitations",
    {
      schema: {
        params: identityOrgParams,
        querystring: organizationEmpty,
        response: {
          200: {
            type: "array",
            maxItems: 100,
            items: organizationInvitationSchema,
          },
        },
      },
    },
    (r) => call(() => o.repository.invitations(requestScope(r))),
  );
  app.post<{ Body: InvitationInput }>(
    "/api/v1/orgs/:orgId/invitations",
    {
      bodyLimit: 4096,
      schema: {
        params: identityOrgParams,
        querystring: organizationEmpty,
        body: organizationInvitationInput,
      },
    },
    async (r) => {
      const token = secret(),
        result = await call(() =>
          o.repository.invite(requestScope(r), r.body, secretDigest(token)),
        );
      return {
        ...result,
        invitation_token: result.credential_issued ? token : null,
      };
    },
  );
  app.post<{
    Params: { orgId: string; invitationId: string };
    Body: { expected_version: number };
  }>(
    "/api/v1/orgs/:orgId/invitations/:invitationId/revoke",
    {
      schema: {
        params: organizationIdParams("invitationId"),
        querystring: organizationEmpty,
        body: organizationVersionInput,
        response: { 200: organizationInvitationSchema },
      },
    },
    (r) =>
      call(() =>
        o.repository.revokeInvitation(
          requestScope(r),
          r.params.invitationId,
          r.body.expected_version,
        ),
      ),
  );
  app.post<{ Body: { invitation_token: string } }>(
    "/api/v1/auth/invitations/accept",
    {
      bodyLimit: 1024,
      schema: { querystring: organizationEmpty, body: organizationAcceptInput },
    },
    async (r, reply) => {
      const t = readSessionCookie(r.headers.cookie);
      if (!t) throw new AppError("authentication_required");
      const next = secret();
      const result = await call(() =>
        o.repository.acceptInvitation(
          secretDigest(t),
          secretDigest(r.body.invitation_token),
          secretDigest(next),
        ),
      );
      reply.header("set-cookie", cookie(next));
      return result;
    },
  );
  app.get<{ Querystring: { q: string } }>(
    "/api/v1/orgs/:orgId/catalog/search",
    {
      schema: {
        params: identityOrgParams,
        querystring: organizationSearchQuery,
      },
    },
    (r) => call(() => o.repository.search(requestScope(r), r.query.q)),
  );
  app.get(
    "/api/v1/orgs/:orgId/identity-connections",
    {
      schema: {
        params: identityOrgParams,
        querystring: organizationEmpty,
        response: {
          200: {
            type: "array",
            maxItems: 20,
            items: organizationConnectionSchema,
          },
        },
      },
    },
    (r) => call(() => o.repository.connections(requestScope(r))),
  );
  app.put<{
    Params: { orgId: string; connectionId: string };
    Body: ConnectionInput;
  }>(
    "/api/v1/orgs/:orgId/identity-connections/:connectionId",
    {
      bodyLimit: 2048,
      schema: {
        params: organizationIdParams("connectionId"),
        querystring: organizationEmpty,
        body: organizationConnectionInput,
        response: { 200: organizationConnectionSchema },
      },
    },
    (r) =>
      call(() =>
        o.repository.configureConnection(
          requestScope(r),
          r.params.connectionId,
          r.body,
        ),
      ),
  );
}
/** Normalized SCIM adapter port. Not a claim of a complete SCIM RFC7644 wire implementation. */
export async function registerProvisioningRoutes(
  app: FastifyInstance,
  o: OrganizationRoutesOptions,
): Promise<void> {
  const limiter = new LoginLimiter();
  app.addHook("onRequest", async (r) => {
    limiter.take(r.ip);
    if (r.headers.cookie !== undefined || r.headers.origin !== undefined)
      throw new AppError("forbidden");
    if (r.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
      throw new AppError("unsupported_media_type");
  });
  app.post<{ Params: { connectionId: string }; Body: ProvisioningInput }>(
    "/api/v1/idp/connections/:connectionId/provisioning",
    {
      bodyLimit: 2048,
      schema: {
        params: organizationConnectionParams,
        querystring: organizationEmpty,
        body: organizationProvisioningInput,
      },
    },
    async (r) => {
      const authorization = r.headers.authorization;
      if (
        typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
      )
        throw new AppError("authentication_required");
      return call(() =>
        o.repository.provision(
          r.params.connectionId,
          secretDigest(authorization.slice(7)),
          r.body,
        ),
      );
    },
  );
}
