"""Temporary read-only formatter diagnostic; removed before acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest


class BundleFormatDiagnostic(unittest.TestCase):
    def test_read_only_fixed_formatter(self):
        paths = ["packages/client/src/runtime-input-bundle.ts", "packages/client/src/index.ts", "tests/runtime-input-bundle.test.mjs"]
        output = []
        for name in paths:
            original = Path(name).read_bytes()
            result = subprocess.run(["node", "node_modules/prettier/bin/prettier.cjs", name], check=True, capture_output=True)
            self.assertEqual(Path(name).read_bytes(), original)
            output.append({"path": name, "original_sha256": hashlib.sha256(original).hexdigest(), "formatted": result.stdout.decode("utf-8")})
        Path("reports").mkdir(exist_ok=True)
        Path("reports/bundle-format-suggestions.json").write_text(json.dumps(output), encoding="utf-8")
