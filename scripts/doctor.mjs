import fs from "node:fs";
import { spawnSync } from "node:child_process";
const runtime = process.versions.node;
const pnpm = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--version"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
const checks = [
  {
    name: "Node 24.21.0 (tested baseline)",
    pass: runtime === "24.21.0",
    value: runtime,
  },
  {
    name: "pnpm 11.10.0",
    pass: pnpm.stdout?.trim() === "11.10.0",
    value: pnpm.stdout?.trim() || "not found",
  },
  {
    name: "Dependency lock",
    pass: fs.existsSync("pnpm-lock.yaml"),
    value: "pnpm-lock.yaml",
  },
  {
    name: "Built API",
    pass: fs.existsSync("services/api/dist/main.js"),
    value: "run pnpm build",
  },
];
for (const check of checks)
  console.log(`${check.pass ? "PASS" : "CHECK"} ${check.name}: ${check.value}`);
if (checks.some((check) => !check.pass)) process.exitCode = 1;
console.log(
  "No credentials, user data, model endpoints or deployment targets are inspected.",
);
