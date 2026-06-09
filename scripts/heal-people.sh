#!/bin/bash
#
# Self-heal watchdog for the People sync pipeline.
#
# Checks the most recent 'people' run in the dashboard DB. If it FAILED and we
# have not already auto-healed within the cooldown window, re-runs the pipeline
# exactly once — via sync.sh, so the retry shares the same flock, env, logging
# and email report as a normal cron run. Safe to invoke on any cadence: it is
# idempotent and cooldown-guarded, so even a tight watchdog loop retries a given
# failure at most once and then waits for the next scheduled cron slot / a human.
#
# Designed to be called from an off-box watchdog over SSH, e.g. a launchd job or
# scheduled agent on another machine:
#   ssh root@46.202.155.16 'cd /home/rondo && sudo -u rondo scripts/heal-people.sh'
#
# Run it as the `rondo` user so the marker file + any SQLite writes are owned
# correctly (same rule as the rest of the pipeline).
#
# Exit codes: 0 = checked (healed or nothing to do), 1 = could not read DB.

set -euo pipefail

# Match the PATH sync.sh uses so `node` resolves under cron/ssh.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_DIR"

MARKER="$PROJECT_DIR/data/.people-heal-last"   # epoch seconds of last auto-heal
COOLDOWN_SECONDS=$(( 150 * 60 ))               # ~one heal per 3h cron slot
NOW=$(date +%s)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Read the latest people-run outcome via the same better-sqlite3 lib the app
# uses, so we don't depend on a sqlite3 CLI being installed. Prints
# "outcome|started_at", or "none", or "error:<msg>".
LATEST=$(node -e '
  try {
    const { openDb } = require("./lib/dashboard-db");
    const db = openDb();
    const row = db.prepare(
      "SELECT outcome, started_at FROM runs WHERE pipeline = ? ORDER BY started_at DESC LIMIT 1"
    ).get("people");
    db.close();
    process.stdout.write(row ? `${row.outcome}|${row.started_at}` : "none");
  } catch (e) {
    process.stdout.write("error:" + e.message);
  }
')

case "$LATEST" in
  none)
    echo "[$TS] heal-people: no people runs recorded yet — nothing to do"
    exit 0
    ;;
  error:*)
    echo "[$TS] heal-people: could not read dashboard DB (${LATEST#error:}) — skipping" >&2
    exit 1
    ;;
esac

OUTCOME="${LATEST%%|*}"
STARTED_AT="${LATEST#*|}"
echo "[$TS] heal-people: latest people run outcome=$OUTCOME started_at=$STARTED_AT"

# Only the hard-failure case (download aborted, 0 members) is auto-healed.
# 'partial' means data downloaded but some later step logged errors — re-running
# rarely helps and would be noisy, so leave those for the operator email.
if [ "$OUTCOME" != "failure" ]; then
  echo "[$TS] heal-people: latest run is '$OUTCOME' (not failure) — no heal needed"
  exit 0
fi

# Cooldown: retry once per failure; don't hammer Sportlink/TOTP on a real outage.
LAST_HEAL=0
[ -f "$MARKER" ] && LAST_HEAL=$(cat "$MARKER" 2>/dev/null || echo 0)
SINCE=$(( NOW - LAST_HEAL ))
if [ "$LAST_HEAL" -gt 0 ] && [ "$SINCE" -lt "$COOLDOWN_SECONDS" ]; then
  echo "[$TS] heal-people: this failure was already auto-healed ${SINCE}s ago (< ${COOLDOWN_SECONDS}s cooldown) — leaving for the next cron slot / a human"
  exit 0
fi

echo "[$TS] heal-people: latest people run FAILED and cooldown elapsed — re-running people sync once"
echo "$NOW" > "$MARKER"
if scripts/sync.sh people; then
  echo "[$TS] heal-people: re-run completed"
else
  echo "[$TS] heal-people: re-run exited non-zero (skipped on lock, or failed again) — cooldown set, will not retry until next slot" >&2
fi
exit 0
