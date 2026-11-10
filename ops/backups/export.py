#!/usr/bin/env python3
"""Create a private, portable srv1 export for the mini to pull."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
from datetime import datetime, timezone

BASE = Path('/var/lib/rondo-backup')
HOMES = [Path('/srv/rondo-' + name) for name in ('prod', 'demo', 'sync')]
CONFIGS = [
    '/etc/nginx', '/etc/php', '/etc/mysql', '/etc/letsencrypt', '/etc/rondo',
    '/etc/systemd/system', '/etc/cron.d', '/etc/logrotate.d', '/etc/ufw',
    '/etc/ssh', '/etc/passwd', '/etc/group', '/var/spool/cron/crontabs',
    '/usr/local/sbin', '/usr/local/libexec/rondo-backup',
    '/home/ubuntu/.ssh/authorized_keys',
]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def copy_sqlite(source, target):
    """Use SQLite's online backup API, including committed WAL data."""
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as stream:
        header = stream.read(16)
    if not header:
        target.touch(mode=0o600)
        return {'empty': True}
    if header != b'SQLite format 3\x00':
        raise ValueError(f'Unexpected database format: {source.name}')
    deadline = time.monotonic() + 300

    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise TimeoutError('SQLite snapshot exceeded five minutes')

    src = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst, pages=1024, progress=progress, sleep=0.1)
        if dst.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError(f'SQLite integrity check failed: {source.name}')
        tables = dst.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
    finally:
        dst.close()
        src.close()
    target.chmod(0o600)
    return {'empty': False, 'tables': tables, 'sha256': digest(target)}


def export():
    if os.geteuid() != 0 or socket.gethostname() != 'srv1-rondo-club':
        raise RuntimeError('Run as root on srv1-rondo-club only')
    os.umask(0o077)
    BASE.mkdir(mode=0o700, exist_ok=True)
    exports = BASE / 'exports'
    exports.mkdir(mode=0o700, exist_ok=True)
    with (BASE / 'export.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if shutil.disk_usage(BASE).free < 15 * 1024**3:
            raise RuntimeError('Less than 15 GiB free for a safe export')
        with tempfile.TemporaryDirectory(prefix='build-', dir=BASE) as temporary:
            work = Path(temporary)
            payload = work / 'payload'
            payload.mkdir()
            files = payload / 'files'
            files.mkdir()
            manifest = {'created_at': datetime.now(timezone.utc).isoformat(), 'mysql': {}, 'sqlite': {}}
            excludes = [
                '/backups/', '/.rondo-releases/', '/node_modules/', '/.git/',
                '/logs/', '/tmp/', '/debug/', '/.cache/', '/.local/',
                '*.sqlite', '*.sqlite-*', '*.db', '*.db-*', '._*',
            ]
            for home in HOMES:
                destination = files / home.relative_to('/')
                destination.mkdir(parents=True)
                run(['rsync', '-aAXL', *['--exclude=' + pattern for pattern in excludes],
                     str(home) + '/', str(destination) + '/'], stdout=subprocess.DEVNULL)
            for config in CONFIGS:
                source = Path(config)
                if not source.exists():
                    raise RuntimeError(f'Required configuration missing: {config}')
                run(['rsync', '-aAXR', config, str(files) + '/'], stdout=subprocess.DEVNULL)

            mysql_dir = payload / 'databases/mysql'
            mysql_dir.mkdir(parents=True)
            for database in ('rondo_prod', 'rondo_demo'):
                # WordPress uses InnoDB base tables; never silently export an
                # unsupported storage engine or omit an added trigger/routine.
                query = (
                    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='" + database
                    + "' AND (ENGINE <> 'InnoDB' OR TABLE_TYPE <> 'BASE TABLE');"
                    "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='" + database + "';"
                    "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='" + database + "';"
                    "SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='" + database + "';"
                )
                checks = run(['mysql', '-N', '-B', '-e', query], capture_output=True, text=True).stdout.split()
                if checks != ['0', '0', '0', '0']:
                    raise RuntimeError('Unexpected MySQL objects; review backup strategy')
                dump = mysql_dir / (database + '.sql')
                run(['mysqldump', '--single-transaction', '--quick', '--no-tablespaces',
                     '--set-gtid-purged=OFF', '--hex-blob', '--skip-comments', '--skip-triggers',
                     '--result-file=' + str(dump), database])
                count = run(['mysql', '-N', '-B', '-e',
                             "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='" + database + "'"],
                            capture_output=True, text=True).stdout.strip()
                manifest['mysql'][database] = {'tables': int(count), 'sha256': digest(dump)}

            # Snapshot every SQLite database in the application's root/data
            # directories, including legacy placeholders, without copying WALs.
            sync = Path('/srv/rondo-sync')
            for directory in (sync, sync / 'data'):
                for source in sorted(directory.iterdir()):
                    if source.is_file() and source.suffix in ('.db', '.sqlite') and not source.name.startswith('._'):
                        relative = str(source.relative_to('/'))
                        target = payload / 'databases/sqlite' / relative
                        info = copy_sqlite(source, target)
                        st = source.stat()
                        info.update(uid=st.st_uid, gid=st.st_gid, mode=st.st_mode & 0o777)
                        manifest['sqlite'][relative] = info
            with (payload / 'packages.tsv').open('w') as stream:
                run(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\n'], stdout=stream)
            (payload / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            identifier = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            destination = exports / identifier
            if destination.exists():
                raise RuntimeError('Export identifier already exists')
            destination.mkdir(mode=0o700)
            try:
                archive = destination / 'srv1.tar'
                run(['tar', '--sort=name', '--acls', '--xattrs', '--numeric-owner', '-cf',
                     str(archive), '-C', str(payload), '.'])
                summary = {'id': identifier, 'sha256': digest(archive), 'bytes': archive.stat().st_size,
                           'mysql_databases': len(manifest['mysql']),
                           'sqlite_databases': sum(not item['empty'] for item in manifest['sqlite'].values())}
                (destination / 'export.json').write_text(json.dumps(summary) + '\n')
            except BaseException:
                shutil.rmtree(destination)
                raise
            # Immutable exports prevent a pull from seeing half-written files.
            # Keep the newest three; never remove the only completed export.
            completed = sorted(p for p in exports.iterdir() if (p / 'export.json').is_file())
            for old in completed[:-3]:
                shutil.rmtree(old)
            print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    export()
