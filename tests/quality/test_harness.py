"""Synthetic filesystem fixtures; no Agent execution or model/network calls."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('harness_under_test', ROOT / 'scripts/harness.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='zentwine-harness-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {
            'schema_version': 1,
            'guides': ['AGENTS.md', 'packages/AGENTS.md', 'packages/db/AGENTS.md', 'apps/AGENTS.md'],
            'entrypoints': ['README.md'],
            'limits': copy.deepcopy(h.CEILINGS),
            'indexes': [],
        }
        for name in self.config['guides']:
            self.write(name, '# Rules\n\nOnly this scope.\n')
        self.write('README.md', '# Entry\n\n[Rules](AGENTS.md)\n')
        self.save()

    def write(self, name, content):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding='utf-8')

    def save(self):
        self.write(h.MANIFEST, json.dumps(self.config))

    def rules(self):
        return {item['rule'] for item in h.check(self.root)['errors']}

    def test_harness_valid_structure(self):
        self.assertEqual(h.check(self.root)['status'], 'passed')

    def test_harness_repository_real_structure(self):
        result = h.check(ROOT)
        self.assertEqual(result['errors'], [])
        self.assertGreaterEqual(result['guides'], 17)

    def test_harness_directory_and_new_file_inherit(self):
        expected = ['AGENTS.md', 'packages/AGENTS.md', 'packages/db/AGENTS.md']
        self.assertEqual(h.instruction_chain(self.root, 'packages/db'), expected)
        self.assertEqual(h.instruction_chain(self.root, 'packages/db/new/deeper.ts'), expected)

    def test_harness_multi_target_union_deduplicates_and_orders(self):
        result = h.context(self.root, ['packages/db/new.ts', 'apps/new.ts', 'packages/db/another.ts'])
        self.assertEqual(result['read_in_order'], ['AGENTS.md', 'apps/AGENTS.md', 'packages/AGENTS.md', 'packages/db/AGENTS.md'])
        self.assertFalse(result['executed'])
        self.assertEqual(result['unique_bytes'], sum((self.root / p).stat().st_size for p in result['read_in_order']))

    def test_harness_unrelated_scope_not_loaded(self):
        result = h.context(self.root, ['apps/new.ts'])
        self.assertEqual(result['read_in_order'], ['AGENTS.md', 'apps/AGENTS.md'])

    def test_harness_root_only_target(self):
        self.assertEqual(h.instruction_chain(self.root, '.'), ['AGENTS.md'])
        self.assertEqual(h.instruction_chain(self.root, 'new-root.txt'), ['AGENTS.md'])

    def test_harness_traversal_and_foreign_paths_rejected(self):
        for target in ('../outside', '/outside', 'packages/../apps', 'C:/outside', 'apps\\new.ts', '', 'apps//x', './apps'):
            with self.subTest(target=target), self.assertRaises(h.HarnessError):
                h.context(self.root, [target])

    def test_harness_symlink_ancestor_rejected(self):
        (self.root / 'alias').symlink_to(self.root / 'packages', target_is_directory=True)
        with self.assertRaises(h.HarnessError):
            h.context(self.root, ['alias/db/file.ts'])

    def test_harness_symlink_guide_rejected(self):
        path = self.root / 'packages/AGENTS.md'
        path.unlink()
        path.symlink_to(self.root / 'AGENTS.md')
        with self.assertRaises(h.HarnessError):
            h.context(self.root, ['packages/new.ts'])

    def test_harness_missing_root_guide(self):
        (self.root / 'AGENTS.md').unlink()
        self.assertIn('missing_guide', self.rules())
        with self.assertRaises(h.HarnessError):
            h.context(self.root, ['apps/file.ts'])

    def test_harness_unregistered_guide(self):
        self.write('apps/studio/AGENTS.md', '# Unexpected\n')
        self.assertIn('unregistered_guide', self.rules())
        with self.assertRaises(h.HarnessError):
            h.context(self.root, ['apps/studio/file.ts'])

    def test_harness_casing_collision(self):
        self.write('apps/agents.md', '# lower\n')
        self.assertIn('instruction_name_or_shadow_file', self.rules())

    def test_harness_override_and_claude_shadows(self):
        for name in ('AGENTS.override.md', 'CLAUDE.md'):
            self.write(f'apps/{name}', '# Shadow\n')
            with self.assertRaises(h.HarnessError):
                h.context(self.root, ['apps/file.ts'])
            (self.root / f'apps/{name}').unlink()

    def test_harness_line_budget(self):
        self.write('apps/AGENTS.md', 'line\n' * 81)
        self.assertIn('guide_budget_exceeded', self.rules())
        with self.assertRaises(h.HarnessError):
            h.context(self.root, ['apps/file.ts'])

    def test_harness_utf8_byte_budget(self):
        self.write('apps/AGENTS.md', '汉' * 1366)
        self.assertIn('guide_budget_exceeded', self.rules())

    def test_harness_chain_budget(self):
        self.config['limits']['chain_bytes'] = 40
        self.save()
        self.assertIn('chain_budget_exceeded', self.rules())
        with self.assertRaises(h.HarnessError):
            h.context(self.root, ['packages/db/file.ts'])

    def test_harness_budget_cannot_silently_raise_ceiling(self):
        self.config['limits']['guide_bytes'] = h.CEILINGS['guide_bytes'] + 1
        self.save()
        with self.assertRaises(h.HarnessError):
            h.check(self.root)

    def test_harness_manifest_duplicate_key_rejected(self):
        self.write(h.MANIFEST, '{"schema_version":1,"schema_version":1}')
        with self.assertRaises(h.HarnessError):
            h.check(self.root)

    def test_harness_manifest_duplicate_path_rejected(self):
        self.config['guides'].append('AGENTS.md')
        self.save()
        with self.assertRaises(h.HarnessError):
            h.check(self.root)

    def test_harness_unknown_manifest_field_rejected(self):
        self.config['execute'] = 'not permitted'
        self.save()
        with self.assertRaises(h.HarnessError):
            h.check(self.root)

    def test_harness_manifest_recursive_glob_rejected(self):
        self.config['indexes'] = [{'entry': 'README.md', 'glob': '**/*.md'}]
        self.save()
        with self.assertRaises(h.HarnessError):
            h.check(self.root)

    def test_harness_broken_local_link(self):
        self.write('README.md', '[missing](missing.md)\n')
        self.assertIn('broken_local_link', self.rules())

    def test_harness_external_links_not_fetched(self):
        self.write('README.md', '[external](https://example.invalid/no-fetch)\n')
        self.assertEqual(h.check(self.root)['status'], 'passed')

    def test_harness_links_cannot_escape_repository(self):
        self.write('README.md', '[outside](../outside.md)\n')
        self.assertIn('link_outside_repository', self.rules())

    def test_harness_valid_and_duplicate_anchors(self):
        self.write('README.md', '# Title\n\n## Same\n\n## Same\n\n[again](#same-1)\n')
        self.assertEqual(h.check(self.root)['status'], 'passed')
        self.assertEqual(h.anchors('# 标题\n'), {'标题'})

    def test_harness_missing_anchor_rejected(self):
        self.write('README.md', '# Title\n[bad](#missing)\n')
        self.assertIn('broken_heading_anchor', self.rules())

    def test_harness_code_fences_are_not_links(self):
        self.write('README.md', '# Entry\n```md\n[not a link](missing.md)\n```\n')
        self.assertEqual(h.check(self.root)['status'], 'passed')

    def test_harness_index_drift(self):
        self.write('docs/development/new.md', '# New guide\n')
        self.config['indexes'] = [{'entry': 'README.md', 'glob': 'docs/development/*.md'}]
        self.save()
        self.assertIn('missing_index_link', self.rules())
        self.write('README.md', '[guide](docs/development/new.md)\n')
        self.assertEqual(h.check(self.root)['status'], 'passed')

    def test_harness_entrypoint_budget(self):
        self.write('README.md', 'entry\n' * 141)
        self.assertIn('entry_budget_exceeded', self.rules())

    def test_harness_invalid_utf8_fails(self):
        (self.root / 'README.md').write_bytes(b'\xff')
        self.assertIn('file_read_error', self.rules())

    def test_harness_cli_no_targets_is_not_success(self):
        result = subprocess.run(['python3', str(ROOT / 'scripts/harness.py'), 'context'], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)

    def test_harness_cli_explicit_target_is_read_only(self):
        result = subprocess.run(['python3', str(ROOT / 'scripts/harness.py'), 'context', 'packages/db/src/new.ts'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['executed'])


if __name__ == '__main__':
    unittest.main()
