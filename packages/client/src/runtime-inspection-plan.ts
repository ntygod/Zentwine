/** Local diagnostic file format, not a Run submission or authorization document. */
import { RuntimeInputBundle } from "./runtime-input-bundle.js";
import { readRuntimeStreamJson } from "./runtime-stream-json.js";

export const RUNTIME_INSPECTION_PLAN_BYTES = 262144;

/** Reject duplicate decoded keys before any ordinary JSON object conversion. */
export function createRuntimeInputInspection(text: string): RuntimeInputBundle {
  const invalid = (): never => {
    throw new TypeError("Invalid local runtime inspection plan");
  };
  try {
    if (
      typeof text !== "string" ||
      text.length > RUNTIME_INSPECTION_PLAN_BYTES ||
      new TextEncoder().encode(text).byteLength > RUNTIME_INSPECTION_PLAN_BYTES
    )
      invalid();
    const parsed = readRuntimeStreamJson(text);
    const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return invalid();
      const own = Object.keys(value);
      if (own.length !== keys.length || own.some((key) => !keys.includes(key)))
        return invalid();
      return value as Record<string, unknown>;
    };
    const plan = exact(parsed, ["inspection_version", "consumer", "producers"]);
    if (plan.inspection_version !== "1.0.0" || !Array.isArray(plan.producers))
      invalid();
    // The strict parser creates null-prototype objects. Rebuild only A6's wrappers;
    // the existing wire parser independently snapshots all requests and manifests.
    const producers = (plan.producers as unknown[]).map((value) => {
      const entry = exact(value, ["request", "manifest"]);
      return { request: entry.request, manifest: entry.manifest };
    });
    return new RuntimeInputBundle(plan.consumer, producers);
  } catch {
    return invalid();
  }
}
