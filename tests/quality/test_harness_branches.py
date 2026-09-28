"""Metadata fixtures plus real temporary bare-Git lease tests; no GitHub writes."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('branch_cleanup_under_test', ROOT / 'scripts/maintenance/branches.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
A, B = 'a' * 40, 'b' * 40


def fixtures():
    manifest = {'schema_version': 1, 'repository': b.REPOSITORY, 'deletion_status': 'not_executed',
                'default_branch': 'main', 'retain': ['main', 'feat/wip'],
                'candidates': [{'branch': 'feat/done', 'sha': A, 'pr': 1, 'ancestor_of_snapshot_main': True}]}
    repository = {'full_name': b.REPOSITORY, 'default_branch': 'main'}
    branches = [{'name': 'main', 'protected': True, 'commit': {'sha': B}},
                {'name': 'feat/done', 'protected': False, 'commit': {'sha': A}}]
    pulls = [{'number': 1, 'merged_at': '2026-09-01T00:00:00Z', 'state': 'closed',
              'head': {'ref': 'feat/done', 'sha': A, 'repo': {'full_name': b.REPOSITORY}},
              'base': {'ref': 'main', 'repo': {'full_name': b.REPOSITORY}}}]
    return manifest, repository, branches, pulls


class BranchMetadataTests(unittest.TestCase):
    def test_cleanup_exact_merged_metadata_eligible(self):
        plan = b.classify(*fixtures())
        self.assertEqual(len(plan['eligible']), 1)
        self.assertEqual(plan['blocked'], [])

    def test_cleanup_checked_in_inventory_is_pending_and_valid(self):
        manifest = b.validate_manifest(json.loads(b.MANIFEST.read_text()))
        self.assertEqual(len(manifest['candidates']), 32)
        self.assertIn('feat/ZT03-02-version-cas', manifest['retain'])
        self.assertEqual(manifest['deletion_status'], 'not_executed')

    def test_cleanup_default_change_blocks(self):
        args = fixtures()
        args[1]['default_branch'] = 'other'
        with self.assertRaises(b.CleanupError):
            b.classify(*args)

    def test_cleanup_head_change_blocks(self):
        args = fixtures()
        args[2][1]['commit']['sha'] = B
        self.assertEqual(b.classify(*args)['blocked'][0]['reason'], 'head_changed')

    def test_cleanup_protected_or_unknown_blocks(self):
        for value in (True, None):
            args = fixtures()
            args[2][1]['protected'] = value
            self.assertEqual(b.classify(*args)['blocked'][0]['reason'], 'protected_or_unknown')

    def test_cleanup_open_pr_head_blocks(self):
        args = fixtures()
        pr = copy.deepcopy(args[3][0])
        pr.update(number=2, state='open', merged_at=None)
        args[3].append(pr)
        self.assertEqual(b.classify(*args)['blocked'][0]['reason'], 'open_pr_head_or_base')

    def test_cleanup_open_pr_base_blocks(self):
        args = fixtures()
        pr = copy.deepcopy(args[3][0])
        pr.update(number=2, state='open', merged_at=None)
        pr['head']['ref'] = 'feat/other'
        pr['base']['ref'] = 'feat/done'
        args[3].append(pr)
        self.assertEqual(b.classify(*args)['blocked'][0]['reason'], 'open_pr_head_or_base')

    def test_cleanup_closed_unmerged_is_not_done(self):
        args = fixtures()
        args[3][0]['merged_at'] = None
        self.assertEqual(b.classify(*args)['eligible'], [])

    def test_cleanup_fork_same_name_not_equivalent(self):
        args = fixtures()
        args[3][0]['head']['repo']['full_name'] = 'example/fork'
        self.assertEqual(b.classify(*args)['eligible'], [])

    def test_cleanup_missing_branch_not_counted_as_deleted(self):
        args = fixtures()
        args[2].pop()
        plan = b.classify(*args)
        self.assertEqual(plan['already_absent'], ['feat/done'])
        self.assertEqual(plan['eligible'], [])

    def test_cleanup_duplicate_branch_metadata_rejected(self):
        args = fixtures()
        args[2].append(copy.deepcopy(args[2][1]))
        with self.assertRaises(b.CleanupError):
            b.classify(*args)

    def test_cleanup_manifest_cannot_target_retained_or_default(self):
        for name in ('main', 'feat/wip', 'master', 'develop'):
            manifest = fixtures()[0]
            manifest['candidates'][0]['branch'] = name
            with self.assertRaises(b.CleanupError):
                b.validate_manifest(manifest)

    def test_cleanup_unsafe_ref_names_rejected(self):
        for name in ('--all', 'feat/../main', 'feat/x.lock', 'feat/x:y', 'x\ny', 'a//b', 'a@{1}'):
            self.assertFalse(b.valid_branch(name))

    def test_cleanup_manifest_requires_ancestry_evidence(self):
        manifest = fixtures()[0]
        manifest['candidates'][0]['ancestor_of_snapshot_main'] = False
        with self.assertRaises(b.CleanupError):
            b.validate_manifest(manifest)

    def test_cleanup_push_is_atomic_with_exact_leases(self):
        candidate = fixtures()[0]['candidates']
        args = b.deletion_arguments(candidate)
        self.assertIn('--atomic', args)
        self.assertIn(f'--force-with-lease=refs/heads/feat/done:{A}', args)
        self.assertNotIn('--force', args)
        self.assertIn(':refs/heads/feat/done', args)
        self.assertIn(b.URL, args)

    def test_cleanup_dry_run_does_not_push(self):
        manifest = fixtures()[0]
        plan = b.classify(*fixtures())
        with patch.object(b, 'snapshot', return_value=plan), patch.object(b, 'verify_ancestry'), patch.object(b, 'git') as git:
            result = b.run(manifest)
        git.assert_not_called()
        self.assertEqual(result['mode'], 'dry_run')
        self.assertEqual(result['deleted_verified'], [])

    def test_cleanup_apply_rechecks_metadata_before_any_push(self):
        manifest = fixtures()[0]
        plan = b.classify(*fixtures())
        changed = copy.deepcopy(plan)
        changed['main_sha'] = A
        with patch.object(b, 'snapshot', side_effect=[plan, changed]), patch.object(b, 'verify_ancestry'), patch.object(b, 'git') as git:
            with self.assertRaises(b.CleanupError):
                b.run(manifest, apply=True)
        git.assert_not_called()

    def test_cleanup_apply_requires_confirmation_without_network(self):
        with patch.object(b, 'run') as run, self.assertRaises(SystemExit):
            b.main(['--apply'])
        run.assert_not_called()

    def test_cleanup_no_delete_receipt_before_remote_absence(self):
        manifest = fixtures()[0]
        plan = b.classify(*fixtures())
        with patch.object(b, 'snapshot', return_value=plan), patch.object(b, 'verify_ancestry'), patch.object(b, 'git', side_effect=['', f'{A}\trefs/heads/feat/done\n']):
            with self.assertRaises(b.CleanupError):
                b.run(manifest, apply=True)


class BranchGitLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='zentwine-lease-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / 'remote.git'
        self.work = self.root / 'work'
        self.work.mkdir()
        self.git('init', '--bare', str(self.remote))
        self.git('init', '-b', 'main', str(self.work))
        self.git('-C', str(self.work), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic baseline')
        self.sha = self.git('-C', str(self.work), 'rev-parse', 'HEAD').strip()
        self.git('-C', str(self.work), 'push', str(self.remote), 'HEAD:refs/heads/main', 'HEAD:refs/heads/feat/a', 'HEAD:refs/heads/feat/b')
        self.items = [{'branch': 'feat/a', 'sha': self.sha}, {'branch': 'feat/b', 'sha': self.sha}]

    def git(self, *args):
        result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def push(self):
        args = b.deletion_arguments(self.items)
        args[args.index(b.URL)] = str(self.remote)  # Only this isolated test redirects the fixed production URL.
        return subprocess.run(['git', '-C', str(self.work), *args], capture_output=True, text=True, timeout=15)

    def refs(self):
        return self.git('--git-dir', str(self.remote), 'for-each-ref', '--format=%(refname) %(objectname)')

    def test_cleanup_real_git_exact_leases_delete_only_candidates(self):
        result = self.push()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('refs/heads/feat/', self.refs())
        self.assertIn(f'refs/heads/main {self.sha}', self.refs())

    def test_cleanup_real_git_race_rejects_entire_atomic_deletion(self):
        self.git('-C', str(self.work), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic concurrent work')
        new = self.git('-C', str(self.work), 'rev-parse', 'HEAD').strip()
        self.git('-C', str(self.work), 'push', str(self.remote), 'HEAD:refs/heads/feat/b')
        result = self.push()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f'refs/heads/feat/a {self.sha}', self.refs())
        self.assertIn(f'refs/heads/feat/b {new}', self.refs())
        self.assertIn(f'refs/heads/main {self.sha}', self.refs())


if __name__ == '__main__':
    unittest.main()
