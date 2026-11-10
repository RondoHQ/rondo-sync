#!/bin/sh
# Root-owned sudo target for the forced backup SSH key, never a general shell.
set -eu
case "${1-}" in
    prepare) exec /usr/bin/python3 /usr/local/libexec/rondo-backup/export.py ;;
    'rsync --server --sender '*)
        export SSH_ORIGINAL_COMMAND="$1"
        exec /usr/bin/rrsync -ro /var/lib/rondo-backup/exports
        ;;
    *) echo 'Only prepare and read-only rsync are allowed' >&2; exit 1 ;;
esac
