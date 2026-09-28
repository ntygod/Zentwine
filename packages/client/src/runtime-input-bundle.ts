/** ZT12-01-A6: all declared artifact inputs, local all-or-nothing ownership only. */
import {
  bindArtifactManifest,
  parseStartRun,
  type StartRun,
} from "@zentwine/contracts";
import {
  RuntimeArtifactHandoff,
  type RuntimeHandoffDelivery,
} from "./runtime-artifact-handoff.js";
import {
  RuntimeInputArtifactReader,
  type RuntimeInputArtifactSnapshot,
} from "./runtime-input-artifact.js";

export interface RuntimeInputBundleLimits {
  readonly max_inputs: number;
  readonly max_producers: number;
  readonly max_total_bytes: number;
}
export const RUNTIME_INPUT_BUNDLE_LIMITS: RuntimeInputBundleLimits =
  Object.freeze({ max_inputs: 16, max_producers: 8, max_total_bytes: 16777216 });
export type RuntimeInputBundleStatus =
  | "idle"
  | "awaiting_producers"
  | "awaiting_artifacts"
  | "reading_artifacts"
  | "ready"
  | "taken"
  | "rejected"
  | "closed";
type ProducerStatus = "idle" | "observing" | "matched" | "closed";
export interface RuntimeInputBundleFault {
  readonly code: "producer_rejected" | "artifact_rejected" | "delivery_unavailable";
  readonly subject_id: string | null;
}
export interface RuntimeInputBundleSnapshot {
  readonly bundle_version: "1.0.0";
  readonly authorization: false;
  readonly scope: "all_declared_input_artifacts";
  readonly status: RuntimeInputBundleStatus;
  readonly consumer: Readonly<{ org_id: string; run_id: string; attempt_id: string }> | null;
  readonly declared_bytes: number;
  readonly fault: RuntimeInputBundleFault | null;
  readonly producers: readonly Readonly<{ manifest_id: string; status: ProducerStatus }>[];
  readonly artifacts: readonly RuntimeInputArtifactSnapshot[];
}
export interface RuntimeInputBundleDelivery {
  readonly authorization: false;
  readonly scope: "all_declared_input_artifacts";
  readonly artifacts: readonly RuntimeHandoffDelivery[];
}
type Producer = {
  manifest_id: string;
  handoff: RuntimeArtifactHandoff;
  status: ProducerStatus;
  report: RuntimeHandoffDelivery["producer_report"] | null;
};
type Input = { artifact_id: string; producer: Producer; reader: RuntimeInputArtifactReader };
function invalid(): never {
  throw new TypeError("Invalid runtime input bundle plan or limits");
}
/** Own enumerable data properties only; not a hostile Proxy sandbox. */
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function limits(value: unknown): RuntimeInputBundleLimits {
  const copy = fields(value, ["max_inputs", "max_producers", "max_total_bytes"]);
  for (const key of ["max_inputs", "max_producers", "max_total_bytes"] as const) {
    const n = copy[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > RUNTIME_INPUT_BUNDLE_LIMITS[key])
      invalid();
  }
  return Object.freeze(copy) as unknown as RuntimeInputBundleLimits;
}
function entries(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const size: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof size !== "number" || size > maximum || Reflect.ownKeys(value).length !== size + 1)
    invalid();
  const result = [];
  for (let i = 0; i < size; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result.push(fields(descriptor.value, ["request", "manifest"]));
  }
  return result;
}
const identity = (request: StartRun) =>
  Object.freeze({ org_id: request.org_id, run_id: request.run_id, attempt_id: request.attempt_id });

/**
 * begin -> observe each producer once -> read each artifact -> takeAll once.
 * Sources are acquired by the caller; no fetch, execution, storage or durable transaction.
 */
