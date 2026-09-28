#!/usr/bin/env python3
"""Read-only routing and structural checks for Zentwine's AGENTS.md harness."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'docs/harness/manifest.json'
CEILINGS = {'guide_lines': 80, 'guide_bytes': 4096, 'chain_bytes': 12288, 'entry_lines': 140}
EXCLUDED = {'.git', 'node_modules', 'dist', 'reports', 'test-results', 'playwright-report',
            '.venv', '.venv-quality', '__pycache__', '.zentwine'}
LINK = re.compile(r'!?\[[^\]\n]*\]\(([^)\n]+)\)')
FENCE = re.compile(r'^\s*(`{3,}|~{3,})')


class HarnessError(ValueError):
    """A fixed, non-content-bearing failure code."""


def relative_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or '\\' in name or '\x00' in name:
        raise HarnessError('invalid_repository_path')
    if name == '.':
        return root
    if PurePosixPath(name).is_absolute() or any(p in ('', '.', '..') for p in name.split('/')):
        raise HarnessError('invalid_repository_path')
    if ':' in name.split('/')[0]:
        raise HarnessError('invalid_repository_path')
    cursor = root
    for part in name.split('/'):
        cursor = cursor / part
        if cursor.is_symlink():
            raise HarnessError('symlink_not_allowed')
    return cursor


def read_text(root: Path, name: str) -> str:
    path = relative_path(root, name)
    if not path.is_file() or path.stat().st_size > 200_000:
        raise HarnessError('missing_or_oversized_file')
    return path.read_text(encoding='utf-8', errors='strict')


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise HarnessError('duplicate_manifest_key')
        result[key] = value
    return result


def configuration(root: Path) -> dict:
    data = json.loads(read_text(root, MANIFEST), object_pairs_hook=unique_pairs)
    if not isinstance(data, dict) or set(data) != {'schema_version', 'guides', 'entrypoints', 'limits', 'indexes'}:
        raise HarnessError('invalid_manifest')
    if type(data['schema_version']) is not int or data['schema_version'] != 1:
        raise HarnessError('invalid_manifest_version')
    for group in ('guides', 'entrypoints'):
        values = data[group]
        if not isinstance(values, list) or not values or any(not isinstance(x, str) for x in values):
            raise HarnessError('invalid_manifest_paths')
        if len(values) != len(set(values)):
            raise HarnessError('duplicate_manifest_path')
        for name in values:
            relative_path(root, name)
            if group == 'guides' and PurePosixPath(name).name != 'AGENTS.md':
                raise HarnessError('invalid_guide_name')
    if 'AGENTS.md' not in data['guides'] or not isinstance(data['limits'], dict):
        raise HarnessError('missing_root_or_limits')
    if set(data['limits']) != set(CEILINGS):
        raise HarnessError('invalid_limit_set')
    for key, maximum in CEILINGS.items():
        value = data['limits'][key]
        if type(value) is not int or not 1 <= value <= maximum:
            raise HarnessError('invalid_budget')
    if not isinstance(data['indexes'], list):
        raise HarnessError('invalid_indexes')
    for item in data['indexes']:
        if not isinstance(item, dict) or set(item) != {'entry', 'glob'}:
            raise HarnessError('invalid_index')
        if not isinstance(item['entry'], str) or item['entry'] not in data['entrypoints'] or not isinstance(item['glob'], str):
            raise HarnessError('invalid_index_entry')
        # Only a filename glob within one explicit repository directory; never recursive.
        pattern = PurePosixPath(item['glob'])
        relative_path(root, str(pattern.parent))
        if not pattern.name or '..' in item['glob'].split('/') or '**' in item['glob'] or any(c in str(pattern.parent) for c in '*?['):
            raise HarnessError('invalid_index_pattern')
    return data


def instruction_chain(root: Path, target: str) -> list[str]:
    path = relative_path(root, target)
    directory = path if path.is_dir() else path.parent
    if path.exists() and not (path.is_file() or path.is_dir()):
        raise HarnessError('unsupported_target')
    scopes = [root]
    cursor = root
    for part in directory.relative_to(root).parts:
        cursor = cursor / part
        scopes.append(cursor)
    chain = []
    for scope in scopes:
        name = (scope / 'AGENTS.md').relative_to(root).as_posix()
        guide = relative_path(root, name)
        if scope.is_dir():
            names = {p.name for p in scope.iterdir()}
            if any(p.lower() in ('agents.md', 'agents.override.md', 'claude.md') and p != 'AGENTS.md' for p in names):
                raise HarnessError('instruction_name_or_shadow_file')
        if guide.is_file():
            chain.append(name)
    if not chain or chain[0] != 'AGENTS.md':
        raise HarnessError('missing_root_guide')
    return chain


def context(root: Path, targets: list[str]) -> dict:
    if not targets:
        raise HarnessError('targets_required')
    config = configuration(root)
    combined, details = [], []
    for target in targets:
        chain = instruction_chain(root, target)
        if any(name not in config['guides'] for name in chain):
            raise HarnessError('unregistered_guide')
        texts = [read_text(root, name) for name in chain]
        if any(len(text.encode('utf-8')) > config['limits']['guide_bytes'] or len(text.splitlines()) > config['limits']['guide_lines'] for text in texts):
            raise HarnessError('guide_budget_exceeded')
        total = sum(len(text.encode('utf-8')) for text in texts)
        if total > config['limits']['chain_bytes']:
            raise HarnessError('chain_budget_exceeded')
        details.append({'target': target, 'read_in_order': chain, 'bytes': total})
        combined.extend(name for name in chain if name not in combined)
    # Shallower instructions precede all refinements, including across multiple targets.
    combined.sort(key=lambda name: (name.count('/'), name))
    return {'status': 'routed', 'executed': False, 'path_base': 'repository_root',
            'targets': details, 'read_in_order': combined,
            'unique_bytes': sum(len(read_text(root, name).encode('utf-8')) for name in combined)}


def markdown_prose(text: str) -> str:
    lines, marker = [], None
    for line in text.splitlines():
        match = FENCE.match(line)
        if match:
            fence = match.group(1)
            if marker is None:
                marker = fence
            elif fence[0] == marker[0] and len(fence) >= len(marker):
                marker = None
            continue
        if marker is None:
            lines.append(line)
    return '\n'.join(lines)


def anchors(text: str) -> set[str]:
    result, counts = set(), {}
    for line in markdown_prose(text).splitlines():
        heading = re.match(r'^#{1,6}\s+(.+?)(?:\s+#+)?$', line)
        if heading:
            slug = re.sub(r'[^\w\-\s]', '', heading.group(1).lower()).replace(' ', '-')
            occurrence = counts.get(slug, 0)
            counts[slug] = occurrence + 1
            result.add(slug if occurrence == 0 else f'{slug}-{occurrence}')
    return result


def local_links(root: Path, name: str, text: str) -> list[str]:
    targets = []
    for match in LINK.finditer(markdown_prose(text)):
        raw = match.group(1)
        # The harness uses simple inline links; deliberately not a CommonMark parser.
        parts = urlsplit(raw)
        if parts.scheme in ('https', 'http', 'mailto'):
            continue
        if parts.scheme or parts.netloc or parts.query or '\\' in raw or raw.startswith('/'):
            raise HarnessError('unsupported_link')
        raw_path = unquote(parts.path)
        candidate = root / name if not raw_path else root / PurePosixPath(name).parent / raw_path
        normalized = Path(os.path.abspath(candidate))
        if not normalized.is_relative_to(root):
            raise HarnessError('link_outside_repository')
        destination = normalized.relative_to(root).as_posix()
        path = relative_path(root, destination)
        if not path.exists():
            raise HarnessError('broken_local_link')
        if parts.fragment and path.suffix == '.md':
            if unquote(parts.fragment) not in anchors(read_text(root, destination)):
                raise HarnessError('broken_heading_anchor')
        targets.append(destination)
    return targets


def repository_files(root: Path):
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED)
        for name in sorted(dirs + files):
            path = Path(directory) / name
            yield path.relative_to(root).as_posix()


def check(root: Path) -> dict:
    config = configuration(root)
    errors, discovered, linked = [], set(), {}
    for name in repository_files(root):
        leaf = PurePosixPath(name).name
        if leaf.lower() in ('agents.md', 'agents.override.md', 'claude.md'):
            if leaf != 'AGENTS.md':
                errors.append({'path': name, 'rule': 'instruction_name_or_shadow_file'})
            else:
                discovered.add(name)
    required = set(config['guides'])
    for name in sorted(required - discovered):
        errors.append({'path': name, 'rule': 'missing_guide'})
    for name in sorted(discovered - required):
        errors.append({'path': name, 'rule': 'unregistered_guide'})
    for name in sorted(required | set(config['entrypoints'])):
        try:
            text = read_text(root, name)
            if name in required:
                if len(text.encode('utf-8')) > config['limits']['guide_bytes'] or len(text.splitlines()) > config['limits']['guide_lines']:
                    errors.append({'path': name, 'rule': 'guide_budget_exceeded'})
                directory = str(PurePosixPath(name).parent)
                chain = instruction_chain(root, directory)
                size = sum(len(read_text(root, p).encode('utf-8')) for p in chain)
                if size > config['limits']['chain_bytes']:
                    errors.append({'path': name, 'rule': 'chain_budget_exceeded'})
            elif len(text.splitlines()) > config['limits']['entry_lines']:
                errors.append({'path': name, 'rule': 'entry_budget_exceeded'})
            linked[name] = set(local_links(root, name, text))
        except (HarnessError, UnicodeError, OSError) as exc:
            rule = str(exc) if isinstance(exc, HarnessError) else 'file_read_error'
            errors.append({'path': name, 'rule': rule})
    for item in config['indexes']:
        for path in sorted(root.glob(item['glob'])):
            name = path.relative_to(root).as_posix()
            if name != item['entry'] and name not in linked.get(item['entry'], set()):
                errors.append({'path': name, 'rule': 'missing_index_link', 'index': item['entry']})
    return {'status': 'failed' if errors else 'passed', 'guides': len(discovered),
            'entrypoints': len(config['entrypoints']), 'errors': errors,
            'scope': 'local_structure_not_agent_execution_or_authorization'}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('check')
    route = commands.add_parser('context')
    route.add_argument('paths', nargs='+', help='Paths relative to the repository root')
    args = parser.parse_args(argv)
    try:
        result = check(ROOT) if args.command == 'check' else context(ROOT, args.paths)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result['status'] == 'failed' else 0
    except (ValueError, OSError, UnicodeError, TypeError, KeyError):
        print(json.dumps({'status': 'failed', 'rule': 'invalid_input_or_structure'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
