#!/bin/bash
#
# Self-heal watchdog for a Rondo sync pipeline.
#
#   heal-sync.sh <people|functions|functions-full>
#
# Checks the most recent run of <pipeline> in the dashboard DB. If it HARD-FAILED
# and we have not already healed the current failure episode, re-runs the pipeline
# exactly once via sync.sh (sharing its flock/env/logging/email report).
#
# "Once per failure episode" is enforced by an arm/disarm marker, NOT a timer, so
# it is correct for the 4x-daily syncs (people, functions) AND the weekly full sync
# (functions-full) alike:
#   - a COMPLETED run that is not a hard failure (success/partial) re-arms the heal
#   - a hard failure heals once, then DISARMS until a non-failure run is seen again
# So a heal-retry that also fails is left for the next scheduled cron slot / a human,
# however long that is — no repeated hammering of Sportlink/TOTP during an outage.
#
# Run as the `rondo` user so the marker + any SQLite writes are owned correctly:
#   ssh root@46.202.155.16 'cd /home/rondo && sudo -u rondo scripts/heal-sync.sh functions'
#
# Exit codes: 0 = checked (healed or nothing to do), 1 = bad usage / could not read DB.

set -euo pipefail

# Match the PATH sync.sh uses so `node` resolves under cron/ssh.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

PIPELINE="${1:-}"
case "$PIPELINE" in
  people)         RERUN=(people) ;;
  functions)      RERUN=(functions) ;;
  functions-full) RERUN=(functions --all --with-invoice) ;;   # mirrors the weekly crontab entry
  *)
    echo "usage: heal-sync.sh <people|functions|functions-full>" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_DIR"

MARKER="$PROJECT_DIR/data/.heal-spent-$PIPELINE"   # exists = current failure episode already healed
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Read the latest run's outcome via the same better-sqlite3 lib the app uses, so we
# don't depend on a sqlite3 CLI. Prints "outcome|started_at", "none", or "error:<msg>".
LATEST=$(PIPELINE="$PIPELINE" node -e '
  try {
    const { openDb } = require("./lib/dashboard-db");
    const db = openDb();
    const row = db.prepare(
      "SELECT outcome, started_at FROM runs WHERE pipeline = ? ORDER BY started_at DESC LIMIT 1"
    ).get(process.env.PIPELINE);
    db.close();
    process.stdout.write(row ? `${row.outcome}|${row.started_at}` : "none");
  } catch (e) {
    process.stdout.write("error:" + e.message);
  }
')

case "$LATEST" in
  none)
    echo "[$TS] heal[$PIPELINE]: no runs recorded yet — nothing to do"
    exit 0
    ;;
  error:*)
    echo "[$TS] heal[$PIPELINE]: could not read dashboard DB (${LATEST#error:}) — skipping" >&2
    exit 1
    ;;
esac

OUTCOME="${LATEST%%|*}"
STARTED_AT="${LATEST#*|}"
echo "[$TS] heal[$PIPELINE]: latest run outcome=$OUTCOME started_at=$STARTED_AT"

case "$OUTCOME" in
  success|partial)
    # Completed and not a hard failure → any failure episode is over. Re-arm.
    if [ -f "$MARKER" ]; then
      rm -f "$MARKER"
      echo "[$TS] heal[$PIPELINE]: '$OUTCOME' run seen — re-armed (cleared heal marker)"
    else
      echo "[$TS] heal[$PIPELINE]: latest run is '$OUTCOME' — healthy, no heal needed"
    fi
    ;;
  running)
    echo "[$TS] heal[$PIPELINE]: a run is in progress — leaving it alone"
    ;;
  failure)
    if [ -f "$MARKER" ]; then
      echo "[$TS] heal[$PIPELINE]: this failure episode was already auto-healed once — leaving for the next cron slot / a human"
    else
      echo "[$TS] heal[$PIPELINE]: latest run FAILED and not yet healed — re-running once: sync.sh ${RERUN[*]}"
      : > "$MARKER"   # disarm BEFORE retrying, so a crash mid-retry still counts as spent
      if scripts/sync.sh "${RERUN[@]}"; then
        echo "[$TS] heal[$PIPELINE]: re-run completed"
      else
        echo "[$TS] heal[$PIPELINE]: re-run exited non-zero (skipped on lock, or failed again) — staying disarmed until a healthy run" >&2
      fi
    fi
    ;;
  *)
    echo "[$TS] heal[$PIPELINE]: unknown outcome '$OUTCOME' — skipping" >&2
    ;;
esac
exit 0
