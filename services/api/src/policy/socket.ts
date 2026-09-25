import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { isContextVersion, isIdentityId } from "@zentwine/domain";
import { PolicyError, type PolicyScope } from "@zentwine/policy";
import { AppError, publicError, newTraceId } from "@zentwine/telemetry";
import {
  readSessionCookie,
  secretDigest,
  verifyCsrf,
} from "../identity/security.js";
import { createCatalogTools } from "./tools.js";
import { policyCall, type PolicyRoutesOptions } from "./routes.js";
/** Real WebSocket transport, bound to one authenticated scope. No push/subscription replay or model execution yet. */
export function registerPolicySocket(
  app: FastifyInstance,
  options: PolicyRoutesOptions,
): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false,
    maxFragments: 16,
    maxBufferedChunks: 32,
  });
  const rawSockets = new Set<Duplex>(),
    sessions = new Map<string, number>();
  let closing = false;
  wss.on("error", () => {});
  const upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    socket.on("error", () => {});
    if (closing || rawSockets.size >= 32) {
      socket.destroy();
      return;
    }
    rawSockets.add(socket);
    let sessionKey: string | undefined;
    socket.once("close", () => {
      rawSockets.delete(socket);
      if (sessionKey) {
        const n = (sessions.get(sessionKey) ?? 1) - 1;
        if (n > 0) sessions.set(sessionKey, n);
        else sessions.delete(sessionKey);
      }
    });
    const timer = setTimeout(() => socket.destroy(), 5000).unref();
    void (async () => {
      if (
        request.method !== "GET" ||
        !request.url?.startsWith("/") ||
        request.url.startsWith("//") ||
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? "") ||
        !options.origins.includes(request.headers.origin ?? "") ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        request.headers["sec-websocket-protocol"]
      )
        throw new AppError("forbidden");
      const url = new URL(request.url, "http://127.0.0.1");
      const keys = [...url.searchParams.keys()];
      if (
        url.pathname !== "/api/v1/policy/socket" ||
        keys.length !== 2 ||
        !keys.includes("org_id") ||
        !keys.includes("context_version")
      )
        throw new AppError("invalid_input");
      const org = url.searchParams.get("org_id"),
        v = url.searchParams.get("context_version");
      if (
        !isIdentityId(org) ||
        !v ||
        !/^[1-9][0-9]{0,9}$/.test(v) ||
        !isContextVersion(Number(v))
      )
        throw new AppError("invalid_input");
      const token = readSessionCookie(request.headers.cookie);
      if (!token) throw new AppError("authentication_required");
      const scope: PolicyScope = Object.freeze({
        session_digest: secretDigest(token),
        org_id: org,
        context_version: Number(v),
      });
      if ((sessions.get(scope.session_digest) ?? 0) >= 4)
        throw new AppError("rate_limited");
      sessionKey = scope.session_digest;
      sessions.set(sessionKey, (sessions.get(sessionKey) ?? 0) + 1);
      await policyCall(() => options.repository.validateScope(scope));
      if (socket.destroyed || closing) return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        const tools = createCatalogTools(options.repository, scope);
        let busy = false,
          count = 0,
          windowStart = performance.now();
        let idle = setTimeout(() => ws.terminate(), 5000).unref();
        const recheck = setInterval(() => {
          void options.repository
            .validateScope(scope)
            .catch(() => ws.terminate());
        }, 10000).unref();
        ws.on("close", () => {
          clearTimeout(idle);
          clearInterval(recheck);
        });
        ws.on("error", () => ws.terminate());
        ws.on("message", (data, binary) => {
          if (busy || binary || ws.bufferedAmount > 32768) {
            ws.terminate();
            return;
          }
          if (performance.now() - windowStart > 60000) {
            count = 0;
            windowStart = performance.now();
          }
          if (++count > 60) {
            ws.terminate();
            return;
          }
          busy = true;
          clearTimeout(idle);
          idle = setTimeout(() => ws.terminate(), 30000).unref();
          void (async () => {
            let payload: unknown;
            try {
              payload = JSON.parse(data.toString("utf8"));
            } catch {
              throw new AppError("invalid_input");
            }
            if (
              !payload ||
              typeof payload !== "object" ||
              Array.isArray(payload)
            )
              throw new AppError("invalid_input");
            const { csrf_token, ...command } = payload as Record<
              string,
              unknown
            >;
            verifyCsrf(token, csrf_token);
            const result = await policyCall(() => tools.invoke(command));
            if (ws.readyState === 1)
              ws.send(JSON.stringify({ type: "result", ...result }));
          })()
            .catch((e: unknown) => {
              const error =
                e instanceof PolicyError
                  ? new AppError(e.code)
                  : e instanceof AppError
                    ? e
                    : new AppError("unavailable");
              const response = publicError(error, newTraceId());
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "error", ...response.body }));
                if (
                  [
                    "authentication_required",
                    "unavailable_resource",
                    "version_conflict",
                    "unavailable",
                    "invalid_input",
                  ].includes(response.body.code)
                )
                  ws.close(1008, "Access must be re-established");
              }
            })
            .finally(() => {
              busy = false;
            });
        });
      });
    })()
      .catch(() => {
        if (!socket.destroyed) {
          const terminate = setTimeout(() => socket.destroy(), 1000).unref();
          socket.once("close", () => clearTimeout(terminate));
          socket.end(
            "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        }
      })
      .finally(() => clearTimeout(timer));
  };
  app.server.on("upgrade", upgrade);
  app.addHook("preClose", async () => {
    closing = true;
    app.server.removeListener("upgrade", upgrade);
    for (const ws of wss.clients) ws.terminate();
    for (const socket of rawSockets) socket.destroy();
    await new Promise<void>((resolve) => wss.close(resolve));
  });
}
