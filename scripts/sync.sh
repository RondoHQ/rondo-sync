#!/bin/bash
#
# Unified sync wrapper for cron
#
# Usage:
#   sync.sh people   # 4x daily: download + laposta + Rondo Club + photos
#   sync.sh photos   # Alias for people (photos integrated)
#   sync.sh teams    # Weekly: team download + sync + work history
#   sync.sh player-history # Monthly: expand historical team memberships
#   sync.sh functions  # Daily: functions download + commissies + work history
#   sync.sh invoice  # Monthly: functions + invoice data from /financial tab
#   sync.sh nikki    # Daily: nikki contributions download + Rondo Club sync
#   sync.sh freescout # Daily: FreeScout customer sync
#   sync.sh conversations # Daily: FreeScout conversations as activities
#   sync.sh former-members  # Manual: import former members from Sportlink
#   sync.sh reverse  # Every 5 min: reverse sync (Rondo Club -> Sportlink)
#   sync.sh all      # Full sync (all steps)
#
# Configuration via environment variables in .env:
#   - All Sportlink/Laposta/Rondo Club credentials
#   - LETTERMINT_* for email reports
#   - OPERATOR_EMAIL for report recipient
#
# Crontab example (single-line entries):
#   0 8,11,14,17 * * * /path/to/sync.sh people  # 4x daily
#   0 7 * * * /path/to/sync.sh nikki            # daily
#   15 7 * * * /path/to/sync.sh functions       # daily
#   0 8 * * * /path/to/sync.sh freescout        # daily
#   0 6 * * 0 /path/to/sync.sh teams            # weekly Sunday
#   0 3 1 * * /path/to/sync.sh player-history   # monthly
#   0 3 1 * * /path/to/sync.sh invoice          # monthly 1st at 3am
#   */5 * * * * /path/to/sync.sh reverse        # every 5 minutes
#

set -e

# Resolve project directory from script location
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# Interactive menu when no argument given
if [ -z "$1" ]; then
    # Only show menu if running in a terminal
    if [ ! -t 0 ]; then
        echo "Error: no pipeline specified (non-interactive mode)" >&2
        echo "Usage: sync.sh <pipeline>" >&2
        exit 1
    fi

    echo ""
    echo "Rondo Sync — pick a pipeline:"
    echo ""
    echo "  1) people           Members, parents, photos"
    echo "  2) functions        Commissies + free fields (recent updates)"
    echo "  3) functions --all  Full commissie sync (all members)"
    echo "  4) nikki            Nikki contributions"
    echo "  5) freescout        FreeScout customers"
    echo "  6) teams            Team rosters + work history"
    echo "  7) player-history   Historical team memberships -> work history"
    echo "  8) discipline       Discipline cases"
    echo "  9) invoice          Functions + invoice data"
    echo " 10) former-members  Import former members from Sportlink"
    echo " 11) all              Run all pipelines sequentially"
    echo " 12) conversations    FreeScout conversations as activities"
    echo ""
    printf "Choice [1-12]: "
    read -r CHOICE

    case "$CHOICE" in
        1) set -- "people" ;;
        2) set -- "functions" ;;
        3) set -- "functions" "--all" ;;
        4) set -- "nikki" ;;
        5) set -- "freescout" ;;
        6) set -- "teams" ;;
        7) set -- "player-history" ;;
        8) set -- "discipline" ;;
        9) set -- "invoice" ;;
        10) set -- "former-members" ;;
        11) set -- "all" ;;
        12) set -- "conversations" ;;
        *)
            echo "Invalid choice." >&2
            exit 1
            ;;
    esac

    printf "Verbose output? [y/N]: "
    read -r VERBOSE_CHOICE
    case "$VERBOSE_CHOICE" in
        [yY]*) set -- "$@" "--verbose" ;;
    esac

    echo ""
fi

SYNC_TYPE="$1"
shift
EXTRA_FLAGS="$*"

