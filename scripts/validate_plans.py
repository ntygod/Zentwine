#!/usr/bin/env python3
"""Validate planning documents; optionally export a task index. No network or writes to GitHub."""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit

TASK_ID = re.compile(r"ZT\d{2}-\d{2}")
TASK_ROW = re.compile(r"^\|\s*(ZT\d{2}-\d{2})\s*\|")
LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
GENERATED_DIRS = {'.git', 'node_modules', 'dist', 'reports', 'test-results', 'playwright-report', '.pnpm-store', '.bin', '__pycache__'}

def markdown_sources(root: Path) -> list[Path]:
    """Prune installed dependencies and generated output, not repository documentation."""
    found: list[Path] = []
    for directory, names, files in os.walk(root):
        names[:] = [name for name in names if name not in GENERATED_DIRS]
        found.extend(Path(directory) / name for name in files if name.endswith('.md'))
    return sorted(found)

def check_graph(graph: dict[str, list[str]], label: str) -> list[str]:
    errors: list[str] = []
    visiting: set[str] = set()
    done: set[str] = set()
    def visit(node: str, trail: list[str]) -> None:
        if node in visiting:
            errors.append(f"{label}: cycle: {' -> '.join(trail + [node])}")
            return
        if node in done:
            return
        visiting.add(node)
        for dep in graph[node]:
            if dep not in graph:
                errors.append(f"{label}: {node} references missing {dep}")
            else:
                visit(dep, trail + [node])
        visiting.remove(node)
        done.add(node)
    for node in graph:
        visit(node, [])
    return errors

def validate(root: Path, schemas: bool) -> tuple[list[dict], list[str], dict]:
    errors: list[str] = []
    tasks: list[dict] = []
    modules = sorted((root / 'docs/modules').glob('*.md'))
    for path in modules:
        for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if not TASK_ROW.match(line):
                continue
            cells = [value.strip() for value in line.strip().strip('|').split('|')]
            if len(cells) != 4:
                errors.append(f'{path.name}:{number}: task row must have four columns')
                continue
            task_id, prerequisites, deliverable, acceptance = cells
            tasks.append({'id': task_id, 'module': task_id.split('-')[0], 'status': 'Planned', 'owner': None,
                          'document': str(path.relative_to(root)), 'line': number,
                          'depends_on': TASK_ID.findall(prerequisites), 'dependency_note': prerequisites,
                          'deliverable': deliverable, 'acceptance': acceptance})
            if not deliverable or not acceptance:
                errors.append(f'{task_id}: missing deliverable or acceptance')
    counts = Counter(item['id'] for item in tasks)
    errors.extend(f'duplicate task: {key}' for key, count in counts.items() if count != 1)
    expected = {f'ZT{module:02d}-{task:02d}' for module in range(1, 31) for task in range(1, 7)}
    if set(counts) != expected:
        errors.append(f'task set mismatch: missing={sorted(expected-set(counts))}, extra={sorted(set(counts)-expected)}')
    if len(modules) != 30:
        errors.append(f'expected 30 modules, got {len(modules)}')
    errors.extend(check_graph({t['id']: t['depends_on'] for t in tasks}, 'task dependencies'))
    md_files = markdown_sources(root)
    for path in md_files:
        text = path.read_text(encoding='utf-8')
        if len(re.findall(r'^```', text, re.MULTILINE)) % 2:
            errors.append(f'{path.relative_to(root)}: unmatched fenced code block')
        for raw in LINK.findall(text):
            target = raw.strip().strip('<>')
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            resolved = (path.parent / unquote(parsed.path)).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                errors.append(f'{path.relative_to(root)}: link escapes root: {target}')
                continue
            if not resolved.exists():
                errors.append(f'{path.relative_to(root)}: missing link: {target}')
    test_path = root / 'docs/tests/end-to-end.md'
    scenario_ids = re.findall(r'^\|\s*(E\d{2})\s*\|', test_path.read_text(encoding='utf-8'), re.MULTILINE)
    expected_cases = {f'E{n:02d}' for n in range(1, 53)}
    if set(scenario_ids) != expected_cases or len(scenario_ids) != 52:
        errors.append('scenario IDs must be unique E01-E52')
    contract_dir = root / 'docs/contracts'
    json_files = sorted(contract_dir.glob('*.json'))
    loaded: dict[str, object] = {}
    for path in json_files:
        try:
            loaded[path.name] = json.loads(path.read_text(encoding='utf-8'))
        except (ValueError, OSError) as exc:
            errors.append(f'{path.name}: {exc}')
    flow = loaded.get('dual-model-flow.example.json', {})
    if isinstance(flow, dict):
        nodes = flow.get('nodes', [])
        graph = {node['id']: node['depends_on'] for node in nodes}
        if len(graph) != len(nodes):
            errors.append('flow example contains duplicate node IDs')
        errors.extend(check_graph(graph, 'flow example'))
        agents = [node for node in nodes if node['kind'] == 'agent']
        if len({(n['provider'], n['model_id']) for n in agents}) < 2:
            errors.append('flow example must contain two distinct model bindings')
        if len({n['runtime_id'] for n in agents}) < 2:
            errors.append('flow example must contain two runtimes')
        if len({n['workspace_id'] for n in agents}) != len(agents):
            errors.append('flow example must isolate agent workspaces')
    if schemas:
        try:
            from jsonschema import Draft202012Validator, FormatChecker
        except ImportError:
            errors.append('--validate-schemas requires jsonschema: python -m pip install jsonschema')
        else:
            pairs = [('runtime-start.schema.json', 'runtime-start.example.json'),
                     ('runtime-event.schema.json', 'runtime-event.example.json'),
                     ('evidence.schema.json', 'evidence.example.json'),
                     ('flow.schema.json', 'dual-model-flow.example.json')]
            for schema_name, example_name in pairs:
                try:
                    schema = loaded[schema_name]
                    Draft202012Validator.check_schema(schema)
                    validator = Draft202012Validator(schema, format_checker=FormatChecker())
                    errors.extend(f'{example_name}: {error.message}' for error in validator.iter_errors(loaded[example_name]))
                except (KeyError, ValueError) as exc:
                    errors.append(f'{schema_name}: {exc}')
    report = {'modules': len(modules), 'tasks': len(tasks), 'scenarios': len(scenario_ids),
              'markdown_files': len(md_files), 'contract_json_files': len(json_files),
              'schema_validation_requested': schemas, 'errors': len(errors)}
    return tasks, errors, report

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--validate-schemas', action='store_true')
    parser.add_argument('--export', type=Path, help='Write a JSON task index only after checks pass')
    args = parser.parse_args()
    try:
        tasks, errors, report = validate(args.root.resolve(), args.validate_schemas)
    except (OSError, KeyError, TypeError, ValueError) as exc:
        print(f'Validation error: {exc}', file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    if args.export:
        args.export.parent.mkdir(parents=True, exist_ok=True)
        payload = {'schema_version': '1.0', 'kind': 'planning_backlog',
                   'note': 'Planned tasks, not implemented capabilities or created GitHub issues. See docs/tasks/status.md for execution status.', 'tasks': tasks}
        args.export.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'Exported {len(tasks)} tasks to {args.export}')
    print('Documentation checks passed. No product, live-model, or deployment tests were run.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
