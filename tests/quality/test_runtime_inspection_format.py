"""Temporary read-only formatter diagnostics, removed before final acceptance."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]

class RuntimeInspectionFormatDiagnostic(unittest.TestCase):
    def test_read_only_format_suggestions(self):
        script = 'import fs from "node:fs";\nimport { createHash } from "node:crypto";\nimport * as prettier from "./node_modules/prettier/index.mjs";\nconst paths = ["apps/studio/src/main.tsx", "apps/studio/src/runtime-inspector.css", "packages/client/src/index.ts", "packages/client/src/runtime-inspection-plan.ts", "packages/ui/src/index.tsx", "packages/ui/src/runtime-inspector.tsx", "tests/fixtures/runtime-inspection-data.mjs", "tests/runtime-inspection-plan.test.mjs", "tests/browser/runtime-inspector.spec.ts", "scripts/runtime-inspection-example.mjs"];\nconst result = [];\nfor (const path of paths) {\n const source = fs.readFileSync(path, "utf8");\n const formatted = await prettier.format(source, { filepath: path });\n if (source !== fs.readFileSync(path, "utf8")) throw new Error("source mutated");\n result.push({ path, sha256: createHash("sha256").update(source).digest("hex"), formatted });\n}\nconsole.log(JSON.stringify(result));\n'
        result = subprocess.check_output(["node", "--input-type=module", "-e", script], cwd=ROOT, text=True, timeout=30)
        data = json.loads(result)
        self.assertEqual(len(data), 10)
        report = ROOT / "reports/runtime-inspection-format.json"
        report.parent.mkdir(exist_ok=True)
        report.write_text(json.dumps(data), encoding="utf8")
