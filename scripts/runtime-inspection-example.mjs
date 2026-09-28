/** Explicit developer example generator. Refuses existing output directories. */
import fs from "node:fs";
import path from "node:path";
import { inspectionFixture } from "../tests/fixtures/runtime-inspection-data.mjs";
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  console.error("Usage: node scripts/runtime-inspection-example.mjs <new-output-directory>");
  process.exitCode = 1;
} else {
  try {
    fs.mkdirSync(directory);
    const f = inspectionFixture();
    fs.writeFileSync(path.join(directory, "plan.json"), JSON.stringify(f.plan, null, 2), { flag: "wx" });
    f.events.forEach((text, i) => fs.writeFileSync(path.join(directory, `producer-${i + 1}.ndjson`), text, { flag: "wx" }));
    f.bytes.forEach((bytes, i) => fs.writeFileSync(path.join(directory, `input-${i + 1}.bin`), bytes, { flag: "wx" }));
    console.log("Created synthetic inspection example. No model calls or execution authorization.");
  } catch {
    console.error("Could not create example. Use a new directory with an existing writable parent; existing paths are never overwritten.");
    process.exitCode = 1;
  }
}
