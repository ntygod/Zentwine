import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  createRepositoryReviewSession,
  serializeRepositoryReviewNotes,
} from "../packages/client/dist/index.js";
import { inspectRepositoryReview as inspect } from "../scripts/repository-review-inspect.mjs";
import { createCommitReviewFixture } from "./fixtures/commit-review-data.mjs";

// Synthetic opinions and real disposable Git/CLI input; explicitly mocked I/O
// boundaries below deterministically inject cancellation, not filesystem timing.
const fixture = await createCommitReviewFixture();
test.after(() => fixture.cleanup());
const secret = "SYNTHETIC_CANCELLATION_DETAIL";
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function inputs(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zt-cancel-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createRepositoryReviewSession(fixture.detail);
  const notes = serializeRepositoryReviewNotes(session, [
    {
      id: "cancel-note",
      path: "src/example.ts",
      kind: "issue",
      author: "Synthetic reviewer",
      body: secret,
    },
  ]);
  await fs.writeFile(path.join(directory, "comparison.json"), fixture.detail);
  await fs.writeFile(path.join(directory, "review-notes.json"), notes);
  return {
    directory,
    expected: {
      baseCommit: fixture.base,
      headCommit: fixture.head,
      reportSha256: hash(fixture.detail),
      notesSha256: hash(notes),
    },
  };
}
function rejected(report, code, exit) {
  assert.equal(report.fault?.code, code, JSON.stringify(report));
  assert.equal(report.exit_code, exit);
  assert.equal(report.feedback, null);
  assert.equal(report.authorization, false);
  assert.equal(report.code_execution, false);
  assert.ok(Object.isFrozen(report));
  assert.ok(!JSON.stringify(report).includes(secret));
}
function accepted(report, pinned = true) {
  assert.equal(report.status, "inspected", JSON.stringify(report));
  assert.equal(report.exit_code, 0);
  assert.equal(report.authorization, false);
  assert.equal(report.feedback.comparison_verification, "matches_local_git");
  assert.equal(
    report.feedback.expectation_verification,
    pinned ? "matches_explicit_pins" : undefined,
  );
  assert.equal(report.feedback.selected, null);
  assert.ok(!JSON.stringify(report).includes(secret));
}
function watchReads(t, onRead) {
  const open = fs.open.bind(fs);
  const handles = [],
    buffers = [];
  let reads = 0;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (!/\/(comparison|review-notes)\.json$/.test(String(args[0])))
      return handle;
    const record = { closed: false };
    handles.push(record);
    const close = handle.close.bind(handle),
      read = handle.read.bind(handle);
    t.mock.method(handle, "close", async () => {
      await close();
      record.closed = true;
    });
    t.mock.method(handle, "read", async (...readArgs) => {
      const result = await read(...readArgs);
      buffers.push(readArgs[0]);
      await onRead(++reads);
      return result;
    });
    return handle;
  });
  return () => {
    assert.ok(handles.length > 0);
    assert.ok(buffers.length > 0);
    assert.ok(handles.every((handle) => handle.closed));
    assert.ok(buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  };
}

