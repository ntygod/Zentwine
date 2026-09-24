#!/usr/bin/env python3
"""Zentwine quality checks. Only fixed commands; report locations/rules, never secret values."""
from __future__ import annotations
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
REQUIRED_JOBS = {"policy", "engineering", "database", "durability", "documentation"}

class CheckError(Exception):
    pass

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def read_json(path: Path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise CheckError("duplicate_json_key")
            result[key] = value
        return result
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs)

def safe_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name:
        raise CheckError("unsafe_path")
    pure = PurePosixPath(name)
    if pure.is_absolute() or any(p in ("..", ".") for p in name.split("/")):
        raise CheckError("unsafe_path")
    path = root / name
    # Reject symlinks at every existing component, not merely the final leaf.
    cursor = root
    for part in pure.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise CheckError("symlink_not_allowed")
    if not path.resolve().is_relative_to(root.resolve()):
        raise CheckError("path_outside_root")
    return path

def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL, timeout=20)

def base_file(root: Path, base: str | None, name: str) -> bytes | None:
    if base is None:
        return None
    if not SHA.fullmatch(base):
        raise CheckError("invalid_base_sha")
    git(root, "cat-file", "-e", f"{base}^{{commit}}")
    names = git(root, "ls-tree", "-r", "--name-only", "-z", base).decode().split("\0")
    return git(root, "show", f"{base}:{name}") if name in names else None

def tracked(root: Path) -> list[str]:
    return sorted(n for n in git(root, "ls-files", "-z").decode().split("\0") if n)

def report(errors: list, **extra) -> dict:
    return {"status": "failed" if errors else "passed", **extra, "errors": errors}

# No snippets or secret fingerprints are printed. Fingerprints only scope reviewed synthetic exclusions.
SECRET_RULES = {
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "github_token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b"),
    "provider_key": re.compile(r"\bsk-(?:ant-[A-Za-z0-9_-]{16,}|proj-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{24,})\b"),
    "aws_access_key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "credential_url": re.compile(r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|https?)://[^\s:/]+:[^\s@/'\"]+@"),
    "literal_secret": re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b[\"']?\s*[:=]\s*[\"'][^\"'\r\n]{12,}[\"']"),
}

def secret_findings(name: str, data: bytes) -> list[dict]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        # Text credentials inside unexpected binary data must not silently disappear.
        if name.endswith((".png", ".jpg", ".webp", ".ico")):
            return []
        return [{"path": name, "line": 0, "rule": "unsupported_binary"}]
    found = []
    for line_no, line in enumerate(text.splitlines(), 1):
        for rule, pattern in SECRET_RULES.items():
            if pattern.search(line):
                found.append({"path": name, "line": line_no, "rule": rule,
                              "line_sha256": sha(line.encode())})
    return found

def check_secrets(root: Path, base: str | None = None) -> dict:
    allow_name = "quality/synthetic-secrets.json"
    exclusions = read_json(root / allow_name)["entries"]
    old = base_file(root, base, allow_name)
    # New suppressions cannot approve themselves in the same ordinary PR.
    approved = json.loads(old)["entries"] if old else exclusions
    keys = set()
    for item in approved:
        if set(item) != {"path", "line_sha256", "rule", "reason"} or len(item["reason"]) < 12:
            raise CheckError("invalid_secret_exclusion")
        if not DIGEST.fullmatch(item["line_sha256"]) or item["rule"] not in SECRET_RULES:
            raise CheckError("invalid_secret_exclusion")
        safe_path(root, item["path"])
        keys.add((item["path"], item["line_sha256"], item["rule"]))
    errors, suppressed, scanned = [], 0, 0
    for name in tracked(root):
        path = safe_path(root, name)
        if not path.is_file():
            errors.append({"path": name, "rule": "tracked_file_missing"})
            continue
        if path.stat().st_size > 2_000_000:
            errors.append({"path": name, "rule": "file_exceeds_scan_limit"})
            continue
        scanned += 1
        for match in secret_findings(name, path.read_bytes()):
            if (name, match.get("line_sha256"), match["rule"]) in keys:
                suppressed += 1
            else:
                errors.append({k: match[k] for k in ("path", "line", "rule")})
    return report(errors, scanned_files=scanned, reviewed_synthetic_matches=suppressed,
                  scope="tracked_working_tree_not_full_history")

