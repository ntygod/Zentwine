"""Temporary read-only formatting evidence. Removed before final acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
FILES = ["packages/client/src/runtime-input-artifact.ts", "packages/client/src/index.ts", "tests/runtime-input-artifact.test.mjs"]


class InputArtifactFormatDiagnostic(unittest.TestCase):
    def test_read_only_fixed_formatter_suggestions(self):
        output = {}
        for filename in FILES:
            path = ROOT / filename
            before = path.read_bytes()
            formatted = subprocess.check_output(
                ["node", "node_modules/prettier/bin/prettier.cjs", filename],
                cwd=ROOT, timeout=30)
            self.assertEqual(path.read_bytes(), before)
            output[filename] = {"original_sha256": hashlib.sha256(before).hexdigest(),
                                "formatted": formatted.decode("utf-8")}
        report = ROOT / "reports" / "quality" / "input-artifact-format.json"
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
