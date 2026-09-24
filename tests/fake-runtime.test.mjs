import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeRuntime,
  fakeRequest,
  createTenantFixtures,
  fixtureAllows,
  ManualClock,
} from "../packages/testkit/dist/index.js";
const setup = (scope = "runtime") => {
  const [a, b] = createTenantFixtures(scope);
  const clock = new ManualClock();
  return {
    a,
    b,
    clock,
    runtime: new FakeRuntime(a, clock),
    request: fakeRequest(a, "fixture_run"),
  };
};
test("fixtures are reproducible but scopes, tenants and mutable objects are isolated", () => {
  const one = createTenantFixtures("one");
  const two = createTenantFixtures("two");
  assert.deepEqual(one, createTenantFixtures("one"));
  assert.notEqual(one[0].org_id, one[1].org_id);
  assert.notEqual(one[0].org_id, two[0].org_id);
  assert.notEqual(one[0], createTenantFixtures("one")[0]);
  assert.throws(() => {
    one[0].spec.revision = 2;
  }, TypeError);
  assert.throws(() => createTenantFixtures("../production"));
});
test("synthetic owner, reader and outsider have explicit test-only scope", () => {
  const [a, b] = createTenantFixtures("permissions");
  assert.equal(fixtureAllows(a, a.owner_id, a.org_id, "write"), true);
  assert.equal(fixtureAllows(a, a.reader_id, a.org_id, "read"), true);
  assert.equal(fixtureAllows(a, a.reader_id, a.org_id, "write"), false);
  assert.equal(fixtureAllows(a, b.owner_id, a.org_id, "read"), false);
  assert.equal(fixtureAllows(a, a.owner_id, b.org_id, "read"), false);
});
test("read never starts execution, unknown and foreign runs are unavailable", () => {
  const { runtime, a, b } = setup();
  for (const org of [a.org_id, b.org_id])
    assert.throws(() => runtime.observe(org, "fixture_run"), {
      code: "unavailable",
    });
});
test("start is idempotent and snapshots/events are immutable and synthetic", () => {
  const { runtime, a, request } = setup();
  assert.deepEqual(runtime.start(request), runtime.start({ ...request }));
  assert.equal(runtime.events(a.org_id, request.run_id).length, 1);
  const view = runtime.observe(a.org_id, request.run_id);
  assert.throws(() => {
    view.request.model_binding.provider = "openai";
  }, TypeError);
  assert.equal(runtime.advance(a.org_id, request.run_id).state, "succeeded");
  for (const e of runtime.events(a.org_id, request.run_id)) {
    assert.equal(e.fixture_only, true);
    assert.equal(e.payload.fixture_only, true);
    assert.throws(() => {
      e.payload.fixture_only = false;
    }, TypeError);
  }
  assert.equal(runtime.observe(a.org_id, request.run_id).charge_microusd, 0);
  assert.throws(() => runtime.advance(a.org_id, request.run_id), {
    code: "invalid_state",
  });
});
test("same run cannot silently switch model or script", () => {
  const { runtime, a, request } = setup();
  runtime.start(request);
  assert.throws(
    () => runtime.start(fakeRequest(a, request.run_id, "fixture-model-b")),
    { code: "conflict" },
  );
  assert.throws(() => runtime.start(request, [{ type: "unknown" }]), {
    code: "conflict",
  });
});
test("real providers, missing fixture tags and wrong task contexts are rejected", () => {
  const { runtime, request, b } = setup();
  for (const patch of [
    { fixture_only: false },
    { org_id: b.org_id },
    { task_id: b.task_id },
    { workspace_id: b.workspace_id },
    { context_snapshot_id: b.context_snapshot_id },
    {
      model_binding: {
        provider: "openai",
        runtime_id: "codex",
        requested_model_id: "any",
      },
    },
  ])
    assert.throws(() => runtime.start({ ...request, ...patch }), {
      code: "invalid_fixture",
    });
});
test("invalid scripts and unbounded work are rejected before start", () => {
  const { runtime, request } = setup();
  for (const steps of [
    [{ type: "shell", command: "echo no" }],
    [{ type: "wait" }],
    [{ type: "succeed" }, { type: "wait" }],
    [{ type: "fail", reason: "raw-secret" }],
  ])
    assert.throws(() => runtime.start(request, steps), {
      code: "invalid_fixture",
    });
  for (const steps of [
    [],
    Array.from({ length: 257 }, () => ({ type: "wait" })),
  ])
    assert.throws(() => runtime.start(request, steps), {
      code: "limit_exceeded",
    });
});
test("input is bound to context and idempotency key; stale or conflicting input cannot release wait", () => {
  const { runtime, a, request } = setup();
  runtime.start(request, [{ type: "wait" }, { type: "succeed" }]);
  runtime.advance(a.org_id, request.run_id);
  assert.throws(() => runtime.advance(a.org_id, request.run_id), {
    code: "invalid_state",
  });
  assert.throws(
    () =>
      runtime.sendInput(
        a.org_id,
        request.run_id,
        "fixture_input",
        "fixture_stale",
        "continue",
      ),
    { code: "conflict" },
  );
  const args = [
    a.org_id,
    request.run_id,
    "fixture_input",
    request.context_snapshot_id,
  ];
  const first = runtime.sendInput(...args, "continue");
  assert.deepEqual(first, runtime.sendInput(...args, "continue"));
  assert.throws(() => runtime.sendInput(...args, "reject"), {
    code: "conflict",
  });
  assert.equal(runtime.advance(a.org_id, request.run_id).state, "succeeded");
});
test("rejection is terminal and cannot be overwritten", () => {
  const { runtime, a, request } = setup();
  runtime.start(request, [{ type: "wait" }, { type: "succeed" }]);
  runtime.advance(a.org_id, request.run_id);
  assert.equal(
    runtime.sendInput(
      a.org_id,
      request.run_id,
      "fixture_reject",
      request.context_snapshot_id,
      "reject",
    ).state,
    "failed",
  );
  assert.throws(
    () =>
      runtime.sendInput(
        a.org_id,
        request.run_id,
        "fixture_later",
        request.context_snapshot_id,
        "continue",
      ),
    { code: "invalid_state" },
  );
});
test("stop request is not cancellation until acknowledged; repeat stop is idempotent", () => {
  const { runtime, a, request } = setup();
  runtime.start(request);
  assert.equal(
    runtime.requestStop(a.org_id, request.run_id).state,
    "stop_requested",
  );
  assert.equal(runtime.requestStop(a.org_id, request.run_id).last_sequence, 2);
  assert.throws(() => runtime.advance(a.org_id, request.run_id), {
    code: "invalid_state",
  });
  assert.equal(
    runtime.acknowledgeStop(a.org_id, request.run_id).state,
    "cancelled",
  );
  assert.equal(
    runtime.acknowledgeStop(a.org_id, request.run_id).last_sequence,
    3,
  );
});
test("stopping a completed run does not rewrite its result", () => {
  const { runtime, a, request } = setup();
  runtime.start(request);
  runtime.advance(a.org_id, request.run_id);
  assert.equal(
    runtime.requestStop(a.org_id, request.run_id).state,
    "succeeded",
  );
  assert.throws(() => runtime.acknowledgeStop(a.org_id, request.run_id), {
    code: "invalid_state",
  });
});
test("transport disconnect can hide remote completion, reconnect does not create another run", () => {
  const { runtime, a, request } = setup();
  runtime.start(request);
  runtime.setConnected(false);
  runtime.advance(a.org_id, request.run_id);
  assert.throws(() => runtime.observe(a.org_id, request.run_id), {
    code: "unavailable",
  });
  runtime.setConnected(true);
  assert.equal(runtime.start(request).state, "succeeded");
  assert.deepEqual(
    runtime.events(a.org_id, request.run_id, 1).map((e) => e.type),
    ["run.succeeded"],
  );
});
test("duplicate/omitted/reordered delivery never corrupts original event history", () => {
  const { runtime, a, request, clock } = setup();
  runtime.start(request, [
    { type: "artifact", artifact_id: "fixture_interface_v1" },
    { type: "succeed" },
  ]);
  clock.advance(10);
  runtime.advance(a.org_id, request.run_id);
  runtime.advance(a.org_id, request.run_id);
  assert.deepEqual(
    runtime
      .transport(a.org_id, request.run_id, {
        reverse: true,
        duplicate: true,
        omit: [2],
      })
      .map((e) => e.sequence),
    [3, 3, 1, 1],
  );
  assert.deepEqual(
    runtime.events(a.org_id, request.run_id).map((e) => e.sequence),
    [1, 2, 3],
  );
  assert.equal(
    runtime.events(a.org_id, request.run_id)[1].occurred_at,
    "2026-09-24T00:00:00.010Z",
  );
  for (const after of [-1, 999, 1.5])
    assert.throws(() => runtime.events(a.org_id, request.run_id, after));
});
test("failure, timeout and unconfirmed tool outcome are distinct from success", () => {
  for (const step of [
    { type: "fail", reason: "injected_failure" },
    { type: "fail", reason: "timeout" },
    { type: "unknown" },
  ]) {
    const { runtime, a, request } = setup();
    runtime.start(request, [step]);
    assert.equal(
      runtime.advance(a.org_id, request.run_id).state,
      step.type === "unknown" ? "unknown" : "failed",
    );
    assert.throws(() => runtime.advance(a.org_id, request.run_id));
  }
});
test("parallel synthetic model instances and tenants remain isolated", async () => {
  const [a, b] = createTenantFixtures("parallel");
  const runtimes = [new FakeRuntime(a), new FakeRuntime(b)];
  await Promise.all(
    [a, b].map(async (tenant, index) => {
      const runtime = runtimes[index];
      const req = fakeRequest(
        tenant,
        "fixture_shared_run",
        index ? "fixture-model-b" : "fixture-model-a",
      );
      runtime.start(req);
      await Promise.resolve();
      runtime.advance(tenant.org_id, req.run_id);
      assert.equal(
        runtime.observe(tenant.org_id, req.run_id).state,
        "succeeded",
      );
      assert.throws(
        () => runtime.observe(index ? a.org_id : b.org_id, req.run_id),
        { code: "unavailable" },
      );
    }),
  );
  assert.notEqual(
    runtimes[0].events(a.org_id, "fixture_shared_run")[0].event_id,
    runtimes[1].events(b.org_id, "fixture_shared_run")[0].event_id,
  );
});
test("simulation has a bounded run count", () => {
  const { runtime, a } = setup();
  for (let i = 0; i < 128; i++)
    runtime.start(fakeRequest(a, `fixture_run_${i}`));
  assert.throws(() => runtime.start(fakeRequest(a, "fixture_extra")), {
    code: "limit_exceeded",
  });
});
