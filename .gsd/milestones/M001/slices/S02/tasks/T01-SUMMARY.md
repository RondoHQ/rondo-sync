---
id: T01
parent: S02
milestone: M001
provides:
  - "RunTracker class with safety-wrapped methods for recording pipeline execution"
  - "All 7 pipelines instrumented with run tracking (people, nikki, teams, functions, discipline, freescout, all)"
  - "Per-step tracking: created/updated/skipped/failed counts"
  - "Error recording with member identifiers, error messages, and stack traces"
  - "Numeric error count handling (nikki pipeline)"
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 67min
verification_result: passed
completed_at: 2026-02-08
blocker_discovered: false
---
# T01: 35-run-tracking 01

**# Phase 35 Plan 01: Run Tracking Summary**

## What Happened

# Phase 35 Plan 01: Run Tracking Summary

**RunTracker class with safety-wrapped methods, all 7 pipelines instrumented for queryable run timing/per-step counts/individual errors stored in dashboard.sqlite**

## Performance

- **Duration:** 67 min
- **Started:** 2026-02-08T14:53:00Z
- **Completed:** 2026-02-08T16:00:48Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- RunTracker class with startRun, startStep, endStep, recordError, recordErrors, endRun methods — all wrapped in try/catch for safety
- All 7 pipelines (people, nikki, teams, functions, discipline, freescout, all) instrumented without modifying core logic
- Per-step tracking records created/updated/skipped/failed counts
- Individual error tracking with member identifiers (knvb_id/email/dossier_id/etc.), error messages, and stack traces
- Prepared SQL statements for performance
- Numeric error count handling (nikki pipeline's `errors` field is a number, not array)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create lib/run-tracker.js with RunTracker class** - `9a7d8b4` (feat)
2. **Task 2: Instrument all 7 pipeline files with run tracking** - `8a97127` (feat)

## Files Created/Modified
- `lib/run-tracker.js` - RunTracker class with startRun/startStep/endStep/recordError/recordErrors/endRun, safety wrappers, prepared statements
- `pipelines/sync-people.js` - 7 steps tracked: sportlink-download, laposta-prepare, laposta-submit, rondo-club-sync, photo-download, photo-upload, reverse-sync
- `pipelines/sync-nikki.js` - 2 steps tracked: nikki-download, rondo-club-sync (handles numeric error count)
- `pipelines/sync-teams.js` - 3 steps tracked: team-download, team-sync, work-history-sync
- `pipelines/sync-functions.js` - 3 steps tracked: functions-download, commissie-sync, commissie-work-history-sync
- `pipelines/sync-discipline.js` - 2 steps tracked: discipline-download, discipline-sync
- `pipelines/sync-freescout.js` - 1 step tracked: freescout-sync (includes early return for missing credentials)
- `pipelines/sync-all.js` - Run-level tracking only (delegates to other pipelines which track their own runs)

## Decisions Made
- **Safety-first approach:** All RunTracker methods wrapped in `_safe()` helper that catches errors and logs to stderr. Tracking failures never crash pipelines.
- **Per-run database connection:** Database opened in constructor, closed in endRun(). Avoids long-lived connections. Each pipeline run gets its own connection.
- **sync-all delegates step tracking:** The 'all' pipeline tracks itself as one run, but when it calls other pipelines (like discipline), those pipelines create their own run records. This is correct — sync-all's run record shows overall timing, individual pipeline runs show detailed step tracking.
- **recordErrors flexibility:** Handles both error arrays (most pipelines) and numeric error counts (nikki pipeline where `stats.rondoClub.errors` is a number).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

**Initial _safe() implementation issue:**
- **Issue:** Initial implementation checked `this.runId === null` in `_safe()`, preventing `startRun()` from working (chicken-and-egg problem).
- **Resolution:** Removed runId check from `_safe()`, only check `this.db`. startRun() can now execute before runId is set.
- **Verification:** CLI self-test passes, creates run ID 2 successfully.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Dashboard database now contains structured run data (timing, counts, errors) for all pipeline executions
- Data model ready for Phase 36 (Web Server) to add REST API endpoints
- Data ready for Phase 37 (Dashboard UI) to visualize
- No blockers

---
*Phase: 35-run-tracking*
*Completed: 2026-02-08*
