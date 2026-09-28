"""Temporary read-only pinned-formatter diagnostic; remove before final acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest


class RuntimeCliFormatDiagnostic(unittest.TestCase):
    def test_read_only_format_suggestions(self):
        files = [
            "scripts/runtime-inspect.mjs",
            "tests/runtime-inspect-cli.test.mjs",
            "tests/fixtures/runtime-inspect-faults.mjs",
        ]
        suggestions = []
        for name in files:
            source = Path(name).read_bytes()
            run = subprocess.run(
                ["node", "node_modules/prettier/bin/prettier.cjs", name],
                capture_output=True, check=True, timeout=30,
            )
            self.assertEqual(Path(name).read_bytes(), source)
            suggestions.append({"path": name, "sha256": hashlib.sha256(source).hexdigest(),
                                "formatted": run.stdout.decode("utf-8")})
        Path("reports").mkdir(exist_ok=True)
        Path("reports/runtime-cli-format.json").write_text(json.dumps(suggestions), encoding="utf-8")
