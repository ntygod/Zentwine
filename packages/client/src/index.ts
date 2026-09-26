import {
  isApiError,
  isBootstrap,
  isErrorCode,
  type Bootstrap,
} from "@zentwine/contracts";
export class ClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}
export interface ClientOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}
export function createClient(options: ClientOptions = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new RangeError("Invalid request timeout");
  return {
    async bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      try {
        const response = await fetcher("/api/v1/system/bootstrap", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any(signals),
        });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new ClientError("invalid_response", "服务响应无法解析");
        }
        if (!response.ok) {
          // Remote error text may contain sensitive or hostile data. Use local UI copy.
          throw new ClientError(
            isApiError(body) && isErrorCode(body.code)
              ? body.code
              : "unavailable",
            "服务暂不可用，请重试",
            isApiError(body) ? body.trace_id : undefined,
          );
        }
        if (!isBootstrap(body))
          throw new ClientError("contract_mismatch", "服务与客户端版本不兼容");
        return body;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof ClientError) throw error;
        throw new ClientError(
          "network_unavailable",
          "无法连接本地 API，请检查服务后重试",
        );
      }
    },
  };
}

export * from "./workbench.js";

export * from "./object-layout.js";

export * from "./catalog-approval.js";