# Validate sync type
case "$SYNC_TYPE" in
    people|photos|teams|player-history|functions|invoice|nikki|freescout|reverse|discipline|former-members|conversations|all)
        ;;
    *)
        echo "Unknown sync type: $SYNC_TYPE" >&2
        echo "Run without arguments for interactive menu." >&2
        exit 1
        ;;
esac

# Create logs directories (cron-run logs + per-pipeline daily log)
LOG_DIR="$PROJECT_DIR/logs/cron"
DAILY_LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

# Compute log paths up-front so the lock-contention path can write to them
DATE=$(date +%Y-%m-%d_%H-%M-%S)
LOG_FILE="$LOG_DIR/sync-${SYNC_TYPE}-${DATE}.log"
DAILY_LOG_FILE="$DAILY_LOG_DIR/sync-${SYNC_TYPE}-$(date +%Y-%m-%d).log"

# Flock-based locking (per sync type to allow parallel different syncs)
LOCKFILE="$PROJECT_DIR/.sync-${SYNC_TYPE}.lock"
exec 200>"$LOCKFILE"
if ! flock -n 200; then
    # Identify the process currently holding the lock — usually a hung previous run.
    # lsof prints "p<pid>" lines when called with -F p; fall back to fuser if unavailable.
    HOLDER_PID=$(lsof -F p "$LOCKFILE" 2>/dev/null | awk '/^p/{sub(/^p/,""); print; exit}')
    if [ -z "$HOLDER_PID" ]; then
        HOLDER_PID=$(fuser "$LOCKFILE" 2>/dev/null | awk '{print $1}')
    fi

    HOLDER_INFO="unknown"
    HOLDER_AGE_S=""
    if [ -n "$HOLDER_PID" ] && [ -d "/proc/$HOLDER_PID" ]; then
        HOLDER_AGE_S=$(ps -o etimes= -p "$HOLDER_PID" 2>/dev/null | tr -d ' ')
        HOLDER_CMD=$(ps -o args= -p "$HOLDER_PID" 2>/dev/null | head -c 200)
        HOLDER_INFO="pid=$HOLDER_PID age=${HOLDER_AGE_S}s cmd=\"$HOLDER_CMD\""
    fi

    # ISO-8601 timestamp matching lib/logger.js format (without milliseconds — close enough).
    TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    MSG="Another $SYNC_TYPE sync is already running ($HOLDER_INFO). Skipping this run."
    LINE="[$TS] [ERROR] $MSG"

    # Stderr (so cron mail still flags it) + cron run log + daily pipeline log
    echo "$MSG" >&2
    echo "$LINE" >> "$LOG_FILE" 2>/dev/null || true
    echo "$LINE" >> "$DAILY_LOG_FILE" 2>/dev/null || true

    # Loud signal when the holder is older than 1 hour — almost certainly hung.
    # People takes ~15 min, functions ~5 min, reverse ~5 min, weekly jobs ~30 min.
    if [ -n "$HOLDER_AGE_S" ] && [ "$HOLDER_AGE_S" -gt 3600 ]; then
        STALE_MSG="WARNING: lock holder pid=$HOLDER_PID has been running ${HOLDER_AGE_S}s (>1h) — likely hung. Investigate and kill manually."
        echo "$STALE_MSG" >&2
        echo "[$TS] [ERROR] $STALE_MSG" >> "$LOG_FILE" 2>/dev/null || true
        echo "[$TS] [ERROR] $STALE_MSG" >> "$DAILY_LOG_FILE" 2>/dev/null || true
    fi

    exit 1
fi

# Set PATH for Node.js
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Change to project directory
cd "$PROJECT_DIR"

# Source .env file
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
else
    echo "Warning: .env file not found at $PROJECT_DIR/.env" >&2
fi

# LOG_FILE path was generated up-front before the flock check

