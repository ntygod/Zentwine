/** Explicit synthetic local inspection example; never loaded by the application. */
import { handoffFixture, handoffId } from "./runtime-handoff-data.mjs";
export function inspectionFixture() {
  const first = handoffFixture();
  const second = handoffFixture(new TextEncoder().encode("review: 众弦 🎻\n"));
  second.producer.run_id = handoffId(700);
  second.producer.attempt_id = handoffId(701);
  second.manifest.run_id = second.producer.run_id;
  second.manifest.attempt_id = second.producer.attempt_id;
  second.manifest.manifest_id = handoffId(702);
  const ref = second.manifest.artifacts[0].ref;
  ref.artifact_id = handoffId(703);
  ref.producer.run_id = second.producer.run_id;
  ref.producer.attempt_id = second.producer.attempt_id;
  second.events = second.events.map((event, i) => ({
    ...event,
    event_id: handoffId(710 + i),
    run_id: second.producer.run_id,
    attempt_id: second.producer.attempt_id,
    ...(event.type === "artifact.produced"
      ? { payload: { artifact: ref } }
      : {}),
    ...(event.type === "run.succeeded"
      ? { payload: { manifest_id: second.manifest.manifest_id } }
      : {}),
  }));
  const consumer = structuredClone(first.consumer);
  consumer.input_artifacts = [
    structuredClone(ref),
    structuredClone(first.manifest.artifacts[0].ref),
  ];
  return {
    plan: {
      inspection_version: "1.0.0",
      consumer,
      producers: [first, second].map((p) => ({
        request: p.producer,
        manifest: p.manifest,
      })),
    },
    events: [first, second].map((p) =>
      p.events.map((e) => JSON.stringify(e) + "\n").join(""),
    ),
    bytes: [second.bytes, first.bytes],
  };
}
