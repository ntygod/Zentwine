"""Temporary read-only diagnostic for the isolated editor's unavailable formatter."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
FILES = ["packages/client/src/runtime-observer.ts", "packages/client/src/index.ts", "tests/runtime-observer.test.mjs"]

class RuntimeObserverFormatDiagnostic(unittest.TestCase):
    def test_read_only_fixed_formatter_proposals(self):
        original = {name: (ROOT / name).read_bytes() for name in FILES}
        script = """import fs from 'node:fs';
import prettier from 'prettier';
const names = JSON.parse(process.argv[1]);
const result = [];
for (const name of names) {
  const content = fs.readFileSync(name, 'utf8');
  result.push({path: name, formatted: await prettier.format(content, {filepath: name})});
}
console.log(JSON.stringify({formatter: prettier.version, files: result}));"""
        result = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, json.dumps(FILES)], cwd=ROOT, timeout=20))
        self.assertEqual(result["formatter"], "3.6.2")
        for item in result["files"]:
            item["original_sha256"] = hashlib.sha256(original[item["path"]]).hexdigest()
            self.assertEqual((ROOT / item["path"]).read_bytes(), original[item["path"]])
        target = ROOT / "reports/runtime-observer-format.json"
        target.parent.mkdir(exist_ok=True)
        target.write_text(json.dumps(result), encoding="utf-8")
