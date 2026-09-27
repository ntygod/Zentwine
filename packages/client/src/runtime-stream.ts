/** ZT12-01-A3: explicit, one-shot consumption of an already authorized byte stream. */
import { RUNTIME_WIRE_LIMITS } from "@zentwine/contracts";
import {
  RuntimeEventObserver,
  type RuntimeObservation,
  type RuntimeObservationResult,
} from "./runtime-observer.js";
import { readRuntimeStreamJson } from "./runtime-stream-json.js";

export interface RuntimeStreamLimits {
  readonly max_frame_bytes: number;
  readonly max_stream_bytes: number;
  readonly max_frames: number;
  readonly max_empty_chunks: number;
}
export const RUNTIME_STREAM_LIMITS: RuntimeStreamLimits = Object.freeze({
  max_frame_bytes: RUNTIME_WIRE_LIMITS.bytes,
  max_stream_bytes: 4194304,
  max_frames: 2048,
  max_empty_chunks: 64,
});
export type RuntimeStreamFault =
  | "invalid_source"
  | "invalid_chunk"
  | "empty_chunk_limit"
  | "invalid_frame"
  | "frame_limit"
  | "stream_limit"
  | "frame_count_limit"
  | "truncated_frame"
  | "unexpected_eof"
  | "transport_lost"
  | "observation_rejected";
export interface RuntimeStreamSnapshot {
  readonly stream_version: "1.0.0";
  readonly authorization: false;
  readonly status: "idle" | "reading" | "ended" | "inspect_required" | "closed";
  readonly fault: RuntimeStreamFault | null;
  readonly event_code: RuntimeObservationResult["code"] | null;
  readonly consumed_bytes: number;
  readonly framed_events: number;
  readonly duplicate_events: number;
  readonly observation: RuntimeObservation;
}
function checkedLimits(value: RuntimeStreamLimits): RuntimeStreamLimits {
  const fail = (): never => {
    throw new TypeError("Invalid runtime stream limits");
  };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  const result = {
    max_frame_bytes: 0,
    max_stream_bytes: 0,
    max_frames: 0,
    max_empty_chunks: 0,
  };
  if (keys.length !== 4 || keys.some((key) => !Object.hasOwn(result, key)))
    fail();
  for (const key of Object.keys(result) as (keyof RuntimeStreamLimits)[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail();
    const n: unknown = descriptor?.value;
    if (
      typeof n !== "number" ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      n > RUNTIME_STREAM_LIMITS[key]
    )
      fail();
    result[key] = n as number;
  }
  return Object.freeze(result);
}
// Intrinsic accessors avoid reading caller-defined getters on byte chunks.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(
  typedArray,
  "byteLength",
)!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(
  typedArray,
  "byteOffset",
)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
function byteView(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new TypeError("Invalid runtime byte chunk");
  const backing: unknown = buffer.call(value);
  if (!(backing instanceof ArrayBuffer))
    throw new TypeError("Invalid runtime byte buffer");
  return new Uint8Array(
    backing,
    byteOffset.call(value),
    byteLength.call(value),
  );
}

