/** Pure ports: no UI, database, process, clock globals or provider SDK dependencies. */
export interface Clock {
  now(): Date;
}
export interface IdSource {
  next(): string;
}
export type FactKind =
  | "approved_intent"
  | "observed_implementation"
  | "agent_claim"
  | "trusted_verification"
  | "runtime_observation"
  | "product_outcome";
export interface RevisionRef {
  id: string;
  revision: number;
  content_hash: string;
}
export function matchesRevision(a: RevisionRef, b: RevisionRef): boolean {
  return (
    a.id === b.id &&
    a.revision === b.revision &&
    a.content_hash === b.content_hash
  );
}

/** Elapsed duration only; not a persistent timestamp or cross-machine ordering. */
export interface MonotonicClock {
  milliseconds(): number;
}

export * from "./identity.js";
export * from "./organizations.js";

export * from "./organization-audit.js";
