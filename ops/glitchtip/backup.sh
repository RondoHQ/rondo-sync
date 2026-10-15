#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/glitchtip
exec 9>/opt/glitchtip/.backup.lock
flock -n 9 || exit 0
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
staging=$(mktemp -d backups/.staging-XXXXXX)
trap 'rm -rf "$staging"' EXIT
docker compose exec -T postgres pg_dump -U glitchtip -Fc glitchtip > "$staging/database.dump"
docker compose exec -T web tar -cf - -C /code uploads > "$staging/uploads.tar"
docker compose exec -T web tar -cf - -C /code cold-storage > "$staging/cold-storage.tar"
cp compose.yml postgres.env glitchtip.env lettermint_backend.py "$staging/"
tar -czf "backups/$stamp.tar.gz" -C "$staging" .
# Only complete GlitchTip archives older than fourteen days are pruned.
find backups -maxdepth 1 -type f -name '????????T??????Z.tar.gz' -mtime +14 -delete
printf 'GlitchTip backup complete: %s\n' "$stamp"
