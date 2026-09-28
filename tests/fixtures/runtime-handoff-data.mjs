/** Fixed synthetic payloads; not a provider, execution host or authorization source. */
import { createHash } from "node:crypto";
import { fixture } from "./runtime-wire-v1.mjs";
export const handoffId = (n) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const handoffHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function handoffFixture(
  bytes = new TextEncoder().encode('{"values":[3,5,8],"total":16}\n'),
) {
  const producer = structuredClone(fixture.start_a);
  const consumer = structuredClone(fixture.start_b);
  const manifest = structuredClone(fixture.manifest_a);
  const entry = manifest.artifacts[0];
  entry.ref.sha256 = handoffHash(bytes);
  entry.size_bytes = bytes.byteLength;
  consumer.input_artifacts = [structuredClone(entry.ref)];
  const event = (type, sequence, payload) => ({
    ...structuredClone(
      fixture.event_variants.find((item) => item.type === type),
    ),
    event_id: handoffId(sequence),
    sequence: String(sequence),
    ...(payload ? { payload } : {}),
  });
  const events = [
    event("run.started", 1),
    event("artifact.produced", 2, { artifact: structuredClone(entry.ref) }),
    event("run.succeeded", 3, { manifest_id: manifest.manifest_id }),
  ];
  return {
    producer,
    consumer,
    manifest,
    events,
    bytes,
    id: entry.ref.artifact_id,
    event,
  };
}
