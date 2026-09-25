import {
  OrganizationError,
  validExternalId,
  type SsoPortRepository,
  type SsoVerifier,
} from "@zentwine/domain";
import { secret, secretDigest } from "../identity/security.js";
/** Dependency-injected server port. Browser claims cannot instantiate or replace this verifier.
 * A configured adapter owns authorization-code/state/nonce/PKCE/signature validation. None is bundled yet. */
export function createSsoPort(
  repository: SsoPortRepository,
  connectionId: string,
  verifier: SsoVerifier,
) {
  return Object.freeze({
    async exchange(input: unknown): Promise<{ ticket: string }> {
      const connection = await repository.connection(connectionId);
      let proof;
      try {
        proof = await verifier.verify(input, Object.freeze({ ...connection }));
      } catch {
        throw new OrganizationError("authentication_required");
      }
      if (
        !proof ||
        proof.issuer !== connection.issuer ||
        proof.audience !== connection.client_id ||
        !validExternalId(proof.subject)
      )
        throw new OrganizationError("authentication_required");
      const ticket = secret();
      await repository.federatedTicket(
        connectionId,
        connection.object_version,
        proof.subject,
        secretDigest(ticket),
      );
      return { ticket };
    },
  });
}
