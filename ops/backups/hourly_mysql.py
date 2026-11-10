#!/usr/bin/env python3
"""Hourly, root-private production database snapshots on srv1."""
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import tempfile
from datetime import datetime, timedelta, timezone

from export import digest, dump_mysql

ROOT = Path('/var/lib/rondo-backup/hourly-mysql/rondo_prod')
RETENTION_DAYS = 7
SNAPSHOT_NAME = re.compile(r'\d{8}T\d{6}Z')


def prune(root, now):
    cutoff = now - timedelta(days=RETENTION_DAYS)
    for folder in root.iterdir():
        if not folder.is_dir() or folder.is_symlink() or not SNAPSHOT_NAME.fullmatch(folder.name):
            continue
        try:
            timestamp = datetime.strptime(folder.name, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
            manifest = json.loads((folder / 'manifest.json').read_text())
        except (ValueError, OSError):
            continue
        if timestamp < cutoff and manifest.get('database') == 'rondo_prod' and (folder / 'database.sql.gz').is_file():
            shutil.rmtree(folder)


def create_backup(root=ROOT, now=None):
    now = now or datetime.now(timezone.utc)
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    root.chmod(0o700)
    with (root / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if shutil.disk_usage(root).free < 1024**3:
            raise RuntimeError('Less than 1 GiB free; backup stopped without pruning')
        identifier = now.strftime('%Y%m%dT%H%M%SZ')
        target = root / identifier
        if target.exists():
            raise RuntimeError('Snapshot already exists')
        with tempfile.TemporaryDirectory(prefix='.pending-', dir=root) as directory:
            temporary = Path(directory)
            dump = temporary / 'database.sql'
            info = dump_mysql('rondo_prod', dump)
            if info['tables'] == 0:
                raise RuntimeError('Production database has no tables; backup rejected')
            archive = temporary / 'database.sql.gz'
            with dump.open('rb') as source, gzip.open(archive, 'wb', compresslevel=6) as compressed:
                shutil.copyfileobj(source, compressed)
            archive.chmod(0o600)
            # Verify the entire gzip stream against the uncompressed dump.
            checksum = hashlib.sha256()
            with gzip.open(archive, 'rb') as restored:
                for block in iter(lambda: restored.read(1024 * 1024), b''):
                    checksum.update(block)
            if checksum.hexdigest() != info['sha256']:
                raise RuntimeError('Compressed backup failed verification')
            manifest = dict(info, database='rondo_prod', created_at=now.isoformat(),
                            compressed_sha256=digest(archive), compressed_bytes=archive.stat().st_size)
            metadata = temporary / 'manifest.json'
            metadata.write_text(json.dumps(manifest, indent=2) + '\n')
            metadata.chmod(0o600)
            dump.unlink()
            temporary.rename(target)
        # Publish first, then prune only recognized snapshots older than seven days.
        prune(root, now)
        return dict(manifest, path=str(target), retention_days=RETENTION_DAYS)


if __name__ == '__main__':
    if os.geteuid() != 0 or socket.gethostname() != 'srv1-rondo-club':
        raise RuntimeError('Run as root on srv1-rondo-club only')
    os.umask(0o077)
    print(json.dumps(create_backup()), flush=True)