ANNOTATIONS = {"title", "description", "$comment", "examples", "default"}
def semantic_schema(value):
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key in ANNOTATIONS:
            continue
        if key in ("properties", "$defs", "definitions", "patternProperties", "dependentSchemas"):
            result[key] = {name: semantic_schema(sub) for name, sub in item.items()}
        elif key in ("items", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames", "not", "if", "then", "else"):
            result[key] = semantic_schema(item)
        elif key in ("allOf", "anyOf", "oneOf", "prefixItems"):
            result[key] = [semantic_schema(sub) for sub in item]
        else:
            result[key] = item
    return result

def no_remote_refs(schema):
    if isinstance(schema, dict):
        for key, value in schema.items():
            if key in ("$ref", "$dynamicRef") and not (isinstance(value, str) and value.startswith("#")):
                raise CheckError("remote_schema_reference_forbidden")
            no_remote_refs(value)
    elif isinstance(schema, list):
        for value in schema:
            no_remote_refs(value)

def check_contracts(root: Path, base: str | None = None) -> dict:
    from jsonschema import Draft202012Validator, FormatChecker
    errors, positive, negative = [], 0, 0
    pairs = [("runtime-start", "runtime-start"), ("runtime-event", "runtime-event"),
             ("evidence", "evidence"), ("flow", "dual-model-flow")]
    for schema_name, example_name in pairs:
        name = f"docs/contracts/{schema_name}.schema.json"
        schema = read_json(root / name)
        no_remote_refs(schema)
        Draft202012Validator.check_schema(schema)
        previous = base_file(root, base, name)
        if previous and semantic_schema(json.loads(previous)) != semantic_schema(schema):
            errors.append({"path": name, "rule": "published_schema_requires_new_version_path"})
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        example = read_json(root / f"docs/contracts/{example_name}.example.json")
        if not validator.is_valid(example):
            errors.append({"path": name, "rule": "positive_example_rejected"})
        else:
            positive += 1
        for field in schema["required"]:
            bad = {k: v for k, v in example.items() if k != field}
            if validator.is_valid(bad):
                errors.append({"path": name, "rule": "required_field_not_enforced"})
            negative += 1
        for bad in [dict(example, unexpected_field=True), dict(example, schema_version="unsupported")]:
            if validator.is_valid(bad):
                errors.append({"path": name, "rule": "invalid_example_accepted"})
            negative += 1
    # Generated from the actual compiled package; no importing arbitrary external schemas.
    api = read_json(root / "reports/runtime-contracts.json")
    snapshot_name = "quality/api-v0.1.0.json"
    snapshot = read_json(root / snapshot_name)
    previous = base_file(root, base, snapshot_name)
    if previous and json.loads(previous) != snapshot:
        errors.append({"path": snapshot_name, "rule": "api_contract_snapshot_overwritten"})
    if api["schemas"] != snapshot["schemas"] or api["version"] != snapshot["version"]:
        errors.append({"rule": "compiled_api_contract_drift"})
    for kind in ("bootstrap", "error"):
        schema = api["schemas"][kind]
        no_remote_refs(schema)
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        if not validator.is_valid(api["examples"][kind]):
            errors.append({"rule": "actual_api_response_invalid", "kind": kind})
        else:
            positive += 1
        for field in schema["required"]:
            bad = dict(api["examples"][kind]); del bad[field]
            negative += 1
            if validator.is_valid(bad):
                errors.append({"rule": "api_required_field_not_enforced", "kind": kind})
    return report(errors, positive_cases=positive, negative_cases=negative,
                  scope="four_planning_contracts_and_two_implemented_api_schemas")

MIGRATIONS = "packages/db/migrations/manifest.json"
def validate_migrations(root: Path, base: str | None = None) -> dict:
    data = read_json(root / MIGRATIONS)
    if set(data) != {"schema_version", "migrations"} or data["schema_version"] != 1 or not isinstance(data["migrations"], list):
        raise CheckError("invalid_migration_manifest")
    errors, last, registered = [], 0, set()
    for entry in data["migrations"]:
        if set(entry) != {"id", "transactional", "up", "down", "verify"}:
            raise CheckError("invalid_migration_entry")
        ident = entry["id"]
        if not re.fullmatch(r"\d{4}-[a-z][a-z0-9-]{0,60}", ident) or int(ident[:4]) <= last or entry["transactional"] is not True:
            raise CheckError("unordered_or_unsupported_migration")
        last = int(ident[:4])
        for part in ("up", "down", "verify"):
            meta = entry[part]
            if set(meta) != {"path", "sha256"} or not DIGEST.fullmatch(meta["sha256"]):
                raise CheckError("invalid_migration_file")
            expected = f"packages/db/migrations/{ident}.{part}.sql"
            if meta["path"] != expected:
                raise CheckError("migration_path_mismatch")
            path = safe_path(root, expected); content = path.read_bytes()
            registered.add(expected)
            if sha(content) != meta["sha256"]:
                errors.append({"path": expected, "rule": "migration_digest_mismatch"})
            if not content.strip() or len(content) > 256_000:
                errors.append({"path": expected, "rule": "invalid_migration_size"})
            # Conservative allowlist mode: complex/nontransactional migrations require a future explicit implementation.
            text = content.decode("utf-8")
            if re.search(r"(?i)\b(BEGIN|COMMIT|ROLLBACK|CONCURRENTLY|VACUUM|COPY|DO|CALL|pg_sleep|dblink)\b|\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|DATABASE|SYSTEM|EXTENSION)\b|\\(?:connect|include)", text):
                errors.append({"path": expected, "rule": "unsupported_migration_statement"})
    actual = {str(p.relative_to(root)) for p in (root / "packages/db/migrations").rglob("*.sql")}
    if actual != registered:
        errors.append({"rule": "unregistered_migration_files"})
    previous = base_file(root, base, MIGRATIONS)
    if previous:
        old = json.loads(previous)["migrations"]
        if data["migrations"][:len(old)] != old:
            errors.append({"rule": "migration_history_changed"})
    return report(errors, migrations=len(data["migrations"]),
                  applicability="no_business_migrations" if not data["migrations"] else "transactional_reversible_only")

def check_workflows(root: Path) -> dict:
    import yaml
    errors = []
    def inspect(value, name):
        if isinstance(value, dict):
            if value.get("continue-on-error") not in (None, "false"):
                errors.append({"path": name, "rule": "continue_on_error_forbidden"})
            if "uses" in value and not re.fullmatch(r"(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[a-f0-9]{40}|\./\.github/workflows/[a-z-]+\.yml)", value["uses"]):
                errors.append({"path": name, "rule": "unpinned_action"})
            if value.get("secrets") == "inherit" or "secrets." in str(value):
                errors.append({"path": name, "rule": "pr_secrets_forbidden"})
            if "permissions" in value and value["permissions"] != {"contents": "read"}:
                errors.append({"path": name, "rule": "write_permissions_forbidden"})
            for v in value.values(): inspect(v, name)
        elif isinstance(value, list):
            for v in value: inspect(v, name)
    paths = sorted((root / ".github/workflows").glob("*.yml"))
    documents = {}
    for path in paths:
        name = str(path.relative_to(root)); doc = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
        if not isinstance(doc, dict): raise CheckError("invalid_workflow")
        documents[path.name] = doc
        inspect(doc, name)
        if doc.get("permissions") != {"contents": "read"} or "pull_request_target" in doc.get("on", {}):
            errors.append({"path": name, "rule": "unsafe_workflow_permissions_or_trigger"})
    main = documents.get("quality.yml", {})
    triggers = main.get("on", {})
    if "pull_request" not in triggers or triggers.get("pull_request") not in ("", None, {}) or "push" not in triggers:
        errors.append({"rule": "quality_trigger_incomplete"})
    jobs = main.get("jobs", {})
    if set(jobs) != REQUIRED_JOBS | {"quality-gate"}:
        errors.append({"rule": "required_job_missing"})
    gate = jobs.get("quality-gate", {})
    if set(gate.get("needs", [])) != REQUIRED_JOBS or gate.get("if") != "${{ always() }}":
        errors.append({"rule": "aggregate_must_run_after_every_required_job"})
    for key, job in jobs.items():
        if key != "quality-gate" and "if" in job:
            errors.append({"rule": "required_job_conditional"})
    for key, target in {"engineering":"validate-foundation.yml", "database":"validate-testkit.yml", "durability":"validate-durable-spike.yml", "documentation":"validate-plans.yml"}.items():
        if jobs.get(key, {}).get("uses") != f"./.github/workflows/{target}" or "workflow_call" not in documents.get(target, {}).get("on", {}):
            errors.append({"rule": "required_reusable_workflow_missing", "job": key})
    required_commands = {
        "validate-foundation.yml": ["pnpm check", "pnpm format:check", "pnpm test:e2e", "pnpm audit", "git diff --exit-code"],
        "validate-testkit.yml": ["pnpm test:fixtures", "pnpm test:integration", "pnpm test:migrations", "pnpm migration-check"],
        "validate-durable-spike.yml": ["npm ci", "npm run build", "npm run test:unit", "npm run test:integration", "npm audit"],
        "validate-plans.yml": ["/tmp/zentwine-docs-venv/bin/python scripts/validate_plans.py --validate-schemas"],
        "quality.yml": ["pnpm test:integrity", "pnpm contract-check", "pnpm test:quality", "pnpm test:live", "python3 scripts/quality/gate.py secrets", "python3 scripts/quality/gate.py aggregate"],
    }
    for filename, commands in required_commands.items():
        steps = [step for job in documents.get(filename, {}).get("jobs", {}).values() for step in job.get("steps", [])]
        for command in commands:
            matches = [step for step in steps if any(line.strip().startswith(command) for line in step.get("run", "").splitlines())]
            if not matches or any("if" in step for step in matches):
                errors.append({"path": filename, "rule": "mandatory_command_missing_or_conditional"})
    scripts = read_json(root / "package.json")["scripts"]
    if scripts.get("check") != "pnpm lint && pnpm build && pnpm typecheck && pnpm test" or scripts.get("test") != "node --test tests/*.test.mjs":
        errors.append({"rule": "required_root_test_pipeline_changed"})
    return report(errors, workflow_files=len(paths))

def check_dependencies(root: Path) -> dict:
    errors, manifests = [], 0
    for name in tracked(root):
        if not name.endswith("package.json"): continue
        manifests += 1; data = read_json(root / name)
        for group in ("dependencies", "devDependencies", "optionalDependencies"):
            for package, version in data.get(group, {}).items():
                if version != "workspace:*" and not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
                    errors.append({"path": name, "package": package, "rule": "dependency_not_exact"})
    if not (root / "pnpm-lock.yaml").is_file(): errors.append({"rule":"missing_lock"})
    return report(errors, manifests=manifests, note="Advisory audit runs separately; exact versions do not prove safety")

def live_status(env: dict[str, str]) -> dict:
    names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
    # Do not trim, print, persist, hash or use the values. Presence is not valid authentication.
    present = [key for key in names if bool(env.get(key))]
    return {"schema_version": 1, "status": "blocked_live" if present else "skipped_live",
            "reason": "adapters_not_implemented" if present else "credentials_not_configured",
            "executed": False, "fixture_used_as_live_evidence": False,
            "providers": [{"provider": p, "status": "not_run"} for p in ("anthropic", "openai")],
            "note": "Never certifies live capability. This command does not call a provider."}

def make_manifest(root: Path, directory: Path, suite: str, result: str) -> dict:
    if directory.is_symlink(): raise CheckError("symlink_not_allowed")
    files = []
    for p in sorted(directory.rglob("*")):
        if p.is_symlink(): raise CheckError("symlink_not_allowed")
        if p.is_file() and str(p.relative_to(directory)) != "artifact-manifest.json":
            files.append({"path": str(p.relative_to(directory)), "bytes": p.stat().st_size, "sha256": sha(p.read_bytes())})
    if not files: raise CheckError("empty_artifacts")
    commit = git(root, "rev-parse", "HEAD").decode().strip()
    tree = git(root, "rev-parse", "HEAD^{tree}").decode().strip()
    return {"schema_version": 1, "kind": "ci_build_manifest", "tested_commit": commit, "source_tree": tree,
            "suite": suite, "job_status": result, "created_at": datetime.now(timezone.utc).isoformat(),
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID"), "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "lock_sha256": sha((root / "pnpm-lock.yaml").read_bytes()), "files": files,
            "trust": "integrity_index_not_signature_or_production_acceptance"}

def verify_manifest(directory: Path, expected_commit: str | None = None) -> dict:
    value = read_json(safe_path(directory, "artifact-manifest.json"))
    errors, seen = [], set()
    if value.get("schema_version") != 1 or not SHA.fullmatch(value.get("tested_commit", "")) or not SHA.fullmatch(value.get("source_tree", "")):
        raise CheckError("invalid_manifest")
    if expected_commit and value["tested_commit"] != expected_commit:
        errors.append({"rule": "artifact_commit_mismatch"})
    for entry in value["files"]:
        name = entry["path"]
        if name in seen or not DIGEST.fullmatch(entry["sha256"]): raise CheckError("invalid_manifest_entry")
        seen.add(name); p = safe_path(directory, name)
        if not p.is_file() or p.stat().st_size != entry["bytes"] or sha(p.read_bytes()) != entry["sha256"]:
            errors.append({"path": name, "rule": "artifact_integrity_mismatch"})
    actual = set()
    for p in directory.rglob("*"):
        if p.is_symlink(): raise CheckError("symlink_not_allowed")
        if p.is_file() and str(p.relative_to(directory)) != "artifact-manifest.json": actual.add(str(p.relative_to(directory)))
    if seen != actual: errors.append({"rule": "artifact_file_set_mismatch"})
    if not seen: errors.append({"rule": "empty_artifacts"})
    return report(errors, tested_commit=value["tested_commit"], verified_files=len(seen))

def aggregate(needs: dict) -> dict:
    errors = []
    if set(needs) != REQUIRED_JOBS: errors.append({"rule": "required_job_set_mismatch"})
    for name in sorted(REQUIRED_JOBS):
        state = needs.get(name, {}).get("result", "missing")
        if state != "success": errors.append({"job": name, "rule": "required_job_not_success", "result": state})
    return report(errors, scope="engineering_only_not_live_or_production")

def inspect_python_tests(source: str) -> dict:
    tree = ast.parse(source)
    methods, disabled = {}, False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
            if node.name in methods: raise CheckError("duplicate_python_test_name")
            methods[node.name] = ast.dump(node, include_attributes=False)
        if isinstance(node, ast.Attribute) and node.attr in ("skip", "skipIf", "skipUnless", "expectedFailure", "skipTest"):
            disabled = True
    return {"tests": methods, "disabled": disabled}

def check_python_tests(root: Path, base: str | None) -> dict:
    if base is None: base = git(root, "rev-parse", "HEAD").decode().strip()
    if not SHA.fullmatch(base): raise CheckError("invalid_base_sha")
    prior = {p for p in git(root, "ls-tree", "-r", "--name-only", "-z", base).decode().split("\0") if p.startswith("tests/") and p.endswith(".py")}
    current = {p for p in tracked(root) if p.startswith("tests/") and p.endswith(".py")}
    errors = []
    for name in prior | current:
        if not (root / name).is_file():
            errors.append({"path": name, "rule": "python_test_file_removed"}); continue
        new = inspect_python_tests((root / name).read_text())
        if new["disabled"]: errors.append({"path": name, "rule": "python_test_disabled"})
        if name in prior:
            old = inspect_python_tests(git(root, "show", f"{base}:{name}").decode())
            for ident, body in old["tests"].items():
                if new["tests"].get(ident) != body: errors.append({"path": name, "rule": "required_python_test_changed"})
    return report(errors, protected_files=len(prior))

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["tests", "secrets", "contracts", "migrations", "workflows", "dependencies", "live-status", "manifest", "verify-manifest", "aggregate"])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--base", default=os.environ.get("QUALITY_BASE_REF"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--expected-commit")
    parser.add_argument("--suite", default="quality")
    parser.add_argument("--job-status", default="unknown")
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        actions = {"tests": lambda: check_python_tests(root, args.base), "secrets": lambda: check_secrets(root, args.base),
                   "contracts": lambda: check_contracts(root, args.base),
                   "migrations": lambda: validate_migrations(root, args.base),
                   "workflows": lambda: check_workflows(root),
                   "dependencies": lambda: check_dependencies(root),
                   "live-status": lambda: live_status(os.environ),
                   "manifest": lambda: make_manifest(root, args.directory, args.suite, args.job_status),
                   "verify-manifest": lambda: verify_manifest(args.directory, args.expected_commit),
                   "aggregate": lambda: aggregate(json.loads(os.environ.get("QUALITY_NEEDS", "{}")))}
        value = actions[args.command]()
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 1 if value.get("status") in ("failed", "blocked_live") else 0
    except Exception:
        # No raw exception serialization: even a rejected path/JSON value may contain a credential.
        print(json.dumps({"status": "failed", "check": args.command, "rule": "invalid_input_or_check_error"}))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
