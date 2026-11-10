import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(Path(__file__).parents[1]))
import hourly_mysql

NOW = datetime(2026, 11, 10, 12, 10, tzinfo=timezone.utc)
SQL = b'CREATE TABLE example (id int);\nINSERT INTO example VALUES (1);\n'


def dump(database, path):
    assert database == 'rondo_prod'
    path.write_bytes(SQL)
    return {'tables': 1, 'sha256': hashlib.sha256(SQL).hexdigest()}


class HourlyMySQLTests(unittest.TestCase):
    def snapshot(self, root, age, database='rondo_prod'):
        path = root / (NOW - timedelta(days=age)).strftime('%Y%m%dT%H%M%SZ')
        path.mkdir()
        (path / 'manifest.json').write_text(json.dumps({'database': database}))
        (path / 'database.sql.gz').write_bytes(b'old backup')
        return path

    def test_publishes_verified_private_backup_then_prunes_only_expired_owned_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expired = self.snapshot(root, 8)
            retained = self.snapshot(root, 7)
            other = self.snapshot(root, 9, 'different_database')
            with patch.object(hourly_mysql, 'dump_mysql', side_effect=dump):
                result = hourly_mysql.create_backup(root, NOW)
            path = Path(result['path'])
            with gzip.open(path / 'database.sql.gz', 'rb') as archive:
                self.assertEqual(archive.read(), SQL)
            self.assertEqual((path / 'database.sql.gz').stat().st_mode & 0o777, 0o600)
            self.assertFalse((path / 'database.sql').exists())
            self.assertFalse(expired.exists())
            self.assertTrue(retained.exists())
            self.assertTrue(other.exists())
            self.assertFalse(list(root.glob('.pending-*')))

    def test_failed_dump_never_publishes_or_prunes_old_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expired = self.snapshot(root, 8)
            with patch.object(hourly_mysql, 'dump_mysql', side_effect=RuntimeError('dump failed')):
                with self.assertRaises(RuntimeError):
                    hourly_mysql.create_backup(root, NOW)
            self.assertTrue(expired.exists())
            self.assertFalse((root / NOW.strftime('%Y%m%dT%H%M%SZ')).exists())
            self.assertFalse(list(root.glob('.pending-*')))

    def test_checksum_failure_never_publishes_or_prunes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expired = self.snapshot(root, 8)

            def corrupt(database, path):
                info = dump(database, path)
                path.write_bytes(b'truncated')
                return info

            with patch.object(hourly_mysql, 'dump_mysql', side_effect=corrupt):
                with self.assertRaisesRegex(RuntimeError, 'verification'):
                    hourly_mysql.create_backup(root, NOW)
            self.assertTrue(expired.exists())
            self.assertFalse(list(root.glob('.pending-*')))


if __name__ == '__main__':
    unittest.main()
