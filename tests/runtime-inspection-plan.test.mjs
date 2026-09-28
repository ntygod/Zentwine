import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeInputInspection, RUNTIME_INSPECTION_PLAN_BYTES } from "../packages/client/dist/index.js";
import { inspectionFixture } from "./fixtures/runtime-inspection-data.mjs";
const json = () => JSON.stringify(inspectionFixture().plan);
const reject = (value) => assert.throws(() => createRuntimeInputInspection(value), { name: "TypeError", message: "Invalid local runtime inspection plan" });

test("inspection plan: public entry constructs idle whole-input bundle without starting work", () => {
  const bundle = createRuntimeInputInspection(json());
  const view = bundle.getSnapshot();
  assert.equal(view.status, "idle");
  assert.equal(view.authorization, false);
  assert.equal(view.producers.length, 2);
  assert.equal(view.artifacts.length, 2);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.artifacts[0].binding));
  bundle.close();
});
for (const value of [null, undefined, {}, [], 1, "", "null", "[]", "{}", "\ufeff{}", "{"]) {
  test(`inspection plan: invalid root ${JSON.stringify(value)} rejected`, () => reject(value));
}
for (const mutate of [
  (p) => { p.inspection_version = "2.0.0"; },
  (p) => { delete p.inspection_version; },
  (p) => { p.authorization = true; },
  (p) => { p.producers = null; },
  (p) => { p.producers = []; },
  (p) => { p.producers[0].url = "https://invalid.example/"; },
  (p) => { p.producers[0].request.org_id = p.consumer.run_id; },
  (p) => { p.producers[0].manifest.manifest_id = p.producers[1].manifest.manifest_id; },
  (p) => { p.consumer.input_artifacts[0].revision = "999"; },
  (p) => { p.producers.push(structuredClone(p.producers[0])); },
  (p) => { p.producers[0].manifest.artifacts[0].size_bytes = 4194305; },
]) {
  test(`inspection plan: rejects invalid plan ${mutate.toString()}`, () => {
    const p = inspectionFixture().plan;
    mutate(p);
    reject(JSON.stringify(p));
  });
}
for (const text of [
  '{"inspection_version":"1.0.0","inspection_version":"1.0.0","consumer":{},"producers":[]}',
  '{"inspection_version":"1.0.0","consumer":{},"cons\\u0075mer":{},"producers":[]}',
  json().replace('"size_bytes":', '"size_bytes":1,"size_bytes":'),
  json().replace('"producers":', '"__proto__":{},"producers":'),
  json() + "{}",
  "[".repeat(18) + "0" + "]".repeat(18),
  "[" + Array(8193).fill("0").join(",") + "]",
]) {
  test(`inspection plan: strict JSON rejection ${text.slice(0, 80)}`, () => reject(text));
}
test("inspection plan: exact byte budget includes whitespace and rejects one more byte", () => {
  const text = json();
  const exact = text + " ".repeat(RUNTIME_INSPECTION_PLAN_BYTES - new TextEncoder().encode(text).length);
  const bundle = createRuntimeInputInspection(exact);
  assert.equal(bundle.getSnapshot().status, "idle");
  bundle.close();
  reject(exact + " ");
});
test("inspection plan: UTF8 budget cannot be bypassed with non-ASCII strings", () => {
  reject('"' + "🎻".repeat(66000) + '"');
});
test("inspection plan: errors never echo supplied contents or URLs", () => {
  reject('{"secret":"not-for-error-output"}');
});
test("inspection plan: valid empty input requires no producers and is not execution authority", () => {
  const p = inspectionFixture().plan;
  p.consumer.input_artifacts = [];
  p.producers = [];
  const bundle = createRuntimeInputInspection(JSON.stringify(p));
  assert.equal(bundle.begin().status, "ready");
  assert.equal(bundle.takeAll().authorization, false);
  bundle.close();
});
test("inspection plan: actual producer streams and bytes reach all-input ready then clear", async () => {
  const f = inspectionFixture();
  const bundle = createRuntimeInputInspection(JSON.stringify(f.plan));
  bundle.begin();
  const from = (bytes) => new Blob([bytes]).stream();
  await Promise.all(f.events.map((text, i) => bundle.observeProducer(f.plan.producers[i].manifest.manifest_id, from(new TextEncoder().encode(text)))));
  assert.equal(bundle.getSnapshot().status, "awaiting_artifacts");
  await Promise.all(f.bytes.map((bytes, i) => bundle.readArtifact(f.plan.consumer.input_artifacts[i].artifact_id, from(bytes))));
  assert.equal(bundle.getSnapshot().status, "ready");
  assert.equal(bundle.close().artifacts.length, 0);
});

test("inspection example: explicit generator emits consumable files and refuses overwrite", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zentwine-inspection-"));
  const target = path.join(parent, "example");
  try {
    const run = () => spawnSync(process.execPath, ["scripts/runtime-inspection-example.mjs", target], { encoding: "utf8" });
    assert.equal(run().status, 0);
    const content = await fs.readFile(path.join(target, "plan.json"), "utf8");
    const bundle = createRuntimeInputInspection(content);
    const f = inspectionFixture();
    bundle.begin();
    for (let i = 0; i < f.events.length; i++)
      await bundle.observeProducer(f.plan.producers[i].manifest.manifest_id, new Blob([await fs.readFile(path.join(target, `producer-${i + 1}.ndjson`))]).stream());
    for (let i = 0; i < f.bytes.length; i++)
      await bundle.readArtifact(f.plan.consumer.input_artifacts[i].artifact_id, new Blob([await fs.readFile(path.join(target, `input-${i + 1}.bin`))]).stream());
    assert.equal(bundle.getSnapshot().status, "ready");
    bundle.close();
    assert.equal(run().status, 1);
    assert.equal(await fs.readFile(path.join(target, "plan.json"), "utf8"), content);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
