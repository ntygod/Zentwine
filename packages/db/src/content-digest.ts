import { createHash } from "node:crypto";
import {
  CANONICALIZATION_VERSION,
  canonicalizeContent,
  validateContentDigest,
  validateTenantKind,
  type ContentDigest,
} from "@zentwine/domain";
/** Node crypto adapter only: no connection, persistence, authorization, or external side effect. */
export function digestContent(schemaId: string, value: unknown): ContentDigest {
  validateTenantKind(schemaId);
  const canonical = canonicalizeContent(value);
  return Object.freeze({
    algorithm: "sha256",
    canonicalization_version: CANONICALIZATION_VERSION,
    schema_id: schemaId,
    content_hash: createHash("sha256")
      .update(
        "zentwine.content-digest.v1\0" +
          schemaId +
          "\0" +
          CANONICALIZATION_VERSION +
          "\0" +
          canonical,
      )
      .digest("hex"),
    content_bytes: Buffer.byteLength(canonical, "utf8"),
  });
}
export function verifyContentDigest(
  digest: ContentDigest,
  value: unknown,
): boolean {
  // Snapshot before reading fields: ordinary getters/toJSON are never invoked.
  const descriptor = JSON.parse(canonicalizeContent(digest)) as ContentDigest;
  validateContentDigest(descriptor);
  const actual = digestContent(descriptor.schema_id, value);
  return (
    actual.content_hash === descriptor.content_hash &&
    actual.content_bytes === descriptor.content_bytes
  );
}
