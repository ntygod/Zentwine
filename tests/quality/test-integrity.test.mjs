import test from "node:test";
import assert from "node:assert/strict";
import {
  compareTests,
  inspectTests,
} from "../../scripts/check-test-integrity.mjs";
const base =
  'import test from "node:test"; test("required", () => { assert.equal(1, 1); });';
test("quality: removing a required test fails", () => {
  assert.ok(compareTests(base, "").includes("required_test_removed"));
});
test("quality: altering a required assertion fails", () => {
  assert.ok(
    compareTests(base, base.replace("assert.equal(1, 1)", "true")).includes(
      "required_test_changed",
    ),
  );
});
test("quality: skip and focus variants fail", () => {
  for (const modifier of ["skip", "todo", "only", "fixme", "fail"]) {
    assert.ok(
      inspectTests(`test.${modifier}("case", () => {});`).violations.length > 0,
    );
  }
});
test("quality: runtime skip option fails", () => {
  assert.ok(
    inspectTests('test("case", {skip: enabled}, () => {});').violations.length >
      0,
  );
});
test("quality: a false skip option is not a disabled test", () => {
  assert.deepEqual(
    inspectTests('test("case", {skip: false}, () => {});').violations,
    [],
  );
});
test("quality: adding an independent test is allowed", () => {
  assert.deepEqual(compareTests(base, base + 'test("added", () => {});'), []);
});
test("quality: formatting and comments do not change assertions", () => {
  assert.deepEqual(
    compareTests(
      base,
      base.replace(
        "assert.equal(1, 1);",
        "/* explanation */ assert.equal( 1, 1 );",
      ),
    ),
    [],
  );
});
test("quality: commented fake test code is ignored", () => {
  assert.equal(
    inspectTests('// test.skip("x", () => {})\nconst text = "test.only";').tests
      .size,
    0,
  );
});
test("quality: duplicate test identity is rejected", () => {
  assert.ok(
    inspectTests(
      base + base.replace('import test from "node:test";', ""),
    ).violations.includes("duplicate_test_identity"),
  );
});
test("quality: invalid syntax is not silently skipped", () => {
  assert.throws(() => inspectTests('test("x", () => {'));
});
test("quality: TypeScript test callbacks preserve type syntax", () => {
  const ts =
    'test("typed", async () => { const x: number = 1; assert.equal(x, 1); });';
  assert.deepEqual(compareTests(ts, ts, "case.test.ts"), []);
});
