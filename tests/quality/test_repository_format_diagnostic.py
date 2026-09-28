"""Temporary read-only formatter output; remove before final acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

class RepositoryFormatDiagnostic(unittest.TestCase):
    def test_format_suggestions(self):
        paths = ['scripts/lib/local-repository.mjs', 'scripts/repository-inspect.mjs', 'tests/local-repository.test.mjs']
        entries = []
        for name in paths:
            source = Path(name).read_bytes()
            result = subprocess.run(['node', 'node_modules/prettier/bin/prettier.cjs', '--stdin-filepath', name], input=source, capture_output=True, check=True)
            self.assertEqual(Path(name).read_bytes(), source)
            entries.append({'path': name, 'source_sha256': hashlib.sha256(source).hexdigest(), 'formatted': result.stdout.decode('utf-8')})
        Path('reports').mkdir(exist_ok=True)
        Path('reports/repository-format-suggestions.json').write_text(json.dumps(entries, ensure_ascii=False), encoding='utf-8')
