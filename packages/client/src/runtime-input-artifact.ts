/** ZT12-01-A4: local byte integrity, never artifact approval or execution authority. */
import {
  parseArtifactManifest,
  parseStartRun,
  type ArtifactManifest,
} from "@zentwine/contracts";

export interface RuntimeInputArtifactLimits {
  readonly max_bytes: number;
  readonly max_chunks: number;
}
export const RUNTIME_INPUT_ARTIFACT_LIMITS: RuntimeInputArtifactLimits =
  Object.freeze({ max_bytes: 4194304, max_chunks: 65536 });
type ArtifactEntry = ArtifactManifest["artifacts"][number];
export interface RuntimeInputArtifactBinding {
  readonly consumer: Readonly<{
    org_id: string;
    run_id: string;
    attempt_id: string;
  }>;
  readonly manifest_id: string;
  readonly evidence_kind: ArtifactManifest["evidence_kind"];
  readonly artifact: ArtifactEntry;
}
export type RuntimeInputArtifactFault =
  | "invalid_source"
  | "invalid_chunk"
  | "size_mismatch"
  | "chunk_limit"
  | "transport_lost"
  | "digest_unavailable"
  | "digest_mismatch";
export interface RuntimeInputArtifactSnapshot {
  readonly reader_version: "1.0.0";
  readonly authorization: false;
  readonly status:
    | "idle"
    | "reading"
    | "checking"
    | "matched"
    | "taken"
    | "rejected"
    | "closed";
  readonly integrity: "not_checked" | "sha256_and_length_match";
  readonly binding: RuntimeInputArtifactBinding | null;
  readonly received_bytes: number;
  readonly received_chunks: number;
  readonly fault: RuntimeInputArtifactFault | null;
}
/** The envelope is frozen; bytes are mutable and ownership passes to the caller. */
export interface RuntimeInputArtifactDelivery {
  readonly authorization: false;
  readonly integrity: "sha256_and_length_match";
  readonly binding: RuntimeInputArtifactBinding;
  readonly bytes: Uint8Array;
}
function checkedLimits(
  value: RuntimeInputArtifactLimits,
): RuntimeInputArtifactLimits {
  const fail = (): never => {
    throw new TypeError("Invalid runtime input artifact limits");
  };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  const copy = { max_bytes: 0, max_chunks: 0 };
  if (keys.length !== 2 || keys.some((key) => !Object.hasOwn(copy, key)))
    fail();
  for (const key of ["max_bytes", "max_chunks"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail();
    const n: unknown = descriptor?.value;
    if (
      typeof n !== "number" ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      n > RUNTIME_INPUT_ARTIFACT_LIMITS[key]
    )
      fail();
    copy[key] = n as number;
  }
  return Object.freeze(copy);
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(
  typedArray,
  Symbol.toStringTag,
)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const offset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const length = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
function byteView(value: unknown): Uint8Array {
  if (tag.call(value) !== "Uint8Array")
    throw new TypeError("Invalid artifact byte chunk");
  const backing: unknown = buffer.call(value);
  if (!(backing instanceof ArrayBuffer))
    throw new TypeError("Invalid artifact byte buffer");
  return new Uint8Array(backing, offset.call(value), length.call(value));
}

/** Reads an already obtained, authorized source. No fetch, storage, execution or retry. */
export class RuntimeInputArtifactReader {
  readonly #limits: RuntimeInputArtifactLimits;
  #snapshot: RuntimeInputArtifactSnapshot;
  #bytes: Uint8Array | null = null;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #claimed = false;
  #interrupt: (() => void) | null = null;
  #detachAbort: (() => void) | null = null;
  constructor(
    consumerRequest: unknown,
    manifestValue: unknown,
    artifactId: string,
    budget: RuntimeInputArtifactLimits = RUNTIME_INPUT_ARTIFACT_LIMITS,
  ) {
    this.#limits = checkedLimits(budget);
    const consumer = parseStartRun(consumerRequest);
    const manifest = parseArtifactManifest(manifestValue);
    const expected = consumer.input_artifacts.find(
      (item) => item.artifact_id === artifactId,
    );
    const entry = manifest.artifacts.find(
      (item) => item.ref.artifact_id === artifactId,
    );
    if (
      typeof artifactId !== "string" ||
      !expected ||
      !entry ||
      JSON.stringify(expected) !== JSON.stringify(entry.ref) ||
      manifest.org_id !== consumer.org_id ||
      manifest.evidence_kind !==
        (consumer.execution_kind === "synthetic"
          ? "synthetic"
          : "adapter_report") ||
      entry.size_bytes > this.#limits.max_bytes
    )
      throw new TypeError("Invalid runtime input artifact binding");
    const binding: RuntimeInputArtifactBinding = Object.freeze({
      consumer: Object.freeze({
        org_id: consumer.org_id,
        run_id: consumer.run_id,
        attempt_id: consumer.attempt_id,
      }),
      manifest_id: manifest.manifest_id,
      evidence_kind: manifest.evidence_kind,
      artifact: entry,
    });
    this.#snapshot = Object.freeze({
      reader_version: "1.0.0",
      authorization: false,
      status: "idle",
      integrity: "not_checked",
      binding,
      received_bytes: 0,
      received_chunks: 0,
      fault: null,
    });
  }
  getSnapshot = (): RuntimeInputArtifactSnapshot => this.#snapshot;
  private update(patch: Partial<RuntimeInputArtifactSnapshot>): void {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...patch });
  }
  private wipe(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }
  private detach(): void {
    this.#detachAbort?.();
    this.#detachAbort = null;
  }
  private cancel(): void {
    const reader = this.#reader;
    this.#reader = null;
    if (reader) {
      try {
        void reader.cancel("runtime_artifact_closed").catch(() => {});
      } catch {
        /* Do not expose a source error or wait for its cancellation. */
      }
    }
  }
  private reject(fault: RuntimeInputArtifactFault): void {
    if (this.#snapshot.status === "closed") return;
    this.wipe();
    this.update({ status: "rejected", integrity: "not_checked", fault });
  }
  /** Clears owned data; cannot erase bytes already transferred to a caller. */
  close = (): RuntimeInputArtifactSnapshot => {
    this.wipe();
    this.detach();
    this.update({
      status: "closed",
      integrity: "not_checked",
      binding: null,
      received_bytes: 0,
      received_chunks: 0,
      fault: null,
    });
    this.#interrupt?.();
    this.cancel();
    return this.#snapshot;
  };
  private async wait<T>(operation: Promise<T>): Promise<T | null> {
    if (this.#snapshot.status === "closed") {
      void operation.catch(() => {});
      return null;
    }
    const interrupted = new Promise<null>((resolve) => {
      this.#interrupt = () => resolve(null);
    });
    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      this.#interrupt?.();
      this.#interrupt = null;
    }
  }
  /** Available exactly once, after EOF, length and digest all match. */
  takeBytes = (): RuntimeInputArtifactDelivery => {
    const binding = this.#snapshot.binding;
    if (this.#snapshot.status !== "matched" || !this.#bytes || !binding)
      throw new TypeError("Runtime input artifact not available");
    const bytes = this.#bytes;
    this.#bytes = null;
    this.detach();
    this.update({ status: "taken" });
    return Object.freeze({
      authorization: false,
      integrity: "sha256_and_length_match",
      binding,
      bytes,
    });
  };
  read = async (
    source: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<RuntimeInputArtifactSnapshot> => {
    if (this.#snapshot.status === "closed") return this.#snapshot;
    if (this.#claimed)
      throw new TypeError("Runtime input artifact already consumed");
    this.#claimed = true;
    if (signal?.aborted) return this.close();
    const binding = this.#snapshot.binding!;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = ReadableStream.prototype.getReader.call(
        source,
      ) as ReadableStreamDefaultReader<Uint8Array>;
    } catch {
      this.reject("invalid_source");
      return this.#snapshot;
    }
    this.#reader = reader;
    let eof = false;
    try {
      if (signal) {
        const abort = () => {
          this.close();
        };
        signal.addEventListener("abort", abort, { once: true });
        this.#detachAbort = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) return this.close();
      }
      this.#bytes = new Uint8Array(binding.artifact.size_bytes);
      this.update({ status: "reading" });
      while (this.#snapshot.status === "reading") {
        const part = await this.wait(reader.read());
        if (this.#snapshot.status !== "reading" || part === null) break;
        if (part.done) {
          eof = true;
          if (this.#snapshot.received_bytes !== binding.artifact.size_bytes)
            this.reject("size_mismatch");
          else this.update({ status: "checking" });
          break;
        }
        if (this.#snapshot.received_chunks >= this.#limits.max_chunks) {
          this.reject("chunk_limit");
          break;
        }
        let bytes: Uint8Array;
        try {
          bytes = byteView(part.value);
        } catch {
          this.reject("invalid_chunk");
          break;
        }
        const total = this.#snapshot.received_bytes + bytes.byteLength;
        if (total > binding.artifact.size_bytes) {
          this.reject("size_mismatch");
          break;
        }
        this.#bytes!.set(bytes, this.#snapshot.received_bytes);
        this.update({
          received_bytes: total,
          received_chunks: this.#snapshot.received_chunks + 1,
        });
      }
      if (this.#snapshot.status === "checking") {
        try {
          // Web Crypto snapshots this private buffer; no pluggable digest or untrusted bytes escape.
          const digest = await this.wait(
            globalThis.crypto.subtle.digest(
              "SHA-256",
              this.#bytes!.buffer as ArrayBuffer,
            ),
          );
          if (this.#snapshot.status === "checking" && digest !== null) {
            const hex = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            if (hex !== binding.artifact.ref.sha256)
              this.reject("digest_mismatch");
            else
              this.update({
                status: "matched",
                integrity: "sha256_and_length_match",
              });
          }
        } catch {
          this.reject("digest_unavailable");
        }
      }
    } catch {
      this.reject("transport_lost");
    } finally {
      if (!eof) this.cancel();
      this.#reader = null;
      try {
        reader.releaseLock();
      } catch {
        /* Trusted native readers only; raw transport errors never escape. */
      }
      if (this.#snapshot.status !== "matched") this.detach();
    }
    return this.#snapshot;
  };
}
