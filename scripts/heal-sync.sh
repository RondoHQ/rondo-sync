#!/bin/bash
#
# Self-heal watchdog for the Rondo sync pipelines.
#
#   heal-sync.sh <pipeline>   # check one pipeline
#   heal-sync.sh --all        # check every known pipeline in turn
#   heal-sync.sh --list       # print the known pipelines, one per line
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
#   ssh root@46.202.155.16 'cd /home/rondo && sudo -u rondo scripts/heal-sync.sh --all'
#
# Exit codes: 0 = checked (healed or nothing to do), 1 = bad usage / could not read DB.
# With --all the exit code is the worst seen across pipelines.

set -euo pipefail

# Match the PATH sync.sh uses so `node` resolves under cron/ssh.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_DIR"

# Every pipeline that opens a RunTracker and is scheduled in crontab, in roughly
# the order it fires. Keep in sync with `new RunTracker(...)` in pipelines/*.js —
# a pipeline missing here is a pipeline nothing is watching.
ALL_PIPELINES=(
  people
  functions
  functions-full
  nikki
  freescout
  freescout-conversations
  teams
  sponsit
  player-history
  discipline
  reverse
)

# Dashboard pipeline name -> sync.sh arguments. These are NOT always the same
# string: the conversations pipeline records itself as `freescout-conversations`
# but is invoked as `sync.sh conversations`, and `functions-full` is really
# `sync.sh functions --all --with-invoice`. Resolve through this table only.
rerun_args_for() {
  case "$1" in
    people)                  echo "people" ;;
    functions)               echo "functions" ;;
    functions-full)          echo "functions --all --with-invoice" ;;
    nikki)                   echo "nikki" ;;
    freescout)               echo "freescout" ;;
    freescout-conversations) echo "conversations" ;;
    teams)                   echo "teams" ;;
    sponsit)                 echo "sponsit" ;;
    player-history)          echo "player-history" ;;
    discipline)              echo "discipline" ;;
    reverse)                 echo "reverse" ;;
    *)                       return 1 ;;
  esac
}

usage() {
  echo "usage: heal-sync.sh <pipeline>|--all|--list" >&2
  echo "pipelines: ${ALL_PIPELINES[*]}" >&2
}

# How long a pipeline may go without STARTING a run before we call it stale, in
# hours. Derived from crontab: take the longest expected gap and roughly double
# it, so one missed slot is tolerated but a dead pipeline surfaces within a day.
# 0 = no cadence configured, skip the check.
#
# This exists because outcome-checking alone cannot see a pipeline that stopped
# running altogether: no run means no row, and "no row" looks exactly like a
# healthy idle pipeline. `nikki` sat dead from 2026-05-29 to 2026-07-23 behind a
# root-owned lockfile — sync.sh died before RunTracker opened, so there was
# nothing to fail and nothing to alert on.
stale_after_hours_for() {
  case "$1" in
    people)                  echo 30 ;;   # 4x daily 08,11,14,17 — longest gap 15h
    functions)               echo 30 ;;   # 4x daily 07:30,10:30,13:30,16:30
    functions-full)          echo 180 ;;  # weekly Sun 01:00
    nikki)                   echo 30 ;;   # daily 07:00
    freescout)               echo 30 ;;   # daily 08:00
    freescout-conversations) echo 30 ;;   # daily 09:00
    teams)                   echo 180 ;;  # weekly Sun 06:00
    sponsit)                 echo 180 ;;  # weekly Sun 10:00
    player-history)          echo 800 ;;  # monthly 1st 03:00 (~33d)
    discipline)              echo 180 ;;  # weekly Mon 23:30
    reverse)                 echo 1 ;;    # every 5 min — 1h is 12 missed slots
    *)                       echo 0 ;;
  esac
}

# Seconds -> compact human string, for log lines only.
human_age() {
  local S="$1"
  if [ "$S" -lt 3600 ]; then
    echo "$((S / 60))m"
  elif [ "$S" -lt 86400 ]; then
    echo "$((S / 3600))h"
  else
    echo "$((S / 86400))d"
  fi
}

# Read the latest run via the same better-sqlite3 lib the app uses, so we don't
# depend on a sqlite3 CLI. Age is computed here rather than in bash because
# parsing ISO timestamps portably in shell is a mess (GNU vs BSD `date`).
# Prints "outcome|started_at|age_seconds", "none", or "error:<msg>".
latest_run_for() {
  PIPELINE="$1" node -e '
    try {
      const { openDb } = require("./lib/dashboard-db");
      const db = openDb();
      const row = db.prepare(
        "SELECT outcome, started_at FROM runs WHERE pipeline = ? ORDER BY started_at DESC LIMIT 1"
      ).get(process.env.PIPELINE);
      db.close();
      if (!row) {
        process.stdout.write("none");
      } else {
        const age = Math.max(0, Math.round((Date.now() - new Date(row.started_at).getTime()) / 1000));
        process.stdout.write(`${row.outcome}|${row.started_at}|${age}`);
      }
    } catch (e) {
      process.stdout.write("error:" + e.message);
    }
  '
}

