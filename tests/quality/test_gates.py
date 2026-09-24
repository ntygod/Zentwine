"""Negative tests use synthetic strings and isolated directories, never provider credentials."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("zt_gate", ROOT / "scripts/quality/gate.py")
gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)

class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
    def tearDown(self):
        self.tmp.cleanup()
    def write(self, name, data):
        path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data) if not isinstance(data, str) else data)
        return path
    def repo(self):
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
    def test_all_required_jobs_must_succeed(self):
        value = {name: {"result": "success"} for name in gate.REQUIRED_JOBS}
        self.assertEqual(gate.aggregate(value)["status"], "passed")
    def test_missing_skipped_cancelled_and_failed_jobs_are_not_green(self):
        for state in ["skipped", "cancelled", "failure", "neutral", "pending"]:
            value = {name: {"result": "success"} for name in gate.REQUIRED_JOBS}
            value["database"]["result"] = state
            self.assertEqual(gate.aggregate(value)["status"], "failed")
        self.assertEqual(gate.aggregate({})["status"], "failed")
    def test_unexpected_job_does_not_substitute_required_job(self):
        value = {name: {"result": "success"} for name in gate.REQUIRED_JOBS}
        value["other"] = value.pop("database")
        self.assertEqual(gate.aggregate(value)["status"], "failed")
    def test_live_without_keys_is_explicitly_skipped(self):
        self.assertEqual(gate.live_status({})["status"], "skipped_live")
        self.assertFalse(gate.live_status({})["executed"])
    def test_live_with_keys_never_claims_unimplemented_adapter_success(self):
        secret = "synthetic-not-a-key"
        value = gate.live_status({"OPENAI_API_KEY": secret})
        self.assertEqual(value["status"], "blocked_live")
        self.assertNotIn(secret, json.dumps(value))
    def test_provider_key_detection_reports_only_location(self):
        text = 'value="' + "sk-" + "x" * 32 + '"'
        hits = gate.secret_findings("example.txt", text.encode())
        self.assertEqual(hits[0]["rule"], "provider_key")
        self.assertNotIn(text, json.dumps(hits))
    def test_private_key_and_github_patterns(self):
        for sample in ["-----BEGIN " + "PRIVATE KEY-----", "ghp_" + "z" * 36, "AKIA" + "X" * 16]:
            self.assertTrue(gate.secret_findings("input.txt", sample.encode()))
    def test_safe_placeholder_is_not_a_provider_key(self):
        self.assertFalse(gate.secret_findings("input.txt", b"OPENAI_API_KEY=replace_me"))
    def test_whitelist_requires_exact_path_rule_and_line_hash(self):
        text = 'value="' + "sk-" + "x" * 32 + '"'
        finding = gate.secret_findings("fixture.txt", text.encode())[0]
        allow = {k: finding[k] for k in ["path", "line_sha256", "rule"]}; allow["reason"] = "synthetic test string reviewed for this fixture"
        self.write("quality/synthetic-secrets.json", {"entries": [allow]}); self.write("fixture.txt", text); self.repo()
        self.assertEqual(gate.check_secrets(self.root)["status"], "passed")
        self.write("fixture.txt", text + " altered")
        self.assertEqual(gate.check_secrets(self.root)["status"], "failed")
    def test_new_secret_suppression_cannot_approve_itself(self):
        self.write("quality/synthetic-secrets.json", {"entries": []}); self.repo()
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@zentwine.invalid", "commit", "-qm", "baseline"], cwd=self.root, check=True)
        base = gate.git(self.root, "rev-parse", "HEAD").decode().strip()
        text = 'value="' + "sk-" + "x" * 32 + '"'
        f = gate.secret_findings("fixture.txt", text.encode())[0]
        self.write("fixture.txt", text)
        self.write("quality/synthetic-secrets.json", {"entries": [{"path": f["path"], "line_sha256": f["line_sha256"], "rule": f["rule"], "reason": "not approved in trusted baseline"}]})
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        self.assertEqual(gate.check_secrets(self.root, base)["status"], "failed")
    def test_path_traversal_is_rejected(self):
        for name in ["../outside", "/tmp/outside", "a/../b", "a\\b"]:
            with self.assertRaises(gate.CheckError): gate.safe_path(self.root, name)
    def test_symlink_is_rejected(self):
        (self.root / "link").symlink_to(self.root.parent)
        with self.assertRaises(gate.CheckError): gate.safe_path(self.root, "link/value")
    def test_duplicate_json_keys_fail(self):
        path = self.write("x.json", '{"a":1,"a":2}')
        with self.assertRaises(gate.CheckError): gate.read_json(path)
    def manifest(self):
        self.write("artifacts/build.bin", "synthetic-build")
        data = {"schema_version": 1, "tested_commit": "a" * 40, "source_tree": "b" * 40,
                "files": [{"path": "build.bin", "bytes": 15, "sha256": gate.sha(b"synthetic-build")} ]}
        data["files"][0]["bytes"] = len(b"synthetic-build")
        self.write("artifacts/artifact-manifest.json", data)
        return self.root / "artifacts"
    def test_manifest_validates_all_files(self):
        self.assertEqual(gate.verify_manifest(self.manifest(), "a" * 40)["status"], "passed")
    def test_manifest_rejects_tampering(self):
        directory = self.manifest(); self.write("artifacts/build.bin", "tampered")
        self.assertEqual(gate.verify_manifest(directory)["status"], "failed")
    def test_manifest_rejects_missing_file(self):
        directory = self.manifest(); (directory / "build.bin").unlink()
        self.assertEqual(gate.verify_manifest(directory)["status"], "failed")
    def test_manifest_rejects_unlisted_file(self):
        directory = self.manifest(); self.write("artifacts/extra.txt", "extra")
        self.assertEqual(gate.verify_manifest(directory)["status"], "failed")
    def test_manifest_rejects_stale_commit(self):
        self.assertEqual(gate.verify_manifest(self.manifest(), "c" * 40)["status"], "failed")
    def test_manifest_rejects_duplicate_entries(self):
        directory = self.manifest(); data = gate.read_json(directory / "artifact-manifest.json")
        data["files"].append(data["files"][0]); self.write("artifacts/artifact-manifest.json", data)
        with self.assertRaises(gate.CheckError): gate.verify_manifest(directory)
    def test_no_migrations_is_not_production_migration_success(self):
        self.write(gate.MIGRATIONS, {"schema_version":1,"migrations":[]})
        value = gate.validate_migrations(self.root)
        self.assertEqual(value["applicability"], "no_business_migrations")
    def migration(self):
        item = {"id":"0001-test", "transactional":True}
        for part, sql in {"up":"CREATE TABLE example(id int)", "down":"DROP TABLE example", "verify":"SELECT true AS verified"}.items():
            name = f"packages/db/migrations/0001-test.{part}.sql"; self.write(name, sql)
            item[part] = {"path":name,"sha256":gate.sha(sql.encode())}
        self.write(gate.MIGRATIONS, {"schema_version":1,"migrations":[item]})
        return item
    def test_migration_manifest_and_hashes_pass(self):
        self.migration(); self.assertEqual(gate.validate_migrations(self.root)["status"], "passed")
    def test_changed_migration_digest_fails(self):
        item = self.migration(); self.write(item["up"]["path"], "SELECT 1")
        self.assertEqual(gate.validate_migrations(self.root)["status"], "failed")
    def test_unregistered_sql_fails(self):
        self.migration(); self.write("packages/db/migrations/unregistered.sql", "SELECT 1")
        self.assertEqual(gate.validate_migrations(self.root)["status"], "failed")
    def test_rewritten_migration_history_fails(self):
        item = self.migration(); self.repo()
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@zentwine.invalid", "commit", "-qm", "baseline"], cwd=self.root, check=True)
        base = gate.git(self.root, "rev-parse", "HEAD").decode().strip()
        item["verify"]["sha256"] = gate.sha(b"SELECT false AS verified")
        self.write(item["verify"]["path"], "SELECT false AS verified")
        self.write(gate.MIGRATIONS, {"schema_version":1,"migrations":[item]})
        self.assertEqual(gate.validate_migrations(self.root, base)["status"], "failed")
    def test_nontransactional_migration_fails_closed(self):
        item = self.migration(); item["transactional"] = False
        self.write(gate.MIGRATIONS,{"schema_version":1,"migrations":[item]})
        with self.assertRaises(gate.CheckError): gate.validate_migrations(self.root)
    def test_migration_cannot_escape_directory(self):
        item = self.migration(); item["up"]["path"] = "../../outside"
        self.write(gate.MIGRATIONS,{"schema_version":1,"migrations":[item]})
        with self.assertRaises(gate.CheckError): gate.validate_migrations(self.root)
    def test_schema_annotation_changes_are_not_validation_changes(self):
        old = {"type":"object","description":"old","properties":{"title":{"type":"string"}}}
        new = {**old,"description":"new"}
        self.assertEqual(gate.semantic_schema(old), gate.semantic_schema(new))
        new["properties"] = {"title":{"type":"number"}}
        self.assertNotEqual(gate.semantic_schema(old), gate.semantic_schema(new))
    def test_schema_remote_references_are_never_fetched(self):
        with self.assertRaises(gate.CheckError): gate.no_remote_refs({"$ref":"https://example.invalid/secret"})
        gate.no_remote_refs({"$ref":"#/$defs/item"})
    def workflow_copy(self):
        shutil.copytree(ROOT / ".github/workflows", self.root / ".github/workflows")
        shutil.copyfile(ROOT / "package.json", self.root / "package.json")
        return self.root / ".github/workflows/quality.yml"
    def test_actual_workflow_structure(self):
        self.assertEqual(gate.check_workflows(ROOT)["status"], "passed")
    def test_workflow_missing_dependency_is_rejected(self):
        p = self.workflow_copy(); p.write_text(p.read_text().replace("[policy, engineering, database, durability, documentation]", "[policy, engineering]"))
        self.assertEqual(gate.check_workflows(self.root)["status"], "failed")
    def test_workflow_write_permission_is_rejected(self):
        p = self.workflow_copy(); p.write_text(p.read_text().replace("contents: read", "contents: write"))
        self.assertEqual(gate.check_workflows(self.root)["status"], "failed")
    def test_workflow_continue_on_error_is_rejected(self):
        p = self.workflow_copy(); p.write_text(p.read_text().replace("    timeout-minutes: 12", "    continue-on-error: true\n    timeout-minutes: 12"))
        self.assertEqual(gate.check_workflows(self.root)["status"], "failed")
    def test_workflow_unpinned_action_is_rejected(self):
        p = self.workflow_copy(); p.write_text(p.read_text().replace("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "actions/checkout@main"))
        self.assertEqual(gate.check_workflows(self.root)["status"], "failed")
    def test_removing_test_command_is_rejected_even_when_job_remains(self):
        self.workflow_copy(); p = self.root / ".github/workflows/validate-foundation.yml"
        p.write_text(p.read_text().replace("pnpm test:e2e", "echo passed"))
        self.assertEqual(gate.check_workflows(self.root)["status"], "failed")
    def test_schema_constant_values_are_not_annotations(self):
        self.assertNotEqual(gate.semantic_schema({"const":{"title":"before"}}), gate.semantic_schema({"const":{"title":"after"}}))
    def test_python_skip_decorators_are_detected(self):
        self.assertTrue(gate.inspect_python_tests("@unittest.skip('reason')\ndef test_one(): pass")["disabled"])
    def test_same_migration_sequence_cannot_be_reused(self):
        item = self.migration(); other = copy.deepcopy(item); other["id"] = "0001-zother"
        self.write(gate.MIGRATIONS,{"schema_version":1,"migrations":[item,other]})
        with self.assertRaises(gate.CheckError): gate.validate_migrations(self.root)
    def test_nested_unlisted_manifest_is_not_ignored(self):
        directory = self.manifest(); self.write("artifacts/nested/artifact-manifest.json", "extra")
        self.assertEqual(gate.verify_manifest(directory)["status"], "failed")
    def test_dependency_range_is_rejected(self):
        self.write("package.json", {"dependencies":{"test-library":"^1.0.0"}}); self.write("pnpm-lock.yaml", "test fixture"); self.repo()
        self.assertEqual(gate.check_dependencies(self.root)["status"], "failed")

if __name__ == "__main__": unittest.main()