for (const key of ["addEventListener", "removeEventListener"]) {
  test(`review cancellation: never evaluate caller ${key} getter`, async (t) => {
    const input = await inputs(t),
      controller = new AbortController();
    let calls = 0;
    Object.defineProperty(controller.signal, key, {
      get() {
        calls++;
        throw new Error(secret);
      },
    });
    accepted(
      await inspect(fixture.root, input.directory, {
        expected: input.expected,
        signal: controller.signal,
      }),
    );
    assert.equal(calls, 0);
  });
  test(`review cancellation: ignore non-callable ${key} shadow`, async (t) => {
    const input = await inputs(t),
      controller = new AbortController();
    Object.defineProperty(controller.signal, key, { value: null });
    accepted(
      await inspect(fixture.root, input.directory, {
        expected: input.expected,
        signal: controller.signal,
      }),
    );
  });
}
for (const key of ["aborted", "reason"]) {
  test(`review cancellation: reject own ${key} getter before I/O`, async (t) => {
    const controller = new AbortController();
    let calls = 0;
    Object.defineProperty(controller.signal, key, {
      get() {
        calls++;
        throw new Error(secret);
      },
    });
    t.mock.method(fs, "lstat", () => assert.fail("must not read input"));
    rejected(
      await inspect("unused", "unused", { signal: controller.signal }),
      "invalid_arguments",
      64,
    );
    assert.equal(calls, 0);
  });
  test(`review cancellation: reject inherited ${key} getter before I/O`, async (t) => {
    const controller = new AbortController();
    let calls = 0;
    Object.setPrototypeOf(
      controller.signal,
      Object.create(AbortSignal.prototype, {
        [key]: {
          get() {
            calls++;
            throw new Error(secret);
          },
        },
      }),
    );
    t.mock.method(fs, "lstat", () => assert.fail("must not read input"));
    rejected(
      await inspect("unused", "unused", { signal: controller.signal }),
      "invalid_arguments",
      64,
    );
    assert.equal(calls, 0);
  });
}
test("review cancellation: pre-aborted source never reads inputs or its reason", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  controller.abort({
    toString() {
      calls++;
      throw new Error(secret);
    },
  });
  t.mock.method(fs, "lstat", () => assert.fail("must not read input"));
  rejected(
    await inspect("unused", "unused", { signal: controller.signal }),
    "cancelled",
    130,
  );
  assert.equal(calls, 0);
});
test("review cancellation: false aborted data shadow cannot hide native abort", async (t) => {
  const controller = new AbortController();
  controller.abort(secret);
  Object.defineProperty(controller.signal, "aborted", { value: false });
  t.mock.method(fs, "lstat", () => assert.fail("must not read input"));
  rejected(
    await inspect("unused", "unused", { signal: controller.signal }),
    "invalid_arguments",
    64,
  );
});
for (const pinned of [false, true]) {
  test(`review cancellation: stopped source event still cancels (pins=${pinned})`, async (t) => {
    const input = await inputs(t),
      controller = new AbortController();
    let stopped = 0;
    controller.signal.addEventListener("abort", (event) => {
      stopped++;
      event.stopImmediatePropagation();
    });
    const cleared = watchReads(t, (count) => {
      if (count === 1) controller.abort(secret);
    });
    rejected(
      await inspect(fixture.root, input.directory, {
        signal: controller.signal,
        ...(pinned ? { expected: input.expected } : {}),
        path: "src/example.ts",
      }),
      "cancelled",
      130,
    );
    assert.equal(stopped, 1);
    cleared();
  });
}
test("review cancellation: synthetic source abort event does not cancel", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  let events = 0;
  const cleared = watchReads(t, (count) => {
    if (count === 1) {
      events++;
      controller.signal.dispatchEvent(new Event("abort"));
      assert.equal(controller.signal.aborted, false);
    }
  });
  accepted(
    await inspect(fixture.root, input.directory, {
      signal: controller.signal,
      expected: input.expected,
    }),
  );
  assert.equal(events, 1);
  cleared();
});
test("review cancellation: synthetic event cannot consume subsequent native cancellation", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  let nativeAbort = false;
  const cleared = watchReads(t, (count) => {
    if (count === 1) controller.signal.dispatchEvent(new Event("abort"));
    if (count === 2) {
      nativeAbort = true;
      controller.abort(secret);
    }
  });
  rejected(
    await inspect(fixture.root, input.directory, {
      signal: controller.signal,
      expected: input.expected,
    }),
    "cancelled",
    130,
  );
  assert.equal(nativeAbort, true);
  cleared();
});
test("review cancellation: late caller property overrides cannot alter cancellation", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  let calls = 0;
  const cleared = watchReads(t, (count) => {
    if (count !== 1) return;
    for (const key of [
      "aborted",
      "reason",
      "addEventListener",
      "removeEventListener",
    ])
      Object.defineProperty(controller.signal, key, {
        get() {
          calls++;
          throw new Error(secret);
        },
      });
    controller.abort(secret);
  });
  rejected(
    await inspect(fixture.root, input.directory, {
      signal: controller.signal,
      expected: input.expected,
    }),
    "cancelled",
    130,
  );
  assert.equal(calls, 0);
  cleared();
});
test("review cancellation: late removal getter cannot turn success into a raw exception", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  let calls = 0;
  const cleared = watchReads(t, (count) => {
    if (count === 1)
      Object.defineProperty(controller.signal, "removeEventListener", {
        get() {
          calls++;
          throw new Error(secret);
        },
      });
  });
  accepted(
    await inspect(fixture.root, input.directory, {
      signal: controller.signal,
      expected: input.expected,
    }),
  );
  assert.equal(calls, 0);
  cleared();
});
test("review cancellation: no public abort listener is attached to the caller", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort");
  const cleared = watchReads(t, () => {
    assert.deepEqual(getEventListeners(controller.signal, "abort"), before);
  });
  accepted(
    await inspect(fixture.root, input.directory, {
      signal: controller.signal,
      expected: input.expected,
    }),
  );
  assert.deepEqual(getEventListeners(controller.signal, "abort"), before);
  cleared();
});
test("review cancellation: native composed source is supported", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  const source = AbortSignal.any([controller.signal]);
  source.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const cleared = watchReads(t, (count) => {
    if (count === 1) controller.abort(secret);
  });
  rejected(
    await inspect(fixture.root, input.directory, {
      signal: source,
      expected: input.expected,
    }),
    "cancelled",
    130,
  );
  cleared();
});
test("review cancellation: stopped event cancels pending digest, ignoring late completion", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  let entered, finish, owned;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  t.mock.method(crypto.subtle, "digest", async (algorithm, bytes) => {
    owned = bytes;
    const actual = await originalDigest(algorithm, bytes);
    entered();
    await pending;
    return actual;
  });
  controller.signal.addEventListener("abort", (event) =>
    event.stopImmediatePropagation(),
  );
  const cleared = watchReads(t, () => {});
  const running = inspect(fixture.root, input.directory, {
    signal: controller.signal,
    expected: input.expected,
    timeoutMs: 10000,
    path: "src/example.ts",
  });
  try {
    await started;
    controller.abort(secret);
    const report = await running;
    rejected(report, "cancelled", 130);
    cleared();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      new Uint8Array(owned.buffer ?? owned).every((byte) => byte === 0),
    );
    rejected(report, "cancelled", 130);
  } finally {
    finish();
    await running;
  }
});
test("review cancellation: deadline remains timeout with a pending native caller", async (t) => {
  const input = await inputs(t),
    controller = new AbortController();
  const expiredAt = performance.now() + 30000;
  const cleared = watchReads(t, (count) => {
    if (count === 1) t.mock.method(performance, "now", () => expiredAt);
  });
  rejected(
    await inspect(fixture.root, input.directory, {
      signal: controller.signal,
      expected: input.expected,
      timeoutMs: 10000,
    }),
    "timeout",
    124,
  );
  assert.equal(controller.signal.aborted, false);
  cleared();
});
