/** Public copy and retry guidance are code-owned, never taken from exceptions. */
export const ERROR_CATALOG = Object.freeze({
  invalid_input: Object.freeze({
    status: 400,
    message: "Invalid request",
    retryable: false,
  }),
  unauthenticated: Object.freeze({
    status: 401,
    message: "Identity is not configured",
    retryable: false,
  }),
  forbidden: Object.freeze({
    status: 403,
    message: "Access denied",
    retryable: false,
  }),
  unavailable_resource: Object.freeze({
    status: 404,
    message: "Resource unavailable",
    retryable: false,
  }),
  version_conflict: Object.freeze({
    status: 409,
    message: "Version conflict",
    retryable: false,
  }),
  stale_baseline: Object.freeze({
    status: 412,
    message: "Baseline is stale",
    retryable: false,
  }),
  payload_too_large: Object.freeze({
    status: 413,
    message: "Request body is too large",
    retryable: false,
  }),
  unsupported_media_type: Object.freeze({
    status: 415,
    message: "Unsupported media type",
    retryable: false,
  }),
  invalid_transition: Object.freeze({
    status: 422,
    message: "Invalid state transition",
    retryable: false,
  }),
  rate_limited: Object.freeze({
    status: 429,
    message: "Rate limit exceeded",
    retryable: true,
  }),
  internal_error: Object.freeze({
    status: 500,
    message: "Service error",
    retryable: false,
  }),
  unavailable: Object.freeze({
    status: 503,
    message: "Service unavailable",
    retryable: true,
  }),
});
export type ErrorCode = keyof typeof ERROR_CATALOG;
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}
