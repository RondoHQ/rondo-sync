#!/bin/bash
#
# Back-compat shim. The people self-heal now lives in the generic heal-sync.sh,
# which also covers functions / functions-full. Kept so older callers and the
# watchdog routine keep working.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
exec "$SCRIPT_DIR/heal-sync.sh" people
