#!/bin/bash
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_DIR"
mkdir -p data logs/cron
# --close prevents detached sync children from inheriting the dispatch lock.
exec flock --nonblock --close data/.schedule-dispatch.lock node lib/schedule-dispatcher.js