# Determine which script to run
case "$SYNC_TYPE" in
    people)
        SYNC_SCRIPT="sync-people.js"
        ;;
    photos)
        # Photos now integrated into people sync (Phase 19)
        echo "Note: Photo sync is now integrated into people sync" >&2
        SYNC_SCRIPT="sync-people.js"
        ;;
    teams)
        SYNC_SCRIPT="sync-teams.js"
        ;;
    player-history)
        SYNC_SCRIPT="sync-player-history.js"
        ;;
    functions)
        SYNC_SCRIPT="sync-functions.js"
        ;;
    invoice)
        SYNC_SCRIPT="sync-functions.js"
        SYNC_FLAGS="--with-invoice"
        ;;
    nikki)
        SYNC_SCRIPT="sync-nikki.js"
        ;;
    freescout)
        SYNC_SCRIPT="sync-freescout.js"
        ;;
    conversations)
        SYNC_SCRIPT="sync-freescout-conversations.js"
        ;;
    reverse)
        SYNC_SCRIPT="reverse-sync.js"
        ;;
    discipline)
        SYNC_SCRIPT="sync-discipline.js"
        ;;
    former-members)
        SYNC_SCRIPT="sync-former-members.js"
        SYNC_FLAGS="--import"
        ;;
    all)
        SYNC_SCRIPT="sync-all.js"
        ;;
esac

# Merge flags from interactive menu and script mapping
SYNC_FLAGS="${SYNC_FLAGS:+$SYNC_FLAGS }$EXTRA_FLAGS"

# Run sync with logging
echo "Starting $SYNC_TYPE sync at $(date)" | tee -a "$LOG_FILE"
node "$PROJECT_DIR/pipelines/$SYNC_SCRIPT" $SYNC_FLAGS 2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}

# Healthchecks.io dead-man's switch (optional, per pipeline).
# Set HEALTHCHECK_<PIPELINE>_URL in .env (e.g. HEALTHCHECK_PEOPLE_URL).
# The dead-man only catches a genuine failure ("nothing ran at all" / the pipeline
# crashed), NOT a partial run. Pipeline exit codes:
#   0 = success, 2 = partial (non-fatal per-item errors, e.g. one photo failed),
#   1 (or any other non-zero) = fatal.
# So exit 0 and 2 both ping the success URL (check stays green); only a fatal exit
# pings /fail. Partial errors are still surfaced via the failure email below and the
# dashboard — they just don't trip the dead-man switch.
HC_VAR_NAME="HEALTHCHECK_$(echo "$SYNC_TYPE" | tr '[:lower:]-' '[:upper:]_')_URL"
HC_URL="${!HC_VAR_NAME}"
if [ -n "$HC_URL" ]; then
    if [ $EXIT_CODE -eq 0 ] || [ $EXIT_CODE -eq 2 ]; then
        curl -fsS -m 10 --retry 3 "$HC_URL" -o /dev/null 2>&1 || \
            echo "Warning: Healthcheck ping failed for $SYNC_TYPE" >&2
    else
        curl -fsS -m 10 --retry 3 "${HC_URL}/fail" -o /dev/null 2>&1 || \
            echo "Warning: Healthcheck fail ping failed for $SYNC_TYPE" >&2
    fi
fi

# Send alert email on any non-zero exit (partial=2 as well as fatal=1) so partial
# runs stay visible in the operator inbox even though they no longer trip the dead-man.
if [ $EXIT_CODE -ne 0 ]; then
    if [ -n "$LETTERMINT_API_TOKEN" ] && [ -n "$LETTERMINT_FROM_EMAIL" ] && [ -n "$OPERATOR_EMAIL" ]; then
        node "$PROJECT_DIR/lib/alert-email.js" send-failure-alert --pipeline "$SYNC_TYPE" || \
            echo "Warning: Failed to send failure alert" >&2
    fi
fi

exit $EXIT_CODE
