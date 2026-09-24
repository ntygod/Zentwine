import {
  ERROR_CATALOG,
  isErrorCode,
  type ErrorCode,
  type ApiErrorPayload,
} from "@zentwine/contracts";
/** No free-form public message or cause. Internal errors are never serialized. */
export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    const safe = isErrorCode(code) ? code : "internal_error";
    super(ERROR_CATALOG[safe].message);
    this.name = "AppError";
    this.code = safe;
  }
}
function ownValue(error: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
const fastifyErrors: Readonly<Record<string, ErrorCode>> = Object.freeze({
  FST_ERR_VALIDATION: "invalid_input",
  FST_ERR_CTP_INVALID_JSON_BODY: "invalid_input",
  FST_ERR_CTP_EMPTY_JSON_BODY: "invalid_input",
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: "invalid_input",
  FST_ERR_CTP_BODY_TOO_LARGE: "payload_too_large",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported_media_type",
});
export function classifyError(error: unknown): ErrorCode {
  try {
    if (error === null || typeof error !== "object") return "internal_error";
    const code = ownValue(error, "code");
    if (error instanceof AppError && isErrorCode(code)) return code;
    if (typeof code === "string" && Object.hasOwn(fastifyErrors, code)) {
      return fastifyErrors[code] ?? "internal_error";
    }
  } catch {
    // A hostile proxy/getter is not allowed to break the error handler.
  }
  return "internal_error";
}
export function publicError(
  error: unknown,
  traceId: string,
): {
  status: number;
  body: ApiErrorPayload;
} {
  const code = classifyError(error);
  const { status, message, retryable } = ERROR_CATALOG[code];
  return {
    status,
    body: { code, message, details: {}, trace_id: traceId, retryable },
  };
}
/** @deprecated Trusted static copy only. Use AppError/publicError at boundaries. */
export function apiError(
  code: string,
  message: string,
  traceId: string,
  retryable = false,
): ApiErrorPayload {
  return { code, message, details: {}, trace_id: traceId, retryable };
}
