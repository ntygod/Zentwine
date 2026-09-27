"""Independent Draft 2020-12 validation of implemented runtime wire schemas.

Uses local compiled JS and fixed synthetic cases; never executes a provider or SQL.
"""
import json
import hashlib
from pathlib import Path
import subprocess
import unittest

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]


class RuntimeProtocolSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads(subprocess.check_output(
            ["node", "scripts/export-runtime-protocol.mjs"], cwd=ROOT, timeout=20))
        cls.cases = json.loads(subprocess.check_output(
            ["node", "tests/fixtures/runtime-wire-cases.mjs"], cwd=ROOT, timeout=20))
        cls.validator = Draft202012Validator(cls.schema)

    def test_versioned_snapshot_matches_compiled_contract(self):
        serialized = json.dumps(self.schema, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(hashlib.sha256(serialized).hexdigest(), "089c237dd26866a9ae1da3e06b42e04978d75c1e7fb8316781dedc8b836682e2")
        Draft202012Validator.check_schema(self.schema)

    def test_synthetic_positive_and_negative_schema_cases(self):
        self.assertGreaterEqual(len(self.cases), 100)
        for case in self.cases:
            with self.subTest(case=case["name"]):
                self.assertEqual(self.validator.is_valid(case["value"]), case["schemaValid"])

    def test_frozen_formatter_diagnostics_are_read_only(self):
        # Provisional branch-only diagnostic, removed before final acceptance.
        subprocess.run(["node", "scripts/runtime-format-diagnostics.mjs"], cwd=ROOT, check=True, timeout=30)

    def test_every_required_field_is_structurally_required(self):
        for kind in ("start_run", "runtime_event", "artifact_manifest", "capability_report"):
            sample = next(c["value"] for c in self.cases if c["kind"] == kind and c["schemaValid"])
            for key in sample:
                with self.subTest(kind=kind, missing=key):
                    altered = {k: v for k, v in sample.items() if k != key}
                    self.assertFalse(self.validator.is_valid(altered))

    def test_schema_and_semantic_validation_are_not_conflated(self):
        semantic_only = [c for c in self.cases if c["schemaValid"] and not c["parseValid"]]
        self.assertGreaterEqual(len(semantic_only), 10)
        self.assertTrue(all(self.validator.is_valid(c["value"]) for c in semantic_only))


if __name__ == "__main__":
    unittest.main()
