/** Provisional, read-only formatter proposals for review. Never rewrites tracked source. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as prettier from "prettier";
assert.equal(prettier.version, "3.6.2");
const paths = [
  "packages/contracts/src/index.ts",
  "packages/contracts/src/runtime-wire.ts",
  "packages/contracts/src/runtime-protocol.ts",
  "scripts/export-runtime-protocol.mjs",
  "tests/fixtures/runtime-wire-v1.mjs",
  "tests/fixtures/runtime-wire-cases.mjs",
  "tests/runtime-protocol.test.mjs",
];
const entries = [];
for (const path of paths) {
  const source = await fs.readFile(path, "utf8");
  const formatted = await prettier.format(source, { filepath: path });
  assert.equal(await prettier.format(formatted, { filepath: path }), formatted);
  assert.equal(await fs.readFile(path, "utf8"), source);
  entries.push({ path, source_sha256: createHash("sha256").update(source).digest("hex"), formatted });
}
await fs.mkdir("reports", { recursive: true });
await fs.writeFile("reports/runtime-format-proposals.json", JSON.stringify({ version: prettier.version, read_only: true, entries }, null, 2) + "\n");
