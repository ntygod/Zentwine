"""Temporary read-only fixed formatter diagnostic; removed before final acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
FILES = ["packages/client/src/runtime-stream-json.ts", "packages/client/src/runtime-stream.ts", "packages/client/src/index.ts", "tests/runtime-stream.test.mjs"]

class RuntimeStreamFormatDiagnostic(unittest.TestCase):
    def test_read_only_fixed_format_suggestions(self):
        formatter = ROOT / "node_modules/prettier/bin/prettier.cjs"
        version = subprocess.check_output(["node", str(formatter), "--version"], cwd=ROOT, text=True).strip()
        self.assertEqual(version, "3.6.2")
        entries = []
        for name in FILES:
            path = ROOT / name
            original = path.read_bytes()
            result = subprocess.run(["node", str(formatter), "--stdin-filepath", name], input=original, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT, check=True)
            self.assertEqual(path.read_bytes(), original)
            entries.append({"path": name, "original_sha256": hashlib.sha256(original).hexdigest(), "formatted": result.stdout.decode("utf-8")})
        reports = ROOT / "reports"
        reports.mkdir(exist_ok=True)
        (reports / "runtime-stream-format.json").write_text(json.dumps({"formatter": version, "files": entries}), encoding="utf-8")