export class RuntimeInputBundle {
  #status: RuntimeInputBundleStatus = "idle";
  #fault: RuntimeInputBundleFault | null = null;
  #consumer: RuntimeInputBundleSnapshot["consumer"];
  #totalBytes = 0;
  #producers: Producer[] = [];
  #inputs: Input[] = [];
  #detachAbort: (() => void) | null = null;

  constructor(
    consumerValue: unknown,
    producerValues: unknown,
    budget: RuntimeInputBundleLimits = RUNTIME_INPUT_BUNDLE_LIMITS,
  ) {
    const bound = limits(budget);
    const consumer = parseStartRun(consumerValue);
    this.#consumer = identity(consumer);
    if (consumer.input_artifacts.length > bound.max_inputs) invalid();
    const plans = entries(producerValues, bound.max_producers).map((entry) => {
      const request = parseStartRun(entry.request);
      return { request, manifest: bindArtifactManifest(request, entry.manifest) };
    });
    if (new Set(plans.map((p) => p.manifest.manifest_id)).size !== plans.length ||
        new Set(plans.map((p) => JSON.stringify(identity(p.request)))).size !== plans.length)
      invalid();
    // Preflight every reference and aggregate byte budget before allocating stream readers.
    const selected = consumer.input_artifacts.map((ref) => {
      const matches = plans.flatMap((plan) => plan.manifest.artifacts
        .filter((item) => JSON.stringify(item.ref) === JSON.stringify(ref))
        .map((item) => ({ plan, item })));
      if (matches.length !== 1) invalid();
      const match = matches[0]!;
      this.#totalBytes += match.item.size_bytes;
      if (this.#totalBytes > bound.max_total_bytes) invalid();
      return { ...match, reader: new RuntimeInputArtifactReader(consumer, match.plan.manifest, ref.artifact_id) };
    });
    if (plans.some((plan) => !selected.some((s) => s.plan === plan))) invalid();
    for (const plan of plans) {
      const first = selected.find((s) => s.plan === plan)!;
      // A5 checks the complete reported artifact set once, including unselected entries.
      // Its selected byte stage is not used: separate private A4 readers own all inputs.
      const producer: Producer = {
        manifest_id: plan.manifest.manifest_id,
        handoff: new RuntimeArtifactHandoff(plan.request, consumer, plan.manifest, first.item.ref.artifact_id),
        status: "idle",
        report: null,
      };
      this.#producers.push(producer);
    }
    this.#inputs = selected.map((s) => ({
      artifact_id: s.item.ref.artifact_id,
      producer: this.#producers.find((p) => p.manifest_id === s.plan.manifest.manifest_id)!,
      reader: s.reader,
    }));
  }

  getSnapshot = (): RuntimeInputBundleSnapshot => Object.freeze({
    bundle_version: "1.0.0",
    authorization: false,
    scope: "all_declared_input_artifacts",
    status: this.#status,
    consumer: this.#consumer,
    declared_bytes: this.#totalBytes,
    fault: this.#fault,
    producers: Object.freeze(this.#producers.map((p) => Object.freeze({ manifest_id: p.manifest_id, status: p.status }))),
    artifacts: Object.freeze(this.#inputs.map((input) => input.reader.getSnapshot())),
  });
  private stopped(): boolean { return this.#status === "closed" || this.#status === "rejected"; }
  private detach(): void { this.#detachAbort?.(); this.#detachAbort = null; }
  private clearOwned(): void {
    this.detach();
    for (const p of this.#producers) { p.handoff.close(); p.status = "closed"; p.report = null; }
    for (const input of this.#inputs) input.reader.close();
  }
  private reject(code: RuntimeInputBundleFault["code"], subjectId: string | null): void {
    if (this.stopped()) return;
    this.#status = "rejected";
    this.#fault = Object.freeze({ code, subject_id: subjectId });
    this.clearOwned();
  }
  close = (): RuntimeInputBundleSnapshot => {
    this.#status = "closed";
    this.#fault = null;
    this.clearOwned();
    this.#inputs = [];
    this.#producers = [];
    this.#consumer = null;
    this.#totalBytes = 0;
    return this.getSnapshot();
  };
  /** Attach a native lifetime signal without acquiring any data source. */
  begin = (signal?: AbortSignal): RuntimeInputBundleSnapshot => {
    if (this.#status === "closed") return this.getSnapshot();
    if (this.#status !== "idle") throw new TypeError("Runtime input bundle already begun");
    if (signal?.aborted) return this.close();
    this.#status = this.#inputs.length ? "awaiting_producers" : "ready";
    if (signal) {
      const abort = () => { this.close(); };
      signal.addEventListener("abort", abort, { once: true });
      this.#detachAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) return this.close();
    }
    return this.getSnapshot();
  };
  /** Different producers may be observed concurrently; every report must pass first. */
  observeProducer = async (manifestId: string, source: ReadableStream<Uint8Array>): Promise<RuntimeInputBundleSnapshot> => {
    if (this.stopped()) return this.getSnapshot();
    const p = this.#producers.find((entry) => entry.manifest_id === manifestId);
    if (this.#status !== "awaiting_producers" || !p || p.status !== "idle")
      throw new TypeError("Runtime input bundle is not awaiting this producer");
    p.status = "observing";
    try {
      const result = await p.handoff.observe(source);
      if (this.stopped()) return this.getSnapshot();
      if (result.status !== "awaiting_bytes") this.reject("producer_rejected", p.manifest_id);
      else {
        const observation = result.producer.observation;
        p.report = Object.freeze({ trust: "reported_not_authenticated", manifest_id: p.manifest_id,
          last_sequence: observation.last_sequence!, event_count: observation.event_count });
        p.status = "matched";
        if (this.#producers.every((entry) => entry.status === "matched")) this.#status = "awaiting_artifacts";
      }
    } catch { this.reject("producer_rejected", p.manifest_id); }
    return this.getSnapshot();
  };
  /** A matched input remains private until every declared input is matched. */
  readArtifact = async (artifactId: string, source: ReadableStream<Uint8Array>): Promise<RuntimeInputBundleSnapshot> => {
    if (this.stopped()) return this.getSnapshot();
    const input = this.#inputs.find((entry) => entry.artifact_id === artifactId);
    if (!["awaiting_artifacts", "reading_artifacts"].includes(this.#status) || !input || input.reader.getSnapshot().status !== "idle")
      throw new TypeError("Runtime input bundle is not awaiting this artifact");
    this.#status = "reading_artifacts";
    try {
      const result = await input.reader.read(source);
      if (this.stopped()) return this.getSnapshot();
      if (result.status !== "matched") this.reject("artifact_rejected", artifactId);
      else if (this.#inputs.every((entry) => entry.reader.getSnapshot().status === "matched")) this.#status = "ready";
    } catch { this.reject("artifact_rejected", artifactId); }
    return this.getSnapshot();
  };
  /** Synchronous ownership transfer in consumer order. No per-input take API. */
  takeAll = (): RuntimeInputBundleDelivery => {
    if (this.#status !== "ready") throw new TypeError("Runtime input bundle not available");
    const artifacts: RuntimeHandoffDelivery[] = [];
    try {
      for (const input of this.#inputs) {
        if (!input.producer.report || input.reader.getSnapshot().status !== "matched") throw new Error();
      }
      for (const input of this.#inputs) artifacts.push(Object.freeze({
        ...input.reader.takeBytes(), producer_report: input.producer.report!,
      }));
    } catch {
      for (const artifact of artifacts) artifact.bytes.fill(0);
      this.reject("delivery_unavailable", null);
      throw new TypeError("Runtime input bundle not available");
    }
    this.#status = "taken";
    this.detach();
    for (const producer of this.#producers) producer.handoff.close();
    return Object.freeze({ authorization: false, scope: "all_declared_input_artifacts", artifacts: Object.freeze(artifacts) });
  };
}
