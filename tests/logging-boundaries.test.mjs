import test from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../packages/telemetry/dist/index.js";

test("ZT01-03 runtime log severity cannot bypass silent or level filters", () => {
  const lines = [];
  for (const level of ["info", "silent"]) {
    const logger = createLogger({ level, sink: (line) => lines.push(line) });
    for (const severity of [
      "silent",
      "invalid",
      "__proto__",
      null,
      undefined,
    ]) {
      logger.log(severity, "diagnostic");
    }
  }
  assert.equal(lines.length, 0);
});
test("ZT01-03 UTF-8 log byte bound includes terminating newline", () => {
  const lines = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });
  for (let count = 1; count <= 50; count++) {
    logger.log("info", "diagnostic", Array(count).fill("汉字".repeat(256)));
  }
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 16384);
    assert.doesNotThrow(() => JSON.parse(line));
    assert.equal(line.split("\n").length, 2);
  }
});
