import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWire,
  wireString,
  wireInteger,
  wireArray,
  wireObject,
  RUNTIME_WIRE_LIMITS,
} from "../packages/contracts/dist/runtime-wire.js";

const text = wireString("^[\\s\\S]*$", RUNTIME_WIRE_LIMITS.bytes, 0);
const integer = wireInteger(0, 1);
const rejected = {
  name: "TypeError",
  message: "Invalid runtime protocol message",
};

test("runtime wire limits: exact JSON byte budget includes string quotes", () => {
  const atLimit = "x".repeat(RUNTIME_WIRE_LIMITS.bytes - 2);
  assert.equal(parseWire(text, atLimit), atLimit);
  assert.throws(() => parseWire(text, atLimit + "x"), rejected);
});

test("runtime wire limits: UTF-8 and escaped property names are charged", () => {
  const key = "\n";
  const codec = wireObject({ [key]: text });
  const overhead = Buffer.byteLength(JSON.stringify({ [key]: "" }));
  const remaining = RUNTIME_WIRE_LIMITS.bytes - overhead;
  const content =
    "中".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const input = { [key]: content };
  assert.equal(
    Buffer.byteLength(JSON.stringify(input)),
    RUNTIME_WIRE_LIMITS.bytes,
  );
  assert.deepEqual(parseWire(codec, input), input);
  assert.throws(() => parseWire(codec, { [key]: content + "x" }), rejected);
});

test("runtime wire limits: node budget includes root and every array item", () => {
  const codec = wireArray(integer, RUNTIME_WIRE_LIMITS.nodes);
  const input = Array(RUNTIME_WIRE_LIMITS.nodes - 1).fill(0);
  assert.deepEqual(parseWire(codec, input), input);
  assert.throws(() => parseWire(codec, [...input, 0]), rejected);
});

test("runtime wire limits: depth boundary is independent of field validation", () => {
  let codec = integer;
  let input = 1;
  for (let i = 0; i < RUNTIME_WIRE_LIMITS.depth; i++) {
    codec = wireObject({ value: codec });
    input = { value: input };
  }
  assert.deepEqual(parseWire(codec, input), input);
  assert.throws(
    () => parseWire(wireObject({ value: codec }), { value: input }),
    rejected,
  );
});

test("runtime wire limits: shared JSON nodes copy independently, cycles fail", () => {
  const child = wireObject({ value: integer });
  const codec = wireObject({ left: child, right: child });
  const shared = { value: 1 };
  const parsed = parseWire(codec, { left: shared, right: shared });
  assert.deepEqual(parsed.left, parsed.right);
  assert.notEqual(parsed.left, parsed.right);
  assert.ok(Object.isFrozen(parsed.left));
  shared.value = shared;
  assert.throws(
    () => parseWire(codec, { left: shared, right: shared }),
    rejected,
  );
});