/** Does not fetch a URL, authenticate, reconnect, dispatch tools, or stop remote execution. */
export class RuntimeEventStreamReader {
  readonly #observer: RuntimeEventObserver;
  readonly #limits: RuntimeStreamLimits;
  #pending: Uint8Array;
  #length = 0;
  #claimed = false;
  #consumed = 0;
  #framed = 0;
  #duplicates = 0;
  #emptyChunks = 0;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #interrupt: (() => void) | null = null;
  #snapshot: RuntimeStreamSnapshot;
  constructor(
    request: unknown,
    budget: RuntimeStreamLimits = RUNTIME_STREAM_LIMITS,
  ) {
    this.#observer = new RuntimeEventObserver(request);
    this.#limits = checkedLimits(budget);
    this.#pending = new Uint8Array(this.#limits.max_frame_bytes);
    this.#snapshot = Object.freeze({
      stream_version: "1.0.0",
      authorization: false,
      status: "idle",
      fault: null,
      event_code: null,
      consumed_bytes: 0,
      framed_events: 0,
      duplicate_events: 0,
      observation: this.#observer.getSnapshot(),
    });
  }
  getSnapshot = (): RuntimeStreamSnapshot => this.#snapshot;
  private update(patch: Partial<RuntimeStreamSnapshot>): void {
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...patch,
      consumed_bytes: this.#consumed,
      framed_events: this.#framed,
      duplicate_events: this.#duplicates,
      observation: this.#observer.getSnapshot(),
    });
  }
  private clearFrame(): void {
    this.#pending.fill(0);
    this.#length = 0;
  }
  private cancelReader(): void {
    const reader = this.#reader;
    this.#reader = null;
    if (reader) {
      try {
        void reader.cancel("runtime_stream_closed").catch(() => {});
      } catch {
        /* Fixed local outcome only. */
      }
    }
  }
  /** Clear local data immediately, even if the underlying source never settles cancellation. */
  close = (): RuntimeStreamSnapshot => {
    this.#observer.close();
    this.#consumed = 0;
    this.#framed = 0;
    this.#duplicates = 0;
    this.#emptyChunks = 0;
    this.clearFrame();
    this.#pending = new Uint8Array(0);
    this.update({
      status: "closed",
      fault: null,
      event_code: null,
      consumed_bytes: 0,
      framed_events: 0,
      duplicate_events: 0,
    });
    this.#interrupt?.();
    this.cancelReader();
    return this.#snapshot;
  };
  private fail(
    fault: RuntimeStreamFault,
    eventCode: RuntimeObservationResult["code"] | null = null,
  ): void {
    if (this.#snapshot.status === "closed") return;
    this.#observer.disconnect();
    this.clearFrame();
    this.#pending = new Uint8Array(0);
    this.update({ status: "inspect_required", fault, event_code: eventCode });
  }
  private ingest(chunk: unknown): void {
    let bytes: Uint8Array;
    try {
      bytes = byteView(chunk);
    } catch {
      this.fail("invalid_chunk");
      return;
    }
    if (
      bytes.length === 0 &&
      ++this.#emptyChunks > this.#limits.max_empty_chunks
    ) {
      this.fail("empty_chunk_limit");
      return;
    }
    for (const byte of bytes) {
      if (this.#consumed >= this.#limits.max_stream_bytes) {
        this.fail("stream_limit");
        return;
      }
      // Charge actual bytes incrementally: acceptance does not depend on network chunk boundaries.
      this.#consumed++;
      if (byte !== 10) {
        if (this.#length >= this.#limits.max_frame_bytes) {
          this.fail("frame_limit");
          return;
        }
        this.#pending[this.#length++] = byte;
        continue;
      }
      if (this.#framed >= this.#limits.max_frames) {
        this.fail("frame_count_limit");
        return;
      }
      let value: unknown;
      try {
        // ignoreBOM:true preserves U+FEFF so the JSON reader rejects it rather than silently stripping it.
        let text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(this.#pending.subarray(0, this.#length));
        if (text.endsWith("\r")) text = text.slice(0, -1);
        if (text.includes("\r")) throw new TypeError("Invalid frame separator");
        value = readRuntimeStreamJson(text);
      } catch {
        this.fail("invalid_frame");
        return;
      }
      this.clearFrame();
      const result = this.#observer.accept(value);
      this.#framed++;
      if (result.disposition === "duplicate") this.#duplicates++;
      this.update({ event_code: result.code });
      if (result.disposition === "rejected" || result.recovery === "inspect") {
        this.fail("observation_rejected", result.code);
        return;
      }
    }
    this.update({});
  }
  /** Consume exactly one source. A second call never steals or alters an existing reader. */
  read = async (
    source: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<RuntimeStreamSnapshot> => {
    if (this.#snapshot.status === "closed") return this.#snapshot;
    if (this.#claimed)
      throw new TypeError("Runtime event stream already consumed");
    this.#claimed = true;
    if (signal?.aborted) return this.close();
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = ReadableStream.prototype.getReader.call(
        source,
      ) as ReadableStreamDefaultReader<Uint8Array>;
    } catch {
      this.fail("invalid_source");
      return this.#snapshot;
    }
    this.#reader = reader;
    const abort = () => {
      this.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) return this.close();
      this.update({ status: "reading" });
      while (this.#snapshot.status === "reading") {
        const interrupted = new Promise<null>((resolve) => {
          this.#interrupt = () => resolve(null);
        });
        let part: ReadableStreamReadResult<Uint8Array> | null;
        try {
          part = await Promise.race([reader.read(), interrupted]);
        } finally {
          this.#interrupt?.();
          this.#interrupt = null;
        }
        if (this.#snapshot.status !== "reading" || part === null) break;
        if (part.done) {
          if (this.#length > 0) this.fail("truncated_frame");
          else if (
            ["succeeded", "failed", "cancelled"].includes(
              this.#observer.getSnapshot().reported_state ?? "",
            )
          )
            this.update({ status: "ended" });
          else this.fail("unexpected_eof");
          break;
        }
        this.ingest(part.value);
      }
    } catch {
      this.fail("transport_lost");
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#interrupt = null;
      if (this.#snapshot.status !== "ended") this.cancelReader();
      this.#reader = null;
      try {
        reader.releaseLock();
      } catch {
        /* Native readers release after read/cancel; no raw error escapes. */
      }
      this.clearFrame();
      this.#pending = new Uint8Array(0);
    }
    return this.#snapshot;
  };
}
