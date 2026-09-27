import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApprovalError, validApprovalCursor } from "@zentwine/policy";
export interface ApprovalInboxPosition {
  head: string;
  before: string;
  started: number;
}
/** Per-repository opaque navigation token. No authorization is carried in a cursor. */
export class ApprovalInboxCursor {
  readonly #key = randomBytes(32);
  encode(position: ApprovalInboxPosition, binding: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(binding));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(position), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
      "base64url",
    );
  }
  decode(token: string, binding: string, now: number): ApprovalInboxPosition {
    try {
      if (!/^[A-Za-z0-9_-]{40,1024}$/.test(token)) throw new Error();
      const raw = Buffer.from(token, "base64url");
      if (raw.toString("base64url") !== token || raw.length < 29)
        throw new Error();
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        raw.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from(binding));
      cipher.setAuthTag(raw.subarray(12, 28));
      const p = JSON.parse(
        Buffer.concat([
          cipher.update(raw.subarray(28)),
          cipher.final(),
        ]).toString("utf8"),
      ) as ApprovalInboxPosition;
      if (
        !p ||
        Object.keys(p).sort().join(",") !== "before,head,started" ||
        !validApprovalCursor(p.head) ||
        !validApprovalCursor(p.before) ||
        BigInt(p.before) < 1n ||
        BigInt(p.before) > BigInt(p.head) ||
        !Number.isSafeInteger(p.started) ||
        p.started < 0 ||
        !Number.isSafeInteger(now) ||
        now < p.started ||
        now - p.started >= 15 * 60 * 1000
      )
        throw new Error();
      return p;
    } catch {
      throw new ApprovalError("invalid_input");
    }
  }
}
