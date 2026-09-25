/** Fixed coverage registry. A rejected placeholder route is NOT implemented authorization. */
export const scenarios = Object.freeze([
  "cross_tenant",
  "role_downgrade",
  "stale_authority",
  "concurrent_revocation",
]);
export const surfaces = Object.freeze([
  "rest",
  "websocket",
  "search",
  "files",
  "preview",
  "export",
]);
const implemented = new Set(["rest", "websocket", "search"]);
export const caseId = (surface, scenario) =>
  `access-matrix ${surface} ${scenario}`;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...expected].sort())
  );
}
export function validateMatrix(value) {
  if (
    !keys(value, ["schema_version", "task", "surfaces"]) ||
    value.schema_version !== 1 ||
    value.task !== "ZT02-06-A" ||
    !Array.isArray(value.surfaces) ||
    value.surfaces.length !== surfaces.length
  )
    throw new Error("invalid_matrix_definition");
  const cells = [];
  for (const [index, name] of surfaces.entries()) {
    const row = value.surfaces[index];
    const availability = implemented.has(name)
      ? "implemented"
      : "unimplemented";
    if (
      !keys(row, ["id", "availability", "scope", "cases"]) ||
      row.id !== name ||
      row.availability !== availability ||
      row.scope !==
        (availability === "implemented"
          ? "catalog_metadata_only"
          : "reserved_route_denial_only") ||
      !Array.isArray(row.cases) ||
      !equal(
        row.cases,
        scenarios.map((s) => caseId(name, s)),
      )
    )
      throw new Error("missing_or_misclassified_matrix_cell");
    for (const scenario of scenarios)
      cells.push({
        id: caseId(name, scenario),
        surface: name,
        scenario,
        assertion_scope: row.scope,
        functional_coverage: availability === "implemented",
      });
  }
  return cells;
}
/** Exact top-level TAP identities and totals, not a grep for the word 'pass'. */
export function verifyTap(text, exitCode, cells) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > 2 * 1024 * 1024 ||
    exitCode !== 0 ||
    !text.startsWith("TAP version 13\n") ||
    /^(?:not ok\b|Bail out!)/m.test(text) ||
    text
      .split("\n")
      .some(
        (line) =>
          /#\s*(?:SKIP|TODO)\b/i.test(line) && !/^# todo 0\r?$/.test(line),
      )
  )
    throw new Error("matrix_test_execution_failed");
  const passed = [...text.matchAll(/^ok \d+ - (access-matrix [^\r\n]+)$/gm)]
    .map((m) => m[1])
    .sort();
  const expected = cells.map((c) => c.id).sort();
  const plans = [...text.matchAll(/^1\.\.(\d+)\r?$/gm)];
  if (plans.length !== 1 || Number(plans[0][1]) !== expected.length)
    throw new Error("invalid_matrix_test_plan");
  const summary = (key) => {
    const matches = [
      ...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, "gm")),
    ];
    if (matches.length !== 1) throw new Error("invalid_matrix_test_summary");
    return Number(matches[0][1]);
  };
  if (
    !equal(passed, expected) ||
    summary("tests") !== expected.length ||
    summary("pass") !== expected.length ||
    ["fail", "cancelled", "skipped", "todo"].some((k) => summary(k) !== 0)
  )
    throw new Error("missing_or_duplicate_matrix_evidence");
  return passed;
}
export function coverageSummary(cells, executed = false) {
  return {
    executed,
    work_package_complete: false,
    functional_cells: cells.filter((c) => c.functional_coverage).length,
    reserved_route_guard_cells: cells.filter((c) => !c.functional_coverage)
      .length,
    deferred_surfaces: surfaces.filter((s) => !implemented.has(s)),
    remaining_deliverables: ["audit_view", "emergency_revocation_workflow"],
    live_models: "not_executed",
    production_acceptance: false,
  };
}
