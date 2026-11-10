import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup_export', Path(__file__).parents[1] / 'export.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SQLiteBackupTests(unittest.TestCase):
    def test_committed_wal_is_included_and_uncommitted_data_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'live.sqlite'
            writer = sqlite3.connect(source)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE records (value TEXT)')
            writer.execute("INSERT INTO records VALUES ('committed')")
            writer.commit()
            writer.execute("INSERT INTO records VALUES ('uncommitted')")
            target = root / 'backup/snapshot.sqlite'
            result = module.copy_sqlite(source, target)
            with sqlite3.connect(target) as restored:
                self.assertEqual(restored.execute('SELECT value FROM records').fetchall(), [('committed',)])
                self.assertEqual(restored.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(result['tables'], 1)
            self.assertEqual(result['sha256'], module.digest(target))
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            writer.close()

    def test_empty_legacy_placeholders_remain_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'empty.sqlite'
            source.touch()
            target = Path(directory) / 'backup/empty.sqlite'
            self.assertEqual(module.copy_sqlite(source, target), {'empty': True})
            self.assertEqual(target.stat().st_size, 0)

    def test_unrecognized_database_content_blocks_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'broken.sqlite'
            source.write_text('not a database')
            with self.assertRaises(ValueError):
                module.copy_sqlite(source, Path(directory) / 'backup.sqlite')


if __name__ == '__main__':
    unittest.main()