# Pipelines found stale during this invocation, for the --all summary.
STALE_REPORT=()
STALE_NOW=0   # set per-pipeline by check_staleness; initialised here for `set -u`

# Emits a STALE line when the newest run is older than the pipeline's cadence
# allows. Deliberately does NOT heal: a pipeline that never ran has not failed,
# and re-running it could just as easily be wrong (deliberately disabled, host
# maintenance). Surfacing it is the job; deciding is a human's.
# Sets STALE_NOW=1 when it fires, so the outcome line below can avoid calling a
# months-dead pipeline "healthy".
check_staleness() {
  local PIPELINE="$1" AGE_S="$2" TS="$3"
  local LIMIT_H
  STALE_NOW=0
  LIMIT_H="$(stale_after_hours_for "$PIPELINE")"
  [ "$LIMIT_H" -eq 0 ] && return 0

  if [ "$AGE_S" -gt $((LIMIT_H * 3600)) ]; then
    local AGE_H
    AGE_H="$(human_age "$AGE_S")"
    echo "[$TS] heal[$PIPELINE]: STALE — newest run started ${AGE_H} ago, expected one within ${LIMIT_H}h"
    STALE_REPORT+=("$PIPELINE(${AGE_H})")
    STALE_NOW=1
  fi
}

heal_one() {
  local PIPELINE="$1"
  local RERUN_STR
  if ! RERUN_STR="$(rerun_args_for "$PIPELINE")"; then
    echo "heal[$PIPELINE]: unknown pipeline" >&2
    usage
    return 1
  fi
  # Word-split is intentional and safe: every mapped value is fixed, space-separated flags.
  local RERUN=()
  read -r -a RERUN <<< "$RERUN_STR"

  local MARKER="$PROJECT_DIR/data/.heal-spent-$PIPELINE"   # exists = current failure episode already healed
  local TS
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local LATEST
  LATEST=$(latest_run_for "$PIPELINE")

  case "$LATEST" in
    none)
      # With tiered retention a pipeline keeps its newest runs regardless of age
      # (see lib/run-tracker.js), so "no rows at all" now genuinely means it has
      # not run in a very long time — not merely that the sweep ate the evidence.
      if [ "$(stale_after_hours_for "$PIPELINE")" -gt 0 ]; then
        echo "[$TS] heal[$PIPELINE]: STALE — no runs recorded at all, expected one within $(stale_after_hours_for "$PIPELINE")h"
        STALE_REPORT+=("$PIPELINE(never)")
      else
        echo "[$TS] heal[$PIPELINE]: no runs recorded yet — nothing to do"
      fi
      return 0
      ;;
    error:*)
      echo "[$TS] heal[$PIPELINE]: could not read dashboard DB (${LATEST#error:}) — skipping" >&2
      return 1
      ;;
  esac

  local OUTCOME="${LATEST%%|*}"
  local REST="${LATEST#*|}"
  local STARTED_AT="${REST%%|*}"
  local AGE_S="${REST#*|}"
  echo "[$TS] heal[$PIPELINE]: latest run outcome=$OUTCOME started_at=$STARTED_AT age=$(human_age "$AGE_S")"

  # Staleness is orthogonal to outcome: a pipeline whose last run succeeded three
  # weeks ago is broken even though nothing "failed".
  check_staleness "$PIPELINE" "$AGE_S" "$TS"

  case "$OUTCOME" in
    success|partial)
      # Completed and not a hard failure → any failure episode is over. Re-arm.
      if [ -f "$MARKER" ]; then
        rm -f "$MARKER"
        echo "[$TS] heal[$PIPELINE]: '$OUTCOME' run seen — re-armed (cleared heal marker)"
      elif [ "$STALE_NOW" -eq 1 ]; then
        # Don't call it healthy — the last run succeeded, but that was ages ago.
        echo "[$TS] heal[$PIPELINE]: last outcome was '$OUTCOME' but it is STALE (see above) — no heal (staleness is not a failure)"
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
  return 0
}

case "${1:-}" in
  --list)
    printf '%s\n' "${ALL_PIPELINES[@]}"
    exit 0
    ;;
  --all)
    RC=0
    for p in "${ALL_PIPELINES[@]}"; do
      # One bad pipeline must not abort the sweep (set -e would otherwise stop us).
      heal_one "$p" || RC=1
    done
    # Single greppable summary line so the hourly routine can report staleness
    # without re-deriving it from per-pipeline output.
    SUMMARY_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "${#STALE_REPORT[@]}" -gt 0 ]; then
      echo "[$SUMMARY_TS] heal: STALE PIPELINES (${#STALE_REPORT[@]}): ${STALE_REPORT[*]}"
    else
      echo "[$SUMMARY_TS] heal: no stale pipelines"
    fi
    exit "$RC"
    ;;
  "")
    usage
    exit 1
    ;;
  *)
    heal_one "$1"
    exit $?
    ;;
esac
