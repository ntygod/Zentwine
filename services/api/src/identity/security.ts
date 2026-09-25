import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "@zentwine/telemetry";
export const SESSION_COOKIE = "zentwine_local_session";
export function secret(): string {
  return randomBytes(32).toString("base64url");
}
export function secretDigest(value: string): string {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  )
    throw new AppError("authentication_required");
  return createHash("sha256").update(value).digest("hex");
}
export function csrfFor(value: string): string {
  secretDigest(value);
  return createHmac("sha256", value)
    .update("zentwine.csrf.v1")
    .digest("base64url");
}
export function verifyCsrf(value: string, provided: unknown): void {
  if (
    typeof provided !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(provided) ||
    !timingSafeEqual(Buffer.from(csrfFor(value)), Buffer.from(provided))
  )
    throw new AppError("forbidden");
}
export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  if (header.length > 8192) throw new AppError("authentication_required");
  const values = header
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.split("=")[0] === SESSION_COOKIE);
  if (!values.length) return null;
  if (values.length !== 1) throw new AppError("authentication_required");
  const value = values[0]?.slice(SESSION_COOKIE.length + 1) ?? "";
  secretDigest(value);
  return value;
}
export function cookie(value: string): string {
  secretDigest(value);
  return `${SESSION_COOKIE}=${value}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=28800`;
}
export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=0`;
}
/** Process-local defense for a loopback-only bootstrap, not distributed abuse protection. */
export class LoginLimiter {
  readonly #buckets = new Map<string, { until: number; count: number }>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  take(peer: string): void {
    const now = this.now();
    for (const [key, b] of this.#buckets)
      if (b.until <= now) this.#buckets.delete(key);
    const b = this.#buckets.get(peer);
    if (b) {
      if (b.count >= 30) throw new AppError("rate_limited");
      b.count++;
      return;
    }
    if (this.#buckets.size >= 256) throw new AppError("rate_limited");
    this.#buckets.set(peer, { until: now + 60000, count: 1 });
  }
}
