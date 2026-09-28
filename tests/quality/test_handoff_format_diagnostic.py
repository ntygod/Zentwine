"""Temporary read-only formatter diagnostics; remove before acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest


class HandoffFormatDiagnostic(unittest.TestCase):
    def test_fixed_formatter_reports_without_changing_sources(self):
        root = Path(__file__).resolve().parents[2]
        formatter = root / "node_modules/prettier/bin/prettier.cjs"
        package = json.loads((root / "node_modules/prettier/package.json").read_text())
        self.assertEqual(package["version"], "3.6.2")
        paths = [
            "packages/client/src/index.ts",
            "packages/client/src/runtime-artifact-handoff.ts",
            "tests/runtime-artifact-handoff.test.mjs",
            "tests/fixtures/runtime-handoff-data.mjs",
            "tests/fixtures/runtime-handoff-peer.mjs",
        ]
        results = []
        for name in paths:
            original = (root / name).read_bytes()
            output = subprocess.run(
                ["node", str(formatter), "--stdin-filepath", name],
                input=original, capture_output=True, check=True, cwd=root,
            ).stdout
            self.assertEqual((root / name).read_bytes(), original)
            results.append({"path": name, "original_sha256": hashlib.sha256(original).hexdigest(), "formatted": output.decode("utf-8")})
        target = root / "reports/quality/handoff-format.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"version": package["version"], "files": results}, ensure_ascii=False))
