import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateMatrix,
  verifyTap,
  coverageSummary,
  caseId,
} from "../scripts/access-matrix.mjs";
const source = JSON.parse(
  fs.readFileSync("quality/access-matrix.json", "utf8"),
);
const definition = () => structuredClone(source);
const cells = validateMatrix(source);
function tap() {
  return [
    "TAP version 13",
    ...cells.map((c, i) => `ok ${i + 1} - ${c.id}`),
    "1..24",
    "# tests 24",
    "# pass 24",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "",
  ].join("\n");
}
test("access matrix: complete definition preserves twelve unsupported guard cells", () => {
  assert.equal(cells.length, 24);
  assert.deepEqual(coverageSummary(cells), {
    executed: false,
    work_package_complete: false,
    functional_cells: 12,
    reserved_route_guard_cells: 12,
    deferred_surfaces: ["files", "preview", "export"],
    remaining_deliverables: ["audit_view", "emergency_revocation_workflow"],
    live_models: "not_executed",
    production_acceptance: false,
  });
});
test("access matrix: removing a surface cannot silently reduce expected coverage", () => {
  const bad = definition();
  bad.surfaces.pop();
  assert.throws(() => validateMatrix(bad));
});
test("access matrix: duplicate surface and missing scenario are rejected", () => {
  const duplicate = definition();
  duplicate.surfaces[1] = duplicate.surfaces[0];
  assert.throws(() => validateMatrix(duplicate));
  const missing = definition();
  missing.surfaces[0].cases.pop();
  assert.throws(() => validateMatrix(missing));
});
test("access matrix: placeholders cannot be relabelled as implemented", () => {
  const bad = definition();
  bad.surfaces[3].availability = "implemented";
  bad.surfaces[3].scope = "catalog_metadata_only";
  assert.throws(() => validateMatrix(bad));
});
test("access matrix: unknown and privilege-shaped fields fail closed", () => {
  for (const key of ["skip", "command", "external_url", "approved"]) {
    const bad = definition();
    bad.surfaces[0][key] = true;
    assert.throws(() => validateMatrix(bad));
  }
});
test("access matrix: exact TAP names and totals form execution evidence", () => {
  assert.deepEqual(verifyTap(tap(), 0, cells), cells.map((c) => c.id).sort());
  assert.equal(coverageSummary(cells, true).work_package_complete, false);
});
test("access matrix: process failure overrides even an all-green transcript", () => {
  for (const status of [1, 2, null])
    assert.throws(() => verifyTap(tap(), status, cells));
});
test("access matrix: missing or duplicate case identities cannot pass", () => {
  assert.throws(() => verifyTap(tap().replace(/^ok 1 - .*\n/m, ""), 0, cells));
  assert.throws(() => verifyTap(tap() + `ok 25 - ${cells[0].id}\n`, 0, cells));
});
test("access matrix: unexpected names cannot substitute for required scenarios", () => {
  assert.throws(() =>
    verifyTap(tap().replace(cells[0].id, caseId("rest", "other")), 0, cells),
  );
});
test("access matrix: skipped todo cancelled and failing tests reject certification", () => {
  for (const key of ["fail", "cancelled", "skipped", "todo"])
    assert.throws(() =>
      verifyTap(tap().replace(`# ${key} 0`, `# ${key} 1`), 0, cells),
    );
  for (const directive of ["# SKIP optional", "# TODO later"])
    assert.throws(() => verifyTap(tap() + directive, 0, cells));
  assert.throws(() => verifyTap(tap() + "not ok 25 - other\n", 0, cells));
  assert.throws(() => verifyTap(tap() + "Bail out!\n", 0, cells));
});
test("access matrix: totals must exist exactly once and match the full matrix", () => {
  for (const transcript of [
    tap().replace("# tests 24", "# tests 0"),
    tap().replace("# pass 24\n", ""),
    tap() + "# pass 24\n",
  ])
    assert.throws(() => verifyTap(transcript, 0, cells));
});
test("access matrix: oversized or malformed execution evidence is rejected", () => {
  assert.throws(() => verifyTap(null, 0, cells));
  assert.throws(() => verifyTap("x".repeat(2 * 1024 * 1024 + 1), 0, cells));
  assert.throws(() => verifyTap("passed", 0, cells));
});
test("access matrix: check mode never claims a database test was executed", () => {
  const r = spawnSync(
    process.execPath,
    ["scripts/run-access-matrix.mjs", "--check"],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, "definition_valid_not_executed");
  assert.equal(report.executed, false);
  assert.equal(report.work_package_complete, false);
});
test("access matrix: missing configuration replaces stale green evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zt-matrix-"));
  try {
    fs.mkdirSync(path.join(root, "quality"));
    fs.mkdirSync(path.join(root, "reports"));
    fs.copyFileSync(
      "quality/access-matrix.json",
      path.join(root, "quality/access-matrix.json"),
    );
    const reportPath = path.join(root, "reports/access-matrix-evidence.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ status: "passed", executed: true }),
    );
    const r = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-access-matrix.mjs")],
      {
        cwd: root,
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(r.status, 1);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.executed, false);
    assert.equal(report.passed_case_ids, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("access matrix: TAP header and one complete plan are mandatory", () => {
  for (const transcript of [
    tap().replace("TAP version 13\n", ""),
    tap().replace("1..24\n", ""),
    tap() + "1..24\n",
    tap().replace("1..24", "1..0"),
  ])
    assert.throws(() => verifyTap(transcript, 0, cells));
});
