/** ZT12-01-A5: compose observations and byte integrity, never execution authority. */
import { bindArtifactManifest, parseStartRun } from "@zentwine/contracts";
import {
  RuntimeInputArtifactReader,
  type RuntimeInputArtifactBinding,
  type RuntimeInputArtifactDelivery,
  type RuntimeInputArtifactSnapshot,
} from "./runtime-input-artifact.js";
import {
  RuntimeEventStreamReader,
  type RuntimeStreamSnapshot,
} from "./runtime-stream.js";

export type RuntimeHandoffStatus =
  | "idle"
  | "observing"
  | "awaiting_bytes"
  | "reading_bytes"
  | "ready"
  | "taken"
  | "rejected"
  | "closed";
export type RuntimeHandoffFault =
  | "producer_stream_rejected"
  | "producer_not_succeeded"
  | "manifest_mismatch"
  | "artifact_set_mismatch"
  | "artifact_rejected";
export interface RuntimeHandoffSnapshot {
  readonly handoff_version: "1.0.0";
  readonly authorization: false;
  readonly scope: "one_selected_artifact";
  readonly status: RuntimeHandoffStatus;
  readonly fault: RuntimeHandoffFault | null;
  readonly binding: RuntimeInputArtifactBinding | null;
  readonly producer: RuntimeStreamSnapshot;
  readonly artifact: RuntimeInputArtifactSnapshot;
}
export interface RuntimeHandoffDelivery extends RuntimeInputArtifactDelivery {
  readonly producer_report: Readonly<{
    trust: "reported_not_authenticated";
    manifest_id: string;
    last_sequence: string;
    event_count: number;
  }>;
}

/**
 * Consume a producer response, then explicitly supply one artifact source.
 * All sources/HTTP status/authentication/expiry remain the caller's responsibility.
 * No caller-supplied observation snapshot, fetch, storage, execution or retry.
 */
export class RuntimeArtifactHandoff {
  readonly #events: RuntimeEventStreamReader;
  readonly #artifact: RuntimeInputArtifactReader;
  #expectedRefs: readonly string[];
  #binding: RuntimeInputArtifactBinding | null;
  #status: RuntimeHandoffStatus = "idle";
  #fault: RuntimeHandoffFault | null = null;
  #producerResult: RuntimeStreamSnapshot | null = null;
  #artifactResult: RuntimeInputArtifactSnapshot | null = null;
  #detachAbort: (() => void) | null = null;

  constructor(
    producerRequest: unknown,
    consumerRequest: unknown,
    manifestValue: unknown,
    artifactId: string,
  ) {
    const producer = parseStartRun(producerRequest);
    const consumer = parseStartRun(consumerRequest);
    const manifest = bindArtifactManifest(producer, manifestValue);
    this.#artifact = new RuntimeInputArtifactReader(
      consumer,
      manifest,
      artifactId,
    );
    this.#events = new RuntimeEventStreamReader(producer);
    this.#expectedRefs = Object.freeze(
      manifest.artifacts.map((entry) => JSON.stringify(entry.ref)).sort(),
    );
    this.#binding = this.#artifact.getSnapshot().binding;
  }

  getSnapshot = (): RuntimeHandoffSnapshot =>
    Object.freeze({
      handoff_version: "1.0.0",
      authorization: false,
      scope: "one_selected_artifact",
      status: this.#status,
      fault: this.#fault,
      binding: this.#binding,
      producer: this.#producerResult ?? this.#events.getSnapshot(),
      artifact: this.#artifactResult ?? this.#artifact.getSnapshot(),
    });

  private detach(): void {
    this.#detachAbort?.();
    this.#detachAbort = null;
  }

  private reject(fault: RuntimeHandoffFault): void {
    if (this.#status === "closed") return;
    this.#status = "rejected";
    this.#fault = fault;
    this.detach();
    this.#events.close();
    this.#artifact.close();
    this.#expectedRefs = Object.freeze([]);
  }

  /** Wipes owned contents, not caller-held copies or remote processes. */
  close = (): RuntimeHandoffSnapshot => {
    this.#status = "closed";
    this.#fault = null;
    this.detach();
    this.#events.close();
    this.#artifact.close();
    this.#binding = null;
    this.#expectedRefs = Object.freeze([]);
    this.#producerResult = null;
    this.#artifactResult = null;
    return this.getSnapshot();
  };

  /** The optional native signal covers the whole lifetime, including stage gaps. */
  observe = async (
    source: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<RuntimeHandoffSnapshot> => {
    if (this.#status === "closed") return this.getSnapshot();
    if (this.#status !== "idle")
      throw new TypeError("Runtime handoff observation already consumed");
    this.#status = "observing";
    if (signal?.aborted) return this.close();
    if (signal) {
      const abort = () => {
        this.close();
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#detachAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) return this.close();
    }
    const result = await this.#events.read(source);
    if (this.getSnapshot().status === "closed") return this.getSnapshot();
    this.#producerResult = result;
    const observation = result.observation;
    if (
      result.status !== "ended" ||
      observation.synchronization !== "contiguous"
    )
      this.reject("producer_stream_rejected");
    else if (observation.reported_state !== "succeeded")
      this.reject("producer_not_succeeded");
    else if (observation.manifest_id !== this.#binding!.manifest_id)
      this.reject("manifest_mismatch");
    else if (
      JSON.stringify(observation.artifacts.map((ref) => JSON.stringify(ref)).sort()) !==
      JSON.stringify(this.#expectedRefs)
    )
      this.reject("artifact_set_mismatch");
    else this.#status = "awaiting_bytes";
    return this.getSnapshot();
  };

  /** Wrong-order calls do not acquire the supplied stream. No source is auto-opened. */
  readArtifact = async (
    source: ReadableStream<Uint8Array>,
  ): Promise<RuntimeHandoffSnapshot> => {
    if (this.#status === "closed") return this.getSnapshot();
    if (this.#status !== "awaiting_bytes")
      throw new TypeError("Runtime handoff is not awaiting artifact bytes");
    this.#status = "reading_bytes";
    const result = await this.#artifact.read(source);
    if (this.getSnapshot().status === "closed") return this.getSnapshot();
    this.#artifactResult = result;
    if (result.status !== "matched") this.reject("artifact_rejected");
    else this.#status = "ready";
    return this.getSnapshot();
  };

  /** Transfers just the selected checked buffer once, not all inputs or a permit. */
  takeBytes = (): RuntimeHandoffDelivery => {
    if (this.#status !== "ready")
      throw new TypeError("Runtime handoff bytes not available");
    const observation = this.#producerResult!.observation;
    const delivery = this.#artifact.takeBytes();
    this.#artifactResult = this.#artifact.getSnapshot();
    this.#status = "taken";
    this.detach();
    return Object.freeze({
      ...delivery,
      producer_report: Object.freeze({
        trust: "reported_not_authenticated",
        manifest_id: observation.manifest_id!,
        last_sequence: observation.last_sequence!,
        event_count: observation.event_count,
      }),
    });
  };
}
