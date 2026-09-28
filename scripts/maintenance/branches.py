#!/usr/bin/env python3
"""Audit the reviewed Zentwine branch inventory; deletion is explicit and leased."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = 'ntygod/Zentwine'
URL = 'https://github.com/ntygod/Zentwine.git'
MANIFEST = ROOT / 'docs/maintenance/branch-cleanup-2026-09-28.json'
SHA = re.compile(r'^[0-9a-f]{40}$')
BRANCH = re.compile(r'^(?:[A-Za-z0-9][A-Za-z0-9_.-]*/)*[A-Za-z0-9][A-Za-z0-9_.-]*$')


class CleanupError(ValueError):
    pass


def valid_branch(name):
    return (isinstance(name, str) and bool(BRANCH.fullmatch(name)) and '..' not in name
            and not name.endswith('.') and not any(p.endswith('.lock') for p in name.split('/')))


def validate_manifest(value):
    if not isinstance(value, dict) or value.get('schema_version') != 1 or value.get('repository') != REPOSITORY:
        raise CleanupError('wrong_repository_or_manifest')
    if value.get('deletion_status') != 'not_executed' or not valid_branch(value.get('default_branch')):
        raise CleanupError('invalid_manifest_state')
    retained = value.get('retain')
    candidates = value.get('candidates')
    if not isinstance(retained, list) or not isinstance(candidates, list) or not candidates:
        raise CleanupError('invalid_branch_lists')
    if any(not valid_branch(name) for name in retained) or value['default_branch'] not in retained:
        raise CleanupError('missing_default_retention')
    names = set()
    for item in candidates:
        if not isinstance(item, dict) or not valid_branch(item.get('branch')):
            raise CleanupError('invalid_branch')
        name, sha = item['branch'], item.get('sha')
        if name in names or name in retained or name in ('main', 'master', 'develop'):
            raise CleanupError('duplicate_or_retained_branch')
        if not isinstance(sha, str) or not SHA.fullmatch(sha) or type(item.get('pr')) is not int or item['pr'] < 1:
            raise CleanupError('invalid_commit_or_pr')
        if item.get('ancestor_of_snapshot_main') is not True:
            raise CleanupError('missing_ancestry_evidence')
        names.add(name)
    return value


def classify(manifest, repository, branches, pulls):
    """Pure metadata decision. Every candidate still needs a fresh Git ancestry check."""
    validate_manifest(manifest)
    if repository.get('full_name') != REPOSITORY or repository.get('default_branch') != manifest['default_branch']:
        raise CleanupError('repository_or_default_changed')
    if not isinstance(branches, list) or not isinstance(pulls, list):
        raise CleanupError('incomplete_metadata')
    by_name = {item['name']: item for item in branches}
    if len(by_name) != len(branches) or manifest['default_branch'] not in by_name:
        raise CleanupError('duplicate_or_missing_branch_metadata')
    by_pr = {item['number']: item for item in pulls}
    if len(by_pr) != len(pulls):
        raise CleanupError('duplicate_pr_metadata')
    open_refs = {pr[side]['ref'] for pr in pulls if pr['state'] == 'open' for side in ('head', 'base')}
    eligible, missing, blocked = [], [], []
    for item in manifest['candidates']:
        name = item['branch']
        live = by_name.get(name)
        if live is None:
            missing.append(name)
            continue
        if live.get('protected') is not False:
            blocked.append({'branch': name, 'reason': 'protected_or_unknown'})
            continue
        if name in open_refs:
            blocked.append({'branch': name, 'reason': 'open_pr_head_or_base'})
            continue
        if live['commit']['sha'] != item['sha']:
            blocked.append({'branch': name, 'reason': 'head_changed'})
            continue
        pr = by_pr.get(item['pr'])
        if (not pr or not pr.get('merged_at') or pr['state'] != 'closed'
                or pr['head']['ref'] != name or pr['head']['sha'] != item['sha']
                or pr['base']['ref'] != manifest['default_branch']
                or pr['head']['repo']['full_name'] != REPOSITORY
                or pr['base']['repo']['full_name'] != REPOSITORY):
            blocked.append({'branch': name, 'reason': 'exact_merged_pr_not_confirmed'})
            continue
        eligible.append(item)
    main_sha = by_name[manifest['default_branch']]['commit']['sha']
    if not isinstance(main_sha, str) or not SHA.fullmatch(main_sha):
        raise CleanupError('invalid_live_main')
    return {'main_sha': main_sha, 'eligible': eligible, 'already_absent': missing, 'blocked': blocked}


def command(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=180, check=False,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GH_PROMPT_DISABLED': '1'})
    if result.returncode:
        # Do not print credential helpers, raw Git errors, URLs or third-party exception text.
        raise CleanupError('external_command_failed')
    return result.stdout


def api(endpoint, collection=False):
    args = ['gh', 'api', '--hostname', 'github.com', '--method', 'GET', f'repos/{REPOSITORY}/{endpoint}'.rstrip('/')]
    if collection:
        args += ['--paginate', '--slurp']
    value = json.loads(command(args))
    if not collection:
        return value
    if not isinstance(value, list) or not all(isinstance(page, list) for page in value):
        raise CleanupError('pagination_failed')
    return [item for page in value for item in page]


def snapshot(manifest):
    return classify(manifest, api(''), api('branches?per_page=100', True),
                    api('pulls?state=all&per_page=100', True))


def git(directory, *args):
    return command(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(directory), *args])


def verify_ancestry(directory, manifest, plan):
    git(directory, 'init', '--bare', '--quiet')
    refs = [f"+refs/heads/{manifest['default_branch']}:refs/heads/audit-main"]
    refs += [f"+refs/heads/{item['branch']}:refs/heads/audit-{n}" for n, item in enumerate(plan['eligible'])]
    git(directory, 'fetch', '--quiet', '--no-tags', URL, *refs)
    if git(directory, 'rev-parse', 'refs/heads/audit-main').strip() != plan['main_sha']:
        raise CleanupError('main_moved_during_fetch')
    for n, item in enumerate(plan['eligible']):
        if git(directory, 'rev-parse', f'refs/heads/audit-{n}').strip() != item['sha']:
            raise CleanupError('branch_moved_during_fetch')
        git(directory, 'merge-base', '--is-ancestor', item['sha'], plan['main_sha'])


def deletion_arguments(candidates):
    if not candidates:
        raise CleanupError('empty_deletion')
    # Explicit expected SHA for EVERY ref. No unconditional --force or wildcard refspec.
    args = ['push', '--atomic', '--porcelain']
    for item in candidates:
        if not valid_branch(item['branch']) or not SHA.fullmatch(item['sha']):
            raise CleanupError('invalid_deletion_argument')
        args.append(f"--force-with-lease=refs/heads/{item['branch']}:{item['sha']}")
    args.append(URL)
    args += [f":refs/heads/{item['branch']}" for item in candidates]
    return args


def run(manifest, apply=False):
    validate_manifest(manifest)
    plan = snapshot(manifest)
    result = {'status': 'blocked' if plan['blocked'] else 'audited',
              'mode': 'apply' if apply else 'dry_run', 'repository': REPOSITORY,
              'main_sha': plan['main_sha'], 'candidates': plan['eligible'],
              'already_absent': plan['already_absent'], 'blocked': plan['blocked'],
              'deleted_verified': [], 'retain': manifest['retain']}
    if plan['blocked'] or not plan['eligible']:
        return result
    # A temporary bare repo avoids checkout, stashing, local branch deletion or changing origin.
    with tempfile.TemporaryDirectory(prefix='zentwine-branch-audit-') as directory:
        verify_ancestry(directory, manifest, plan)
        result['ancestry_verified'] = True
        if not apply:
            return result
        if snapshot(manifest) != plan:
            raise CleanupError('metadata_changed_before_delete')
        git(directory, *deletion_arguments(plan['eligible']))
        names = [f"refs/heads/{item['branch']}" for item in plan['eligible']]
        if git(directory, 'ls-remote', '--heads', URL, *names).strip():
            raise CleanupError('deletion_or_concurrent_recreation_unverified')
        result['deleted_verified'] = [item['branch'] for item in plan['eligible']]
        result['status'] = 'deleted'
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Explicitly delete the reviewed branches after all checks')
    parser.add_argument('--confirm', help='Required with --apply: ntygod/Zentwine')
    args = parser.parse_args(argv)
    if (args.apply and args.confirm != REPOSITORY) or (args.confirm is not None and not args.apply):
        parser.error('--apply requires --confirm ntygod/Zentwine; default is dry-run')
    try:
        value = run(json.loads(MANIFEST.read_text(encoding='utf-8')), apply=args.apply)
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 1 if value['status'] == 'blocked' else 0
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print(json.dumps({'status': 'failed', 'mode': 'apply' if args.apply else 'dry_run',
                          'rule': 'audit_or_operation_failed',
                          'deletion_state': 'unknown_recheck_remote' if args.apply else 'not_attempted'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
