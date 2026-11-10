#!/usr/bin/env python3
"""Mini-owned encrypted restic backups; srv1 cannot access this repository."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from datetime import datetime, timezone

BASE = Path.home() / 'Library/Application Support/Rondo Backup'
CONFIG = Path.home() / '.config/rondo-backup'
REMOTE = 'rondo-backup@81.24.6.19'
SSH = ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
       '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
       '-o', 'UserKnownHostsFile=' + str(CONFIG / 'known_hosts'),
       '-i', str(CONFIG / 'id_ed25519')]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def restic(*args, **kwargs):
    env = dict(os.environ, RESTIC_REPOSITORY=str(BASE / 'repository'),
               RESTIC_PASSWORD_FILE=str(CONFIG / 'password'),
               RESTIC_CACHE_DIR=str(BASE / 'restic-cache'))
    return run(['/opt/homebrew/bin/restic', *args], env=env, **kwargs)


def save_status(status):
    temporary = BASE / 'status.next.json'
    temporary.write_text(json.dumps(status, indent=2) + '\n')
    temporary.replace(BASE / 'status.json')


def backup():
    os.umask(0o077)
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (BASE / 'backup.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another Rondo backup is running; skipping overlap', flush=True)
            return
        status_path = BASE / 'status.json'
        status = json.loads(status_path.read_text()) if status_path.exists() else {}
        status.update(state='running', started_at=datetime.now(timezone.utc).isoformat())
        save_status(status)
        incoming = BASE / 'incoming'
        try:
            if shutil.disk_usage(BASE).free < 12 * 1024**3:
                raise RuntimeError('Less than 12 GiB free; free space before retrying')
            print('Preparing a consistent database export on srv1', flush=True)
            response = run([*SSH, REMOTE, 'prepare'], capture_output=True, text=True, timeout=3600)
            export = json.loads(response.stdout)
            identifier = export['id']
            if not identifier.isalnum() or len(identifier) != 16:
                raise RuntimeError('Invalid remote export identifier')
            incoming.mkdir(mode=0o700, exist_ok=True)
            # Fixed local paths allow restic to deduplicate successive exports.
            import shlex
            run(['/opt/homebrew/bin/rsync', '-rt', '--delete', '-e', shlex.join(SSH),
                 REMOTE + ':' + identifier + '/', str(incoming) + '/'], timeout=3600)
            with (incoming / 'srv1.tar').open('rb') as stream:
                actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            if actual != export['sha256']:
                raise RuntimeError('Downloaded export checksum does not match srv1')
            print('Export checksum verified; saving encrypted snapshot', flush=True)
            result = restic('backup', '--json', '--tag', 'srv1', '--host', 'srv1-rondo-club',
                            str(incoming), capture_output=True, text=True, timeout=3600)
            summaries = [json.loads(line) for line in result.stdout.splitlines()
                         if json.loads(line).get('message_type') == 'summary']
            if not summaries or not summaries[-1].get('snapshot_id'):
                raise RuntimeError('Restic did not confirm a snapshot')
            snapshot = summaries[-1]['snapshot_id']
            restic('forget', '--tag', 'srv1', '--host', 'srv1-rondo-club',
                   '--keep-within', '2d', '--keep-daily', '14', '--keep-weekly', '8',
                   '--keep-monthly', '12', '--prune', stdout=subprocess.DEVNULL, timeout=3600)
            # Check metadata each run and read all stored data at least weekly.
            full_check = time.time() - status.get('last_full_check_epoch', 0) >= 7 * 86400
            restic('check', *(['--read-data'] if full_check else []),
                   stdout=subprocess.DEVNULL, timeout=3600)
            if full_check:
                status['last_full_check_epoch'] = time.time()
            status.update(state='success', last_success_at=datetime.now(timezone.utc).isoformat(),
                          snapshot_id=snapshot, source_export=export,
                          free_bytes=shutil.disk_usage(BASE).free)
            status.pop('error', None)
            print(json.dumps({'state': 'success', 'snapshot_id': snapshot,
                              'mysql_databases': export['mysql_databases'],
                              'sqlite_databases': export['sqlite_databases']}), flush=True)
        except BaseException as error:
            status.update(state='failure', error=type(error).__name__,
                          failed_at=datetime.now(timezone.utc).isoformat())
            # Command arguments never contain a password or member data.
            print('Rondo backup failed: ' + str(error), flush=True)
            raise
        finally:
            # The mini retains encrypted snapshots, not plaintext export caches.
            if incoming.exists():
                shutil.rmtree(incoming)
            save_status(status)


if __name__ == '__main__':
    backup()
